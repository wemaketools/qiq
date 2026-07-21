/**
 * Job 2 — the hourly lead-inactivity-expiry sweep (T-032; AC-066, AC-068, AC-072; V-084, V-090).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Jobs/LeadInactivityExpiryJob.cs`.
 *
 * ============================================================================================
 * JOB CONTRACT (spec §9.5's required documentation for every recurring job)
 * ============================================================================================
 *   NAME              lead-inactivity-expiry
 *   SCHEDULE          hourly at ten past — pg_cron `10 * * * *` -> pg_net ->
 *                     GET /api/cron/lead-inactivity-expiry. Locally,
 *                     `npm run cron:run -- lead-inactivity-expiry` through the same object graph.
 *                     The ten-minute offset from Job 1 is deliberate: the quote sweep STAMPS
 *                     `last_activity_at` on every lead whose quote it expires, so running them
 *                     simultaneously would have this job reading a column the other is still
 *                     writing.
 *   PURPOSE           Move every open/quoted lead whose `last_activity_at` is older than the
 *                     tenant's own `lead_inactivity_expiry_days` to Expired. With Job 1 these are
 *                     the ONLY automatic status changes in the product (P-07).
 *   IDEMPOTENCY KEY   NONE, and deliberately so — the same state-guarded argument as Job 1. The
 *                     candidate query selects only leads CURRENTLY in an open/quoted category, and
 *                     expiring one moves it to the `expired` category, out of the set. A second run
 *                     selects nothing and writes nothing.
 *   RETRY BEHAVIOUR   Safe at any time, including concurrent and duplicate delivery. Each lead is
 *                     expired in its own transaction which re-reads the lead and re-checks the
 *                     legality matrix inside that transaction, so two overlapping runs cannot both
 *                     expire the same lead.
 *   FAILURE HANDLING  PER-TENANT, and per-lead within a tenant (AC-072), as Job 1.
 *   DATABASE STATE    Reads leads/reference_items/tenant_settings; writes leads.status_id,
 *                     lead_status_history and audit_log — through the shared executor, never by hand.
 *   OBSERVABILITY     One structured log line per tenant (tenant id + counts), a warning per lead
 *                     that failed to expire, and aggregate counts on the job_run row.
 *
 * IT NEVER RE-DERIVES ACTIVITY
 * ============================
 * `last_activity_at` is maintained by the write paths, not reconstructed here: T-024 stamps it on
 * lead create and mutation, and T-026's `executeQuoteOperation` stamps the parent lead
 * UNCONDITIONALLY on every quote operation — verified in that file rather than assumed. So "quote
 * activity counts as lead activity" is already true in the column by the time this job reads it, and
 * a second definition of activity living here would be a second source of truth to drift.
 */
import { getTenantSettings } from '../../domains/business-rules/index.js';
import {
  LEAD_EXPIRE_OPERATION,
  executeLeadOperation,
  listInactivityExpiredLeadCandidates,
  type LeadChangedListener,
} from '../../domains/leads/index.js';
import { toTenantId, type DbClient, type TenantId } from '../../lib/db/index.js';
import { forEachActiveTenant } from '../tenant-iterator.js';
import type { JobContext, JobHandler, JobResult } from '../types.js';
import { PartialSweepError } from './partial-sweep-error.js';

export const LEAD_INACTIVITY_EXPIRY_JOB_NAME = 'lead-inactivity-expiry';

export interface LeadInactivityExpiryOptions {
  /** Injected so tests are deterministic; production passes nothing and uses the wall clock. */
  readonly now?: Date | undefined;
  readonly batchSize?: number | undefined;
  readonly timeBudgetMs?: number | undefined;
  /**
   * The T-034 alert re-evaluation seam (closes F-032-2 for this sweep too).
   *
   * The reference reached the same behaviour by construction: `LeadInactivityExpiryJob` resolves
   * `LeadOperationExecutor` from the job scope and that executor enqueues the re-evaluation itself.
   * Passing a bare `{ db }` here would have dropped it invisibly.
   */
  readonly onLeadChanged?: LeadChangedListener | undefined;
}

export interface LeadInactivityExpirySweepResult {
  readonly counts: Record<string, number>;
  readonly failedTenantIds: number[];
}

const MS_PER_DAY = 86_400_000;

/**
 * The inactivity cutoff: `now - leadInactivityExpiryDays`, as an ISO instant.
 *
 * Exported and pure so `unit/expiry-thresholds.test.ts` can sweep it without a database. Day
 * arithmetic in milliseconds rather than by mutating a Date's date component: the latter is
 * calendar-aware and would silently shift the cutoff by an hour across a DST boundary in any
 * non-UTC process timezone, which is exactly the kind of one-hour error the boundary fixtures are
 * built to detect.
 */
export function inactivityThreshold(now: Date, days: number): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

function systemActor(tenantId: TenantId): {
  userId: null;
  tenantId: TenantId;
  access: null;
  isSystemActor: true;
} {
  return { userId: null, tenantId, access: null, isSystemActor: true };
}

/**
 * Expires one tenant's inactive leads.
 *
 * Settings are read FIRST here, unlike Job 1 — the reference's ordering
 * (`LeadInactivityExpiryJob.cs:72-75`), and unavoidable: the threshold IS the tenant setting, so
 * there is no candidate query to run without it. A tenant with no settings row therefore always
 * fails this sweep, where in Job 1 it fails only when it had work to do. That asymmetry is the
 * reference's and is preserved.
 */
async function expireForTenant(
  db: DbClient,
  tenantId: TenantId,
  now: Date,
  context: Pick<JobContext, 'logger'>,
  onLeadChanged: LeadChangedListener | undefined,
): Promise<{ leadsExpired: number; leadsFailed: number }> {
  // Throws for an unprovisioned tenant rather than falling back to defaults — see
  // `getTenantSettings`. Here that surfaces as a per-tenant sweep failure, which is what it is.
  const settings = await getTenantSettings(db, tenantId);

  const threshold = inactivityThreshold(now, settings.leadInactivityExpiryDays);
  const candidates = await listInactivityExpiredLeadCandidates(db, tenantId, threshold);
  if (candidates.length === 0) {
    return { leadsExpired: 0, leadsFailed: 0 };
  }

  const actor = systemActor(tenantId);
  const workflowDeps = onLeadChanged === undefined ? { db } : { db, onLeadChanged };
  let leadsExpired = 0;
  let leadsFailed = 0;

  for (const candidate of candidates) {
    try {
      await executeLeadOperation(
        workflowDeps,
        LEAD_EXPIRE_OPERATION,
        candidate.id,
        actor,
        () => Promise.resolve({ inputs: { reason: 'inactivity' } }),
      );
      leadsExpired += 1;
    } catch (error) {
      // One bad lead must not abandon the rest of the tenant's candidates.
      leadsFailed += 1;
      context.logger.warn('lead-inactivity-expiry could not expire lead', {
        tenantId: Number(tenantId),
        leadId: candidate.id,
        err: error,
      });
    }
  }

  return { leadsExpired, leadsFailed };
}

export async function runLeadInactivityExpirySweep(
  db: DbClient,
  context: Pick<JobContext, 'logger'>,
  options: LeadInactivityExpiryOptions = {},
): Promise<LeadInactivityExpirySweepResult> {
  const now = options.now ?? new Date();

  let leadsExpired = 0;
  let leadsFailed = 0;
  const failedTenantIds: number[] = [];

  const outcome = await forEachActiveTenant(
    db,
    async (tenant) => {
      const result = await expireForTenant(
        db,
        toTenantId(tenant.id),
        now,
        context,
        options.onLeadChanged,
      );

      leadsExpired += result.leadsExpired;
      leadsFailed += result.leadsFailed;

      context.logger.info('lead-inactivity-expiry swept tenant', {
        tenantId: tenant.id,
        leadsExpired: result.leadsExpired,
        leadsFailed: result.leadsFailed,
      });
    },
    {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
    },
  );

  for (const failure of outcome.failures) {
    failedTenantIds.push(failure.tenantId);
    context.logger.error('lead-inactivity-expiry failed for tenant', {
      tenantId: failure.tenantId,
      err: failure.error,
    });
  }

  return {
    counts: {
      tenantsProcessed: outcome.processed,
      tenantsFailed: outcome.failures.length,
      leadsExpired,
      leadsFailed,
      budgetExhausted: outcome.budgetExhausted ? 1 : 0,
    },
    failedTenantIds,
  };
}

export function createLeadInactivityExpiryHandler(
  db: DbClient,
  options: LeadInactivityExpiryOptions = {},
): JobHandler {
  return {
    name: LEAD_INACTIVITY_EXPIRY_JOB_NAME,

    async handle(_payload: unknown, context: JobContext): Promise<JobResult> {
      const { counts, failedTenantIds } = await runLeadInactivityExpirySweep(db, context, options);

      if (failedTenantIds.length > 0) {
        throw new PartialSweepError(LEAD_INACTIVITY_EXPIRY_JOB_NAME, failedTenantIds, counts);
      }

      return { counts };
    },
  };
}
