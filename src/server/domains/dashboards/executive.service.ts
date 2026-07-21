/**
 * The Executive Overview dashboard payload (T-036; AC-022, AC-074, AC-075, AC-077, AC-079;
 * V-027, V-092, V-093, V-094, V-096, V-097, V-100; spec FR-55, P-10).
 *
 * Port of `GetExecutiveOverviewQueryHandler.cs`, with the wire shape pinned against the SPA's
 * `src/ui/src/features/dashboards/executiveApi.ts`.
 *
 * NINE KPI CARDS, THREE CHARTS, ONE TABLE, ONE PANEL
 * =================================================
 * Every formula is delegated to `metrics/index.ts` rather than re-derived here (AC-080's
 * single-home rule): if the ratio lived inline, "the endpoint agrees with the metric definition"
 * would be unfalsifiable because the endpoint WOULD BE the definition.
 *
 * THE AGING DONUT USES THE **EXECUTIVE** FOUR-BUCKET SCHEME
 * ========================================================
 * `0-3 days / 4-7 days / 8-14 days / 15+ days` (:230-233). The Pipeline dashboard uses a DIFFERENT
 * six-bucket scheme ending `60+`. T-035 ported both under distinct names precisely so they could
 * not be conflated, and this task owns both dashboards — so this module imports
 * `EXECUTIVE_AGING_BUCKETS` by name and never spells the labels out.
 *
 * MONEY NEVER PASSES THROUGH A DOUBLE UNTIL THE LAST LINE
 * ======================================================
 * Every premium is summed as exact `bigint` cents by `money.ts`. `Number(...)` appears only in
 * `toWireAmount`, at the DTO boundary, because the SPA's contract is a JSON number. Summing first
 * and widening once is the difference between an exact total and one that is wrong in the cents.
 */
import { getAlertSummary } from '../alerts/service.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import {
  ageDays,
  buildKpi,
  compareStages,
  dayLabel,
  addDays,
  addMonths,
  firstOfMonth,
  inRange,
  monthLabel,
  resolvePeriods,
  roundShare,
  todayUtc,
  type DashboardKpiDto,
} from './composition.js';
import type { DashboardFilter } from './filters.js';
import {
  EXECUTIVE_AGING_BUCKETS,
  averageTurnaroundDays,
  boundPremiumTotal,
  conversionRate,
  leadToQuoteRate,
  openPipelinePremium,
  type ExecutiveAgingBucket,
  type TurnaroundPair,
} from './metrics/index.js';
import { ZERO_MONEY, compareMoney, sumMoney, type Money } from './money.js';
import type { DateRange } from './payload.js';
import {
  isOpenCategory,
  loadDashboardSettings,
  loadDashboardSnapshot,
  type DashboardCaller,
  type DashboardSnapshot,
  type SnapshotLead,
  type SnapshotQuote,
} from './snapshot.js';

// ---------------------------------------------------------------------------------------------
// Drill widget keys (`ExecutiveWidgetKeys.cs`).
// ---------------------------------------------------------------------------------------------

export const EXECUTIVE_WIDGET_KEYS = {
  allLeads: 'exec.leads',
  quoted: 'exec.quotes',
  openPipeline: 'exec.open_pipeline',
  won: 'exec.won',
  lost: 'exec.lost',
  highValue: 'exec.high_value',
  atRisk: 'exec.at_risk',
} as const;

// ---------------------------------------------------------------------------------------------
// The wire contract (`ExecutiveOverviewDto.cs`, `executiveApi.ts`).
// ---------------------------------------------------------------------------------------------

export interface ExecutivePipelineStageDto {
  readonly stageName: string;
  readonly stageCanonicalKey: string | null;
  readonly openCount: number;
  readonly shareOfOpen: number;
  readonly drillWidgetKey: string;
}

export interface ExecutiveAgingBucketDto {
  readonly bucket: ExecutiveAgingBucket;
  readonly count: number;
  readonly share: number;
}

export interface ExecutiveAgingDto {
  readonly buckets: readonly ExecutiveAgingBucketDto[];
  readonly totalOpenQuotes: number;
  readonly drillWidgetKey: string;
}

export interface ExecutiveTrendPointDto {
  readonly label: string;
  readonly wonPremium: number;
  readonly lostPremium: number;
}

export interface ExecutiveTrendDto {
  readonly weekly: readonly ExecutiveTrendPointDto[];
  readonly monthly: readonly ExecutiveTrendPointDto[];
  readonly drillWidgetKey: string;
}

export interface ExecutiveHighValueRowDto {
  readonly leadId: number;
  readonly leadRef: string;
  readonly clientName: string;
  readonly partyType: string;
  readonly brokerName: string | null;
  readonly productLineName: string;
  readonly premium: number;
  readonly stageName: string;
  readonly stageReportingCategory: string;
  readonly nextFollowUpDate: string | null;
  readonly ownerName: string | null;
  readonly riskFlag: boolean;
}

export interface ExecutiveAttentionRowDto {
  readonly category: string;
  readonly name: string;
  readonly definition: string;
  readonly tab: string | null;
  readonly count: number;
}

/**
 * The full payload.
 *
 * There is NO `generatedAt` field, and its absence is deliberate: T-036's scope names a
 * "generatedAt footer timestamp", but no dashboard DTO in the reference carries one
 * (`ExecutiveOverviewDto.cs:76-83`), `GeneratedAt` lives only on export/report metadata, and the
 * SPA's own `ExecutiveOverviewDto` declares no such field. Adding it would widen a preserved wire
 * contract (A-3) with a field no consumer reads. FLAGGED, not invented.
 */
export interface ExecutiveOverviewDto {
  readonly currencyCode: string;
  readonly kpis: readonly DashboardKpiDto[];
  readonly pipelineByStage: readonly ExecutivePipelineStageDto[];
  readonly openQuotesAging: ExecutiveAgingDto;
  readonly wonVsLostTrend: ExecutiveTrendDto;
  readonly highValueOpportunities: readonly ExecutiveHighValueRowDto[];
  readonly requiresAttention: readonly ExecutiveAttentionRowDto[];
}

export interface DashboardServiceDeps {
  readonly db: DbExecutor;
}

export interface DashboardActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  /**
   * The caller's `leads.view_all` grant, resolved server-side by the route (T-050, AC-076).
   *
   * It narrows the AGGREGATE, not only the drill: a dashboard number a user cannot reconcile by
   * drilling into it is worse than a smaller, honest one.
   */
  readonly canViewAllLeads: boolean;
}

/** The breadth facts every dashboard load passes down to its queries. */
export function callerOf(actor: DashboardActor): DashboardCaller {
  return { callerUserId: actor.userId, callerHasViewAll: actor.canViewAllLeads };
}

/** Money -> the JSON number the SPA contract requires. The LAST place a premium is widened. */
function toWireAmount(value: Money): number {
  return Number(value);
}

// ---------------------------------------------------------------------------------------------
// Population helpers.
// ---------------------------------------------------------------------------------------------

function openLeadsOf(snapshot: DashboardSnapshot): readonly SnapshotLead[] {
  return snapshot.leads.filter((lead) => isOpenCategory(lead.reportingCategory));
}

function openQuotesOf(snapshot: DashboardSnapshot): readonly SnapshotQuote[] {
  return snapshot.quotes.filter((quote) => isOpenCategory(quote.reportingCategory));
}

function decisionInRange(quote: SnapshotQuote, range: DateRange): boolean {
  return quote.decisionDate !== null && inRange(quote.decisionDate, range);
}

/** Won premium: the BOUND amount, falling back to the quoted one (`:136-137`). */
function wonPremiumIn(snapshot: DashboardSnapshot, range: DateRange): Money {
  return boundPremiumTotal(
    snapshot.quotes
      .filter((quote) => quote.reportingCategory === 'won' && decisionInRange(quote, range))
      .map((quote) => ({ boundPremium: quote.boundPremium, currentPremium: quote.currentPremium })),
  );
}

/** Lost premium is the QUOTED amount: nothing was bound, so there is no bound figure to prefer. */
function lostPremiumIn(snapshot: DashboardSnapshot, range: DateRange): Money {
  return sumMoney(
    snapshot.quotes
      .filter((quote) => quote.reportingCategory === 'lost' && decisionInRange(quote, range))
      .map((quote) => quote.currentPremium),
  );
}

function countLeadsReceived(snapshot: DashboardSnapshot, range: DateRange): number {
  return snapshot.leads.filter((lead) => inRange(lead.dateReceived, range)).length;
}

function countQuotesPrepared(snapshot: DashboardSnapshot, range: DateRange): number {
  return snapshot.quotes.filter((quote) => inRange(quote.preparedDate, range)).length;
}

/** Won over DECIDED (won + lost). Expired/withdrawn carry a decision date but are not decided. */
function conversionRateIn(snapshot: DashboardSnapshot, range: DateRange): number | null {
  const won = snapshot.quotes.filter(
    (quote) => quote.reportingCategory === 'won' && decisionInRange(quote, range),
  ).length;
  const lost = snapshot.quotes.filter(
    (quote) => quote.reportingCategory === 'lost' && decisionInRange(quote, range),
  ).length;
  return conversionRate(won, won + lost);
}

/** Mean days from lead received to quote sent, over quotes SENT inside the window. */
function averageTurnaroundIn(snapshot: DashboardSnapshot, range: DateRange): number | null {
  const pairs: TurnaroundPair[] = snapshot.quotes
    .filter((quote) => quote.sentDate !== null && inRange(quote.sentDate, range))
    .map((quote) => ({ receivedDate: quote.leadDateReceived, sentDate: quote.sentDate as string }));
  return averageTurnaroundDays(pairs);
}

/** LEADS that received a quote over eligible LEADS. A lead with three quotes still counts once. */
function leadToQuoteRateIn(snapshot: DashboardSnapshot, range: DateRange): number | null {
  const eligible = snapshot.leads.filter((lead) => inRange(lead.dateReceived, range));
  return leadToQuoteRate(eligible.filter((lead) => lead.hasQuote).length, eligible.length);
}

/** Open pipeline: open quotes' premium PLUS open leads that have no quote yet — never both. */
function openPipelineOf(snapshot: DashboardSnapshot): Money {
  const openQuotePremium = sumMoney(openQuotesOf(snapshot).map((quote) => quote.currentPremium));
  const openLeadEstimated = sumMoney(
    openLeadsOf(snapshot)
      .filter((lead) => !lead.hasQuote)
      .map((lead) => lead.estimatedPremium ?? ZERO_MONEY),
  );
  return openPipelinePremium(openQuotePremium, openLeadEstimated);
}

// ---------------------------------------------------------------------------------------------
// Widgets.
// ---------------------------------------------------------------------------------------------

function buildKpis(snapshot: DashboardSnapshot, period: DateRange, prior: DateRange): DashboardKpiDto[] {
  return [
    buildKpi({
      key: 'total_quotes',
      label: 'Total Quotes',
      leadOrQuote: 'quote',
      kind: 'count',
      value: countQuotesPrepared(snapshot, period),
      prior: countQuotesPrepared(snapshot, prior),
      goodDirection: 'higherIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.quoted,
    }),
    buildKpi({
      key: 'open_pipeline_premium',
      label: 'Open Pipeline Premium',
      leadOrQuote: 'quote',
      kind: 'currency',
      value: toWireAmount(openPipelineOf(snapshot)),
      // No prior: open pipeline is an as-of-now position, not a period total, so a
      // period-over-period delta on it would compare a stock against a flow.
      prior: null,
      goodDirection: 'higherIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.openPipeline,
    }),
    buildKpi({
      key: 'won_premium',
      label: 'Won Premium',
      leadOrQuote: 'quote',
      kind: 'currency',
      value: toWireAmount(wonPremiumIn(snapshot, period)),
      prior: toWireAmount(wonPremiumIn(snapshot, prior)),
      goodDirection: 'higherIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.won,
    }),
    buildKpi({
      key: 'conversion_rate',
      label: 'Conversion Rate',
      leadOrQuote: 'quote',
      kind: 'percent',
      value: conversionRateIn(snapshot, period),
      prior: conversionRateIn(snapshot, prior),
      goodDirection: 'higherIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.won,
    }),
    buildKpi({
      key: 'average_turnaround',
      label: 'Avg Turnaround',
      leadOrQuote: 'quote',
      kind: 'days',
      value: averageTurnaroundIn(snapshot, period),
      prior: averageTurnaroundIn(snapshot, prior),
      goodDirection: 'lowerIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.quoted,
    }),
    buildKpi({
      key: 'quotes_at_risk',
      label: 'Quotes at Risk',
      leadOrQuote: 'quote',
      kind: 'count',
      value: snapshot.atRiskQuoteIds.size,
      prior: null,
      goodDirection: 'lowerIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.atRisk,
    }),
    buildKpi({
      key: 'total_leads',
      label: 'Total Leads',
      leadOrQuote: 'lead',
      kind: 'count',
      value: countLeadsReceived(snapshot, period),
      prior: countLeadsReceived(snapshot, prior),
      goodDirection: 'higherIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.allLeads,
    }),
    buildKpi({
      key: 'lead_to_quote_rate',
      label: 'Lead-to-Quote Rate',
      leadOrQuote: 'lead',
      kind: 'percent',
      value: leadToQuoteRateIn(snapshot, period),
      prior: leadToQuoteRateIn(snapshot, prior),
      goodDirection: 'higherIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.allLeads,
    }),
    buildKpi({
      key: 'leads_at_risk',
      label: 'Leads at Risk',
      leadOrQuote: 'lead',
      kind: 'count',
      value: snapshot.atRiskLeadIds.size,
      prior: null,
      goodDirection: 'lowerIsBetter',
      drillWidgetKey: EXECUTIVE_WIDGET_KEYS.atRisk,
    }),
  ];
}

/**
 * Pipeline by stage (`:166-196`): CURRENT open leads per stage, NOT cumulative.
 *
 * Each bar counts only the leads whose current status IS that stage, so the bars are independent
 * per-stage snapshots rather than a monotonically-decreasing funnel — the Pipeline dashboard's
 * funnel is the cumulative one. Reading this chart as a funnel is the documented prototype
 * deviation (spec FR-55) and is why the field is named `openCount`, not `reachedCount`.
 */
function buildPipelineByStage(snapshot: DashboardSnapshot): ExecutivePipelineStageDto[] {
  const openLeads = openLeadsOf(snapshot);
  const totalOpen = openLeads.length;
  if (totalOpen === 0) return [];

  const groups = new Map<string, { stageName: string; stageCanonicalKey: string | null; count: number }>();
  for (const lead of openLeads) {
    // NUL separator, written as an explicit escape rather than typed as an invisible
    // character. Grouping is by the (name, canonical key) PAIR, and a printable separator
    // could be forged: a tenant status literally named "Sent|" would collide with "Sent"
    // carrying the canonical key "". NUL cannot appear in a Postgres text value.
    const key = `${lead.statusName}\u0000${lead.statusCanonicalKey ?? ''}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        stageName: lead.statusName,
        stageCanonicalKey: lead.statusCanonicalKey,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }

  return [...groups.values()].sort(compareStages).map((group) => ({
    stageName: group.stageName,
    stageCanonicalKey: group.stageCanonicalKey,
    openCount: group.count,
    shareOfOpen: roundShare(group.count, totalOpen),
    drillWidgetKey: EXECUTIVE_WIDGET_KEYS.openPipeline,
  }));
}

/**
 * Open quotes aging (`:209-238`) — THE EXECUTIVE FOUR-BUCKET SCHEME.
 *
 * A quote ages from when it was SENT, falling back to when it was prepared: an unsent draft is
 * still aging, but a sent quote's clock is the one the client is waiting on. The age is clamped at
 * zero so a future-dated quote reads as brand new rather than negative.
 */
function buildAging(snapshot: DashboardSnapshot, today: string): ExecutiveAgingDto {
  const openQuotes = openQuotesOf(snapshot);
  const total = openQuotes.length;

  const counts = new Map<ExecutiveAgingBucket, number>(
    EXECUTIVE_AGING_BUCKETS.map((bucket) => [bucket, 0]),
  );

  for (const quote of openQuotes) {
    const reference = quote.sentDate ?? quote.preparedDate;
    const age = ageDays(reference, today);
    const bucket = executiveBucketFor(age);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return {
    buckets: EXECUTIVE_AGING_BUCKETS.map((bucket) => {
      const count = counts.get(bucket) ?? 0;
      return { bucket, count, share: roundShare(count, total) };
    }),
    totalOpenQuotes: total,
    drillWidgetKey: EXECUTIVE_WIDGET_KEYS.openPipeline,
  };
}

/**
 * The bucket boundaries, expressed as the reference's INCLUSIVE upper bounds.
 *
 * Uses `EXECUTIVE_AGING_BUCKETS` positionally rather than repeating the labels, so the labels have
 * exactly one home (T-035's `metrics/index.ts`) and a relabelling cannot leave this function
 * emitting the old strings.
 */
function executiveBucketFor(age: number): ExecutiveAgingBucket {
  if (age <= 3) return EXECUTIVE_AGING_BUCKETS[0];
  if (age <= 7) return EXECUTIVE_AGING_BUCKETS[1];
  if (age <= 14) return EXECUTIVE_AGING_BUCKETS[2];
  return EXECUTIVE_AGING_BUCKETS[3];
}

/**
 * Won-vs-lost trend (`:240-272`): eight trailing weeks and six trailing months, BOTH pre-computed.
 *
 * Both series ship on every response so the Weekly/Monthly selector toggles without a refetch. The
 * windows are relative to today and are NOT narrowed by the dashboard's date filter — a six-month
 * trend restricted to a one-month filter would render five empty columns.
 */
function buildTrend(snapshot: DashboardSnapshot, today: string): ExecutiveTrendDto {
  const weekly: ExecutiveTrendPointDto[] = [];
  for (let week = 7; week >= 0; week -= 1) {
    const end = addDays(today, -7 * week);
    const start = addDays(end, -6);
    weekly.push(trendPoint(snapshot, { from: start, to: end }, dayLabel(end)));
  }

  const monthly: ExecutiveTrendPointDto[] = [];
  const thisMonth = firstOfMonth(today);
  for (let month = 5; month >= 0; month -= 1) {
    const start = addMonths(thisMonth, -month);
    const end = addDays(addMonths(start, 1), -1);
    monthly.push(trendPoint(snapshot, { from: start, to: end }, monthLabel(start)));
  }

  return { weekly, monthly, drillWidgetKey: EXECUTIVE_WIDGET_KEYS.won };
}

function trendPoint(snapshot: DashboardSnapshot, range: DateRange, label: string): ExecutiveTrendPointDto {
  return {
    label,
    wonPremium: toWireAmount(wonPremiumIn(snapshot, range)),
    lostPremium: toWireAmount(lostPremiumIn(snapshot, range)),
  };
}

/**
 * High-value opportunities (`:274-302`): the ten richest OPEN leads above the tenant threshold.
 *
 * A tenant with NO configured threshold gets an EMPTY table, not every open lead. "No threshold"
 * means the tenant has no high-value classification at all, which is a different fact from a
 * threshold of zero — and promoting every open lead onto the executive's attention table is the
 * failure mode that makes the whole panel ignorable.
 *
 * The comparison is on exact cents (`compareMoney`), never on widened doubles: a lead sitting one
 * cent either side of the threshold must land on the correct side deterministically.
 */
function buildHighValue(
  snapshot: DashboardSnapshot,
  threshold: Money | null,
): ExecutiveHighValueRowDto[] {
  if (threshold === null) return [];

  return openLeadsOf(snapshot)
    .map((lead) => ({
      lead,
      premium: lead.currentQuotedPremium ?? lead.estimatedPremium ?? ZERO_MONEY,
    }))
    // STRICTLY greater than: a lead exactly at the threshold is not high value.
    .filter((entry) => compareMoney(entry.premium, threshold) > 0)
    .sort((left, right) => {
      const byPremium = compareMoney(right.premium, left.premium);
      return byPremium !== 0 ? byPremium : left.lead.leadId - right.lead.leadId;
    })
    .slice(0, 10)
    .map((entry) => ({
      leadId: entry.lead.leadId,
      leadRef: entry.lead.leadRef,
      clientName: entry.lead.partyName,
      partyType: entry.lead.partyType,
      brokerName: entry.lead.brokerName,
      productLineName: entry.lead.productLineName,
      premium: toWireAmount(entry.premium),
      stageName: entry.lead.statusName,
      stageReportingCategory: entry.lead.reportingCategory,
      nextFollowUpDate: entry.lead.nextFollowUpDate,
      ownerName: entry.lead.ownerName,
      riskFlag: snapshot.atRiskLeadIds.has(entry.lead.leadId),
    }));
}

// ---------------------------------------------------------------------------------------------
// The endpoint.
// ---------------------------------------------------------------------------------------------

/**
 * Builds the Executive Overview payload.
 *
 * `now` is injected rather than read from a clock inside, so the whole payload is a pure function
 * of (data, filter, instant) and an integration test can assert exact aging, trend and period
 * values instead of shapes.
 */
export async function getExecutiveOverview(
  deps: DashboardServiceDeps,
  actor: DashboardActor,
  filter: DashboardFilter,
  now: Date = new Date(),
): Promise<ExecutiveOverviewDto> {
  const today = todayUtc(now);
  const { period, prior } = resolvePeriods(filter, today);

  const [settings, snapshot, summary] = await Promise.all([
    loadDashboardSettings(deps.db, actor.tenantId),
    loadDashboardSnapshot(deps.db, actor.tenantId, filter, callerOf(actor)),
    // The Requires Attention panel CONSUMES the T-033 alert summary rather than re-deriving alert
    // categories. Two implementations of "what is escalated" would disagree the first time a
    // threshold moved, and the panel is the thing an executive acts on.
    getAlertSummary({ db: deps.db }, { userId: actor.userId, tenantId: actor.tenantId }),
  ]);

  return {
    currencyCode: settings.currencyCode,
    kpis: buildKpis(snapshot, period, prior),
    pipelineByStage: buildPipelineByStage(snapshot),
    openQuotesAging: buildAging(snapshot, today),
    wonVsLostTrend: buildTrend(snapshot, today),
    highValueOpportunities: buildHighValue(snapshot, settings.highValueThreshold),
    requiresAttention: summary.categories.map((category) => ({
      category: category.category,
      name: category.name,
      definition: category.definition,
      tab: category.tab,
      count: category.count,
    })),
  };
}
