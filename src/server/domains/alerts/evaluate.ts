/**
 * Alert reconciliation (T-033; AC-069, AC-072; V-086, V-090; spec §9.5 Job 3).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Jobs/AlertReconciler.cs`.
 *
 * WHAT RECONCILIATION MEANS, AND WHY IT IS NOT "RAISE ALERTS"
 * ==========================================================
 * The rules describe a SET: the alerts that should exist right now for this tenant. This function
 * makes the `alerts` table match that set — inserting what is missing and resolving what is no
 * longer matched. It never appends.
 *
 * That framing is the whole idempotency story, and it is a property of the ALGORITHM rather than of
 * any bookkeeping:
 *
 *   - Run it twice with unchanged data and the second run computes the same set, finds every member
 *     already present and nothing unmatched, and writes nothing. Convergent by construction.
 *   - A duplicate cron delivery is therefore a no-op, which is why the sweeps need no idempotency
 *     key (`run-cron-job.ts` says exactly this) and why a missed tick is survivable — the next tick
 *     re-derives the truth rather than replaying a backlog of events.
 *   - Even two OVERLAPPING runs cannot double-insert: `insertAlertCandidate` conflicts on the
 *     partial unique index and reports "not created", so `created` counts rows that really appeared.
 *
 * RESOLUTION IS THE HALF THAT IS EASY TO FORGET
 * =============================================
 * An alerts system that only creates is a system that only grows. Completing the workflow action an
 * alert asked for (assigning the lead, logging the follow-up) changes the underlying record so the
 * rule stops matching — and the NEXT evaluation is what turns that into a cleared alert. That is
 * the mechanism behind "completing the action clears or downgrades the alert" (FR-62): there is no
 * separate clearing code path to keep in step with the rules, which is precisely the point.
 *
 * SCOPED EVALUATION IS THE SAME FUNCTION, NARROWED
 * ================================================
 * `evaluateForLead` narrows BOTH sides of the diff — candidates and open alerts — to one lead.
 * Narrowing only the candidate side would compute an empty match set for every other lead in the
 * tenant and resolve their alerts wholesale, which is the single worst bug available in this file.
 */
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { evaluateAllRules, type AlertCandidate } from './rules/index.js';
import {
  buildEvaluationContext,
  insertAlertCandidate,
  listOpenAlerts,
  loadAlertThresholds,
  resolveAlerts,
} from './repository.js';

export interface ReconcileOptions {
  /** Narrows the whole reconciliation to one lead (the post-workflow-action re-evaluation). */
  readonly onlyLeadId?: number | undefined;
  /** Injected so tests are deterministic; production passes nothing and gets `new Date()`. */
  readonly now?: Date | undefined;
}

export interface ReconcileResult {
  readonly tenantId: number;
  /** Alerts inserted by THIS run (a conflict with a concurrent run does not count). */
  readonly created: number;
  /** Open alerts whose rule stopped matching, closed with `resolved_reason = 'rule_cleared'`. */
  readonly resolved: number;
  /** Size of the rule-match set — the number of alerts that SHOULD be open in scope. */
  readonly matched: number;
}

/** `(type, lead, quote)` — the same key the open-alert uniqueness index is built on. */
function keyOf(candidate: { type: string; leadId: number; quoteId: number | null }): string {
  return `${candidate.type}:${String(candidate.leadId)}:${String(candidate.quoteId ?? 0)}`;
}

/**
 * Reconciles one tenant's alerts against the rule-match set.
 *
 * The caller supplies the executor, which is how "one tenant per unit of work" is enforced: the
 * cron handler opens a transaction PER TENANT and passes it here, so no unit of work can span two
 * tenants and one tenant's failure rolls back only its own writes.
 */
export async function reconcileTenantAlerts(
  executor: DbExecutor,
  tenantId: TenantId,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();

  const thresholds = await loadAlertThresholds(executor, tenantId);
  const context = await buildEvaluationContext(executor, tenantId, thresholds, {
    onlyLeadId: options.onlyLeadId,
    now,
  });

  // De-duplicated defensively. The rules are unit-tested not to emit a repeated key, but a single
  // duplicate here would attempt a second insert that the uniqueness index rejects, and `created`
  // would then under-report rather than fail loudly.
  const candidates = new Map<string, AlertCandidate>();
  for (const candidate of evaluateAllRules(context)) {
    candidates.set(keyOf(candidate), candidate);
  }

  const openAlerts = await listOpenAlerts(executor, tenantId, options.onlyLeadId);
  const openKeys = new Set(openAlerts.map((alert) => keyOf(alert)));

  let created = 0;
  for (const [key, candidate] of candidates) {
    if (openKeys.has(key)) continue;
    if (await insertAlertCandidate(executor, tenantId, candidate, now)) created += 1;
  }

  const clearedIds = openAlerts
    .filter((alert) => !candidates.has(keyOf(alert)))
    .map((alert) => alert.id);
  const resolved = await resolveAlerts(executor, tenantId, clearedIds, now);

  return { tenantId, created, resolved, matched: candidates.size };
}

/**
 * The scoped re-evaluation fired after a workflow operation touches one lead (T-034 wires the
 * trigger; this is the unit it invokes). Identical semantics, narrowed to that lead.
 */
export async function evaluateForLead(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  options: Omit<ReconcileOptions, 'onlyLeadId'> = {},
): Promise<ReconcileResult> {
  return await reconcileTenantAlerts(executor, tenantId, { ...options, onlyLeadId: leadId });
}
