/**
 * Shared cron execution (T-031, AC-063/AC-065, spec §9.5).
 *
 * ONE function behind BOTH cron paths — the deployed `/api/cron/{job}` endpoint (called by pg_cron
 * through pg_net) and the local `cron:run <job>` script. Spec §9.5 requires the local substitute to
 * be the same code, not a re-implementation, and the only difference this function permits between
 * them is the `trigger` value stamped on the job_run row ('cron' vs 'manual').
 *
 * Unlike the queue path there is no idempotency key here: the sweeps are STATE-GUARDED (only quotes
 * that are currently Sent and past valid_until transition; alert reconciliation converges on the
 * rule-match set), so a duplicated or overlapping invocation is a no-op by construction. That is
 * spec §9.5's stated strategy and the reason a missed pg_cron tick is survivable.
 *
 * The handler is NOT wrapped in a single transaction: a sweep spans every active tenant, and one
 * transaction across all of them would both hold a pooled backend far too long and make one
 * tenant's failure roll back every other tenant's completed work. Handlers open their own
 * per-tenant transactions (see ../tenant-iterator.ts).
 */
import type { DbClient } from '../../lib/db/index.js';
import { jobLogger, newCorrelationId } from '../../lib/logging/index.js';
import type { JobRunRepository } from '../job-run-repository.js';
import type { JobCounts, JobHandlerRegistry, JobTrigger } from '../types.js';

/** Raised when the endpoint exists but nothing has registered a handler for it yet. */
export class HandlerNotRegisteredError extends Error {
  constructor(readonly jobName: string) {
    super(`No handler is registered for cron job "${jobName}"`);
    this.name = 'HandlerNotRegisteredError';
  }
}

export interface RunCronJobDeps {
  readonly db: DbClient;
  readonly handlers: JobHandlerRegistry;
  readonly jobRuns: JobRunRepository;
}

export interface RunCronJobOptions {
  readonly jobName: string;
  readonly trigger: JobTrigger;
  readonly correlationId?: string;
}

export interface CronRunOutcome {
  readonly jobRunId: number;
  readonly jobName: string;
  readonly correlationId: string;
  readonly status: 'succeeded' | 'failed';
  readonly counts?: JobCounts;
  readonly error?: unknown;
}

export async function runCronJob(
  deps: RunCronJobDeps,
  options: RunCronJobOptions,
): Promise<CronRunOutcome> {
  const correlationId = options.correlationId ?? newCorrelationId();
  const log = jobLogger({
    jobName: options.jobName,
    correlationId,
    trigger: options.trigger,
  });

  const jobRunId = await deps.jobRuns.start({
    jobName: options.jobName,
    trigger: options.trigger,
    correlationId,
  });

  try {
    const handler = deps.handlers.get(options.jobName);
    if (handler === undefined) throw new HandlerNotRegisteredError(options.jobName);

    const result = await handler.handle(
      {},
      {
        db: deps.db,
        jobName: options.jobName,
        trigger: options.trigger,
        correlationId,
        tenantId: null,
        attempt: 1,
        jobRunId,
        logger: log,
      },
    );

    await deps.jobRuns.succeed(jobRunId, result?.counts);
    log.info('cron job succeeded', { jobRunId });
    return {
      jobRunId,
      jobName: options.jobName,
      correlationId,
      status: 'succeeded',
      ...(result?.counts === undefined ? {} : { counts: result.counts }),
    };
  } catch (error) {
    await deps.jobRuns.fail(jobRunId, error);
    log.error('cron job failed', { jobRunId, err: error });
    return { jobRunId, jobName: options.jobName, correlationId, status: 'failed', error };
  }
}
