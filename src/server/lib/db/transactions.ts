/**
 * Explicit transaction helper (T-008, AC-012).
 *
 * Every multi-statement business operation runs through here so that a partial write is not a
 * thing this system can produce. The helper is deliberately thin: Kysely already rolls back when
 * the callback rejects, and the value of wrapping it is having ONE place that documents the
 * pooler constraints and one name to grep for.
 *
 * TRANSACTION POOLING NOTES (see pool.ts for the full rationale):
 *   - A transaction is the unit Supavisor pins a backend for, so everything inside the callback is
 *     guaranteed to run on the SAME backend. `SELECT ... FOR UPDATE`, `SET LOCAL` (the seam T-014
 *     uses for RLS context) and `pg_advisory_xact_lock()` are therefore all valid HERE and only
 *     here — outside a transaction they are session state and will be lost.
 *   - Keep the callback short. It holds a pooled backend for its whole duration; a network call in
 *     the middle of a transaction stalls every other client waiting for that backend.
 *   - Errors are re-thrown UNCHANGED. Swallowing or wrapping them would turn a rolled-back
 *     transaction into something a caller could mistake for success.
 */
import type { DbClient, DbTransaction } from './types.js';

/**
 * Runs `fn` inside a database transaction, committing on return and rolling back on throw.
 * The error is always re-thrown, so a caller that does not catch cannot proceed as if it worked.
 */
export async function withTransaction<T>(
  db: DbClient,
  fn: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  return await db.transaction().execute(fn);
}
