/**
 * Shared dashboard payload conventions (T-035; spec FR-54, §9.6, P-10).
 *
 * Port of `src/api/QuoteIQ.Application/Dashboards/KpiValue.cs` and `DashboardPeriod.cs`.
 *
 * Three things live here, and they are here rather than in each dashboard because every dashboard
 * must agree on them: what "the prior period" means for a given range shape, how a delta is
 * computed, and whether that delta is good news. Five dashboards each deriving "last month" for
 * themselves is five chances to disagree about February.
 */
import type { GoodDirection } from './metrics/index.js';

/** An INCLUSIVE `yyyy-MM-dd` range, both ends. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/**
 * How the active range was chosen, which is what decides the prior-period derivation
 * (`DashboardPeriodKind`). A month's predecessor is the previous calendar month; a custom range's
 * predecessor is the equal-length window immediately before it.
 */
export type DashboardPeriodKind = 'month' | 'quarter' | 'custom';

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const shifted = toUtc(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return toDateOnly(shifted);
}

/**
 * `PriorFullMonths` (DashboardPeriod.cs:57-62): the full calendar span `monthsBack` months before
 * the current range's START month, covering `spanMonths` whole months.
 *
 * It re-derives the END from the start rather than shifting the current end date, and that is the
 * entire point. Q2 ends 30 June; naively subtracting three months gives 30 March, silently
 * dropping 31 March from every quarterly comparison. Deriving forward from 1 January + 3 months -
 * 1 day gives Q1's true 31 March end. Same story for a February predecessor of a 31-day March.
 */
function priorFullMonths(current: DateRange, monthsBack: number, spanMonths: number): DateRange {
  const start = toUtc(current.from);
  const priorFrom = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - monthsBack, 1));
  const priorToExclusive = new Date(
    Date.UTC(priorFrom.getUTCFullYear(), priorFrom.getUTCMonth() + spanMonths, 1),
  );
  priorToExclusive.setUTCDate(priorToExclusive.getUTCDate() - 1);

  return { from: toDateOnly(priorFrom), to: toDateOnly(priorToExclusive) };
}

/** `PriorEqualLengthWindow` (DashboardPeriod.cs:64-70): shift back by the range's own day count. */
function priorEqualLengthWindow(current: DateRange): DateRange {
  const lengthDays =
    Math.round((toUtc(current.to).getTime() - toUtc(current.from).getTime()) / 86_400_000) + 1;
  const priorTo = addDays(current.from, -1);
  return { from: addDays(priorTo, -(lengthDays - 1)), to: priorTo };
}

/**
 * The period a KPI delta is measured against (`DashboardPeriod.PriorComparablePeriod`).
 *
 * The month and quarter branches ASSUME the current range is already a whole month/quarter, which
 * every dashboard period of that kind is by construction — the kind is chosen by whatever built
 * the range, not inferred from the dates.
 */
export function priorComparablePeriod(current: DateRange, kind: DashboardPeriodKind): DateRange {
  switch (kind) {
    case 'month':
      return priorFullMonths(current, 1, 1);
    case 'quarter':
      return priorFullMonths(current, 3, 3);
    default:
      return priorEqualLengthWindow(current);
  }
}

/**
 * The period-over-period delta, or null when either side is missing.
 *
 * Null propagates ON PURPOSE. A missing prior value is not zero: rendering "+100%" because last
 * month had no decided business is worse than rendering nothing, and the reference's
 * `current is not null && prior is not null` guard says so.
 */
export function kpiDelta(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  return current - prior;
}

/**
 * Whether a delta should render in the favourable colour (`KpiValue.IsFavorableDelta`).
 *
 * TRI-STATE, not boolean: a delta of exactly 0 returns null, not false. Zero movement is neither
 * good nor bad and renders uncoloured — collapsing it to `false` would paint every flat KPI red.
 */
export function isFavorableDelta(
  delta: number | null,
  goodDirection: GoodDirection,
): boolean | null {
  if (delta === null || delta === 0) return null;
  return delta > 0 ? goodDirection === 'higherIsBetter' : goodDirection === 'lowerIsBetter';
}

/**
 * The currency metadata every dashboard payload carries (NFR-08/A-3).
 *
 * MEASURED CONTRADICTION AGAINST THE TASK BRIEF. T-035's scope names "generatedAt timestamp,
 * tenant display-currency metadata" as the payload convention. Only the SECOND half exists in the
 * reference: every dashboard DTO carries `CurrencyCode` (ExecutiveOverviewDto.cs:77,
 * PipelineDashboardDto.cs:103, BrokerPerformanceDto.cs:85, RmPerformanceDto.cs:110,
 * LossAnalysisDto.cs:78) and NONE carries a generated-at timestamp — `GeneratedAt` appears only on
 * export and report-view metadata (ExportDocument.cs:33), never on a dashboard, and the SPA reads
 * no such field. Adding one would be a new wire field no consumer asked for, so it is FLAGGED for
 * the orchestrator rather than invented here.
 */
export interface DashboardCurrencyPayload {
  readonly currencyCode: string;
}

export function currencyPayload(currencyCode: string): DashboardCurrencyPayload {
  return { currencyCode };
}
