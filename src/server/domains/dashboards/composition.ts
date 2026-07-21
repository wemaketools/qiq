/**
 * Dashboard payload composition primitives (T-036).
 *
 * Port of the helpers `GetExecutiveOverviewQueryHandler.cs` and `GetPipelineDashboardQueryHandler.cs`
 * each defined privately and identically: period resolution, share rounding, lifecycle ordering,
 * age computation, trend labelling and the KPI card shape.
 *
 * WHY THESE ARE SHARED RATHER THAN COPIED, WHEN THE REFERENCE COPIED THEM
 * ======================================================================
 * The reference duplicates `ResolvePeriod`, `LifecycleOrder`, `AgeDays` and `Kpi` verbatim across
 * its two handlers. Duplicating them here would mean the Executive Overview and the Pipeline
 * dashboard could disagree about what "last month" is, or about where `closed_won` sits in the
 * lifecycle — and the two dashboards are read side by side, so a disagreement between them is
 * exactly the defect a user notices and cannot explain. There are two real consumers today, which
 * is the bar CLAUDE.md sets for extracting a seam at all.
 *
 * NOTHING HERE TOUCHES MONEY. Premium is `numeric(18,2)` handled as an exact decimal string by
 * `money.ts`; the only numbers below are counts, ratios and day differences.
 */
import { LEAD_STATUS_KEYS } from '../leads/workflow/legality.js';
import type { DashboardFilter } from './filters.js';
import type { GoodDirection, MetricKind } from './metrics/index.js';
import { isFavorableDelta, priorComparablePeriod, type DateRange, type DashboardPeriodKind } from './payload.js';

// ---------------------------------------------------------------------------------------------
// Date arithmetic on `yyyy-MM-dd` strings.
// ---------------------------------------------------------------------------------------------

/**
 * Every date below is handled as a `yyyy-MM-dd` STRING and every conversion pins UTC.
 *
 * `date` columns are read with an explicit `::text` cast rather than through node-postgres's Date
 * parsing, which materialises a `date` at LOCAL midnight — in any positive UTC offset
 * `toISOString().slice(0, 10)` then reports the PREVIOUS day, silently shifting a lead into the
 * wrong reporting month. Dashboards are month-bucketed by construction, so that off-by-one would
 * not crash anything; it would just move revenue between months.
 */
export function toUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const shifted = toUtcDate(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return toDateOnly(shifted);
}

export function addMonths(date: string, months: number): string {
  const source = toUtcDate(date);
  return toDateOnly(
    new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, source.getUTCDate())),
  );
}

export function firstOfMonth(date: string): string {
  const source = toUtcDate(date);
  return toDateOnly(new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), 1)));
}

/** The last day of the calendar month containing `date`, derived forward so month lengths hold. */
export function lastOfMonth(date: string): string {
  return addDays(addMonths(firstOfMonth(date), 1), -1);
}

/** `DateOnly.FromDateTime(DateTime.UtcNow)` — UTC, date only. */
export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `Math.Max(0, today.DayNumber - from.DayNumber)` — never negative, so a future date reads 0. */
export function ageDays(from: string, today: string): number {
  const days = Math.round((toUtcDate(today).getTime() - toUtcDate(from).getTime()) / 86_400_000);
  return Math.max(0, days);
}

export function inRange(date: string, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

// ---------------------------------------------------------------------------------------------
// Trend labels.
// ---------------------------------------------------------------------------------------------

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * `start.ToString("MMM yyyy")` and `end.ToString("MMM d")`, rendered from an explicit table.
 *
 * DELIBERATE DIVERGENCE FROM THE REFERENCE, which passes no culture and therefore formats in the
 * server's CURRENT culture. That makes the axis labels of a shipped chart depend on the host's
 * locale — the same deployment renders "Mar 2026" or "mars 2026" depending on where it runs, and
 * the SPA matches on those strings. Fixing the labels to English abbreviations makes the payload a
 * function of the data alone.
 */
export function monthLabel(date: string): string {
  const source = toUtcDate(date);
  return `${MONTH_ABBREVIATIONS[source.getUTCMonth()]} ${String(source.getUTCFullYear())}`;
}

export function dayLabel(date: string): string {
  const source = toUtcDate(date);
  return `${MONTH_ABBREVIATIONS[source.getUTCMonth()]} ${String(source.getUTCDate())}`;
}

// ---------------------------------------------------------------------------------------------
// Period resolution.
// ---------------------------------------------------------------------------------------------

/**
 * `ResolvePeriod` (GetExecutiveOverviewQueryHandler.cs:57-67, identical in the Pipeline handler).
 *
 * BOTH ends must be supplied for a custom period. A half-open filter (`from` with no `to`) falls
 * back to the current calendar month rather than running to today, which is measured behaviour:
 * a prior-period delta is only meaningful against a CLOSED window of known length.
 */
export function resolvePeriod(
  filter: DashboardFilter,
  today: string,
): { readonly period: DateRange; readonly kind: DashboardPeriodKind } {
  if (filter.from !== undefined && filter.to !== undefined) {
    return { period: { from: filter.from, to: filter.to }, kind: 'custom' };
  }
  return {
    period: { from: firstOfMonth(today), to: lastOfMonth(today) },
    kind: 'month',
  };
}

/** The active period paired with the window its deltas are measured against. */
export function resolvePeriods(
  filter: DashboardFilter,
  today: string,
): { readonly period: DateRange; readonly prior: DateRange } {
  const { period, kind } = resolvePeriod(filter, today);
  return { period, prior: priorComparablePeriod(period, kind) };
}

// ---------------------------------------------------------------------------------------------
// Share rounding.
// ---------------------------------------------------------------------------------------------

export const SHARE_SCALE = 4;
const SHARE_UNIT = 10 ** SHARE_SCALE;

/**
 * `Math.Round((decimal)count / total, 4)` — four decimal places, HALF TO EVEN, exactly as .NET's
 * decimal rounding defaults.
 *
 * Computed on integers rather than by rounding a double. `Math.round(count / total * 10000) / 10000`
 * would inherit the division's representation error before rounding and would round halves AWAY
 * from zero, so a share of exactly 0.03125 (1 of 32, entirely reachable) would render 0.0313 here
 * and 0.0312 in the reference. Shares are summed and compared against 1 by the charts, so a
 * systematic upward bias is visible.
 *
 * A zero or negative denominator yields 0 — the reference's `total == 0 ? 0m : ...` guard. This is
 * a SHARE OF A POPULATION, not a rate: an empty donut renders as an empty ring, not an em dash.
 */
export function roundShare(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;

  const scaled = numerator * SHARE_UNIT;
  const quotient = Math.floor(scaled / denominator);
  const remainder = scaled - quotient * denominator;
  const twiceRemainder = remainder * 2;

  let rounded = quotient;
  if (twiceRemainder > denominator) {
    rounded = quotient + 1;
  } else if (twiceRemainder === denominator) {
    rounded = quotient % 2 === 0 ? quotient : quotient + 1;
  }

  return rounded / SHARE_UNIT;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle ordering.
// ---------------------------------------------------------------------------------------------

/** The eleven guarded keys in lifecycle order (`LeadStatusKeys.All`). */
const LIFECYCLE_ORDER: readonly string[] = Object.values(LEAD_STATUS_KEYS);

/**
 * `LifecycleOrder` (:198-207): a status's position in the guarded lifecycle.
 *
 * A null key, or a custom key that is not one of the eleven, sorts to the END rather than the
 * beginning. That is deliberate and is what the reference does: a tenant's brand-new custom status
 * is NOT assumed to occupy a known lifecycle position, and sorting it first would put an unknown
 * stage at the top of the funnel where it would look like the entry point.
 */
export function lifecycleOrder(canonicalKey: string | null): number {
  if (canonicalKey === null) return LIFECYCLE_ORDER.length;
  const index = LIFECYCLE_ORDER.indexOf(canonicalKey);
  return index < 0 ? LIFECYCLE_ORDER.length : index;
}

/** Ordinal string comparison (`StringComparer.Ordinal`), the reference's tie-break for stage names. */
export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Lifecycle position first, then ordinal name — the stage ordering both dashboards use. */
export function compareStages(
  left: { readonly stageName: string; readonly stageCanonicalKey: string | null },
  right: { readonly stageName: string; readonly stageCanonicalKey: string | null },
): number {
  const byLifecycle = lifecycleOrder(left.stageCanonicalKey) - lifecycleOrder(right.stageCanonicalKey);
  return byLifecycle !== 0 ? byLifecycle : compareOrdinal(left.stageName, right.stageName);
}

// ---------------------------------------------------------------------------------------------
// The KPI card.
// ---------------------------------------------------------------------------------------------

/**
 * `ExecutiveKpiDto` / `PipelineKpiDto` — ONE shape, because they are one shape in the reference and
 * the SPA renders both dashboards through the same KPI row component.
 *
 * `leadOrQuote` is not decoration. CLAUDE.md requires every dashboard number to state whether it
 * counts Leads, Quotes or Premium, and a card reading "Total: 128" that does not say which is the
 * defect that ships and is believed.
 */
export interface DashboardKpiDto {
  readonly key: string;
  readonly label: string;
  readonly leadOrQuote: 'lead' | 'quote';
  readonly kind: MetricKind;
  readonly value: number | null;
  readonly delta: number | null;
  readonly goodDirection: GoodDirection;
  readonly isFavorableDelta: boolean | null;
  readonly drillWidgetKey: string;
}

export interface KpiInput {
  readonly key: string;
  readonly label: string;
  readonly leadOrQuote: 'lead' | 'quote';
  readonly kind: MetricKind;
  readonly value: number | null;
  /** The prior-period value, or null when this card is not period-comparable at all. */
  readonly prior?: number | null;
  readonly goodDirection: GoodDirection;
  readonly drillWidgetKey: string;
}

/**
 * Builds one KPI card (`Kpi(...)`, :117-124).
 *
 * The delta is null unless BOTH sides are present. A missing prior is not zero: rendering "+100%"
 * because last month had no decided business is worse than rendering nothing.
 */
export function buildKpi(input: KpiInput): DashboardKpiDto {
  const prior = input.prior ?? null;
  const delta = input.value !== null && prior !== null ? input.value - prior : null;

  return {
    key: input.key,
    label: input.label,
    leadOrQuote: input.leadOrQuote,
    kind: input.kind,
    value: input.value,
    delta,
    goodDirection: input.goodDirection,
    isFavorableDelta: isFavorableDelta(delta, input.goodDirection),
    drillWidgetKey: input.drillWidgetKey,
  };
}
