/**
 * The Pipeline & Conversion dashboard payload (T-036; AC-022, AC-074, AC-075, AC-077, AC-079;
 * V-027, V-092, V-093, V-094, V-096, V-097, V-100; spec FR-56, AC-055/AC-059, P-10).
 *
 * Port of `GetPipelineDashboardQueryHandler.cs`, with the wire shape pinned against the SPA's
 * `src/ui/src/features/dashboards/pipelineApi.ts`.
 *
 * THE AGING HEATMAP USES THE **PIPELINE** SIX-BUCKET SCHEME
 * ========================================================
 * `0-3 / 4-7 / 8-14 / 15-30 / 31-60 / 60+` (:273-284), which is NOT the Executive Overview's
 * four-bucket `0-3 days .. 15+ days`. Different count, different labels, different final boundary.
 * This module imports `PIPELINE_AGING_BUCKETS` by name and never spells the labels out, so the two
 * schemes cannot be conflated by a copy-paste between the two services this task owns.
 *
 * THREE RATES HERE ARE DELIBERATELY NOT PERIOD-SCOPED
 * ==================================================
 * `quote_to_proposal_rate`, `proposal_to_win_rate` and `lead_to_quote_rate` are computed over the
 * WHOLE filtered snapshot (`:88-95` takes no date range), while `new_leads_this_month` and
 * `quotes_issued_this_month` are period-scoped. The asymmetry is measured, is easy to "tidy" into
 * consistency, and tidying it would silently change three shipped numbers. Pinned by test.
 */
import {
  ageDays,
  addDays,
  addMonths,
  buildKpi,
  compareOrdinal,
  compareStages,
  firstOfMonth,
  inRange,
  lifecycleOrder,
  monthLabel,
  resolvePeriods,
  roundShare,
  todayUtc,
  type DashboardKpiDto,
} from './composition.js';
import type { DashboardFilter } from './filters.js';
import {
  PIPELINE_AGING_BUCKETS,
  averageLeadAgeDays,
  averageQuoteAgeDays,
  leadToQuoteRate,
  openPipelinePremium,
  proposalToWinRate,
  quoteToProposalRate,
  type PipelineAgingBucket,
} from './metrics/index.js';
import { ZERO_MONEY, addMoney, compareMoney, sumMoney, type Money } from './money.js';
import type { DateRange } from './payload.js';
import {
  isOpenCategory,
  loadDashboardSettings,
  loadDashboardSnapshot,
  type DashboardSnapshot,
  type SnapshotLead,
} from './snapshot.js';
import { callerOf } from './executive.service.js';
import type { DashboardActor, DashboardServiceDeps } from './executive.service.js';

// ---------------------------------------------------------------------------------------------
// Drill widget keys (`PipelineWidgetKeys.cs`).
// ---------------------------------------------------------------------------------------------

export const PIPELINE_WIDGET_KEYS = {
  newLeads: 'pipeline.new_leads',
  allLeads: 'pipeline.leads',
  openPipeline: 'pipeline.open_pipeline',
  quoted: 'pipeline.quoted',
  won: 'pipeline.won',
  lost: 'pipeline.lost',
  atRisk: 'pipeline.at_risk',
  /**
   * Q-8's overdue-quotes action. Resolves to the open-pipeline lead list: the pre-sent-draft subset
   * Q-8 defines is not a distinct lead-list scope, so the drill lands on the open pipeline rather
   * than inventing one. The reference records the same rendering and flags it.
   */
  overdueQuotes: 'pipeline.overdue_quotes',
} as const;

/** Alerts Center tab keys (`AlertDefinitions`), used to deep-link an Immediate Action. */
const TAB_ALL = 'all';
const TAB_ESCALATED = 'escalated';
const TAB_OVERDUE = 'overdue';
const TAB_EXPIRING = 'expiring';
const TAB_SLA = 'sla';

const DIRECT_SOURCE_LABEL = 'Direct';
const UNKNOWN_CHANNEL_LABEL = 'Unspecified';
const TOTAL_BUCKET = 'Total';

/** Progression categories: what counts as "still moving forward" in the funnel (`:24`). */
const PROGRESSION_CATEGORIES: readonly string[] = ['open', 'quoted', 'won'];

// ---------------------------------------------------------------------------------------------
// The wire contract (`PipelineDashboardDto.cs`, `pipelineApi.ts`).
// ---------------------------------------------------------------------------------------------

export interface FunnelStageDto {
  readonly stageName: string;
  readonly stageCanonicalKey: string | null;
  readonly reachedCount: number;
  readonly conversionFromTop: number;
  readonly isLost: boolean;
  readonly drillWidgetKey: string;
}

export interface ProductLineStackSegmentDto {
  readonly productLineName: string;
  readonly value: number;
}

export interface ProductLineStackColumnDto {
  readonly monthLabel: string;
  readonly segments: readonly ProductLineStackSegmentDto[];
  readonly monthlyTotal: number;
}

export interface PipelineByProductLineDto {
  readonly productLines: readonly string[];
  readonly columns: readonly ProductLineStackColumnDto[];
  readonly drillWidgetKey: string;
}

export interface PipelineDonutSliceDto {
  readonly label: string;
  readonly count: number;
  readonly share: number;
}

export interface PipelineDonutDto {
  readonly slices: readonly PipelineDonutSliceDto[];
  readonly drillWidgetKey: string;
}

export interface AgingHeatmapStageDto {
  readonly stageName: string;
  readonly stageCanonicalKey: string | null;
}

export type AgingGrade = 'normal' | 'amber' | 'red';

export interface AgingHeatmapCellDto {
  readonly stageName: string;
  readonly bucket: string;
  readonly count: number;
  readonly grade: AgingGrade;
  readonly drillWidgetKey: string;
}

export interface AgingByStageDto {
  readonly stages: readonly AgingHeatmapStageDto[];
  readonly buckets: readonly string[];
  readonly cells: readonly AgingHeatmapCellDto[];
  readonly drillWidgetKey: string;
}

export interface AtRiskRowDto {
  readonly leadId: number;
  readonly leadRef: string;
  readonly clientName: string;
  readonly brokerName: string | null;
  readonly premium: number;
  readonly stageName: string;
  readonly stageReportingCategory: string;
  readonly ageDays: number;
  readonly ownerName: string | null;
  readonly riskReason: string;
  readonly suggestedAction: string;
  /** Populated only in Internal cross-tenant mode, which this endpoint is not. */
  readonly tenantName: string | null;
  readonly drillWidgetKey: string;
}

export interface ImmediateActionDto {
  readonly category: string;
  readonly name: string;
  readonly count: number;
  readonly tab: string | null;
  readonly drillWidgetKey: string;
}

/** The full payload. No `generatedAt`; see `executive.service.ts` for the measured reasoning. */
export interface PipelineDashboardDto {
  readonly currencyCode: string;
  readonly kpis: readonly DashboardKpiDto[];
  readonly stageConversionFunnel: readonly FunnelStageDto[];
  readonly pipelineByProductLine: PipelineByProductLineDto;
  readonly quoteVolumeBySource: PipelineDonutDto;
  readonly leadVolumeByChannel: PipelineDonutDto;
  readonly agingByStage: AgingByStageDto;
  readonly atRiskPipeline: readonly AtRiskRowDto[];
  readonly immediateActions: readonly ImmediateActionDto[];
}

function toWireAmount(value: Money): number {
  return Number(value);
}

// ---------------------------------------------------------------------------------------------
// Population helpers.
// ---------------------------------------------------------------------------------------------

function openLeadsOf(snapshot: DashboardSnapshot): readonly SnapshotLead[] {
  return snapshot.leads.filter((lead) => isOpenCategory(lead.reportingCategory));
}

/**
 * A lead's contribution to open pipeline VALUE (`OpenPipelineValue`, :205-206).
 *
 * A quoted lead is worth what it was quoted at, falling back to the original estimate; an unquoted
 * lead is worth its estimate. The distinction matters because a quote REPLACES the estimate as the
 * best available number, and adding both would double-count every quoted lead.
 */
function openPipelineValueOf(lead: SnapshotLead): Money {
  if (lead.hasQuote) {
    return lead.currentQuotedPremium ?? lead.estimatedPremium ?? ZERO_MONEY;
  }
  return lead.estimatedPremium ?? ZERO_MONEY;
}

function countLeadsReceived(snapshot: DashboardSnapshot, range: DateRange): number {
  return snapshot.leads.filter((lead) => inRange(lead.dateReceived, range)).length;
}

function countQuotesPrepared(snapshot: DashboardSnapshot, range: DateRange): number {
  return snapshot.quotes.filter((quote) => inRange(quote.preparedDate, range)).length;
}

// ---------------------------------------------------------------------------------------------
// KPIs.
// ---------------------------------------------------------------------------------------------

function buildKpis(
  snapshot: DashboardSnapshot,
  alertCounts: ReadonlyMap<string, number>,
  today: string,
  period: DateRange,
  prior: DateRange,
): DashboardKpiDto[] {
  const openLeads = openLeadsOf(snapshot);
  const openQuotes = snapshot.quotes.filter((quote) => isOpenCategory(quote.reportingCategory));

  const openQuotePremium = sumMoney(openQuotes.map((quote) => quote.currentPremium));
  const openLeadEstimated = sumMoney(
    openLeads.filter((lead) => !lead.hasQuote).map((lead) => lead.estimatedPremium ?? ZERO_MONEY),
  );
  const openPipelineValue = openPipelinePremium(openQuotePremium, openLeadEstimated);

  // NOT period-scoped — measured. See the module header.
  const totalQuotes = snapshot.quotes.length;
  const quotesSent = snapshot.quotes.filter((quote) => quote.sentDate !== null).length;
  const wonQuotes = snapshot.quotes.filter((quote) => quote.reportingCategory === 'won').length;
  const leadsWithQuote = snapshot.leads.filter((lead) => lead.hasQuote).length;

  const openLeadAges = openLeads.map((lead) => ageDays(lead.dateReceived, today));
  // Open quote age runs from the SENT date, so an unsent draft has no quote age to average.
  const openSentQuoteAges = openQuotes
    .filter((quote) => quote.sentDate !== null)
    .map((quote) => ageDays(quote.sentDate as string, today));

  return [
    buildKpi({
      key: 'new_leads_this_month',
      label: 'New Leads This Month',
      leadOrQuote: 'lead',
      kind: 'count',
      value: countLeadsReceived(snapshot, period),
      prior: countLeadsReceived(snapshot, prior),
      goodDirection: 'higherIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.newLeads,
    }),
    buildKpi({
      key: 'open_pipeline_value',
      label: 'Open Pipeline Value',
      leadOrQuote: 'quote',
      kind: 'currency',
      value: toWireAmount(openPipelineValue),
      prior: null,
      goodDirection: 'higherIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
    }),
    buildKpi({
      key: 'quote_to_proposal_rate',
      label: 'Quote-to-Proposal Rate',
      leadOrQuote: 'quote',
      kind: 'percent',
      // Q-5 fixed the denominator as QUOTES, not leads.
      value: quoteToProposalRate(quotesSent, totalQuotes),
      prior: null,
      goodDirection: 'higherIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.quoted,
    }),
    buildKpi({
      key: 'proposal_to_win_rate',
      label: 'Proposal-to-Win Rate',
      leadOrQuote: 'quote',
      kind: 'percent',
      value: proposalToWinRate(wonQuotes, quotesSent),
      prior: null,
      goodDirection: 'higherIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.won,
    }),
    buildKpi({
      key: 'average_quote_age',
      label: 'Average Quote Age',
      leadOrQuote: 'quote',
      kind: 'days',
      value: averageQuoteAgeDays(openSentQuoteAges),
      prior: null,
      goodDirection: 'lowerIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
    }),
    buildKpi({
      key: 'sla_breaches',
      label: 'SLA Breaches',
      leadOrQuote: 'quote',
      kind: 'count',
      value: alertCounts.get('sla_breach') ?? 0,
      prior: null,
      goodDirection: 'lowerIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.atRisk,
    }),
    buildKpi({
      key: 'quotes_issued_this_month',
      label: 'Quotes Issued This Month',
      leadOrQuote: 'quote',
      kind: 'count',
      value: countQuotesPrepared(snapshot, period),
      prior: countQuotesPrepared(snapshot, prior),
      goodDirection: 'higherIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.quoted,
    }),
    buildKpi({
      key: 'lead_to_quote_rate',
      label: 'Lead-to-Quote Rate',
      leadOrQuote: 'lead',
      kind: 'percent',
      value: leadToQuoteRate(leadsWithQuote, snapshot.leads.length),
      prior: null,
      goodDirection: 'higherIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.allLeads,
    }),
    buildKpi({
      key: 'average_lead_age',
      label: 'Average Lead Age',
      leadOrQuote: 'lead',
      kind: 'days',
      value: averageLeadAgeDays(openLeadAges),
      prior: null,
      goodDirection: 'lowerIsBetter',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Funnel.
// ---------------------------------------------------------------------------------------------

/**
 * Stage conversion funnel (`:169-203`): CUMULATIVE reached-stage counts.
 *
 * A lead "reaches" stage S if its current status sits at or beyond S in the lifecycle order, so the
 * bars decrease monotonically — unlike the Executive Overview's per-stage snapshot, which does not.
 * Lost/expired/withdrawn leads are excluded from the progression entirely and counted only in the
 * terminal Lost bar, which is rendered last and marked `isLost` for the UI's red styling.
 */
function buildFunnel(snapshot: DashboardSnapshot): FunnelStageDto[] {
  const progressionLeads = snapshot.leads.filter((lead) =>
    PROGRESSION_CATEGORIES.includes(lead.reportingCategory),
  );
  const progressionStages = snapshot.stages
    .filter((stage) => PROGRESSION_CATEGORIES.includes(stage.reportingCategory))
    .slice()
    .sort(compareStages);

  const top = progressionLeads.length;

  const bars: FunnelStageDto[] = progressionStages.map((stage) => {
    const stageOrder = lifecycleOrder(stage.stageCanonicalKey);
    const reached = progressionLeads.filter(
      (lead) => lifecycleOrder(lead.statusCanonicalKey) >= stageOrder,
    ).length;
    return {
      stageName: stage.stageName,
      stageCanonicalKey: stage.stageCanonicalKey,
      reachedCount: reached,
      conversionFromTop: roundShare(reached, top),
      isLost: false,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
    };
  });

  const lostLeads = snapshot.leads.filter((lead) => lead.reportingCategory === 'lost');
  // The reference takes `FirstOrDefault` over an UNORDERED stage list, which is non-deterministic
  // when a tenant configures more than one lost status. Ordering first makes the chosen label
  // stable across requests; with a single lost status the two agree exactly.
  const lostStage = snapshot.stages
    .filter((stage) => stage.reportingCategory === 'lost')
    .slice()
    .sort(compareStages)[0];

  bars.push({
    stageName: lostStage?.stageName ?? 'Lost',
    stageCanonicalKey: lostStage?.stageCanonicalKey ?? 'closed_lost',
    reachedCount: lostLeads.length,
    conversionFromTop: roundShare(lostLeads.length, top),
    isLost: true,
    drillWidgetKey: PIPELINE_WIDGET_KEYS.lost,
  });

  return bars;
}

// ---------------------------------------------------------------------------------------------
// Product-line stacks.
// ---------------------------------------------------------------------------------------------

/**
 * Pipeline by product line (`:208-237`): six trailing monthly columns of open pipeline VALUE.
 *
 * The legend order is fixed by descending total contribution so the UI can map each product line to
 * a stable series colour, and EVERY legend entry gets a segment in EVERY column — including zero
 * ones — so the stacked series stay aligned rather than shifting colour between months.
 */
function buildProductLineStacks(snapshot: DashboardSnapshot, today: string): PipelineByProductLineDto {
  const openLeads = openLeadsOf(snapshot);

  const totals = new Map<string, Money>();
  for (const lead of openLeads) {
    totals.set(
      lead.productLineName,
      addMoney(totals.get(lead.productLineName) ?? ZERO_MONEY, openPipelineValueOf(lead)),
    );
  }

  const productLines = [...totals.entries()]
    .sort((left, right) => {
      const byValue = compareMoney(right[1], left[1]);
      return byValue !== 0 ? byValue : compareOrdinal(left[0], right[0]);
    })
    .map(([name]) => name);

  const thisMonth = firstOfMonth(today);
  const columns: ProductLineStackColumnDto[] = [];

  for (let month = 5; month >= 0; month -= 1) {
    const start = addMonths(thisMonth, -month);
    const end = addDays(addMonths(start, 1), -1);
    const monthLeads = openLeads.filter(
      (lead) => lead.dateReceived >= start && lead.dateReceived <= end,
    );

    const segments = productLines.map((name) => {
      const value = sumMoney(
        monthLeads.filter((lead) => lead.productLineName === name).map(openPipelineValueOf),
      );
      return { productLineName: name, value: toWireAmount(value) };
    });

    // Summed as exact money, then widened once — not by adding the already-widened segments.
    const monthlyTotal = sumMoney(
      monthLeads.map(openPipelineValueOf),
    );

    columns.push({ monthLabel: monthLabel(start), segments, monthlyTotal: toWireAmount(monthlyTotal) });
  }

  return { productLines, columns, drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline };
}

// ---------------------------------------------------------------------------------------------
// Donuts.
// ---------------------------------------------------------------------------------------------

function toSlices(groups: ReadonlyMap<string, number>, drillWidgetKey: string): PipelineDonutDto {
  const entries = [...groups.entries()];
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return {
    slices: entries
      .sort((left, right) => {
        const byCount = right[1] - left[1];
        return byCount !== 0 ? byCount : compareOrdinal(left[0], right[0]);
      })
      .map(([label, count]) => ({ label, count, share: roundShare(count, total) })),
    drillWidgetKey,
  };
}

/** Quote volume by SOURCE: the broker the quote's LEAD came through, or Direct when unbrokered. */
function buildQuoteVolumeBySource(snapshot: DashboardSnapshot): PipelineDonutDto {
  const brokerByLead = new Map(snapshot.leads.map((lead) => [lead.leadId, lead.brokerName]));
  const counts = new Map<string, number>();

  for (const quote of snapshot.quotes) {
    const label = brokerByLead.get(quote.leadId) ?? DIRECT_SOURCE_LABEL;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return toSlices(counts, PIPELINE_WIDGET_KEYS.quoted);
}

/** Lead volume by CHANNEL — a LEAD count, a different population from the quote donut above. */
function buildLeadVolumeByChannel(snapshot: DashboardSnapshot): PipelineDonutDto {
  const counts = new Map<string, number>();
  for (const lead of snapshot.leads) {
    const label = lead.requestChannelName ?? UNKNOWN_CHANNEL_LABEL;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return toSlices(counts, PIPELINE_WIDGET_KEYS.allLeads);
}

// ---------------------------------------------------------------------------------------------
// Aging heatmap — THE PIPELINE SIX-BUCKET SCHEME.
// ---------------------------------------------------------------------------------------------

function pipelineBucketFor(age: number): PipelineAgingBucket {
  if (age <= 3) return PIPELINE_AGING_BUCKETS[0];
  if (age <= 7) return PIPELINE_AGING_BUCKETS[1];
  if (age <= 14) return PIPELINE_AGING_BUCKETS[2];
  if (age <= 30) return PIPELINE_AGING_BUCKETS[3];
  if (age <= 60) return PIPELINE_AGING_BUCKETS[4];
  return PIPELINE_AGING_BUCKETS[5];
}

/**
 * Cell grade (`:286-301`): an AGE-TIER concentration, hotter to the right.
 *
 * An EMPTY cell is always `normal` regardless of how old its bucket is — a `60+` column with no
 * leads in it is good news, and painting it red would make the heatmap unreadable.
 */
function gradeFor(bucket: PipelineAgingBucket, count: number): AgingGrade {
  if (count === 0) return 'normal';
  if (bucket === PIPELINE_AGING_BUCKETS[0] || bucket === PIPELINE_AGING_BUCKETS[1]) return 'normal';
  if (bucket === PIPELINE_AGING_BUCKETS[2] || bucket === PIPELINE_AGING_BUCKETS[3]) return 'amber';
  return 'red';
}

/**
 * Aging by stage (`:303-340`): OPEN lifecycle stages only.
 *
 * Won/Lost/Expired/Withdrawn rows are omitted (the documented prototype deviation): a closed lead
 * does not age, so a "60+ days in Closed Won" cell would be reporting nothing.
 */
function buildAgingByStage(snapshot: DashboardSnapshot, today: string): AgingByStageDto {
  const openStages = snapshot.stages
    .filter((stage) => isOpenCategory(stage.reportingCategory))
    .slice()
    .sort(compareStages);

  const leadsByStage = new Map<string, SnapshotLead[]>();
  for (const lead of openLeadsOf(snapshot)) {
    const bucket = leadsByStage.get(lead.statusName);
    if (bucket === undefined) leadsByStage.set(lead.statusName, [lead]);
    else bucket.push(lead);
  }

  const cells: AgingHeatmapCellDto[] = [];
  for (const stage of openStages) {
    const leads = leadsByStage.get(stage.stageName) ?? [];

    const counts = new Map<PipelineAgingBucket, number>(
      PIPELINE_AGING_BUCKETS.map((bucket) => [bucket, 0]),
    );
    for (const lead of leads) {
      const bucket = pipelineBucketFor(ageDays(lead.dateReceived, today));
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }

    for (const bucket of PIPELINE_AGING_BUCKETS) {
      const count = counts.get(bucket) ?? 0;
      cells.push({
        stageName: stage.stageName,
        bucket,
        count,
        grade: gradeFor(bucket, count),
        drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
      });
    }

    cells.push({
      stageName: stage.stageName,
      bucket: TOTAL_BUCKET,
      count: leads.length,
      grade: 'normal',
      drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
    });
  }

  return {
    stages: openStages.map((stage) => ({
      stageName: stage.stageName,
      stageCanonicalKey: stage.stageCanonicalKey,
    })),
    buckets: [...PIPELINE_AGING_BUCKETS, TOTAL_BUCKET],
    cells,
    drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
  };
}

// ---------------------------------------------------------------------------------------------
// At-risk pipeline.
// ---------------------------------------------------------------------------------------------

const RISK_REASON_BY_TYPE: Readonly<Record<string, string>> = {
  sla_breach: 'SLA breach',
  executive_escalation: 'Executive escalation',
  high_value_stalled: 'High-value stalled',
  quote_expiring: 'Quote expiring',
  quote_expired: 'Quote expired',
  overdue_follow_up: 'Overdue follow-up',
  pending_pricing_approval: 'Pricing approval pending',
  awaiting_underwriting: 'Awaiting underwriting',
  unassigned_lead: 'Unassigned lead',
  stalled_lead: 'Stalled lead',
  stalled_quote: 'Stalled quote',
};

const SUGGESTED_ACTION_BY_TYPE: Readonly<Record<string, string>> = {
  sla_breach: 'Escalate to underwriting',
  executive_escalation: 'Executive review',
  high_value_stalled: 'Executive review',
  quote_expiring: 'Follow up before expiry',
  quote_expired: 'Revise or close quote',
  overdue_follow_up: 'Log follow-up',
  pending_pricing_approval: 'Approve pricing',
  awaiting_underwriting: 'Chase underwriting',
  unassigned_lead: 'Assign owner',
  stalled_lead: 'Re-engage lead',
  stalled_quote: 'Re-engage quote',
};

/** Most severe first. A lead commonly carries four open alerts; the row shows the worst one. */
const RISK_PRIORITY: readonly string[] = [
  'executive_escalation',
  'sla_breach',
  'high_value_stalled',
  'quote_expired',
  'quote_expiring',
  'pending_pricing_approval',
  'awaiting_underwriting',
  'overdue_follow_up',
  'unassigned_lead',
  'stalled_lead',
  'stalled_quote',
];

function buildAtRisk(snapshot: DashboardSnapshot, today: string): AtRiskRowDto[] {
  const rows: { row: AtRiskRowDto; premium: Money }[] = [];

  for (const lead of openLeadsOf(snapshot)) {
    const alertTypes = snapshot.openAlertTypesByLead.get(lead.leadId);
    if (alertTypes === undefined || alertTypes.length === 0) continue;

    const primaryType = RISK_PRIORITY.find((type) => alertTypes.includes(type)) ?? alertTypes[0]!;
    const premium = openPipelineValueOf(lead);

    rows.push({
      premium,
      row: {
        leadId: lead.leadId,
        leadRef: lead.leadRef,
        clientName: lead.partyName,
        brokerName: lead.brokerName,
        premium: toWireAmount(premium),
        stageName: lead.statusName,
        stageReportingCategory: lead.reportingCategory,
        ageDays: ageDays(lead.dateReceived, today),
        ownerName: lead.ownerName,
        riskReason: RISK_REASON_BY_TYPE[primaryType] ?? 'At risk',
        suggestedAction: SUGGESTED_ACTION_BY_TYPE[primaryType] ?? 'Review lead',
        tenantName: null,
        drillWidgetKey: PIPELINE_WIDGET_KEYS.atRisk,
      },
    });
  }

  return rows
    .sort((left, right) => {
      const byPremium = compareMoney(right.premium, left.premium);
      return byPremium !== 0 ? byPremium : left.row.leadId - right.row.leadId;
    })
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------------------------
// Immediate actions.
// ---------------------------------------------------------------------------------------------

function buildImmediateActions(
  snapshot: DashboardSnapshot,
  alertCounts: ReadonlyMap<string, number>,
  slaReceivedToSentDays: number,
  today: string,
): ImmediateActionDto[] {
  // Q-8: an overdue quote is a PRE-SENT (draft) open quote whose days-since-prepared exceeds the
  // tenant's prepared-to-sent target. STRICTLY exceeds — a quote sitting exactly on the target has
  // not yet breached it. Rendered against `sla_received_to_sent_days`; FLAGGED, because no dedicated
  // prepared-to-sent field exists on `tenant_settings` and the reference records the same gap.
  const overdueQuotes = snapshot.quotes.filter(
    (quote) =>
      quote.sentDate === null &&
      quote.reportingCategory === 'open' &&
      ageDays(quote.preparedDate, today) > slaReceivedToSentDays,
  ).length;

  // Follow-ups due TODAY are a date comparison on open leads, not an alert type: an alert fires when
  // a follow-up is already OVERDUE, which is a different (and later) fact.
  const followUpsDueToday = openLeadsOf(snapshot).filter(
    (lead) => lead.nextFollowUpDate === today,
  ).length;

  const alerts = (type: string): number => alertCounts.get(type) ?? 0;

  return [
    {
      category: 'overdue_quotes',
      name: 'Overdue Quotes',
      count: overdueQuotes,
      tab: TAB_SLA,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.overdueQuotes,
    },
    {
      category: 'pending_pricing_approvals',
      name: 'Pending Pricing Approvals',
      count: alerts('pending_pricing_approval'),
      tab: TAB_SLA,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.atRisk,
    },
    {
      category: 'exec_escalations',
      name: 'Exec Escalations',
      count: alerts('executive_escalation'),
      tab: TAB_ESCALATED,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.atRisk,
    },
    {
      category: 'sla_breaches',
      name: 'SLA Breaches',
      count: alerts('sla_breach'),
      tab: TAB_SLA,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.atRisk,
    },
    {
      category: 'unassigned_leads',
      name: 'Unassigned Leads',
      count: alerts('unassigned_lead'),
      tab: TAB_ALL,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.allLeads,
    },
    {
      category: 'overdue_follow_ups',
      name: 'Overdue Follow-ups',
      count: alerts('overdue_follow_up'),
      tab: TAB_OVERDUE,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.atRisk,
    },
    {
      category: 'expiring_quotes',
      name: 'Expiring Quotes',
      count: alerts('quote_expiring'),
      tab: TAB_EXPIRING,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.atRisk,
    },
    {
      category: 'follow_ups_due_today',
      name: 'Follow-ups Due Today',
      count: followUpsDueToday,
      tab: TAB_OVERDUE,
      drillWidgetKey: PIPELINE_WIDGET_KEYS.openPipeline,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// The endpoint.
// ---------------------------------------------------------------------------------------------

export async function getPipelineDashboard(
  deps: DashboardServiceDeps,
  actor: DashboardActor,
  filter: DashboardFilter,
  now: Date = new Date(),
): Promise<PipelineDashboardDto> {
  const today = todayUtc(now);
  const { period, prior } = resolvePeriods(filter, today);

  const [settings, snapshot] = await Promise.all([
    loadDashboardSettings(deps.db, actor.tenantId),
    loadDashboardSnapshot(deps.db, actor.tenantId, filter, callerOf(actor)),
  ]);

  // Alert-backed counts now come from the SNAPSHOT's own alert rows rather than from the tenant-wide
  // `countOpenAlertsByType`, so they honour the dashboard filter and the caller's breadth — see the
  // `openAlertCountsByType` note in `snapshot.ts`. Without that, `sla_breaches` and five Immediate
  // Actions showed counts whose drill (which does honour both) could not reproduce them.
  const alertCounts = snapshot.openAlertCountsByType;

  return {
    currencyCode: settings.currencyCode,
    kpis: buildKpis(snapshot, alertCounts, today, period, prior),
    stageConversionFunnel: buildFunnel(snapshot),
    pipelineByProductLine: buildProductLineStacks(snapshot, today),
    quoteVolumeBySource: buildQuoteVolumeBySource(snapshot),
    leadVolumeByChannel: buildLeadVolumeByChannel(snapshot),
    agingByStage: buildAgingByStage(snapshot, today),
    atRiskPipeline: buildAtRisk(snapshot, today),
    immediateActions: buildImmediateActions(
      snapshot,
      alertCounts,
      settings.slaReceivedToSentDays,
      today,
    ),
  };
}
