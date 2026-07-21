/**
 * Cron job registry (T-031 scaffolding; handlers land in T-032/T-034, spec §9.5).
 *
 * The three sweeps that replace the Hangfire recurring jobs. The NAMES are fixed here because they
 * are part of three separate contracts — the URL path (`/api/cron/{name}`), the `job_run.job_name`
 * value operators query on, and the `pg_cron` schedule entry that will call them — and those three
 * must agree exactly or a scheduled job fails silently at 03:00.
 *
 * `cronHandlers` STARTS EMPTY and is filled by `createJobRuntime()` (jobs/runtime.ts), which is the
 * only place the `DbClient` each handler factory needs is resolved. A name in `CRON_JOB_NAMES` with
 * no handler is therefore a REAL, reportable state — the endpoint fails loudly (501 + a failed
 * job_run row) rather than returning a cheerful 200 for work nobody has written, and `cron:list`
 * says NOT REGISTERED. Keep that property: a registry that always answers "registered" tells an
 * operator nothing, and a green scaffold is how a missing sweep survives to production.
 */
import type { JobHandler, JobHandlerRegistry } from '../types.js';

export const CRON_JOB_NAMES = [
  /** Job 1: Sent quotes past valid_until -> Expired (hourly). */
  'quote-expiry',
  /** Job 2: open leads inactive beyond the tenant threshold -> Expired (hourly, offset). */
  'lead-inactivity-expiry',
  /** Job 3: full per-tenant alert reconciliation (every 15 minutes). */
  'alert-evaluation',
  /** Job 5: delete pending attachment rows + objects whose upload URL expired unconfirmed (hourly). */
  'orphaned-upload-reaper',
] as const;

export type CronJobName = (typeof CRON_JOB_NAMES)[number];

export function isCronJobName(value: string): value is CronJobName {
  return (CRON_JOB_NAMES as readonly string[]).includes(value);
}

const handlers = new Map<string, JobHandler>();

/** Registration seam, called from the job composition root. */
export function registerCronHandler(handler: JobHandler): void {
  if (!isCronJobName(handler.name)) {
    throw new Error(
      `"${handler.name}" is not a known cron job name. Add it to CRON_JOB_NAMES and give it an api/cron entrypoint and a pg_cron schedule.`,
    );
  }
  handlers.set(handler.name, handler);
}

export const cronHandlers: JobHandlerRegistry = handlers;
