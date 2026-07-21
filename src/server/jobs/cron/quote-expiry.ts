/**
 * Job 1 — the hourly quote-expiry sweep (T-032; AC-066, AC-067, AC-068, AC-072; V-083, V-090).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Jobs/QuoteExpiryJob.cs`.
 *
 * ============================================================================================
 * JOB CONTRACT (spec §9.5's required documentation for every recurring job)
 * ============================================================================================
 *   NAME              quote-expiry
 *   SCHEDULE          hourly on the hour — pg_cron `0 * * * *` -> pg_net -> GET /api/cron/quote-expiry.
 *                     Locally, `npm run cron:run -- quote-expiry` through the same object graph.
 *   PURPOSE           Move every Sent/Revised quote whose `valid_until` has passed to Expired, and —
 *                     only when the tenant has opted in — expire the parent lead once its last open
 *                     quote has gone. With Job 2 these are the ONLY automatic status changes in the
 *                     product (P-07).
 *   IDEMPOTENCY KEY   NONE, and deliberately so. The sweep is STATE-GUARDED: its candidate query
 *                     selects only quotes CURRENTLY in Sent/Revised past valid_until, and expiring
 *                     one removes it from that set. A second run therefore selects nothing and
 *                     writes nothing — no second status change, no second history row, no second
 *                     audit entry. A missed tick self-heals on the next one. An idempotency key
 *                     would add a way to fail without removing a single duplicate, because the
 *                     duplicate is already impossible.
 *   RETRY BEHAVIOUR   Safe at any time, including concurrent and duplicate delivery. Each quote is
 *                     expired in its OWN transaction, which re-reads the quote and re-checks the
 *                     legality matrix inside that transaction — so two overlapping runs cannot both
 *                     expire the same quote: the loser finds it already Expired and the matrix
 *                     rejects `expire_automatic` from Expired.
 *   FAILURE HANDLING  PER-TENANT, and per-quote within a tenant. One tenant throwing does not stop
 *                     the sweep (AC-072); one quote failing does not abandon the rest of its
 *                     tenant's candidates — it is logged and skipped, exactly as the reference did.
 *                     The run reports FAILED with the failing tenant ids and partial counts.
 *   DATABASE STATE    Reads quotes/reference_items/tenant_settings/leads; writes quotes.status_id,
 *                     quote_status_history, leads (status + last_activity_at), lead_status_history
 *                     and audit_log — all through the shared workflow executors, never by hand.
 *   OBSERVABILITY     One structured log line per tenant (tenant id + counts, never a business
 *                     field), a warning per quote that failed to expire, and aggregate counts on the
 *                     job_run row.
 *
 * IT NEVER WRITES A STATUS COLUMN ITSELF
 * ======================================
 * Every transition goes through `executeQuoteOperation` / `executeLeadOperation` — the same engine
 * every human-invoked operation uses — so legality, history and audit cannot be skipped by the one
 * caller that has no user watching. The reference made the same choice explicitly
 * (`QuoteExpiryJob.cs:94-98`), and it is why the automatic expiry needed a matrix row rather than an
 * UPDATE statement.
 */
import { getTenantSettings } from '../../domains/business-rules/index.js';
import {
  LEAD_EXPIRE_OPERATION,
  executeLeadOperation,
  type LeadChangedListener,
} from '../../domains/leads/index.js';
import {
  QUOTE_EXPIRE_OPERATION,
  listExpiredQuoteCandidates,
  listOtherOpenQuotes,
  executeQuoteOperation,
} from '../../domains/quotes/index.js';
import { toTenantId, type DbClient, type TenantId } from '../../lib/db/index.js';
import { forEachActiveTenant } from '../tenant-iterator.js';
import type { JobContext, JobHandler, JobResult } from '../types.js';
import { PartialSweepError } from './partial-sweep-error.js';

export const QUOTE_EXPIRY_JOB_NAME = 'quote-expiry';

export interface QuoteExpiryOptions {
  /** Injected so tests are deterministic; production passes nothing and uses the wall clock. */
  readonly now?: Date | undefined;
  /** Bounds the tenant page size; the default lives in the tenant iterator. */
  readonly batchSize?: number | undefined;
  /** Stops starting new tenants once the Vercel invocation budget is spent. */
  readonly timeBudgetMs?: number | undefined;
  /**
   * The T-034 alert re-evaluation seam, threaded into the workflow executors this sweep drives
   * (closes F-032-2 / AC-066's "alerts are refreshed").
   *
   * MEASURED AGAINST THE REFERENCE: `QuoteExpiryJob` resolves `QuoteOperationExecutor` and
   * `LeadOperationExecutor` from the job scope, and BOTH of those executors call
   * `IAlertReevaluationQueue.EnqueueLeadReevaluationAsync` after they commit. So in .NET an
   * automatic expiry refreshed the lead's alerts through exactly this seam. Constructing the
   * executor deps as a bare `{ db }` here would have dropped that behaviour silently — the sweep
   * would still expire everything correctly and the alerts would simply lag by up to 15 minutes.
   *
   * Optional, because a sweep with no seam is still CORRECT: the every-15-minute alert-evaluation
   * job converges the same set. This makes the clearing prompt, not possible.
   */
  readonly onLeadChanged?: LeadChangedListener | undefined;
}

export interface QuoteExpirySweepResult {
  readonly counts: Record<string, number>;
  readonly failedTenantIds: number[];
}

/** The system actor: no user, no grants, and the only caller the executors let skip permissions. */
function systemActor(tenantId: TenantId): {
  userId: null;
  tenantId: TenantId;
  access: null;
  isSystemActor: true;
} {
  return { userId: null, tenantId, access: null, isSystemActor: true };
}

/**
 * Expires one tenant's due quotes. Returns the counts so the caller can aggregate them.
 *
 * The ORDER of the two reads matters and is the reference's (`QuoteExpiryJob.cs:82-88`): candidates
 * FIRST, tenant settings only if there is at least one. A tenant with no settings row is a
 * provisioning fault, but one with nothing to expire must not be turned into a sweep failure over a
 * setting the run was never going to read.
 */
async function expireForTenant(
  db: DbClient,
  tenantId: TenantId,
  today: string,
  context: Pick<JobContext, 'logger'>,
  onLeadChanged: LeadChangedListener | undefined,
): Promise<{ quotesExpired: number; leadsExpired: number; quotesFailed: number }> {
  // Built ONCE per tenant and shared by both executors below, so the quote expiry and its lead
  // cascade cannot end up wired differently.
  const workflowDeps = onLeadChanged === undefined ? { db } : { db, onLeadChanged };
  const candidates = await listExpiredQuoteCandidates(db, tenantId, today);
  if (candidates.length === 0) {
    return { quotesExpired: 0, leadsExpired: 0, quotesFailed: 0 };
  }

  // Throws for an unprovisioned tenant rather than falling back to defaults — see
  // `getTenantSettings`. Here that surfaces as a per-tenant sweep failure, which is what it is.
  const settings = await getTenantSettings(db, tenantId);

  const actor = systemActor(tenantId);
  let quotesExpired = 0;
  let leadsExpired = 0;
  let quotesFailed = 0;

  for (const candidate of candidates) {
    try {
      await executeQuoteOperation(
        workflowDeps,
        QUOTE_EXPIRE_OPERATION,
        candidate.id,
        actor,
        () => Promise.resolve({ inputs: { reason: 'past_valid_until' } }),
      );
      quotesExpired += 1;
    } catch (error) {
      // One bad quote must not abandon the rest of the tenant's candidates.
      quotesFailed += 1;
      context.logger.warn('quote-expiry could not expire quote', {
        tenantId: Number(tenantId),
        quoteId: candidate.id,
        err: error,
      });
      continue;
    }

    if (!settings.expireLeadWhenLastQuoteExpires) continue;

    // PRD 10.4's quote Expire row: expire the LEAD too, but only if nothing else is still open on
    // it. Read AFTER the quote committed, so the quote just expired is already out of the open set.
    try {
      const otherOpen = await listOtherOpenQuotes(db, tenantId, candidate.leadId, candidate.id);
      if (otherOpen.length > 0) continue;

      await executeLeadOperation(
        workflowDeps,
        LEAD_EXPIRE_OPERATION,
        candidate.leadId,
        actor,
        () => Promise.resolve({ inputs: { reason: 'last_open_quote_expired' } }),
      );
      leadsExpired += 1;
    } catch (error) {
      context.logger.warn('quote-expiry could not cascade lead expiry', {
        tenantId: Number(tenantId),
        leadId: candidate.leadId,
        err: error,
      });
    }
  }

  return { quotesExpired, leadsExpired, quotesFailed };
}

/**
 * Runs the sweep across every active tenant. Exported separately from the handler so tests can drive
 * it with a real client and assert per-tenant behaviour without the job_run plumbing.
 */
export async function runQuoteExpirySweep(
  db: DbClient,
  context: Pick<JobContext, 'logger'>,
  options: QuoteExpiryOptions = {},
): Promise<QuoteExpirySweepResult> {
  // Tenant-local "today" is modelled as the UTC date (`DateOnly.FromDateTime(DateTime.UtcNow)`).
  // The reference flags this as an MVP simplification — no per-tenant timezone column exists in
  // spec §11.2's tenant_settings — and that flag is inherited rather than silently resolved.
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);

  let quotesExpired = 0;
  let leadsExpired = 0;
  let quotesFailed = 0;
  const failedTenantIds: number[] = [];

  const outcome = await forEachActiveTenant(
    db,
    async (tenant) => {
      const result = await expireForTenant(
        db,
        toTenantId(tenant.id),
        today,
        context,
        options.onLeadChanged,
      );

      quotesExpired += result.quotesExpired;
      leadsExpired += result.leadsExpired;
      quotesFailed += result.quotesFailed;

      // Ids and counts only — never a quote ref, a party name or a premium (§15).
      context.logger.info('quote-expiry swept tenant', {
        tenantId: tenant.id,
        quotesExpired: result.quotesExpired,
        leadsExpired: result.leadsExpired,
        quotesFailed: result.quotesFailed,
      });
    },
    {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
    },
  );

  for (const failure of outcome.failures) {
    failedTenantIds.push(failure.tenantId);
    context.logger.error('quote-expiry failed for tenant', {
      tenantId: failure.tenantId,
      err: failure.error,
    });
  }

  return {
    counts: {
      tenantsProcessed: outcome.processed,
      tenantsFailed: outcome.failures.length,
      quotesExpired,
      leadsExpired,
      quotesFailed,
      budgetExhausted: outcome.budgetExhausted ? 1 : 0,
    },
    failedTenantIds,
  };
}

/**
 * The registrable handler.
 *
 * A FACTORY over an explicit client rather than a bare object reading `context.db`: the sweep opens
 * its own transactions (one per quote, via the executors), and `JobContext.db` is typed as an
 * executor that may already be inside one. Production passes the same process-wide client, so there
 * is no second connection — the type now just states what the handler actually requires.
 */
export function createQuoteExpiryHandler(
  db: DbClient,
  options: QuoteExpiryOptions = {},
): JobHandler {
  return {
    name: QUOTE_EXPIRY_JOB_NAME,

    async handle(_payload: unknown, context: JobContext): Promise<JobResult> {
      const { counts, failedTenantIds } = await runQuoteExpirySweep(db, context, options);

      if (failedTenantIds.length > 0) {
        throw new PartialSweepError(QUOTE_EXPIRY_JOB_NAME, failedTenantIds, counts);
      }

      return { counts };
    },
  };
}
