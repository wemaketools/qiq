/**
 * job_run history (T-031, AC-063, spec §9.5, N-08).
 *
 * One row per ATTEMPT, written in three moves: `start` (status=running) before the handler,
 * then exactly one of `succeed` / `fail` after it.
 *
 * ============================================================================================
 * THESE WRITES ARE DELIBERATELY OUTSIDE THE HANDLER'S TRANSACTION.
 * ============================================================================================
 * The obvious implementation — record the run in the same transaction as the work — destroys the
 * only thing this table is for. A failed handler rolls its transaction back, and a failure row
 * written inside it rolls back too: the table would then contain a perfect record of every success
 * and no trace whatsoever of the failures. The caller therefore passes the process-wide client
 * here, never a transaction handle, and the repository writes on its own connection.
 *
 * `duration_ms` is computed by the DATABASE (now() - started_at) rather than in JavaScript. Both
 * endpoints of the interval then come from one clock, which is the only way the number means
 * anything across a serverless instance whose wall clock nobody controls.
 */
import { sql } from 'kysely';

import type { AppEnv } from '../lib/config/index.js';
import type { DbClient } from '../lib/db/index.js';
import type { JobCounts, JobTrigger } from './types.js';

/** Stacks are for debugging, not for storage; anything longer is noise in every reader's terminal. */
export const MAX_ERROR_STACK_CHARS = 4000;
export const MAX_ERROR_MESSAGE_CHARS = 2000;

export interface JobRunStartInput {
  readonly jobName: string;
  readonly trigger: JobTrigger;
  readonly correlationId: string;
  readonly attempt?: number;
  readonly idempotencyKey?: string | null;
  readonly messageId?: number | null;
}

export interface JobRunRepository {
  /** Inserts a `running` row and returns its id. */
  start(input: JobRunStartInput): Promise<number>;
  succeed(jobRunId: number, counts?: JobCounts): Promise<void>;
  fail(jobRunId: number, error: unknown, counts?: JobCounts): Promise<void>;
}

interface ErrorDetail {
  readonly errorClass: string;
  readonly errorMessage: string;
  readonly errorStack: string | null;
}

/** Accepts anything a handler can throw — including non-Error values, which happens in practice. */
export function describeError(error: unknown): ErrorDetail {
  if (error instanceof Error) {
    return {
      errorClass: error.constructor.name,
      errorMessage: (error.message === '' ? error.name : error.message).slice(
        0,
        MAX_ERROR_MESSAGE_CHARS,
      ),
      errorStack: error.stack === undefined ? null : error.stack.slice(0, MAX_ERROR_STACK_CHARS),
    };
  }
  return {
    errorClass: typeof error,
    // String(...) rather than JSON: a thrown object with a toString is common and readable.
    errorMessage: String(error).slice(0, MAX_ERROR_MESSAGE_CHARS) || 'unknown error',
    errorStack: null,
  };
}

export class PgJobRunRepository implements JobRunRepository {
  constructor(
    private readonly db: DbClient,
    private readonly environment: AppEnv,
  ) {}

  async start(input: JobRunStartInput): Promise<number> {
    const row = await this.db
      .insertInto('job_run')
      .values({
        job_name: input.jobName,
        trigger: input.trigger,
        environment: this.environment,
        correlation_id: input.correlationId,
        attempt: input.attempt ?? 1,
        idempotency_key: input.idempotencyKey ?? null,
        message_id: input.messageId ?? null,
        status: 'running',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async succeed(jobRunId: number, counts?: JobCounts): Promise<void> {
    await this.finish(jobRunId, 'succeeded', counts, null);
  }

  async fail(jobRunId: number, error: unknown, counts?: JobCounts): Promise<void> {
    await this.finish(jobRunId, 'failed', counts, describeError(error));
  }

  private async finish(
    jobRunId: number,
    status: 'succeeded' | 'failed',
    counts: JobCounts | undefined,
    error: ErrorDetail | null,
  ): Promise<void> {
    await this.db
      .updateTable('job_run')
      .set({
        status,
        finished_at: sql<string>`now()`,
        duration_ms: sql<number>`greatest(0, (extract(epoch from (now() - started_at)) * 1000)::int)`,
        counts: counts === undefined ? null : JSON.stringify(counts),
        error_class: error?.errorClass ?? null,
        error_message: error?.errorMessage ?? null,
        error_stack: error?.errorStack ?? null,
      })
      .where('id', '=', jobRunId)
      // Only a running row may be finished. Without this an out-of-order or duplicated finish call
      // would silently rewrite a completed run's outcome — turning a recorded failure into a
      // success, which is the one lie this table must never tell.
      .where('status', '=', 'running')
      .execute();
  }
}
