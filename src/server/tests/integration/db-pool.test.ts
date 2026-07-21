/**
 * Connection and transaction behaviour of the Kysely layer against the real local database
 * (T-008, AC-012, V-015, N-03, R-3).
 *
 * WHY THIS IS A "POOLER-EQUIVALENT" PATH AND NOT SUPAVISOR ITSELF
 * ---------------------------------------------------------------
 * `supabase/config.toml` ships with `[db.pooler] enabled = false`, so the local stack exposes only
 * the direct port. Rather than assert nothing, these tests reproduce the two client-visible
 * properties that transaction pooling imposes, both of which are what actually break applications:
 *
 *   1. A statement may execute on a DIFFERENT server backend than the statement before it.
 *   2. Nothing that lives in a session survives between statements.
 *
 * Property 1 is exercised directly (queries are observed landing on different backend PIDs, and a
 * positive control proves that a NAMED prepared statement genuinely fails when it does). Property 2
 * is enforced by asserting our query path leaves `pg_prepared_statements` empty — the sensor that
 * turns red the moment anything starts naming statements.
 */
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../lib/db/client.js';
import { withTransaction } from '../../lib/db/transactions.js';
import { probeLocalStack, suiteTitle, type StackProbe } from './helpers/local-stack.js';

const probe: StackProbe = await probeLocalStack();

describe.skipIf(!probe.available)(suiteTitle('Kysely pool against the local database', probe), () => {
  let handle: DbHandle;

  beforeAll(() => {
    if (!probe.available) return;
    handle = createDb({ connectionString: probe.stack.dbUrl });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('connects and runs a simple query', async () => {
    const result = await sql<{ one: number }>`select 1::int as one`.execute(handle.db);
    expect(result.rows[0]?.one).toBe(1);
  });

  it('caps the live pool at the configured maximum under concurrent load', async () => {
    // 12 concurrent slow-ish queries against a pool of 2 must queue, not open 12 backends.
    await Promise.all(
      Array.from({ length: 12 }, () => sql`select pg_sleep(0.05)`.execute(handle.db)),
    );

    expect(handle.pool.totalCount).toBeLessThanOrEqual(handle.max);
    expect(handle.max).toBeLessThanOrEqual(2);
  });

  it('spreads work across more than one backend, as transaction pooling would', async () => {
    const pids = new Set<number>();
    // Concurrency forces both pooled connections into use simultaneously.
    for (let round = 0; round < 6; round += 1) {
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          sql<{ pid: number }>`select pg_backend_pid()::int as pid`.execute(handle.db),
        ),
      );
      for (const result of results) {
        const pid = result.rows[0]?.pid;
        if (pid !== undefined) pids.add(pid);
      }
    }

    expect(pids.size).toBeGreaterThan(1);
  });

  it('POSITIVE CONTROL: a named prepared statement does NOT survive a change of backend', async () => {
    // Proves the hazard the next test guards against is real, and that this database would in fact
    // punish us for naming statements. If this control ever passes silently, the guard below is
    // measuring nothing.
    const a = new pg.Client({ connectionString: probe.available ? probe.stack.dbUrl : '' });
    const b = new pg.Client({ connectionString: probe.available ? probe.stack.dbUrl : '' });
    await a.connect();
    await b.connect();
    try {
      await a.query('prepare t008_control as select 1');
      await expect(b.query('execute t008_control')).rejects.toThrow(/does not exist/i);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('leaves no named prepared statements behind, however many times a query is repeated', async () => {
    // Pinned to ONE connection so the check observes the same backend that ran the queries.
    const named = await handle.db.connection().execute(async (pinned) => {
      for (let i = 0; i < 10; i += 1) {
        await sql<{ n: number }>`select ${i}::int as n`.execute(pinned);
      }
      const result = await sql<{ count: string }>`
        select count(*)::text as count from pg_prepared_statements
      `.execute(pinned);
      return Number(result.rows[0]?.count ?? '-1');
    });

    expect(named).toBe(0);
  });

  it('runs the same parameterised query repeatedly across pooled connections', async () => {
    // The classic transaction-pooling regression: statement reuse blowing up on connection N+1.
    const values = await Promise.all(
      Array.from({ length: 20 }, (_unused, i) =>
        sql<{ n: number }>`select ${i}::int as n`.execute(handle.db),
      ),
    );

    expect(values.map((result) => result.rows[0]?.n)).toEqual(
      Array.from({ length: 20 }, (_unused, i) => i),
    );
  });

  it('returns bigint columns as JS numbers, matching the generated `number` declaration', async () => {
    const result = await sql<{ big: number }>`select 9007199254740991::int8 as big`.execute(handle.db);
    const value = result.rows[0]?.big;
    expect(typeof value).toBe('number');
    expect(value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns numeric columns as strings, so money keeps its exact decimal value', async () => {
    const result = await sql<{ amount: string }>`select 12345678901234.99::numeric as amount`.execute(
      handle.db,
    );
    const value = result.rows[0]?.amount;
    expect(typeof value).toBe('string');
    expect(value).toBe('12345678901234.99');
  });

  it('refuses a bigint beyond 2^53 rather than silently rounding it', async () => {
    await expect(sql`select 9007199254740993::int8 as big`.execute(handle.db)).rejects.toThrow(
      /precision|safe integer/i,
    );
  });
});

describe.skipIf(!probe.available)(
  suiteTitle('withTransaction against the local database', probe),
  () => {
    let handle: DbHandle;
    const marker = `t008-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    beforeAll(() => {
      if (!probe.available) return;
      handle = createDb({ connectionString: probe.stack.dbUrl });
    });

    afterAll(async () => {
      if (handle) {
        await handle.db.deleteFrom('tenants').where('name', 'like', 't008-tx-%').execute();
        await handle.close();
      }
    });

    const now = new Date().toISOString();

    it('commits every statement of a successful multi-statement transaction', async () => {
      await withTransaction(handle.db, async (trx) => {
        await trx
          .insertInto('tenants')
          .values({ name: `${marker}-a`, created_at: now, updated_at: now })
          .execute();
        await trx
          .insertInto('tenants')
          .values({ name: `${marker}-b`, created_at: now, updated_at: now })
          .execute();
      });

      const rows = await handle.db
        .selectFrom('tenants')
        .select('name')
        .where('name', 'in', [`${marker}-a`, `${marker}-b`])
        .execute();

      expect(rows.map((row) => row.name).sort()).toEqual([`${marker}-a`, `${marker}-b`]);
    });

    it('rolls back EVERY statement when the callback throws mid-transaction', async () => {
      const boom = new Error('t008 deliberate mid-transaction failure');

      await expect(
        withTransaction(handle.db, async (trx) => {
          await trx
            .insertInto('tenants')
            .values({ name: `${marker}-rollback-1`, created_at: now, updated_at: now })
            .execute();
          await trx
            .insertInto('tenants')
            .values({ name: `${marker}-rollback-2`, created_at: now, updated_at: now })
            .execute();
          throw boom;
        }),
      ).rejects.toThrow(boom);

      // The point of the test: the FIRST insert, which succeeded, must also be gone.
      const rows = await handle.db
        .selectFrom('tenants')
        .select('name')
        .where('name', 'like', `${marker}-rollback-%`)
        .execute();

      expect(rows).toEqual([]);
    });

    it('rolls back when the database itself rejects a later statement', async () => {
      await expect(
        withTransaction(handle.db, async (trx) => {
          await trx
            .insertInto('tenants')
            .values({ name: `${marker}-constraint`, created_at: now, updated_at: now })
            .execute();
          // Violates ck_tenants_status.
          await trx
            .insertInto('tenants')
            .values({
              name: `${marker}-constraint-2`,
              status: 'not-a-valid-status',
              created_at: now,
              updated_at: now,
            })
            .execute();
        }),
      ).rejects.toThrow();

      const rows = await handle.db
        .selectFrom('tenants')
        .select('name')
        .where('name', 'like', `${marker}-constraint%`)
        .execute();

      expect(rows).toEqual([]);
    });

    it('propagates the original error, not a wrapped or swallowed one', async () => {
      class MarkerError extends Error {}
      await expect(
        withTransaction(handle.db, async () => {
          throw new MarkerError('t008 marker');
        }),
      ).rejects.toBeInstanceOf(MarkerError);
    });

    it('returns the callback result on success', async () => {
      const value = await withTransaction(handle.db, async () => 'result');
      expect(value).toBe('result');
    });

    it('supports SELECT ... FOR UPDATE inside a single transaction (R-3 sequence pattern)', async () => {
      // Row locks are transaction-scoped, so they remain valid under transaction pooling — unlike
      // session-level advisory locks, which this codebase must never use.
      await withTransaction(handle.db, async (trx) => {
        await trx
          .insertInto('tenants')
          .values({ name: `${marker}-lock`, created_at: now, updated_at: now })
          .execute();

        const locked = await trx
          .selectFrom('tenants')
          .select(['id', 'name'])
          .where('name', '=', `${marker}-lock`)
          .forUpdate()
          .execute();

        expect(locked).toHaveLength(1);
      });
    });
  },
);
