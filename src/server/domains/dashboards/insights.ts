/**
 * The PRD 15.2 Leadership Insights panel (T-037; AC-078).
 *
 * Port of `src/api/QuoteIQ.Domain/Dashboards/LeadershipInsightRules.cs`.
 *
 * FLAGGED, INHERITED FROM THE REFERENCE: the PRD names the five insight types but not their
 * selection rules. The reference selects the top broker by won premium, the underperforming RM by
 * lowest conversion (then most overdue), turnaround-at-risk by the slowest RM, and the largest
 * opportunity by open pipeline premium — surfaced for human review rather than presented as
 * derived. Preserved verbatim, narrative strings included: they are rendered text, so a reworded
 * narrative is a visible product change.
 *
 * EVERY PRODUCER RETURNS NULL ON AN EMPTY POPULATION, AND THAT IS WHY THE PANEL IS SAFE ON A NEW
 * TENANT. Only follow-up compliance is unconditional, because "nothing was due" is itself the
 * insight — an empty panel would read as a broken widget rather than as a quiet month.
 */
import { compareMoney, parseMoney, type Money } from './money.js';

export const LEADERSHIP_INSIGHT_TYPES = [
  'topPerformingBroker',
  'underperformingRm',
  'turnaroundAtRisk',
  'followUpCompliance',
  'largestPremiumOpportunity',
] as const;
export type LeadershipInsightType = (typeof LEADERSHIP_INSIGHT_TYPES)[number];

export interface LeadershipInsight {
  readonly type: LeadershipInsightType;
  readonly icon: string;
  readonly headline: string;
  readonly narrative: string;
}

/** One RM or broker, already aggregated by the dashboard service (`InsightSubject`). */
export interface InsightSubject {
  readonly name: string;
  readonly conversion: number | null;
  readonly volume: number;
  readonly wonPremium: Money;
  readonly avgTurnaroundDays: number | null;
  readonly overdueFollowUps: number;
  readonly openPipelinePremium: Money;
}

export interface LeadershipInsightContext {
  readonly rms: readonly InsightSubject[];
  readonly brokers: readonly InsightSubject[];
  readonly turnaroundTargetDays: number;
  readonly followUpCompliance: number | null;
  readonly currencyCode: string;
}

/**
 * `Currency` (:196-197): `{code} {amount:N0}` — grouped thousands, no decimals.
 *
 * Rounded on exact `bigint` cents rather than by `Number(amount).toFixed(0)`. The reference formats
 * a `decimal`, whose `N0` rounds half AWAY FROM ZERO; JavaScript's `toFixed` rounds a binary double
 * whose value may already not be the decimal that was stored. For a figure this is only cosmetic
 * until it is not — and this string is read by executives as the size of the opportunity.
 */
function currency(amount: Money, currencyCode: string): string {
  const cents = parseMoney(amount);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  // Half away from zero: add 50 cents before truncating toward zero.
  const units = (absolute + 50n) / 100n;
  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currencyCode} ${negative ? '-' : ''}${grouped}`;
}

/** `Percent` (:199-200): one decimal place, or `n/a` when the rate is undefined. */
function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

/** `Days` (:202): one decimal place. */
function days(value: number): string {
  return value.toFixed(1);
}

/** Ordinal string comparison, matching the reference's `StringComparer.Ordinal` tie-breaks. */
function byNameOrdinal(left: InsightSubject, right: InsightSubject): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function topPerformingBroker(context: LeadershipInsightContext): LeadershipInsight | null {
  const broker = [...context.brokers].sort(
    (left, right) =>
      compareMoney(right.wonPremium, left.wonPremium) ||
      (right.conversion ?? -1) - (left.conversion ?? -1) ||
      byNameOrdinal(left, right),
  )[0];

  // A broker who has won nothing is not a "top performer"; the panel omits the card entirely.
  if (broker === undefined || parseMoney(broker.wonPremium) <= 0n) return null;

  return {
    type: 'topPerformingBroker',
    icon: '★',
    headline: `Top performing broker: ${broker.name}`,
    narrative:
      `${broker.name} leads all brokers with ${currency(broker.wonPremium, context.currencyCode)} ` +
      `in won premium and ${percent(broker.conversion)} conversion.`,
  };
}

function underperformingRm(context: LeadershipInsightContext): LeadershipInsight | null {
  if (context.rms.length === 0) return null;

  // Weakest converter first. An RM with NOTHING decided sorts LAST here (`decimal.MaxValue`,
  // :126) — the opposite of how `classifyQuadrant` treats a null — because naming someone the
  // worst converter on the strength of having no outcomes yet is a claim the data does not support.
  const rm = [...context.rms].sort(
    (left, right) =>
      (left.conversion ?? Number.POSITIVE_INFINITY) - (right.conversion ?? Number.POSITIVE_INFINITY) ||
      right.overdueFollowUps - left.overdueFollowUps ||
      byNameOrdinal(left, right),
  )[0] as InsightSubject;

  return {
    type: 'underperformingRm',
    icon: '!',
    headline: `Underperforming RM: ${rm.name}`,
    narrative:
      `${rm.name} has the lowest conversion at ${percent(rm.conversion)} with ` +
      `${String(rm.overdueFollowUps)} overdue follow-up(s).`,
  };
}

function turnaroundAtRisk(context: LeadershipInsightContext): LeadershipInsight | null {
  const slowest = context.rms
    .filter((rm) => rm.avgTurnaroundDays !== null)
    .sort(
      (left, right) =>
        (right.avgTurnaroundDays as number) - (left.avgTurnaroundDays as number) ||
        byNameOrdinal(left, right),
    )[0];

  if (slowest === undefined) return null;

  const value = slowest.avgTurnaroundDays as number;
  const target = context.turnaroundTargetDays;
  // Strictly greater, the same breach comparison as `slaStatus` and `evaluateSuggestedAction`.
  const narrative =
    value > target
      ? `${slowest.name} averages ${days(value)} days to quote, over the ${days(target)}-day SLA target.`
      : `${slowest.name} has the slowest turnaround at ${days(value)} days, within the ${days(target)}-day SLA target.`;

  return {
    type: 'turnaroundAtRisk',
    icon: '⏱',
    headline: `Turnaround at risk: ${slowest.name}`,
    narrative,
  };
}

function followUpComplianceInsight(context: LeadershipInsightContext): LeadershipInsight {
  return {
    type: 'followUpCompliance',
    icon: '☑',
    headline: 'Follow-up compliance',
    narrative:
      context.followUpCompliance === null
        ? 'No follow-ups were due in this period.'
        : `Team follow-up compliance is ${percent(context.followUpCompliance)} of due follow-ups actioned on time.`,
  };
}

function largestPremiumOpportunity(context: LeadershipInsightContext): LeadershipInsight | null {
  const subject = [...context.rms].sort(
    (left, right) =>
      compareMoney(right.openPipelinePremium, left.openPipelinePremium) || byNameOrdinal(left, right),
  )[0];

  if (subject === undefined || parseMoney(subject.openPipelinePremium) <= 0n) return null;

  return {
    type: 'largestPremiumOpportunity',
    icon: '$',
    headline: `Largest premium opportunity: ${subject.name}`,
    narrative: `${subject.name} is working ${currency(subject.openPipelinePremium, context.currencyCode)} of open pipeline premium.`,
  };
}

/** `LeadershipInsightRules.Generate` (:64-95) — stable type order, empty populations omitted. */
export function generateLeadershipInsights(
  context: LeadershipInsightContext,
): LeadershipInsight[] {
  const insights: LeadershipInsight[] = [];

  const broker = topPerformingBroker(context);
  if (broker !== null) insights.push(broker);

  const rm = underperformingRm(context);
  if (rm !== null) insights.push(rm);

  const turnaround = turnaroundAtRisk(context);
  if (turnaround !== null) insights.push(turnaround);

  insights.push(followUpComplianceInsight(context));

  const opportunity = largestPremiumOpportunity(context);
  if (opportunity !== null) insights.push(opportunity);

  return insights;
}
