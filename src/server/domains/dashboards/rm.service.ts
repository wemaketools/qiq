/**
 * The RM Performance dashboard (T-037; AC-074, AC-075, AC-078, AC-079; spec FR-58, AC-057, AC-059,
 * PRD 15.2/15.4).
 *
 * Port of `GetRmPerformanceQueryHandler.cs` + `RmPerformanceStore.cs`.
 *
 * THE SLA DECISION, MEASURED AND MADE VISIBLE — THIS IS WHERE T-035's `unknown` WOULD HAVE SURFACED
 * ================================================================================================
 * T-035 ported `slaStatus()` as a TRI-state (`on_track` / `breached` / `unknown`), deriving the
 * breach from `avgTurnaround > slaTarget` and adding `unknown` as a documented addition that
 * reached no wire. RM Performance is the dashboard that renders SLA, so the question lands here.
 *
 * MEASURED ANSWER: the reference's wire has no SLA status field at all. `TurnaroundRmRowDto`
 * (:69-74) carries `AvgTurnaroundDays: double?` and `BeyondTarget: bool`, and the handler computes
 *     `r.AvgTurnaroundDays is not null && r.AvgTurnaroundDays.Value > slaTarget`
 * (GetRmPerformanceQueryHandler.cs:291). The SPA declares exactly that pair
 * (`src/ui/src/features/dashboards/rmApi.ts` `TurnaroundRmRowDto`) and nothing else.
 *
 * So the two facts travel SEPARATELY and `unknown` never becomes a wire value:
 *   - an RM who has sent quotes late   -> `avgTurnaroundDays: 11, beyondTarget: true`   (breached)
 *   - an RM who has sent quotes on time-> `avgTurnaroundDays: 2,  beyondTarget: false`  (on track)
 *   - an RM who has sent NOTHING       -> `avgTurnaroundDays: null, beyondTarget: FALSE`
 * The third row is the one that matters: `beyondTarget` is false, so the chart draws NO breach
 * marker, and `avgTurnaroundDays` is null, so the UI renders an em dash rather than a zero-length
 * bar. "Unknown" is expressed by the NULL, not by a third enum value — which is strictly more
 * information than a tri-state string would carry, because the null also suppresses the bar.
 *
 * `slaStatus()` therefore stays an internal metric with no consumer on this wire. Adding it to the
 * payload would be a contract change (A-3) that no client reads. FLAGGED, not silently added.
 *
 * THE `beyondTarget` COMPARISON IS STRICTLY GREATER. Meeting the target exactly is compliant; `>=`
 * here would flag every perfectly-compliant RM as breaching.
 *
 * OTHER MEASURED BEHAVIOURS PRESERVED
 * ===================================
 *  - the RM dimension is the ACCOUNTABLE OWNER (the `rm` business-assignment slot), not any
 *    assignment — see `owner.ts` for why that distinction is load-bearing;
 *  - unlike Broker Performance, this dashboard DOES apply `brokerTypeId`, and selecting one
 *    excludes unbrokered leads entirely (`RmPerformanceStore` :62-65);
 *  - `Won Premium YTD` is computed over the ACTIVE FILTER WINDOW, not a calendar YTD — the shared
 *    date filter governs the window and no separate YTD anchor exists (the reference's own flag);
 *  - follow-up compliance uses the open-commitment proxy: required = open leads carrying a next
 *    follow-up date, on-time = those not yet overdue. The follow-up log does not retain the prior
 *    committed date the literal PRD 22 semantics would need (the reference's own flag);
 *  - turnaround is per-RM, not per-team: the MVP has no team entity (the reference's own flag).
 *
 * QUERY BUDGET (N-04/AC-079): four statements, none per-row.
 */
import { sql } from 'kysely';

import { getTenantSettings } from '../business-rules/service.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import {
  averageTurnaroundDays,
  conversionRate,
  followUpCompliance,
  slaStatus,
  type TurnaroundPair,
} from './metrics/index.js';
import { ZERO_MONEY, addMoney, compareMoney, type Money } from './money.js';
import { classifyQuadrant, median, type PerformanceQuadrant } from './quadrant.js';
import { breadthPredicate, leadFilterWhere, type DashboardFilter, effectiveRmUserId } from './filters.js';
import { callerOf, type DashboardActor } from './executive.service.js';
import type { DashboardCaller } from './snapshot.js';
import { accountableOwnerJoin, accountableOwnerPredicate } from './owner.js';
import {
  evaluateSuggestedAction,
  suggestedActionLabel,
  suggestedActionSeverity,
  suggestedActionTone,
} from './suggested-action.js';
import { generateLeadershipInsights, type LeadershipInsight } from './insights.js';

/** `RmWidgetKeys` (:15-19). */
export const RM_WIDGET_KEYS = {
  leads: 'rm.leads',
  quotes: 'rm.quotes',
  won: 'rm.won',
  lost: 'rm.lost',
  overdue: 'rm.overdue',
} as const;

const OPEN_CATEGORIES: readonly string[] = ['open', 'quoted'];

export interface RmKpiDto {
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

export interface TopRmDto {
  readonly rmUserId: number;
  readonly rmName: string;
  readonly quoteVolume: number;
  readonly wonPremium: number;
  readonly conversionRate: number | null;
  readonly drillWidgetKey: string;
}

export interface TopBrokerRankDto {
  readonly brokerId: number;
  readonly brokerName: string;
  readonly quoteVolume: number;
  readonly wonPremium: number;
  readonly conversionRate: number | null;
  readonly drillWidgetKey: string;
}

export interface RmBrokerMatrixPointDto {
  readonly brokerId: number;
  readonly brokerName: string;
  readonly quoteVolume: number;
  readonly conversionRate: number | null;
  readonly wonPremium: number;
  readonly quadrant: PerformanceQuadrant;
  readonly drillWidgetKey: string;
}

export interface RmBrokerMatrixDto {
  readonly points: readonly RmBrokerMatrixPointDto[];
  readonly volumeSplit: number;
  readonly conversionSplit: number;
  readonly drillWidgetKey: string;
}

export interface TurnaroundRmRowDto {
  readonly rmUserId: number;
  readonly rmName: string;
  readonly avgTurnaroundDays: number | null;
  readonly beyondTarget: boolean;
  readonly drillWidgetKey: string;
}

export interface TurnaroundByRmDto {
  readonly rows: readonly TurnaroundRmRowDto[];
  readonly slaTargetDays: number;
  readonly drillWidgetKey: string;
}

export interface SuggestedActionDto {
  readonly label: string;
  readonly tone: string;
}

export interface WatchlistRowDto {
  readonly rmUserId: number;
  readonly name: string;
  readonly quoteVolume: number;
  readonly wonPremium: number;
  readonly conversionRate: number | null;
  readonly avgTurnaroundDays: number | null;
  readonly overdueFollowUps: number;
  readonly suggestedAction: SuggestedActionDto;
  readonly drillWidgetKey: string;
}

export interface RmPerformanceDto {
  readonly currencyCode: string;
  readonly kpis: readonly RmKpiDto[];
  readonly topRms: readonly TopRmDto[];
  readonly topBrokers: readonly TopBrokerRankDto[];
  readonly brokerMatrix: RmBrokerMatrixDto;
  readonly turnaroundByRm: TurnaroundByRmDto;
  readonly watchlist: readonly WatchlistRowDto[];
  readonly insights: readonly LeadershipInsight[];
}

interface RmBrokerMetaRow {
  readonly brokerId: number;
  readonly name: string;
}

interface RmLeadRow {
  readonly leadId: number;
  readonly ownerUserId: number | null;
  readonly ownerName: string | null;
  readonly brokerId: number | null;
  readonly reportingCategory: string;
  readonly dateReceived: string;
  readonly nextFollowUpDate: string | null;
  readonly estimatedPremium: Money | null;
  readonly currentQuotedPremium: Money | null;
}

interface RmQuoteRow {
  readonly leadId: number;
  readonly ownerUserId: number | null;
  readonly brokerId: number | null;
  readonly reportingCategory: string;
  readonly currentPremium: Money;
  readonly boundPremium: Money | null;
  readonly leadDateReceived: string;
  readonly sentDate: string | null;
}

interface RmMetrics {
  readonly userId: number;
  readonly name: string;
  readonly quoteVolume: number;
  readonly wonQuotes: number;
  readonly decidedQuotes: number;
  readonly conversion: number | null;
  readonly wonPremium: Money;
  readonly avgTurnaroundDays: number | null;
  readonly overdueFollowUps: number;
  readonly openPipelinePremium: Money;
  readonly hasActivity: boolean;
}

interface BrokerRollup {
  readonly brokerId: number;
  readonly name: string;
  readonly quoteVolume: number;
  readonly wonQuotes: number;
  readonly decidedQuotes: number;
  readonly conversion: number | null;
  readonly wonPremium: Money;
  readonly hasActivity: boolean;
}

export interface RmDashboardDeps {
  readonly db: DbExecutor;
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The lead-side predicates this dashboard applies through the shared contract.
 *
 * The RM dimension is ERASED here and re-applied separately via `accountableOwnerPredicate`,
 * because the shared predicate matches ANY assignment while this dashboard attributes by the `rm`
 * SLOT — see `owner.ts`. Erasing it explicitly is what stops both predicates being applied at once
 * (which would silently AND two different definitions of ownership together).
 */
function rmScopedFilter(filter: DashboardFilter): DashboardFilter {
  return { ...filter, rmUserId: undefined, teamOrRmId: undefined };
}

async function loadBrokers(
  db: DbExecutor,
  tenantId: TenantId,
  filter: DashboardFilter,
): Promise<RmBrokerMetaRow[]> {
  const brokerTypeId = filter.brokerTypeId ?? null;
  const brokerId = filter.brokerId ?? null;

  const { rows } = await sql<{ id: string; name: string }>`
    select b.id::text as id, b.name
      from brokers b
     where b.tenant_id = ${tenantId}
       and (${brokerTypeId}::bigint is null or b.broker_type_id = ${brokerTypeId}::bigint)
       and (${brokerId}::bigint is null or b.id = ${brokerId}::bigint)
     order by b.id
  `.execute(db);

  return rows.map((row) => ({ brokerId: Number(row.id), name: row.name }));
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
): Promise<RmLeadRow[]> {
  const breadth = breadthPredicate(tenantId, caller);
  const rmUserId = effectiveRmUserId(filter);
  const ownerPredicate =
    rmUserId === undefined ? sql<boolean>`true` : accountableOwnerPredicate(tenantId, rmUserId);

  // The current quoted premium comes from a LATERAL over the lead's CURRENT quote's CURRENT
  // version — one statement, not one per lead. `order by q.id` makes "which current quote" stable
  // if bad data ever left a lead with two (the reference degrades the same way rather than 500ing).
  const { rows } = await sql<{
    id: string;
    owner_user_id: string | null;
    first_name: string | null;
    last_name: string | null;
    broker_id: string | null;
    reporting_category: string | null;
    date_received: string;
    next_follow_up_date: string | null;
    estimated_premium: string | null;
    current_quoted_premium: string | null;
  }>`
    select l.id::text as id,
           owner.user_id::text as owner_user_id,
           owner.first_name,
           owner.last_name,
           l.broker_id::text as broker_id,
           s.reporting_category,
           l.date_received::text as date_received,
           l.next_follow_up_date::text as next_follow_up_date,
           l.estimated_premium::text as estimated_premium,
           current_quote.quoted_premium::text as current_quoted_premium
      from leads l
      join reference_items s on s.tenant_id = ${tenantId} and s.id = l.status_id
      ${accountableOwnerJoin(tenantId)}
      left join lateral (
        select v.quoted_premium
          from quotes q
          join quote_versions v
            on v.tenant_id = ${tenantId} and v.quote_id = q.id and v.is_current
         where q.tenant_id = ${tenantId} and q.lead_id = l.id and q.is_current
         order by q.id desc
         limit 1
      ) current_quote on true
     where ${leadFilterWhere(tenantId, rmScopedFilter(filter))}
       and ${ownerPredicate}
       and ${breadth ?? sql<boolean>`true`}
     order by l.id
  `.execute(db);

  return rows.map((row) => ({
    leadId: Number(row.id),
    ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id),
    ownerName:
      row.first_name === null && row.last_name === null
        ? null
        : `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    brokerId: row.broker_id === null ? null : Number(row.broker_id),
    reportingCategory: row.reporting_category ?? 'open',
    dateReceived: row.date_received,
    nextFollowUpDate: row.next_follow_up_date,
    estimatedPremium: row.estimated_premium,
    currentQuotedPremium: row.current_quoted_premium,
  }));
}

async function loadQuotes(
  db: DbExecutor,
  tenantId: TenantId,
  leads: readonly RmLeadRow[],
): Promise<RmQuoteRow[]> {
  if (leads.length === 0) return [];

  const leadIds = leads.map((lead) => lead.leadId);
  const byLead = new Map(leads.map((lead) => [lead.leadId, lead]));

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
        on v.tenant_id = ${tenantId} and v.quote_id = q.id and v.is_current
     where q.tenant_id = ${tenantId}
       and q.lead_id = any(${sql.val(leadIds)}::bigint[])
     order by q.id
  `.execute(db);

  return rows.map((row) => {
    const leadId = Number(row.lead_id);
    const lead = byLead.get(leadId);
    return {
      leadId,
      ownerUserId: lead?.ownerUserId ?? null,
      brokerId: lead?.brokerId ?? null,
      reportingCategory: row.reporting_category ?? 'open',
      currentPremium: row.current_premium ?? ZERO_MONEY,
      boundPremium: row.bound_premium,
      leadDateReceived: lead?.dateReceived ?? row.prepared_date,
      sentDate: row.sent_date,
    };
  });
}

function sumWonPremium(quotes: readonly RmQuoteRow[]): Money {
  return quotes
    .filter((quote) => quote.reportingCategory === 'won')
    .reduce<Money>((total, quote) => addMoney(total, quote.boundPremium ?? quote.currentPremium), ZERO_MONEY);
}

function turnaroundPairsOf(quotes: readonly RmQuoteRow[]): TurnaroundPair[] {
  return quotes
    .filter((quote) => quote.sentDate !== null)
    .map((quote) => ({ receivedDate: quote.leadDateReceived, sentDate: quote.sentDate as string }));
}

function isOverdue(lead: RmLeadRow, today: string): boolean {
  return (
    OPEN_CATEGORIES.includes(lead.reportingCategory) &&
    lead.nextFollowUpDate !== null &&
    lead.nextFollowUpDate < today
  );
}

function buildPerRmMetrics(
  leads: readonly RmLeadRow[],
  quotes: readonly RmQuoteRow[],
  today: string,
): RmMetrics[] {
  const leadsByRm = new Map<number, RmLeadRow[]>();
  for (const lead of leads) {
    if (lead.ownerUserId === null) continue;
    const bucket = leadsByRm.get(lead.ownerUserId);
    if (bucket === undefined) leadsByRm.set(lead.ownerUserId, [lead]);
    else bucket.push(lead);
  }

  const quotesByRm = new Map<number, RmQuoteRow[]>();
  for (const quote of quotes) {
    if (quote.ownerUserId === null) continue;
    const bucket = quotesByRm.get(quote.ownerUserId);
    if (bucket === undefined) quotesByRm.set(quote.ownerUserId, [quote]);
    else bucket.push(quote);
  }

  const rmIds = [...new Set([...quotesByRm.keys(), ...leadsByRm.keys()])];

  return rmIds.map((rmId) => {
    const rmLeads = leadsByRm.get(rmId) ?? [];
    const rmQuotes = quotesByRm.get(rmId) ?? [];

    const name = rmLeads.find((lead) => lead.ownerName !== null)?.ownerName ?? `RM ${String(rmId)}`;

    const wonQuotes = rmQuotes.filter((quote) => quote.reportingCategory === 'won').length;
    const lostQuotes = rmQuotes.filter((quote) => quote.reportingCategory === 'lost').length;
    const decidedQuotes = wonQuotes + lostQuotes;

    // Open pipeline per RM: the lead's current quoted premium if it reached a quote, else its
    // estimate. `?? 0.00` rather than skipping the lead, matching the reference.
    const openPipelinePremium = rmLeads
      .filter((lead) => OPEN_CATEGORIES.includes(lead.reportingCategory))
      .reduce<Money>(
        (total, lead) => addMoney(total, lead.currentQuotedPremium ?? lead.estimatedPremium ?? ZERO_MONEY),
        ZERO_MONEY,
      );

    return {
      userId: rmId,
      name,
      quoteVolume: rmQuotes.length,
      wonQuotes,
      decidedQuotes,
      conversion: conversionRate(wonQuotes, decidedQuotes),
      wonPremium: sumWonPremium(rmQuotes),
      avgTurnaroundDays: averageTurnaroundDays(turnaroundPairsOf(rmQuotes)),
      overdueFollowUps: rmLeads.filter((lead) => isOverdue(lead, today)).length,
      openPipelinePremium,
      hasActivity: rmQuotes.length > 0 || rmLeads.length > 0,
    };
  });
}

function buildPerBrokerRollup(
  brokers: readonly RmBrokerMetaRow[],
  leads: readonly RmLeadRow[],
  quotes: readonly RmQuoteRow[],
): BrokerRollup[] {
  const leadCounts = new Map<number, number>();
  for (const lead of leads) {
    if (lead.brokerId === null) continue;
    leadCounts.set(lead.brokerId, (leadCounts.get(lead.brokerId) ?? 0) + 1);
  }

  const quotesByBroker = new Map<number, RmQuoteRow[]>();
  for (const quote of quotes) {
    if (quote.brokerId === null) continue;
    const bucket = quotesByBroker.get(quote.brokerId);
    if (bucket === undefined) quotesByBroker.set(quote.brokerId, [quote]);
    else bucket.push(quote);
  }

  return brokers.map((meta) => {
    const brokerQuotes = quotesByBroker.get(meta.brokerId) ?? [];
    const wonQuotes = brokerQuotes.filter((quote) => quote.reportingCategory === 'won').length;
    const lostQuotes = brokerQuotes.filter((quote) => quote.reportingCategory === 'lost').length;
    const decidedQuotes = wonQuotes + lostQuotes;

    return {
      brokerId: meta.brokerId,
      name: meta.name,
      quoteVolume: brokerQuotes.length,
      wonQuotes,
      decidedQuotes,
      conversion: conversionRate(wonQuotes, decidedQuotes),
      wonPremium: sumWonPremium(brokerQuotes),
      hasActivity: brokerQuotes.length > 0 || (leadCounts.get(meta.brokerId) ?? 0) > 0,
    };
  });
}

/**
 * Tenant-wide follow-up compliance (`FollowUpCompliance`, :176-181).
 *
 * The open-commitment proxy, flagged by the reference: REQUIRED counts open leads carrying a next
 * follow-up date; ON TIME counts those whose date has not yet passed. Null when nothing was due —
 * undefined compliance, not a trivially perfect 100%.
 */
function tenantFollowUpCompliance(leads: readonly RmLeadRow[], today: string): number | null {
  const withCommitment = leads.filter(
    (lead) => OPEN_CATEGORIES.includes(lead.reportingCategory) && lead.nextFollowUpDate !== null,
  );
  const onTime = withCommitment.filter((lead) => (lead.nextFollowUpDate as string) >= today).length;
  return followUpCompliance(onTime, withCommitment.length);
}

function kpi(
  key: string,
  label: string,
  leadOrQuote: 'lead' | 'quote',
  kind: RmKpiDto['kind'],
  value: number | null,
  goodDirection: RmKpiDto['goodDirection'],
  drillWidgetKey: string,
): RmKpiDto {
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

export async function getRmPerformance(
  deps: RmDashboardDeps,
  actor: DashboardActor,
  filter: DashboardFilter,
  now: Date = new Date(),
): Promise<RmPerformanceDto> {
  const tenantId = actor.tenantId;
  const settings = await getTenantSettings(deps.db, tenantId);
  const slaTarget = settings.slaReceivedToSentDays;
  const today = todayUtc(now);

  const brokers = await loadBrokers(deps.db, tenantId, filter);

  // The broker-type narrowing happens IN THE QUERY, via the shared filter contract's `brokerTypeId`
  // predicate (an EXISTS over `brokers` on the lead's own broker). That reproduces both halves of
  // the reference's two-step — restrict to the type AND exclude unbrokered leads entirely
  // (`RmPerformanceStore` :62-65) — because a lead with no broker satisfies no EXISTS.
  //
  // The reference filtered in memory only because its store had already materialized the rows. A
  // second in-memory pass here would be dead code no test could distinguish from its own absence,
  // which is worse than no guard: it reads like the protection while the SQL does the work.
  const leads = await loadLeads(deps.db, tenantId, filter, callerOf(actor));

  const quotes = await loadQuotes(deps.db, tenantId, leads);

  const perRm = buildPerRmMetrics(leads, quotes, today);
  const perBroker = buildPerBrokerRollup(brokers, leads, quotes);
  const compliance = tenantFollowUpCompliance(leads, today);

  const wonQuotesTotal = quotes.filter((quote) => quote.reportingCategory === 'won').length;
  const decidedTotal = quotes.filter(
    (quote) => quote.reportingCategory === 'won' || quote.reportingCategory === 'lost',
  ).length;
  const brokerWon = perBroker.reduce((total, broker) => total + broker.wonQuotes, 0);
  const brokerDecided = perBroker.reduce((total, broker) => total + broker.decidedQuotes, 0);

  const kpis: RmKpiDto[] = [
    kpi('active_rms', 'Active RMs', 'lead', 'count', perRm.filter((rm) => rm.hasActivity).length, 'higherIsBetter', RM_WIDGET_KEYS.leads),
    kpi(
      'active_brokers',
      'Active Brokers',
      'lead',
      'count',
      perBroker.filter((broker) => broker.hasActivity).length,
      'higherIsBetter',
      RM_WIDGET_KEYS.leads,
    ),
    kpi('won_premium_ytd', 'Won Premium YTD', 'quote', 'currency', Number(sumWonPremium(quotes)), 'higherIsBetter', RM_WIDGET_KEYS.won),
    kpi('rm_conversion_rate', 'RM Conversion Rate', 'quote', 'percent', conversionRate(wonQuotesTotal, decidedTotal), 'higherIsBetter', RM_WIDGET_KEYS.won),
    kpi('broker_conversion_rate', 'Broker Conversion Rate', 'quote', 'percent', conversionRate(brokerWon, brokerDecided), 'higherIsBetter', RM_WIDGET_KEYS.won),
    kpi('follow_up_compliance', 'Follow-up Compliance', 'lead', 'percent', compliance, 'higherIsBetter', RM_WIDGET_KEYS.overdue),
  ];

  const activeRms = perRm.filter((rm) => rm.hasActivity);

  const topRms = [...activeRms]
    .sort(
      (left, right) =>
        compareMoney(right.wonPremium, left.wonPremium) ||
        (right.conversion ?? -1) - (left.conversion ?? -1) ||
        ordinal(left.name, right.name) ||
        left.userId - right.userId,
    )
    .map((rm) => ({
      rmUserId: rm.userId,
      rmName: rm.name,
      quoteVolume: rm.quoteVolume,
      wonPremium: Number(rm.wonPremium),
      conversionRate: rm.conversion,
      drillWidgetKey: RM_WIDGET_KEYS.leads,
    }));

  const plottedBrokers = perBroker.filter((broker) => broker.quoteVolume > 0);
  const volumeSplit = median(plottedBrokers.map((broker) => broker.quoteVolume));
  const conversionSplit = median(
    plottedBrokers
      .filter((broker) => broker.conversion !== null)
      .map((broker) => broker.conversion as number),
  );

  const topBrokers = [...plottedBrokers]
    .sort(
      (left, right) =>
        compareMoney(right.wonPremium, left.wonPremium) ||
        (right.conversion ?? -1) - (left.conversion ?? -1) ||
        ordinal(left.name, right.name),
    )
    .map((broker) => ({
      brokerId: broker.brokerId,
      brokerName: broker.name,
      quoteVolume: broker.quoteVolume,
      wonPremium: Number(broker.wonPremium),
      conversionRate: broker.conversion,
      drillWidgetKey: RM_WIDGET_KEYS.quotes,
    }));

  const matrixPoints = [...plottedBrokers]
    .sort((left, right) => right.quoteVolume - left.quoteVolume || ordinal(left.name, right.name))
    .map((broker) => ({
      brokerId: broker.brokerId,
      brokerName: broker.name,
      quoteVolume: broker.quoteVolume,
      conversionRate: broker.conversion,
      wonPremium: Number(broker.wonPremium),
      quadrant: classifyQuadrant(broker.quoteVolume, broker.conversion, volumeSplit, conversionSplit),
      drillWidgetKey: RM_WIDGET_KEYS.quotes,
    }));

  // Slowest first. A null turnaround sorts LAST (the reference's `?? double.MinValue`), so RMs with
  // nothing to grade sit below every graded one rather than heading the chart.
  const turnaroundRows = [...activeRms]
    .sort(
      (left, right) =>
        (right.avgTurnaroundDays ?? Number.NEGATIVE_INFINITY) -
          (left.avgTurnaroundDays ?? Number.NEGATIVE_INFINITY) ||
        ordinal(left.name, right.name) ||
        left.userId - right.userId,
    )
    .map((rm) => ({
      rmUserId: rm.userId,
      rmName: rm.name,
      avgTurnaroundDays: rm.avgTurnaroundDays,
      // Derived through the SHARED `slaStatus()` rather than by rewriting `> slaTarget` here.
      //
      // The two are equivalent by construction — `slaStatus` returns `breached` exactly when the
      // turnaround is non-null and STRICTLY greater than the target — but routing through it means
      // the strictly-greater boundary has ONE home, already pinned by
      // `tests/unit/metric-definitions.test.ts` (`slaStatus(3, 3) === 'on_track'`). Written inline,
      // an off-by-one to `>=` here would be unfalsifiable without a seeded RM whose average
      // turnaround lands exactly on the tenant's target.
      //
      // It is also where the tri-state collapses to the wire's two fields: `unknown` (no quote to
      // grade) is NOT `breached`, so it renders `beyondTarget: false` alongside a null
      // `avgTurnaroundDays` — no bar, no breach marker. See the file header.
      beyondTarget: slaStatus(rm.avgTurnaroundDays, slaTarget) === 'breached',
      drillWidgetKey: RM_WIDGET_KEYS.quotes,
    }));

  const conversionMedian = median(
    activeRms.filter((rm) => rm.conversion !== null).map((rm) => rm.conversion as number),
  );
  const volumeMedian = median(activeRms.map((rm) => rm.quoteVolume));
  const wonPremiumMedian = median(activeRms.map((rm) => Number(rm.wonPremium)));

  const watchlist = activeRms
    .map((rm) => {
      const action = evaluateSuggestedAction({
        conversion: rm.conversion,
        conversionMedian,
        volume: rm.quoteVolume,
        volumeMedian,
        wonPremium: rm.wonPremium,
        wonPremiumMedian: wonPremiumMedian.toFixed(2),
        avgTurnaroundDays: rm.avgTurnaroundDays,
        turnaroundTargetDays: slaTarget,
        overdueFollowUps: rm.overdueFollowUps,
      });

      return {
        row: {
          rmUserId: rm.userId,
          name: rm.name,
          quoteVolume: rm.quoteVolume,
          wonPremium: Number(rm.wonPremium),
          conversionRate: rm.conversion,
          avgTurnaroundDays: rm.avgTurnaroundDays,
          overdueFollowUps: rm.overdueFollowUps,
          suggestedAction: {
            label: suggestedActionLabel(action),
            tone: suggestedActionTone(action),
          },
          drillWidgetKey: RM_WIDGET_KEYS.leads,
        },
        severity: suggestedActionSeverity(action),
      };
    })
    .sort(
      (left, right) =>
        right.severity - left.severity ||
        right.row.overdueFollowUps - left.row.overdueFollowUps ||
        ordinal(left.row.name, right.row.name) ||
        left.row.rmUserId - right.row.rmUserId,
    )
    .map((entry) => entry.row);

  const insights = generateLeadershipInsights({
    rms: activeRms.map((rm) => ({
      name: rm.name,
      conversion: rm.conversion,
      volume: rm.quoteVolume,
      wonPremium: rm.wonPremium,
      avgTurnaroundDays: rm.avgTurnaroundDays,
      overdueFollowUps: rm.overdueFollowUps,
      openPipelinePremium: rm.openPipelinePremium,
    })),
    brokers: perBroker
      .filter((broker) => broker.hasActivity)
      .map((broker) => ({
        name: broker.name,
        conversion: broker.conversion,
        volume: broker.quoteVolume,
        wonPremium: broker.wonPremium,
        avgTurnaroundDays: null,
        overdueFollowUps: 0,
        openPipelinePremium: ZERO_MONEY,
      })),
    turnaroundTargetDays: slaTarget,
    followUpCompliance: compliance,
    currencyCode: settings.currencyCode,
  });

  return {
    currencyCode: settings.currencyCode,
    kpis,
    topRms,
    topBrokers,
    brokerMatrix: {
      points: matrixPoints,
      volumeSplit,
      conversionSplit,
      drillWidgetKey: RM_WIDGET_KEYS.quotes,
    },
    turnaroundByRm: {
      rows: turnaroundRows,
      slaTargetDays: slaTarget,
      drillWidgetKey: RM_WIDGET_KEYS.quotes,
    },
    watchlist,
    insights,
  };
}
