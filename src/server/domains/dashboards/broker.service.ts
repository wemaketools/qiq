/**
 * The Broker Performance dashboard (T-037; AC-074, AC-075, AC-078, AC-079; spec FR-57, PRD 15.1/15.3).
 *
 * Port of `GetBrokerPerformanceQueryHandler.cs` + `BrokerPerformanceStore.cs`.
 *
 * MEASURED CONTRADICTIONS AGAINST THE OBVIOUS READING — ALL FOUR ARE THE REFERENCE'S BEHAVIOUR
 * ===========================================================================================
 *  1. ONLY BROKER-ORIGINATED LEADS ARE IN SCOPE. `BrokerPerformanceStore.LeadQuery` (:199) filters
 *     `lead.BrokerId != null`. A lead with no broker contributes to no broker's numbers and to no
 *     KPI on this dashboard — including the tenant-wide-looking ones.
 *
 *  2. THE DATE WINDOW FILTERS LEADS, NOT QUOTES. The quote read (:74-79) carries NO date predicate
 *     at all: it selects every quote of the already-narrowed leads. So a February quote on a March
 *     lead COUNTS here, while the Executive dashboard (T-036) filters quotes by prepared date. The
 *     two dashboards genuinely report different populations for the same window, and unifying them
 *     would silently change what a shipped screen says. FLAGGED, not resolved.
 *
 *  3. brokerTypeId AND rmUserId/teamOrRmId ARE ACCEPTED AND IGNORED HERE. `BrokerPerformanceStore`
 *     applies exactly five of the eight shared dimensions (product line, broker, region, from, to);
 *     the RM dashboard applies broker type and RM, and this one does not. The endpoint still BINDS
 *     all eight (`DashboardEndpoints.cs:81-82`) because the filter bar is shared, so a stale
 *     brokerType selection must not 400 — it simply does not narrow. Preserved deliberately:
 *     implementing them here would make this dashboard disagree with the reference on every
 *     filtered request, in the direction of returning FEWER rows than the shipped screen shows.
 *
 *  4. THE TABLE IS A ROSTER, THE MATRIX IS NOT. Every broker appears in the table, including those
 *     with zero quotes (ranked last); the ranking and the matrix plot only brokers with volume,
 *     because a broker with no quotes has no matrix position to occupy.
 *
 * NO BREADTH PREDICATE. `BuildSnapshotAsync` takes no caller and applies none — the leads-visibility
 * rule governs the DRILL (which returns lead rows) and not the aggregate. That is the reference's
 * behaviour and the endpoint's own permission (`dashboards.view_broker_performance`) is what gates
 * it. Recorded here rather than left to be rediscovered as a suspected bug.
 *
 * QUERY BUDGET (N-04/AC-079): five statements, none per-row. Everything else is computed in memory
 * over those bounded results, exactly as the reference does — which also keeps every formula in
 * `metrics/index.ts` rather than re-derived in SQL.
 */
import { sql } from 'kysely';

import { getTenantSettings } from '../business-rules/service.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import {
  averageTurnaroundDays,
  conversionRate,
  type TurnaroundPair,
} from './metrics/index.js';
import { ZERO_MONEY, addMoney, type Money } from './money.js';
import { classifyQuadrant, median, type PerformanceQuadrant } from './quadrant.js';
import { breadthPredicate, leadFilterWhere, type DashboardFilter } from './filters.js';
import { callerOf, type DashboardActor } from './executive.service.js';
import type { DashboardCaller } from './snapshot.js';

/** `BrokerWidgetKeys` (:14-18) — the drill keys the SPA's chevrons send back. */
export const BROKER_WIDGET_KEYS = {
  leads: 'broker.leads',
  quotes: 'broker.quotes',
  won: 'broker.won',
  lost: 'broker.lost',
  overdue: 'broker.overdue',
} as const;

/** `ReportingCategory` values treated as still-open for the overdue count. */
const OPEN_CATEGORIES: readonly string[] = ['open', 'quoted'];

export interface BrokerKpiDto {
  readonly key: string;
  readonly label: string;
  readonly leadOrQuote: 'lead' | 'quote';
  readonly kind: 'currency' | 'percent' | 'count' | 'days';
  readonly value: number | null;
  readonly delta: number | null;
  readonly goodDirection: 'higherIsBetter' | 'lowerIsBetter';
  readonly isFavorableDelta: boolean | null;
  readonly drillWidgetKey: string;
}

export interface TopBrokerDto {
  readonly brokerId: number;
  readonly brokerName: string;
  readonly quoteVolume: number;
  readonly conversionRate: number | null;
  readonly drillWidgetKey: string;
}

export interface BrokerMatrixPointDto {
  readonly brokerId: number;
  readonly brokerName: string;
  readonly quoteVolume: number;
  readonly conversionRate: number | null;
  readonly wonPremium: number;
  readonly quadrant: PerformanceQuadrant;
  readonly drillWidgetKey: string;
}

export interface BrokerMatrixDto {
  readonly points: readonly BrokerMatrixPointDto[];
  readonly volumeSplit: number;
  readonly conversionSplit: number;
  readonly drillWidgetKey: string;
}

export interface BrokerTableRowDto {
  readonly brokerId: number;
  readonly brokerName: string;
  readonly primaryContactName: string | null;
  readonly tierName: string | null;
  readonly branch: string | null;
  readonly quoteVolume: number;
  readonly conversionRate: number | null;
  readonly wonPremium: number;
  readonly avgTurnaroundDays: number | null;
  readonly overdueFollowUps: number;
  readonly topLossReason: string | null;
  readonly drillWidgetKey: string;
}

export interface BrokerPerformanceDto {
  readonly currencyCode: string;
  readonly kpis: readonly BrokerKpiDto[];
  readonly topBrokers: readonly TopBrokerDto[];
  readonly matrix: BrokerMatrixDto;
  readonly table: readonly BrokerTableRowDto[];
}

/** `TopBrokersLimit` (:178) — the ranking CARD is a top-N; the table carries the full ledger. */
const TOP_BROKERS_LIMIT = 8;

interface BrokerMetaRow {
  readonly brokerId: number;
  readonly name: string;
  readonly tierName: string | null;
  readonly branch: string | null;
  readonly primaryContactName: string | null;
}

interface BrokerLeadRow {
  readonly leadId: number;
  readonly brokerId: number;
  readonly reportingCategory: string;
  readonly dateReceived: string;
  readonly nextFollowUpDate: string | null;
  readonly lostReasonName: string | null;
}

interface BrokerQuoteRow {
  readonly leadId: number;
  readonly brokerId: number;
  readonly reportingCategory: string;
  readonly currentPremium: Money;
  readonly boundPremium: Money | null;
  readonly leadDateReceived: string;
  readonly sentDate: string | null;
}

/** Everything one broker contributes, computed once and read by all four widgets. */
interface BrokerMetrics {
  readonly meta: BrokerMetaRow;
  readonly quoteVolume: number;
  readonly wonQuotes: number;
  readonly decidedQuotes: number;
  readonly conversion: number | null;
  readonly wonPremium: Money;
  readonly avgTurnaroundDays: number | null;
  readonly overdueFollowUps: number;
  readonly topLossReason: string | null;
  readonly hasActivity: boolean;
}

export interface BrokerDashboardDeps {
  readonly db: DbExecutor;
}

/** `DateOnly.FromDateTime(DateTime.UtcNow)` — the overdue comparison is date-only and UTC. */
function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Ordinal comparison, matching the reference's `StringComparer.Ordinal` tie-breaks. */
function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function loadBrokers(
  db: DbExecutor,
  tenantId: TenantId,
  brokerId: number | undefined,
): Promise<BrokerMetaRow[]> {
  // The primary contact is resolved with a LATERAL rather than a second round trip: it is still one
  // statement over a bounded set, and `min(name)` makes the pick deterministic if a broker has been
  // left with two primaries by bad data — rather than an arbitrary row, or a crash.
  const { rows } = await sql<{
    id: string;
    name: string;
    tier_name: string | null;
    branch: string | null;
    primary_contact_name: string | null;
  }>`
    select b.id::text as id,
           b.name,
           t.name as tier_name,
           b.branch,
           (select min(c.name)
              from broker_contacts c
             where c.tenant_id = ${tenantId}
               and c.broker_id = b.id
               and c.is_primary) as primary_contact_name
      from brokers b
      left join reference_items t
        on t.tenant_id = ${tenantId}
       and t.id = b.broker_type_id
     where b.tenant_id = ${tenantId}
       and (${brokerId ?? null}::bigint is null or b.id = ${brokerId ?? null}::bigint)
     order by b.id
  `.execute(db);

  return rows.map((row) => ({
    brokerId: Number(row.id),
    name: row.name,
    tierName: row.tier_name,
    branch: row.branch,
    primaryContactName: row.primary_contact_name,
  }));
}

/**
 * The five dimensions this dashboard actually narrows on — see contradiction 3 in the file header.
 *
 * Written as an explicit ERASURE of the other three rather than by hand-rolling a second predicate
 * builder. That keeps the one shared filter contract (`leadFilterPredicates`) as the only place
 * these predicates are expressed, and makes the omission greppable and deliberate instead of
 * looking like three predicates someone forgot.
 */
function brokerScopedFilter(filter: DashboardFilter): DashboardFilter {
  return {
    ...filter,
    rmUserId: undefined,
    teamOrRmId: undefined,
    brokerTypeId: undefined,
  };
}


/**
 * BREADTH NARROWS THIS AGGREGATE, NOT ONLY THE DRILL (AC-076, T-050).
 *
 * Without `leads.view_all` the caller sees only the leads they are assigned to — applied HERE, in
 * the lead query, before any aggregation. After a sum there is no way back: you cannot subtract the
 * rows the caller should not have seen. Applying it only to the drill would leave a headline the
 * user cannot reconcile by clicking it.
 */
async function loadLeads(
  db: DbExecutor,
  tenantId: TenantId,
  filter: DashboardFilter,
  caller: DashboardCaller,
): Promise<BrokerLeadRow[]> {
  const breadth = breadthPredicate(tenantId, caller);
  // The lost-reason join is a LEFT join with NO `is_active` predicate: a retired reason must still
  // resolve on the historical leads that carry it (P-04).
  const { rows } = await sql<{
    id: string;
    broker_id: string;
    reporting_category: string | null;
    date_received: string;
    next_follow_up_date: string | null;
    lost_reason_name: string | null;
  }>`
    select l.id::text as id,
           l.broker_id::text as broker_id,
           s.reporting_category,
           l.date_received::text as date_received,
           l.next_follow_up_date::text as next_follow_up_date,
           lr.name as lost_reason_name
      from leads l
      join reference_items s on s.tenant_id = ${tenantId} and s.id = l.status_id
      left join reference_items lr on lr.tenant_id = ${tenantId} and lr.id = l.lost_reason_id
     where ${leadFilterWhere(tenantId, brokerScopedFilter(filter))}
       and l.broker_id is not null
       and ${breadth ?? sql<boolean>`true`}
     order by l.id
  `.execute(db);

  return rows.map((row) => ({
    leadId: Number(row.id),
    brokerId: Number(row.broker_id),
    reportingCategory: row.reporting_category ?? 'open',
    dateReceived: row.date_received,
    nextFollowUpDate: row.next_follow_up_date,
    lostReasonName: row.lost_reason_name,
  }));
}

async function loadQuotes(
  db: DbExecutor,
  tenantId: TenantId,
  leads: readonly BrokerLeadRow[],
): Promise<BrokerQuoteRow[]> {
  if (leads.length === 0) return [];

  const leadIds = leads.map((lead) => lead.leadId);
  const brokerByLead = new Map(leads.map((lead) => [lead.leadId, lead.brokerId]));
  const receivedByLead = new Map(leads.map((lead) => [lead.leadId, lead.dateReceived]));

  // NO date predicate on the quote — see contradiction 2 in the file header.
  const { rows } = await sql<{
    lead_id: string;
    reporting_category: string | null;
    current_premium: string | null;
    bound_premium: string | null;
    prepared_date: string;
    sent_date: string | null;
  }>`
    select q.lead_id::text as lead_id,
           s.reporting_category,
           v.quoted_premium::text as current_premium,
           q.bound_premium::text as bound_premium,
           q.prepared_date::text as prepared_date,
           q.sent_date::text as sent_date
      from quotes q
      join reference_items s on s.tenant_id = ${tenantId} and s.id = q.status_id
      left join quote_versions v
        on v.tenant_id = ${tenantId}
       and v.quote_id = q.id
       and v.is_current
     where q.tenant_id = ${tenantId}
       and q.lead_id = any(${sql.val(leadIds)}::bigint[])
     order by q.id
  `.execute(db);

  return rows.map((row) => {
    const leadId = Number(row.lead_id);
    return {
      leadId,
      brokerId: brokerByLead.get(leadId) ?? 0,
      reportingCategory: row.reporting_category ?? 'open',
      // A quote with no current version contributes 0.00, matching the reference's `: 0m` fallback.
      currentPremium: row.current_premium ?? ZERO_MONEY,
      boundPremium: row.bound_premium,
      leadDateReceived: receivedByLead.get(leadId) ?? row.prepared_date,
      sentDate: row.sent_date,
    };
  });
}

function buildPerBrokerMetrics(
  brokers: readonly BrokerMetaRow[],
  leads: readonly BrokerLeadRow[],
  quotes: readonly BrokerQuoteRow[],
  today: string,
): BrokerMetrics[] {
  const leadsByBroker = new Map<number, BrokerLeadRow[]>();
  for (const lead of leads) {
    const bucket = leadsByBroker.get(lead.brokerId);
    if (bucket === undefined) leadsByBroker.set(lead.brokerId, [lead]);
    else bucket.push(lead);
  }

  const quotesByBroker = new Map<number, BrokerQuoteRow[]>();
  for (const quote of quotes) {
    const bucket = quotesByBroker.get(quote.brokerId);
    if (bucket === undefined) quotesByBroker.set(quote.brokerId, [quote]);
    else bucket.push(quote);
  }

  return brokers.map((meta) => {
    const brokerLeads = leadsByBroker.get(meta.brokerId) ?? [];
    const brokerQuotes = quotesByBroker.get(meta.brokerId) ?? [];

    const wonQuotes = brokerQuotes.filter((quote) => quote.reportingCategory === 'won');
    const lostCount = brokerQuotes.filter((quote) => quote.reportingCategory === 'lost').length;
    const decidedQuotes = wonQuotes.length + lostCount;

    // `BoundPremium ?? CurrentPremium` (:88): a won quote with no recorded bound amount still bound
    // business at the quoted figure. Summed on exact cents, never through a double.
    const wonPremium = wonQuotes.reduce<Money>(
      (total, quote) => addMoney(total, quote.boundPremium ?? quote.currentPremium),
      ZERO_MONEY,
    );

    const turnaroundPairs: TurnaroundPair[] = brokerQuotes
      .filter((quote) => quote.sentDate !== null)
      .map((quote) => ({
        receivedDate: quote.leadDateReceived,
        sentDate: quote.sentDate as string,
      }));

    const overdueFollowUps = brokerLeads.filter(
      (lead) =>
        OPEN_CATEGORIES.includes(lead.reportingCategory) &&
        lead.nextFollowUpDate !== null &&
        lead.nextFollowUpDate < today,
    ).length;

    // The MODE of this broker's lost leads' reasons, ties broken by name so the card is stable
    // across requests rather than depending on row order.
    const reasonCounts = new Map<string, number>();
    for (const lead of brokerLeads) {
      if (lead.reportingCategory !== 'lost' || lead.lostReasonName === null) continue;
      reasonCounts.set(lead.lostReasonName, (reasonCounts.get(lead.lostReasonName) ?? 0) + 1);
    }
    const topLossReason =
      [...reasonCounts.entries()].sort(
        (left, right) => right[1] - left[1] || ordinal(left[0], right[0]),
      )[0]?.[0] ?? null;

    return {
      meta,
      quoteVolume: brokerQuotes.length,
      wonQuotes: wonQuotes.length,
      decidedQuotes,
      conversion: conversionRate(wonQuotes.length, decidedQuotes),
      wonPremium,
      avgTurnaroundDays: averageTurnaroundDays(turnaroundPairs),
      overdueFollowUps,
      topLossReason,
      hasActivity: brokerQuotes.length > 0 || brokerLeads.length > 0,
    };
  });
}

function kpi(
  key: string,
  label: string,
  leadOrQuote: 'lead' | 'quote',
  kind: BrokerKpiDto['kind'],
  value: number | null,
  goodDirection: BrokerKpiDto['goodDirection'],
  drillWidgetKey: string,
): BrokerKpiDto {
  // Deltas are null and so is their colouring: this dashboard derives no prior comparable period
  // (`Kpi`, :163-171). Rendering a delta of 0 would claim a flat month we have not measured.
  return {
    key,
    label,
    leadOrQuote,
    kind,
    value,
    delta: null,
    goodDirection,
    isFavorableDelta: null,
    drillWidgetKey,
  };
}

function buildKpis(
  perBroker: readonly BrokerMetrics[],
  quotes: readonly BrokerQuoteRow[],
): BrokerKpiDto[] {
  const activeBrokers = perBroker.filter((broker) => broker.hasActivity).length;
  const brokerQuotes = perBroker.reduce((total, broker) => total + broker.quoteVolume, 0);
  const wonQuotesTotal = perBroker.reduce((total, broker) => total + broker.wonQuotes, 0);
  const decidedTotal = perBroker.reduce((total, broker) => total + broker.decidedQuotes, 0);
  const wonViaBrokers = perBroker.reduce<Money>(
    (total, broker) => addMoney(total, broker.wonPremium),
    ZERO_MONEY,
  );

  // Tenant-wide turnaround is computed over the QUOTE population, not as a mean of the per-broker
  // means — averaging averages would weight a one-quote broker the same as a fifty-quote one.
  const avgTurnaround = averageTurnaroundDays(
    quotes
      .filter((quote) => quote.sentDate !== null)
      .map((quote) => ({
        receivedDate: quote.leadDateReceived,
        sentDate: quote.sentDate as string,
      })),
  );

  const overdueFollowUps = perBroker.reduce((total, broker) => total + broker.overdueFollowUps, 0);

  return [
    kpi('active_brokers', 'Active Brokers', 'lead', 'count', activeBrokers, 'higherIsBetter', BROKER_WIDGET_KEYS.leads),
    kpi('broker_quotes', 'Broker Quotes', 'quote', 'count', brokerQuotes, 'higherIsBetter', BROKER_WIDGET_KEYS.quotes),
    kpi(
      'broker_conversion',
      'Broker Conversion',
      'quote',
      'percent',
      conversionRate(wonQuotesTotal, decidedTotal),
      'higherIsBetter',
      BROKER_WIDGET_KEYS.won,
    ),
    kpi('won_via_brokers', 'Won via Brokers', 'quote', 'currency', Number(wonViaBrokers), 'higherIsBetter', BROKER_WIDGET_KEYS.won),
    kpi('avg_turnaround', 'Avg Turnaround', 'quote', 'days', avgTurnaround, 'lowerIsBetter', BROKER_WIDGET_KEYS.quotes),
    kpi(
      'overdue_follow_ups',
      'Overdue Follow-ups',
      'lead',
      'count',
      overdueFollowUps,
      'lowerIsBetter',
      BROKER_WIDGET_KEYS.overdue,
    ),
  ];
}

/** Volume descending, name ascending — the ranking order shared by the card, matrix and table. */
function byVolumeThenName(left: BrokerMetrics, right: BrokerMetrics): number {
  return right.quoteVolume - left.quoteVolume || ordinal(left.meta.name, right.meta.name);
}

/**
 * Runs the dashboard.
 *
 * `now` is injected rather than read inside, so the overdue boundary is testable without waiting
 * for a day to turn over.
 */
export async function getBrokerPerformance(
  deps: BrokerDashboardDeps,
  actor: DashboardActor,
  filter: DashboardFilter,
  now: Date = new Date(),
): Promise<BrokerPerformanceDto> {
  const tenantId = actor.tenantId;
  const settings = await getTenantSettings(deps.db, tenantId);
  const brokers = await loadBrokers(deps.db, tenantId, filter.brokerId);
  const leads = await loadLeads(deps.db, tenantId, filter, callerOf(actor));
  const quotes = await loadQuotes(deps.db, tenantId, leads);

  const perBroker = buildPerBrokerMetrics(brokers, leads, quotes, todayUtc(now));

  const plotted = perBroker.filter((broker) => broker.quoteVolume > 0);
  const volumeSplit = median(plotted.map((broker) => broker.quoteVolume));
  const conversionSplit = median(
    plotted
      .filter((broker) => broker.conversion !== null)
      .map((broker) => broker.conversion as number),
  );

  const ranked = [...plotted].sort(byVolumeThenName);

  return {
    currencyCode: settings.currencyCode,
    kpis: buildKpis(perBroker, quotes),
    topBrokers: ranked.slice(0, TOP_BROKERS_LIMIT).map((broker) => ({
      brokerId: broker.meta.brokerId,
      brokerName: broker.meta.name,
      quoteVolume: broker.quoteVolume,
      conversionRate: broker.conversion,
      drillWidgetKey: BROKER_WIDGET_KEYS.quotes,
    })),
    matrix: {
      points: ranked.map((broker) => ({
        brokerId: broker.meta.brokerId,
        brokerName: broker.meta.name,
        quoteVolume: broker.quoteVolume,
        conversionRate: broker.conversion,
        wonPremium: Number(broker.wonPremium),
        quadrant: classifyQuadrant(
          broker.quoteVolume,
          broker.conversion,
          volumeSplit,
          conversionSplit,
        ),
        drillWidgetKey: BROKER_WIDGET_KEYS.quotes,
      })),
      volumeSplit,
      conversionSplit,
      drillWidgetKey: BROKER_WIDGET_KEYS.quotes,
    },
    table: [...perBroker].sort(byVolumeThenName).map((broker) => ({
      brokerId: broker.meta.brokerId,
      brokerName: broker.meta.name,
      primaryContactName: broker.meta.primaryContactName,
      tierName: broker.meta.tierName,
      branch: broker.meta.branch,
      quoteVolume: broker.quoteVolume,
      conversionRate: broker.conversion,
      wonPremium: Number(broker.wonPremium),
      avgTurnaroundDays: broker.avgTurnaroundDays,
      overdueFollowUps: broker.overdueFollowUps,
      topLossReason: broker.topLossReason,
      drillWidgetKey: BROKER_WIDGET_KEYS.leads,
    })),
  };
}
