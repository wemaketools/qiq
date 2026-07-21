/**
 * Job 3 — the full per-tenant alert reconciliation sweep (T-033; AC-069, AC-072; V-086, V-090).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Jobs/AlertEvaluationJob.cs`.
 *
 * ============================================================================================
 * JOB CONTRACT (spec §9.5's required documentation for every recurring job)
 * ============================================================================================
 *   NAME              alert-evaluation
 *   SCHEDULE          every 15 minutes, pg_cron -> pg_net -> GET /api/cron/alert-evaluation.
 *                     The schedule row itself is registered by T-034; this module is the handler.
 *   PURPOSE           Make the `alerts` table equal the rule-match set for every active tenant:
 *                     create what is missing, resolve what has cleared.
 *   IDEMPOTENCY KEY   NONE, and deliberately so. The sweep is STATE-GUARDED rather than
 *                     event-driven: it re-derives the whole truth from current data every run, so
 *                     running it twice is a no-op and a MISSED tick self-heals on the next one.
 *                     An idempotency key would add a way to fail without removing any duplicate.
 *                     The database backstop is `uq_alerts_open_per_type_lead_quote`, against which
 *                     inserts conflict-do-nothing — so even two OVERLAPPING runs cannot duplicate.
 *   RETRY BEHAVIOUR   Safe at any time; there is nothing to replay. A tenant that failed this run
 *                     is simply reconciled on the next tick.
 *   FAILURE HANDLING  PER-TENANT. One tenant throwing does not stop the sweep — the remaining
 *                     tenants still complete in the same run (AC-072). The run then reports
 *                     FAILED, with the failing tenant ids and the partial counts in the error
 *                     message, so a persistent single-tenant fault cannot hide behind a green run.
 *   DATABASE STATE    Reads leads/quotes/quote_versions/pricing_approvals/lead_status_history/
 *                     reference_items/parties/tenant_settings; writes ONLY `alerts`.
 *   OBSERVABILITY     One structured log line per tenant (tenant id + created/resolved/matched
 *                     counts — never a business field), plus aggregate counts on the job_run row.
 *
 * ============================================================================================
 * THIS JOB NEVER CHANGES A LEAD OR QUOTE STATUS.
 * ============================================================================================
 * That boundary belongs exclusively to the T-032 expiry sweeps. This one only ever materializes or
 * resolves `alerts` rows. Two jobs writing the same status column on different schedules is a race
 * with no winner, and the `quote_expired` alert rule exists precisely so that an expired-but-not-
 * yet-swept quote is VISIBLE without this job reaching for the status itself.
 *
 * ONE TENANT PER UNIT OF WORK
 * ===========================
 * Each tenant is reconciled inside its OWN transaction. Nothing here ever holds two tenants at
 * once, so a fault while processing one cannot roll back — or leak into — another's alerts. A
 * single transaction spanning the sweep would do both, and would hold a pooled connection for the
 * length of the whole tenant list.
 */
import { toTenantId, withTransaction, type DbClient } from '../../lib/db/index.js';
import { reconcileTenantAlerts } from '../../domains/alerts/index.js';
import { forEachActiveTenant } from '../tenant-iterator.js';
import type { JobContext, JobHandler, JobResult } from '../types.js';

export const ALERT_EVALUATION_JOB_NAME = 'alert-evaluation';

/**
 * Raised when some tenants reconciled and others did not.
 *
 * The message carries the failing tenant ids AND the partial counts because `runCronJob` records
 * counts only on the SUCCESS path (`jobRuns.fail(jobRunId, error)` passes none) — so without this,
 * a partially-failed sweep would leave a job_run row that says nothing about the work that did
 * complete. Flagged on the task: the alternative is widening T-031's shared cron runner, which is
 * another task's file.
 */
export class PartialSweepError extends Error {
  constructor(
    readonly failedTenantIds: readonly number[],
    readonly counts: Readonly<Record<string, number>>,
  ) {
    super(
      `alert-evaluation completed with per-tenant failures. failedTenantIds=[${failedTenantIds.join(',')}] ` +
        `counts=${JSON.stringify(counts)}`,
    );
    this.name = 'PartialSweepError';
  }
}

export interface AlertEvaluationOptions {
  /** Injected so tests are deterministic; production passes nothing and each tenant gets `now`. */
  readonly now?: Date | undefined;
  /** Bounds the tenant page size; the default lives in the tenant iterator. */
  readonly batchSize?: number | undefined;
  /** Stops starting new tenants once the Vercel invocation budget is spent. */
  readonly timeBudgetMs?: number | undefined;
}

/**
 * Runs the sweep. Exported separately from the handler so tests can drive it directly with a real
 * client and assert per-tenant behaviour without going through the job_run plumbing.
 */
export async function runAlertEvaluationSweep(
  db: DbClient,
  context: Pick<JobContext, 'logger'>,
  options: AlertEvaluationOptions = {},
): Promise<{ counts: Record<string, number>; failedTenantIds: number[] }> {
  let created = 0;
  let resolved = 0;
  let matched = 0;
  const failedTenantIds: number[] = [];

  const outcome = await forEachActiveTenant(
    db,
    async (tenant) => {
      const result = await withTransaction(db, async (trx) =>
        reconcileTenantAlerts(trx, toTenantId(tenant.id), { now: options.now }),
      );

      created += result.created;
      resolved += result.resolved;
      matched += result.matched;

      // Ids and counts only — never a lead ref, a party name or a premium (§15).
      context.logger.info('alert-evaluation reconciled tenant', {
        tenantId: tenant.id,
        created: result.created,
        resolved: result.resolved,
        matched: result.matched,
      });
    },
    {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
    },
  );

  for (const failure of outcome.failures) {
    failedTenantIds.push(failure.tenantId);
    context.logger.error('alert-evaluation failed for tenant', {
      tenantId: failure.tenantId,
      err: failure.error,
    });
  }

  return {
    counts: {
      tenantsProcessed: outcome.processed,
      tenantsFailed: outcome.failures.length,
      created,
      resolved,
      matched,
      budgetExhausted: outcome.budgetExhausted ? 1 : 0,
    },
    failedTenantIds,
  };
}

/**
 * The registrable handler.
 *
 * A FACTORY over an explicit client rather than a bare object reading `context.db`: the sweep needs
 * to OPEN transactions (one per tenant), and `JobContext.db` is typed as an executor that may
 * already be inside one. In production `runCronJob` passes the same process-wide client this
 * factory is given, so there is no second connection — but the type now states what the handler
 * actually requires instead of assuming what it will be handed.
 *
 * REGISTRATION IS NOT DONE HERE. `registerCronHandler(...)` is called by T-034 along with the
 * pg_cron schedule, so the endpoint, the schedule and the handler land together rather than the
 * handler going live against no schedule.
 */
export function createAlertEvaluationHandler(
  db: DbClient,
  options: AlertEvaluationOptions = {},
): JobHandler {
  return {
    name: ALERT_EVALUATION_JOB_NAME,

    async handle(_payload: unknown, context: JobContext): Promise<JobResult> {
      const { counts, failedTenantIds } = await runAlertEvaluationSweep(db, context, options);

      if (failedTenantIds.length > 0) {
        throw new PartialSweepError(failedTenantIds, counts);
      }

      return { counts };
    },
  };
}
