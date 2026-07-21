/**
 * The Loss Analysis dashboard (T-037; AC-074, AC-075, AC-078, AC-079; spec FR-59, AC-058, PRD 16).
 *
 * Port of `GetLossAnalysisQueryHandler.cs` + `LossAnalysisStore.cs`.
 *
 * WHAT A "LOSS" COUNTS — STATED, BECAUSE CLAUDE.md REQUIRES IT AND THE LABELS DISAGREE
 * ===================================================================================
 * This dashboard operates on LOST LEADS: leads whose status maps to the `lost` reporting category
 * (`LostLeadQuery` :143). It does NOT count lost quotes, and the two are different populations —
 * a lead can lose after three quotes, or before any quote at all.
 *
 *  - Lost Premium is PREMIUM. Per lead it is the current quoted premium if the lead reached a
 *    quote, else the estimated premium (:46-48). There is no bound premium on a lost lead, and the
 *    "quoted-until-quoted, then estimated" precedence is the same projection the Leads list premium
 *    column uses, inverted for the lost side.
 *  - Quotes Lost is a COUNT OF LEADS despite the PRD's label. The reference flagged exactly this
 *    and carried it as a LEAD metric so the FR-54 lead-vs-quote labelling stays honest; the payload
 *    below does the same, and the integration suite asserts the `leadOrQuote: 'lead'` marking
 *    rather than only the number.
 *  - Avg Price Gap is a RATE over the SUBSET of lost records carrying a positive competitor
 *    premium, marked as a quote metric.
 *
 * DISABLED LOST REASONS MUST STILL RESOLVE (P-04). The reason join is a LEFT JOIN with NO
 * `is_active` predicate. A tenant retires a reason after using it for years; filtering on active
 * would silently drop those historical leads' premium from every reason bar while the row counts
 * still looked plausible. Asserted directly in `dashboard-loss.test.ts`.
 *
 * A LOST LEAD WITH NO REASON IS `Unspecified`, not dropped (:58). Dropping it would make the reason
 * bars sum to LESS than the Lost Premium KPI — two numbers on one screen that do not reconcile.
 *
 * OTHER MEASURED BEHAVIOURS PRESERVED
 * ===================================
 *  - the RM dimension is the ACCOUNTABLE OWNER (`rm` slot) — see `owner.ts`;
 *  - `brokerTypeId` IS ACCEPTED AND IGNORED: `LossAnalysisStore` applies product line, broker,
 *    region, the received-date window and the RM owner, and no broker-type predicate anywhere.
 *    FLAGGED rather than implemented, for the same reason as Broker Performance;
 *  - the six-month trend buckets by DECISION date and anchors on the filter's upper bound, falling
 *    back to the current UTC month. A lost lead with no decision date contributes to the KPI total
 *    and to NO month — deliberate, and asserted;
 *  - there is NO Win-back Potential card (spec §2's explicit PRD 16.0 exclusion).
 *
 * QUERY BUDGET (N-04/AC-079): two statements, none per-row.
 */
import { sql } from 'kysely';

import { getTenantSettings } from '../business-rules/service.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { averagePriceGap, type PriceGapPair } from './metrics/index.js';
import { ZERO_MONEY, addMoney, compareMoney, type Money } from './money.js';
import { breadthPredicate, leadFilterWhere, type DashboardFilter, effectiveRmUserId } from './filters.js';
import { callerOf, type DashboardActor } from './executive.service.js';
import type { DashboardCaller } from './snapshot.js';
import { accountableOwnerPredicate } from './owner.js';

/** `LossWidgetKeys` (:18-23). */
export const LOSS_WIDGET_KEYS = {
  countByReason: 'loss.count_by_reason',
  trendByReason: 'loss.trend_by_reason',
  byCoverType: 'loss.by_cover_type',
  byBroker: 'loss.by_broker',
  byRm: 'loss.by_rm',
  priceGap: 'loss.price_gap',
} as const;

/** `LossAnalysisStore` :58 — the placeholder for a lost lead carrying no reason. */
export const UNSPECIFIED_LOSS_REASON = 'Unspecified';

/** `TrendMonths` / `CommentaryLimit` / `LossReasonChipTone` (:44-46). */
const TREND_MONTHS = 6;
const COMMENTARY_LIMIT = 8;
const LOSS_REASON_CHIP_TONE = 'danger';

export interface LossKpiDto {
  readonly key: string;
  readonly label: string;
  readonly leadOrQuote: 'lead' | 'quote';
  readonly kind: 'currency' | 'percent' | 'count' | 'text';
  readonly value: number | null;
  readonly textValue: string | null;
  readonly delta: number | null;
  readonly goodDirection: 'higherIsBetter' | 'lowerIsBetter';
  readonly isFavorableDelta: boolean | null;
  readonly drillWidgetKey: string;
}

export interface LostPremiumByReasonRowDto {
  readonly reasonName: string;
  readonly amount: number;
  readonly drillWidgetKey: string;
}

export interface LostPremiumByProductLineRowDto {
  readonly productLineName: string;
  readonly amount: number;
  readonly drillWidgetKey: string;
}

export interface LossTrendPointDto {
  readonly monthLabel: string;
  readonly amount: number;
}

export interface CompetitorAnalysisRowDto {
  readonly competitor: string;
  readonly dealsLost: number;
  readonly premiumLost: number;
  readonly avgPriceGapPct: number | null;
  readonly drillWidgetKey: string;
}

export interface LossCommentaryItemDto {
  readonly leadId: number;
  readonly client: string;
  readonly productLineName: string;
  readonly comment: string | null;
  readonly lossReasonName: string;
  readonly lossReasonTone: string;
  readonly premium: number;
  readonly drillWidgetKey: string;
}

export interface LossAnalysisDto {
  readonly currencyCode: string;
  readonly kpis: readonly LossKpiDto[];
  readonly lostPremiumByReason: {
    readonly rows: readonly LostPremiumByReasonRowDto[];
    readonly drillWidgetKey: string;
  };
  readonly lostPremiumTrend: {
    readonly points: readonly LossTrendPointDto[];
    readonly drillWidgetKey: string;
  };
  readonly lostPremiumByProductLine: {
    readonly rows: readonly LostPremiumByProductLineRowDto[];
    readonly drillWidgetKey: string;
  };
  readonly competitorAnalysis: {
    readonly rows: readonly CompetitorAnalysisRowDto[];
    readonly drillWidgetKey: string;
  };
  readonly lossCommentary: { readonly items: readonly LossCommentaryItemDto[] };
}

/** One lost lead, already projected (`LossLeadSnapshot`). */
interface LostLead {
  readonly leadId: number;
  readonly partyName: string;
  readonly productLineName: string;
  readonly lostReasonName: string;
  readonly competitor: string | null;
  readonly competitorPremium: Money | null;
  readonly lossComments: string | null;
  /** `yyyy-MM-dd`, or null when the loss was never formally decided. */
  readonly decisionDate: string | null;
  readonly lostPremium: Money;
}

export interface LossDashboardDeps {
  readonly db: DbExecutor;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * `brokerTypeId` is erased for the same reason as on Broker Performance — see the file header.
 * The RM dimension is erased here and re-applied through `accountableOwnerPredicate`.
 */
function lossScopedFilter(filter: DashboardFilter): DashboardFilter {
  return { ...filter, rmUserId: undefined, teamOrRmId: undefined, brokerTypeId: undefined };
}


/**
 * BREADTH NARROWS THIS AGGREGATE, NOT ONLY THE DRILL (AC-076, T-050).
 *
 * Without `leads.view_all` the caller sees only the leads they are assigned to — applied HERE, in
 * the lead query, before any aggregation. After a sum there is no way back: you cannot subtract the
 * rows the caller should not have seen. Applying it only to the drill would leave a headline the
 * user cannot reconcile by clicking it.
 */
async function loadLostLeads(
  db: DbExecutor,
  tenantId: TenantId,
  filter: DashboardFilter,
  caller: DashboardCaller,
): Promise<LostLead[]> {
  const breadth = breadthPredicate(tenantId, caller);
  const rmUserId = effectiveRmUserId(filter);
  const ownerPredicate =
    rmUserId === undefined ? sql<boolean>`true` : accountableOwnerPredicate(tenantId, rmUserId);

  const { rows } = await sql<{
    id: string;
    party_name: string;
    product_line_name: string;
    lost_reason_name: string | null;
    competitor: string | null;
    competitor_premium: string | null;
    loss_comments: string | null;
    decision_date: string | null;
    estimated_premium: string | null;
    current_quoted_premium: string | null;
  }>`
    select l.id::text as id,
           p.name as party_name,
           pl.name as product_line_name,
           lr.name as lost_reason_name,
           l.competitor,
           l.competitor_premium::text as competitor_premium,
           l.loss_comments,
           to_char(l.decision_date at time zone 'UTC', 'YYYY-MM-DD') as decision_date,
           l.estimated_premium::text as estimated_premium,
           current_quote.quoted_premium::text as current_quoted_premium
      from leads l
      join reference_items s on s.tenant_id = ${tenantId} and s.id = l.status_id
      join parties p on p.tenant_id = ${tenantId} and p.id = l.party_id
      join reference_items pl on pl.tenant_id = ${tenantId} and pl.id = l.product_line_id
      left join reference_items lr on lr.tenant_id = ${tenantId} and lr.id = l.lost_reason_id
      left join lateral (
        select v.quoted_premium
          from quotes q
          join quote_versions v
            on v.tenant_id = ${tenantId} and v.quote_id = q.id and v.is_current
         where q.tenant_id = ${tenantId} and q.lead_id = l.id and q.is_current
         order by q.id desc
         limit 1
      ) current_quote on true
     where ${leadFilterWhere(tenantId, lossScopedFilter(filter))}
       and s.reporting_category = 'lost'
       and ${ownerPredicate}
       and ${breadth ?? sql<boolean>`true`}
     order by l.id
  `.execute(db);

  return rows.map((row) => ({
    leadId: Number(row.id),
    partyName: row.party_name,
    productLineName: row.product_line_name,
    lostReasonName: row.lost_reason_name ?? UNSPECIFIED_LOSS_REASON,
    competitor: row.competitor,
    competitorPremium: row.competitor_premium,
    lossComments: row.loss_comments,
    decisionDate: row.decision_date,
    // Quoted-then-estimated-then-zero, exactly as the reference projects it.
    lostPremium: row.current_quoted_premium ?? row.estimated_premium ?? ZERO_MONEY,
  }));
}

/** The pairs the price-gap average consumes — only records with a POSITIVE competitor premium. */
function priceGapPairs(lost: readonly LostLead[]): PriceGapPair[] {
  return lost
    .filter(
      (lead) => lead.competitorPremium !== null && compareMoney(lead.competitorPremium, ZERO_MONEY) > 0,
    )
    .map((lead) => ({
      ourPremium: lead.lostPremium,
      competitorPremium: lead.competitorPremium as Money,
    }));
}

/** Exact total over `bigint` cents; the widening to `number` happens only at the DTO boundary. */
function totalPremium(lost: readonly LostLead[]): Money {
  return lost.reduce<Money>((total, lead) => addMoney(total, lead.lostPremium), ZERO_MONEY);
}

/** Groups by a key, summing premium exactly, and orders amount-descending then key-ascending. */
function groupByPremium(
  lost: readonly LostLead[],
  keyOf: (lead: LostLead) => string,
): Array<{ key: string; amount: Money }> {
  const totals = new Map<string, Money>();
  for (const lead of lost) {
    const key = keyOf(lead);
    totals.set(key, addMoney(totals.get(key) ?? ZERO_MONEY, lead.lostPremium));
  }

  return [...totals.entries()]
    .map(([key, amount]) => ({ key, amount }))
    .sort((left, right) => compareMoney(right.amount, left.amount) || ordinal(left.key, right.key));
}

/** The modal value of a projection, ties broken by name so the KPI is stable across requests. */
function modeOf(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (
    [...counts.entries()].sort((left, right) => right[1] - left[1] || ordinal(left[0], right[0]))[0]?.[0] ??
    null
  );
}

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `month.ToString("MMM yy", InvariantCulture)` — e.g. `Mar 26`. */
function monthLabel(year: number, monthIndex: number): string {
  return `${MONTH_ABBREVIATIONS[monthIndex] as string} ${String(year % 100).padStart(2, '0')}`;
}

function buildTrend(
  lost: readonly LostLead[],
  filter: DashboardFilter,
  now: Date,
): LossTrendPointDto[] {
  // Anchored on the filter's upper bound when set, else the current UTC month (:149).
  const anchorSource = filter.to ?? now.toISOString().slice(0, 10);
  const anchorYear = Number(anchorSource.slice(0, 4));
  const anchorMonth = Number(anchorSource.slice(5, 7)) - 1;

  const byMonth = new Map<string, Money>();
  for (const lead of lost) {
    if (lead.decisionDate === null) continue;
    const key = lead.decisionDate.slice(0, 7);
    byMonth.set(key, addMoney(byMonth.get(key) ?? ZERO_MONEY, lead.lostPremium));
  }

  const points: LossTrendPointDto[] = [];
  for (let offset = TREND_MONTHS - 1; offset >= 0; offset -= 1) {
    const month = new Date(Date.UTC(anchorYear, anchorMonth - offset, 1));
    const key = month.toISOString().slice(0, 7);
    points.push({
      monthLabel: monthLabel(month.getUTCFullYear(), month.getUTCMonth()),
      amount: Number(byMonth.get(key) ?? ZERO_MONEY),
    });
  }

  return points;
}

function kpi(
  key: string,
  label: string,
  leadOrQuote: 'lead' | 'quote',
  kind: LossKpiDto['kind'],
  value: number | null,
  textValue: string | null,
  drillWidgetKey: string,
): LossKpiDto {
  // Every Loss KPI is lower-is-better and carries a null delta: no prior-period baseline is
  // derived, matching the Pipeline/Broker/RM precedent. The direction is still set so a falling
  // delta renders green once a baseline exists.
  return {
    key,
    label,
    leadOrQuote,
    kind,
    value,
    textValue,
    delta: null,
    goodDirection: 'lowerIsBetter',
    isFavorableDelta: null,
    drillWidgetKey,
  };
}

export async function getLossAnalysis(
  deps: LossDashboardDeps,
  actor: DashboardActor,
  filter: DashboardFilter,
  now: Date = new Date(),
): Promise<LossAnalysisDto> {
  const tenantId = actor.tenantId;
  const settings = await getTenantSettings(deps.db, tenantId);
  const lost = await loadLostLeads(deps.db, tenantId, filter, callerOf(actor));

  const withCompetitor = lost.filter(
    (lead) => lead.competitor !== null && lead.competitor.trim().length > 0,
  );

  const competitorRows = groupByPremium(withCompetitor, (lead) => lead.competitor as string).map(
    (group) => {
      const members = withCompetitor.filter((lead) => lead.competitor === group.key);
      return {
        competitor: group.key,
        dealsLost: members.length,
        premiumLost: Number(group.amount),
        avgPriceGapPct: averagePriceGap(priceGapPairs(members)),
        drillWidgetKey: LOSS_WIDGET_KEYS.countByReason,
      };
    },
  );

  return {
    currencyCode: settings.currencyCode,
    kpis: [
      kpi('lost_premium', 'Lost Premium', 'lead', 'currency', Number(totalPremium(lost)), null, LOSS_WIDGET_KEYS.countByReason),
      kpi('quotes_lost', 'Quotes Lost', 'lead', 'count', lost.length, null, LOSS_WIDGET_KEYS.countByReason),
      kpi(
        'top_loss_reason',
        'Top Loss Reason',
        'lead',
        'text',
        null,
        modeOf(lost.map((lead) => lead.lostReasonName)),
        LOSS_WIDGET_KEYS.countByReason,
      ),
      kpi('avg_price_gap', 'Avg Price Gap', 'quote', 'percent', averagePriceGap(priceGapPairs(lost)), null, LOSS_WIDGET_KEYS.priceGap),
      kpi(
        'top_competitor',
        'Top Competitor',
        'lead',
        'text',
        null,
        modeOf(withCompetitor.map((lead) => lead.competitor as string)),
        LOSS_WIDGET_KEYS.countByReason,
      ),
    ],
    lostPremiumByReason: {
      rows: groupByPremium(lost, (lead) => lead.lostReasonName).map((group) => ({
        reasonName: group.key,
        amount: Number(group.amount),
        drillWidgetKey: LOSS_WIDGET_KEYS.countByReason,
      })),
      drillWidgetKey: LOSS_WIDGET_KEYS.countByReason,
    },
    lostPremiumTrend: {
      points: buildTrend(lost, filter, now),
      drillWidgetKey: LOSS_WIDGET_KEYS.trendByReason,
    },
    lostPremiumByProductLine: {
      rows: groupByPremium(lost, (lead) => lead.productLineName).map((group) => ({
        productLineName: group.key,
        amount: Number(group.amount),
        drillWidgetKey: LOSS_WIDGET_KEYS.byCoverType,
      })),
      drillWidgetKey: LOSS_WIDGET_KEYS.byCoverType,
    },
    competitorAnalysis: {
      // Ranked by deals lost, then premium, then name — the reference's ordering.
      rows: [...competitorRows].sort(
        (left, right) =>
          right.dealsLost - left.dealsLost ||
          right.premiumLost - left.premiumLost ||
          ordinal(left.competitor, right.competitor),
      ),
      drillWidgetKey: LOSS_WIDGET_KEYS.countByReason,
    },
    lossCommentary: {
      // Most recently decided first; a lead with NO decision date sorts last rather than first,
      // which a naive descending sort on a null would do.
      items: [...lost]
        .sort(
          (left, right) =>
            ordinal(right.decisionDate ?? '', left.decisionDate ?? '') || right.leadId - left.leadId,
        )
        .slice(0, COMMENTARY_LIMIT)
        .map((lead) => ({
          leadId: lead.leadId,
          client: lead.partyName,
          productLineName: lead.productLineName,
          comment: lead.lossComments,
          lossReasonName: lead.lostReasonName,
          lossReasonTone: LOSS_REASON_CHIP_TONE,
          premium: Number(lead.lostPremium),
          drillWidgetKey: LOSS_WIDGET_KEYS.countByReason,
        })),
    },
  };
}
