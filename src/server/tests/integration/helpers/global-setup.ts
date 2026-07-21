/**
 * Integration-run global setup: drop ORPHANED tenant partitions before the suite runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `create_tenant_partitions(id)` creates one LIST partition per partitioned parent (~22 tables)
 * for every tenant. Production never drops them, and that is correct there: tenants are SOFT
 * deleted, so their partitions must survive to keep historical data queryable.
 *
 * Integration tests, however, create REAL tenants in the thousands over a session. Suite cleanup
 * deletes the tenant ROWS, but nothing dropped the partition TABLES, so DDL residue accumulated
 * invisibly — row-level residue checks all reported zero while the schema grew without bound.
 *
 * It is not merely untidy. `supabase gen types typescript --local` emits every table it finds, so
 * at ~11,000 orphaned partitions its output reached 14.8 MB and `npm run db:types:check` — a gate
 * several tasks depend on — went from sub-second to a hard timeout, taking the whole suite with it.
 * That is how this was found: the drift suite timed out, not because it was flaky, but because the
 * schema it reads had been growing all session.
 *
 * A per-suite `afterAll` drop would work only for suites that remember it and only on clean exits;
 * much of the observed residue came from runs killed mid-flight (CI timeouts, SIGPIPE). Purging at
 * the START of a run is self-healing instead: it recovers from any previous crash, cannot be
 * forgotten by a future suite, and needs no per-suite discipline.
 *
 * SAFETY: only partitions whose tenant id has NO row in `tenants` are dropped. A live tenant's
 * partitions — including seeded/demo tenants — are never touched, and neither are DEFAULT
 * partitions, which carry no `_p<id>` suffix.
 */
import pg from 'pg';

import { probeLocalStack } from './local-stack.js';

export default async function setup(): Promise<void> {
  const probe = await probeLocalStack();
  // No stack: the suites themselves report a visible skip. Failing here would turn a
  // "Docker is not running" into an inscrutable global-setup crash.
  if (!probe.available) return;

  const client = new pg.Client({ connectionString: probe.stack.dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ qualified: string }>(`
      select format('%I.%I', n.nspname, c.relname) as qualified
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_inherits i on i.inhrelid = c.oid
       where c.relkind = 'r'
         and n.nspname = 'public'
         and c.relname ~ '_p[0-9]+$'
         and not exists (
               select 1 from tenants t
                where t.id = substring(c.relname from '_p([0-9]+)$')::bigint
             )
    `);

    if (rows.length === 0) return;

    // Batched, NOT one statement. Every dropped table takes a lock held to end of transaction, so
    // a single DROP of ~11k partitions dies with `out of shared memory` / max_locks_per_transaction
    // (observed). Each batch is its own implicit transaction, which bounds locks and lets a partial
    // purge still make progress.
    const BATCH = 250;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r) => r.qualified);
      await client.query(`drop table if exists ${batch.join(', ')} cascade`);
    }
    process.stderr.write(
      `\n[global-setup] dropped ${rows.length} orphaned tenant partition(s) left by previous runs\n\n`,
    );
  } finally {
    await client.end();
  }
}
