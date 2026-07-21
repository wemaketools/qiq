/**
 * The audit_log writer (T-013, AC-024, V-031; M-06, P-13, NFR-02, spec §15).
 *
 * Port of `src/api/tests/QuoteIQ.Infrastructure.Tests/Auditing/AuditWriterTests.cs`, against a real
 * database rather than an in-memory provider — the properties that matter here (jsonb round-tripping,
 * transaction participation, a nullable tenant) are exactly the ones a fake would not reproduce.
 *
 * The before/after key assertions discharge the obligation T-003's evaluator recorded against this
 * task: `20260718001300_audit_log.sql:18-22` documents that the writer emits
 * `{"before": ..., "after": ...}` into `details`, and until now nothing enforced it.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAuditDetails, writeAudit } from '../../domains/audit/index.js';
import {
  poolerPoolConfig,
  withTransaction,
  type Database,
  type DbExecutor,
} from '../../lib/db/index.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('writeAudit: audit_log writer', probe);

describeStack(title, () => {
  let stack: LocalStack;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  /** Every action this suite writes, removed in afterAll. */
  const actions: string[] = [];

  function uniqueAction(name: string): string {
    const action = `t013.${name}.${crypto.randomUUID()}`;
    actions.push(action);
    return action;
  }

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const result = await pool.query<T>(sql, params);
    return result.rows;
  };

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;
    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  });

  afterAll(async () => {
    if (!probe.available) return;
    for (const action of actions) {
      await pool.query('delete from audit_log where action = $1', [action]);
    }
    await db?.destroy();
  });

  it('writes one row carrying actor, tenant, entity, timestamp and details', async () => {
    const action = uniqueAction('created');

    await writeAudit(db, {
      entityType: 'sample_item',
      entityId: '42',
      action,
      actorUserId: null,
      actorLabel: 'system',
      tenantId: 4242,
      before: null,
      after: { name: 'value' },
    });

    const row = await assertAudited(query, {
      action,
      entityType: 'sample_item',
      entityId: '42',
      tenantId: 4242,
      before: null,
      after: { name: 'value' },
    });

    expect(row.actor_label).toBe('system');
    expect(row.acted_at).toBeInstanceOf(Date);
  });

  it('emits BOTH before and after keys even when the caller supplies neither', async () => {
    // The documented `details->'before'` / `details->'after'` mapping must be TOTAL. If either key
    // could be absent, every downstream consumer would need a null branch the docs do not mention.
    const action = uniqueAction('bare');

    await writeAudit(db, {
      entityType: 'sample_item',
      entityId: '1',
      action,
      actorUserId: 7,
      tenantId: null,
    });

    const rows = await findAuditRows(query, { action });
    expect(rows).toHaveLength(1);
    const details = rows[0]?.details as Record<string, unknown>;

    expect(Object.hasOwn(details, 'before')).toBe(true);
    expect(Object.hasOwn(details, 'after')).toBe(true);
    expect(details['before']).toBeNull();
    expect(details['after']).toBeNull();
  });

  it('reads the keys back through a jsonb path query, as the schema documents', async () => {
    // Asserting through `details->>'before'` rather than the deserialized object proves the SQL
    // access path in the migration comment actually works, not merely that a JS object round-tripped.
    const action = uniqueAction('jsonpath');

    await writeAudit(db, {
      entityType: 'tenant',
      entityId: '9',
      action,
      actorUserId: 3,
      tenantId: 9,
      before: { name: 'Old Name' },
      after: { name: 'New Name' },
    });

    const rows = await query<{ before_name: string; after_name: string }>(
      `select details->'before'->>'name' as before_name,
              details->'after'->>'name'  as after_name
         from audit_log where action = $1`,
      [action],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.before_name).toBe('Old Name');
    expect(rows[0]?.after_name).toBe('New Name');
  });

  it('records a global action with a null tenant', async () => {
    // audit_log.tenant_id is nullable precisely so tenant-lifecycle and global-template actions can
    // be recorded. Writing through forTenant() could not express this.
    const action = uniqueAction('global');

    await writeAudit(db, {
      entityType: 'tenant',
      entityId: '11',
      action,
      actorUserId: 5,
      tenantId: null,
      after: { name: 'Created' },
    });

    const rows = await findAuditRows(query, { action });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBeNull();
  });

  it('merges extra context alongside before/after without displacing them', async () => {
    const action = uniqueAction('context');

    await writeAudit(db, {
      entityType: 'lead',
      entityId: '5',
      action,
      actorUserId: 1,
      tenantId: 1,
      before: { status: 'new' },
      after: { status: 'assigned' },
      context: { correlationId: 'abc-123' },
    });

    const rows = await findAuditRows(query, { action });
    const details = rows[0]?.details as Record<string, unknown>;

    expect(details['correlationId']).toBe('abc-123');
    expect(details['before']).toEqual({ status: 'new' });
    expect(details['after']).toEqual({ status: 'assigned' });
  });

  it('cannot have before/after overwritten by a caller-supplied context key', async () => {
    // `context` is spread FIRST in buildAuditDetails, so a caller cannot blank the audit payload
    // — accidentally or otherwise — by passing its own `before`/`after`.
    const details = buildAuditDetails({
      entityType: 'lead',
      entityId: '1',
      action: 'x',
      actorUserId: 1,
      tenantId: 1,
      before: { real: true },
      after: { real: true },
      context: { before: 'spoofed', after: 'spoofed' },
    });

    expect(details.before).toEqual({ real: true });
    expect(details.after).toEqual({ real: true });
  });

  // ---------------------------------------------------------------- transaction participation

  it('commits the audit row with the caller transaction', async () => {
    // POSITIVE CONTROL for the rollback test below: the same code path must genuinely persist a row
    // when the transaction commits, or "no row after rollback" would prove nothing.
    const action = uniqueAction('committed');

    await withTransaction(db, async (trx: DbExecutor) => {
      await writeAudit(trx, {
        entityType: 'lead',
        entityId: '100',
        action,
        actorUserId: 1,
        tenantId: 1,
        after: { committed: true },
      });
    });

    const rows = await findAuditRows(query, { action });
    expect(rows).toHaveLength(1);
  });

  it('leaves no audit row when the caller transaction rolls back', async () => {
    // The atomicity property: an audit row that survived a failed change would assert something
    // that never happened. Passing the transaction handle is what makes this hold.
    const action = uniqueAction('rolledback');
    const failure = new Error('business failure after the audit write');

    await expect(
      withTransaction(db, async (trx: DbExecutor) => {
        await writeAudit(trx, {
          entityType: 'lead',
          entityId: '101',
          action,
          actorUserId: 1,
          tenantId: 1,
          after: { committed: false },
        });
        throw failure;
      }),
    ).rejects.toThrow(failure);

    const rows = await findAuditRows(query, { action });
    expect(rows).toEqual([]);
  });

  it('survives a rollback when handed the root handle instead of the transaction', async () => {
    // Documents the failure mode the executor parameter exists to prevent: writing through `db`
    // from inside a transaction escapes it, and the row outlives the rolled-back change. Pinned so
    // the distinction is a tested behaviour rather than a comment nobody reads.
    const action = uniqueAction('escaped');

    await expect(
      withTransaction(db, async () => {
        await writeAudit(db, {
          entityType: 'lead',
          entityId: '102',
          action,
          actorUserId: 1,
          tenantId: 1,
          after: { escaped: true },
        });
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    const rows = await findAuditRows(query, { action });
    expect(rows).toHaveLength(1);
  });

  it('makes assertAudited reject a duplicated audit row', async () => {
    // Tests the SHARED HELPER's strictness, not the writer. Every later domain suite (T-016..T-039)
    // proves its audit coverage through assertAudited, so if the helper quietly accepted "one or
    // more" rows, a double-write under retry would pass everywhere at once. The only way to know it
    // rejects duplicates is to hand it duplicates.
    const action = uniqueAction('duplicate');
    const entry = {
      entityType: 'lead',
      entityId: '300',
      action,
      actorUserId: 1,
      tenantId: 1,
      after: { n: 1 },
    } as const;

    await writeAudit(db, entry);
    await writeAudit(db, entry);

    await expect(assertAudited(query, { action })).rejects.toThrow();
  });

  it('writes exactly one row per call', async () => {
    // Guards the "at least one" trap: a double-write is a real bug under retries.
    const action = uniqueAction('single');

    await writeAudit(db, {
      entityType: 'lead',
      entityId: '200',
      action,
      actorUserId: 1,
      tenantId: 1,
      after: { n: 1 },
    });

    const rows = await findAuditRows(query, { action });
    expect(rows).toHaveLength(1);
  });
});
