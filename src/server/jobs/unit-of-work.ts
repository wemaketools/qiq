/**
 * The transactional boundary a queued message is processed inside (T-031, spec §9.5).
 *
 * ============================================================================================
 * THIS FILE IS WHERE AT-LEAST-ONCE DELIVERY BECOMES EXACTLY-ONCE EFFECT.
 * ============================================================================================
 * Three things happen in ONE transaction, in this order, and the order is the guarantee:
 *
 *   1. claim the idempotency key   -> INSERT ... ON CONFLICT DO NOTHING
 *   2. run the handler            -> its writes use the same transaction handle
 *   3. ack the message            -> pgmq.delete on the same connection
 *
 * Commit publishes all three or none of them.
 *
 *   - Duplicate delivery: the key is already present, the claim returns false, the handler is not
 *     run at all. One effect, no matter how many times pgmq delivers the message.
 *   - Handler failure: the claim rolls back WITH the effect, so the key is released and the retry
 *     genuinely re-runs the work. (Claiming the key in a separate committed transaction — the
 *     tempting "reserve it first" design — would burn the key on the first failure and make every
 *     retry a silent no-op. That is a data-loss bug wearing an idempotency costume.)
 *   - Crash between handler and ack: impossible to observe, because the ack is in the transaction.
 *     If the whole thing dies before commit, nothing happened and the message redelivers.
 *
 * The in-memory runner exists so the drain loop's control flow can be unit-tested without a
 * database. It models the same rollback semantics — keys claimed inside a failed callback are
 * released — because a test seam that cannot reproduce the failure path proves nothing.
 */
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

import { withTransaction, type Database, type DbClient, type DbExecutor } from '../lib/db/index.js';

export interface IdempotencyClaimInput {
  readonly key: string;
  readonly jobName: string;
  readonly tenantId: number | null;
  readonly jobRunId: number;
}

export interface JobTransactionContext {
  readonly db: DbExecutor;
  /** True when THIS attempt claimed the key; false when it was already claimed (a duplicate). */
  claimIdempotencyKey(input: IdempotencyClaimInput): Promise<boolean>;
}

export type RunInJobTransaction = <T>(
  fn: (context: JobTransactionContext) => Promise<T>,
) => Promise<T>;

/** Production runner: a real database transaction over the pooled client. */
export function pgJobTransactionRunner(db: DbClient): RunInJobTransaction {
  return async <T>(fn: (context: JobTransactionContext) => Promise<T>): Promise<T> =>
    await withTransaction(db, async (trx) =>
      fn({
        db: trx,
        claimIdempotencyKey: async (input) => {
          const claimed = await trx
            .insertInto('job_idempotency_key')
            .values({
              key: input.key,
              job_name: input.jobName,
              tenant_id: input.tenantId,
              job_run_id: input.jobRunId,
            })
            .onConflict((oc) => oc.column('key').doNothing())
            .returning('key')
            .executeTakeFirst();
          return claimed !== undefined;
        },
      }),
    );
}

/**
 * A Kysely client wired to Kysely's DummyDriver: it compiles SQL and never connects. Unit tests get
 * a real `DbExecutor` (no `any`, no partial mock) for handlers that do not touch the database.
 */
export function createOfflineDbClient(): DbClient {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

export interface InMemoryJobTransactionRunner {
  readonly run: RunInJobTransaction;
  /** Keys committed so far — the assertion surface for duplicate-suppression unit tests. */
  readonly claimedKeys: ReadonlySet<string>;
}

/** Unit-test runner with the same claim/rollback semantics as the Postgres one. */
export function createInMemoryJobTransactionRunner(
  db: DbExecutor = createOfflineDbClient(),
): InMemoryJobTransactionRunner {
  const committed = new Set<string>();

  const run: RunInJobTransaction = async <T>(
    fn: (context: JobTransactionContext) => Promise<T>,
  ): Promise<T> => {
    const pending = new Set<string>();
    try {
      const result = await fn({
        db,
        claimIdempotencyKey: async (input) => {
          if (committed.has(input.key) || pending.has(input.key)) return false;
          pending.add(input.key);
          return true;
        },
      });
      for (const key of pending) committed.add(key);
      return result;
    } catch (error) {
      // Rollback: nothing claimed inside a failed transaction survives it.
      pending.clear();
      throw error;
    }
  };

  return { run, claimedKeys: committed };
}
