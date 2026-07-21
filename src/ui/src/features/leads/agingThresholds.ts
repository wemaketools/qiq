/**
 * Age-column coloring thresholds (spec FR-43, A-12): "amber >= tenant aging_amber_days, red >=
 * tenant aging_red_days" — these are per-tenant business rules (`FullBusinessRulesDto.agingAmberDays`/
 * `agingRedDays`, `src/api/.../BusinessRules/BusinessRulesDto.cs`, T-010).
 *
 * The gap T-027 flagged here (the rules read was gated by `business_rules.view`, so most Leads
 * users could only ever use these defaults) was resolved on 2026-07-13 (T-044):
 * `GET /settings/business-rules` is now a membership-only read, so screens fetch the tenant's real
 * thresholds via `fetchFullBusinessRules()` and use these constants only as the A-12 fallback
 * ("amber >= 8 days, red >= 15 days ... when a tenant has not configured its own") while loading
 * or if the fetch fails.
 */
export const DEFAULT_AGING_AMBER_DAYS = 8;
export const DEFAULT_AGING_RED_DAYS = 15;

export type AgeSeverity = 'normal' | 'amber' | 'red';

export function resolveAgeSeverity(
  ageDays: number,
  agingAmberDays: number = DEFAULT_AGING_AMBER_DAYS,
  agingRedDays: number = DEFAULT_AGING_RED_DAYS,
): AgeSeverity {
  if (ageDays >= agingRedDays) {
    return 'red';
  }
  if (ageDays >= agingAmberDays) {
    return 'amber';
  }
  return 'normal';
}
