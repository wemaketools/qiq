/**
 * The PRD 15.4 Performance-Watchlist suggested action (T-037; AC-078).
 *
 * Port of `src/api/QuoteIQ.Domain/Dashboards/SuggestedActionRule.cs`.
 *
 * FLAGGED, INHERITED FROM THE REFERENCE: the PRD names these seven labels but not the thresholds
 * that select among them. The reference chose median-relative axis splits plus the tenant SLA
 * target and an overdue-count escalation threshold, and surfaced that choice for human review
 * rather than presenting it as derived. It is preserved verbatim here, including the threshold
 * value, because changing it would silently re-label every RM on a shipped screen.
 *
 * WHY THIS IS A PURE FUNCTION OVER ALREADY-AGGREGATED INPUTS
 * =========================================================
 * The rule is evaluated once per RM against tenant-wide medians, so it needs the whole population's
 * summary before it can judge one member. Keeping it free of I/O, tenant and clock is what lets the
 * boundary conditions — median-inclusive "high", strictly-greater "beyond target" — be asserted
 * directly instead of inferred from a seeded dashboard that only ever exercises one point per axis.
 */
import { compareMoney, type Money } from './money.js';

export const SUGGESTED_ACTIONS = [
  'maintainMomentum',
  'recognizeAndRetain',
  'deepenEngagement',
  'provideMoreLeads',
  'coachAndSupport',
  'escalateAndIntervene',
  'reviewRelationship',
] as const;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

/** One subject's standing relative to the tenant medians (`PerformanceProfile`). */
export interface PerformanceProfile {
  /** Won/decided conversion (0..1), or null when nothing has been decided. */
  readonly conversion: number | null;
  readonly conversionMedian: number;
  readonly volume: number;
  readonly volumeMedian: number;
  /** Money stays a decimal string; comparison goes through exact cents, never a double. */
  readonly wonPremium: Money;
  readonly wonPremiumMedian: Money;
  readonly avgTurnaroundDays: number | null;
  readonly turnaroundTargetDays: number;
  readonly overdueFollowUps: number;
}

/**
 * Overdue count at or above which weak conversion escalates from "coach" to "escalate"
 * (`SuggestedActionRule.OverdueEscalationThreshold`).
 */
export const OVERDUE_ESCALATION_THRESHOLD = 3;

/**
 * `SuggestedActionRule.Evaluate` (:75-108), evaluated worst-signal-first.
 *
 * A NULL conversion is treated as WEAK, matching `classifyQuadrant`. That is what puts an RM with
 * no decided business into the coach/review branch rather than the star branch — they may simply be
 * new, but the watchlist exists to surface who needs attention, and "no outcomes at all" qualifies.
 *
 * `turnaroundBeyondTarget` is STRICTLY greater (:80), the same comparison as `slaStatus` in
 * `metrics/index.ts`: an RM hitting the target exactly is compliant, not breaching.
 */
export function evaluateSuggestedAction(profile: PerformanceProfile): SuggestedAction {
  const highConversion = profile.conversion !== null && profile.conversion >= profile.conversionMedian;
  const highVolume = profile.volume >= profile.volumeMedian;
  const highWonPremium = compareMoney(profile.wonPremium, profile.wonPremiumMedian) >= 0;
  const turnaroundBeyondTarget =
    profile.avgTurnaroundDays !== null && profile.avgTurnaroundDays > profile.turnaroundTargetDays;
  const hasOverdue = profile.overdueFollowUps > 0;
  const manyOverdue = profile.overdueFollowUps >= OVERDUE_ESCALATION_THRESHOLD;

  // Weak conversion: order by how many things are going wrong at once.
  if (!highConversion) {
    if (manyOverdue || (turnaroundBeyondTarget && hasOverdue)) return 'escalateAndIntervene';
    return highVolume ? 'coachAndSupport' : 'reviewRelationship';
  }

  // Strong conversion on low volume: an efficient converter who is underutilized.
  if (!highVolume) return 'provideMoreLeads';

  // Strong on both axes: protect the relationship if service is slipping, else recognize it.
  if (turnaroundBeyondTarget || hasOverdue) return 'deepenEngagement';

  return highWonPremium ? 'recognizeAndRetain' : 'maintainMomentum';
}

const LABELS: Readonly<Record<SuggestedAction, string>> = {
  maintainMomentum: 'Maintain momentum',
  recognizeAndRetain: 'Recognize and retain',
  deepenEngagement: 'Deepen engagement',
  provideMoreLeads: 'Provide more leads',
  coachAndSupport: 'Coach and support',
  escalateAndIntervene: 'Escalate and intervene',
  reviewRelationship: 'Review relationship',
};

/** The chip tone token suffix — the SPA renders `qiq-chip--{tone}`. */
const TONES: Readonly<Record<SuggestedAction, string>> = {
  maintainMomentum: 'success',
  recognizeAndRetain: 'success',
  deepenEngagement: 'accent',
  provideMoreLeads: 'accent',
  coachAndSupport: 'warning',
  escalateAndIntervene: 'danger',
  reviewRelationship: 'neutral',
};

export function suggestedActionLabel(action: SuggestedAction): string {
  return LABELS[action];
}

export function suggestedActionTone(action: SuggestedAction): string {
  return TONES[action];
}

/**
 * Watchlist ordering rank (`GetRmPerformanceQueryHandler.SeverityRank`, :330-340): most-at-risk
 * first, so the row a manager must act on is the row at the top rather than an alphabetical
 * accident.
 */
const SEVERITY: Readonly<Record<SuggestedAction, number>> = {
  escalateAndIntervene: 6,
  coachAndSupport: 5,
  reviewRelationship: 4,
  provideMoreLeads: 3,
  deepenEngagement: 2,
  maintainMomentum: 1,
  recognizeAndRetain: 0,
};

export function suggestedActionSeverity(action: SuggestedAction): number {
  return SEVERITY[action];
}
