/**
 * THE METRIC DEFINITIONS (T-035; AC-073; V-091; spec P-10, §9.6, Q-4, Q-5, AC-080).
 *
 * Port of `src/api/QuoteIQ.Domain/Metrics/MetricDefinitions.cs` and
 * `src/api/QuoteIQ.Domain/Alerts/ExecutiveEscalationRule.cs`, plus the two aging-bucket schemes and
 * the SLA grading that the reference left inlined in its dashboard handlers.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR WHAT THE BUSINESS REPORTS
 * ====================================================================
 * Everything here is a PURE function over already-aggregated inputs: no I/O, no tenant context, no
 * clock — every "now" is passed in. That is what lets the same definition be asserted by a unit
 * test and by a SQL aggregation over the same fixture (AC-074): if the formula lived inline in a
 * query, "the SQL agrees with the definition" would be unfalsifiable, because the query WOULD BE
 * the definition.
 *
 * MONEY IS A STRING, RATES ARE NUMBERS, AND THAT SPLIT IS DELIBERATE
 * =================================================================
 * Money in and money out is a `numeric(18,2)` decimal string handled by `../money.js` on exact
 * bigint cents. A RATE is not money — it is a dimensionless ratio the UI renders as a percentage —
 * so rates return `number`, computed as one division of two exact integers. One division cannot
 * accumulate error; a running double sum can, which is why no total is ever computed that way.
 *
 * EVERY ZERO-DENOMINATOR RETURNS null, NOT 0, AND THAT IS A DOCUMENTED BUSINESS DECISION
 * =====================================================================================
 * Inherited verbatim from the reference, whose XML docs state the reasoning per formula: a 0%
 * conversion rate reads as "we lost every deal" when the truth is "nothing has been decided yet",
 * and the UI renders an em dash for null. Sums are the exception — `openPipelinePremium` returns
 * 0.00, never null, because its KPI card always renders a currency figure.
 */
import {
  ZERO_MONEY,
  formatMoney,
  parseMoney,
  sumMoney,
  type Money,
} from '../money.js';

// ---------------------------------------------------------------------------------------------
// Rates and averages — MetricDefinitions.cs, ported one-for-one.
// ---------------------------------------------------------------------------------------------

/** Exact ratio of two counts, or null when the denominator is not a positive population. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Q-4 CONVERSION RATE / QUOTE-TO-WIN (MetricDefinitions.cs:23-31): won QUOTES divided by DECIDED
 * QUOTES (won + lost).
 *
 * "Decided" is the caller's denominator, not this function's business: the caller decides which
 * categories count, and — per the reference and V-091 — expired/withdrawn quotes are NOT decided
 * even though they carry a decision date. Counting them would inflate the denominator and
 * understate the win rate.
 *
 * Null when nothing has been decided (see the file header).
 */
export function conversionRate(wonQuotes: number, decidedQuotes: number): number | null {
  return ratio(wonQuotes, decidedQuotes);
}

/** Alias carrying the product's own label. Same function; see `METRIC_CATALOG.quoteToWinRate`. */
export const quoteToWinRate = conversionRate;

/**
 * LEAD-TO-QUOTE RATE (MetricDefinitions.cs:38-46): LEADS that received at least one formal quote,
 * divided by eligible LEADS. Both sides count leads — never quotes — so a lead with three quotes
 * still counts once.
 */
export function leadToQuoteRate(leadsWithQuote: number, eligibleLeads: number): number | null {
  return ratio(leadsWithQuote, eligibleLeads);
}

/**
 * Q-5 QUOTE-TO-PROPOSAL RATE (MetricDefinitions.cs:55-63): quotes that reached Quote Sent divided
 * by TOTAL QUOTES.
 *
 * Q-5 explicitly resolved the PRD's "leads or quotes, depending on agreed business definition"
 * ambiguity in favour of the QUOTE denominator. That is the whole content of this function — the
 * arithmetic is trivial, the denominator choice is not — so it is named rather than inlined.
 */
export function quoteToProposalRate(quotesSent: number, totalQuotes: number): number | null {
  return ratio(quotesSent, totalQuotes);
}

/** PROPOSAL-TO-WIN RATE (MetricDefinitions.cs:70-78): won quotes over quotes that reached sent. */
export function proposalToWinRate(wonQuotes: number, sentQuotes: number): number | null {
  return ratio(wonQuotes, sentQuotes);
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * AVERAGE LEAD AGE (MetricDefinitions.cs:86-94): mean days since date received over currently-open
 * LEADS. Null on an empty population rather than 0, which would read as "leads are brand new".
 */
export function averageLeadAgeDays(openLeadAgesDays: readonly number[]): number | null {
  return average(openLeadAgesDays);
}

/** AVERAGE QUOTE AGE (MetricDefinitions.cs:101-109): the same, over currently-open QUOTES. */
export function averageQuoteAgeDays(openQuoteAgesDays: readonly number[]): number | null {
  return average(openQuoteAgesDays);
}

/** A sent quote's lead-received and quote-sent dates, both `yyyy-MM-dd`. */
export interface TurnaroundPair {
  readonly receivedDate: string;
  readonly sentDate: string;
}

/** Whole days between two `yyyy-MM-dd` dates — UTC midnights, so no DST or clock-time drift. */
export function dayDifference(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * AVERAGE TURNAROUND (MetricDefinitions.cs:119-132): mean days from lead received to quote sent,
 * over quotes that have ACTUALLY BEEN SENT.
 *
 * Pairs whose sent date precedes the received date are defensively DROPPED, exactly as the
 * reference does. FR-46's date-consistency validation should make them impossible, but this
 * function must not turn one bad upstream row into a negative average — a negative turnaround is
 * not merely wrong, it is nonsense that would be read as spectacular performance.
 */
export function averageTurnaroundDays(pairs: readonly TurnaroundPair[]): number | null {
  const validDays = pairs
    .filter((pair) => pair.sentDate >= pair.receivedDate)
    .map((pair) => dayDifference(pair.receivedDate, pair.sentDate));
  return average(validDays);
}

/**
 * FOLLOW-UP COMPLIANCE (MetricDefinitions.cs:140-148): follow-ups completed by or before their
 * next-follow-up date, over required follow-ups. Null when nothing was due — undefined compliance,
 * NOT a trivially perfect 100%.
 */
export function followUpCompliance(
  onTimeFollowUps: number,
  requiredFollowUps: number,
): number | null {
  return ratio(onTimeFollowUps, requiredFollowUps);
}

/** One lost record's own premium against the competitor's, both `numeric(18,2)` strings. */
export interface PriceGapPair {
  readonly ourPremium: Money;
  readonly competitorPremium: Money;
}

/**
 * AVERAGE PRICE GAP (MetricDefinitions.cs:163-176, FR-59): mean of `(ours - theirs) / theirs` over
 * ONLY the lost records whose competitor premium is actually known. Positive means we quoted above
 * the competitor.
 *
 * Pairs with a zero or negative competitor premium are excluded so a bad upstream value can never
 * divide by zero or invert the sign. Null when no pair is usable — 0% would misleadingly read as
 * "we were priced identically to the competition".
 *
 * SQL PARITY (AC-074). Each gap is computed on exact cents and truncated to `PRICE_GAP_SCALE`
 * digits BEFORE averaging, so the canonical SQL fragment
 *   `avg(trunc((our_premium - competitor_premium) / competitor_premium, 12))`
 * reproduces this exactly rather than to within a rounding mode. Averaging raw doubles here would
 * make that equality depend on summation order.
 */
export const PRICE_GAP_SCALE = 12;
const PRICE_GAP_UNIT = 10n ** BigInt(PRICE_GAP_SCALE);

export function averagePriceGap(pairs: readonly PriceGapPair[]): number | null {
  const gaps: bigint[] = [];
  for (const pair of pairs) {
    const competitor = parseMoney(pair.competitorPremium);
    if (competitor <= 0n) continue;
    const ours = parseMoney(pair.ourPremium);
    // Truncation toward zero, matching Postgres `trunc`.
    gaps.push(((ours - competitor) * PRICE_GAP_UNIT) / competitor);
  }

  if (gaps.length === 0) return null;

  const total = gaps.reduce((sum, gap) => sum + gap, 0n);
  return Number(total) / (Number(PRICE_GAP_UNIT) * gaps.length);
}

// ---------------------------------------------------------------------------------------------
// Premium totals — Quoted Premium and Bound Premium are DIFFERENT NUMBERS (CLAUDE.md, AC-073).
// ---------------------------------------------------------------------------------------------

/**
 * QUOTED PREMIUM: the total premium we QUOTED, i.e. the sum of each quote's current version's
 * `quoted_premium`. Says nothing about whether any of it was won.
 */
export function quotedPremiumTotal(amounts: readonly Money[]): Money {
  return sumMoney(amounts);
}

/** A won quote's bound amount, with the quoted amount as the documented fallback. */
export interface BoundPremiumRow {
  readonly boundPremium: Money | null;
  readonly currentPremium: Money;
}

/**
 * BOUND PREMIUM: the total premium actually BOUND, over won quotes.
 *
 * `boundPremium ?? currentPremium` is measured from the reference
 * (GetExecutiveOverviewQueryHandler.cs:136), not invented: `quotes.bound_premium` is nullable, and
 * a won quote that never had one recorded still bound business at the quoted figure. Treating a
 * null as 0.00 would silently under-report Won Premium for exactly those tenants who do not
 * capture the bound amount separately.
 */
export function boundPremiumTotal(rows: readonly BoundPremiumRow[]): Money {
  return sumMoney(rows.map((row) => row.boundPremium ?? row.currentPremium));
}

/**
 * OPEN PIPELINE PREMIUM (MetricDefinitions.cs:184-185): quoted premium for open QUOTES plus
 * estimated premium for open LEADS THAT DO NOT YET HAVE A QUOTE.
 *
 * The "do not yet have a quote" half is the caller's responsibility and is the easy thing to get
 * wrong: adding every open lead's estimate would double-count the leads whose quote is already in
 * the first term. Unlike the rates above this is a sum, so it returns 0.00 and never null.
 */
export function openPipelinePremium(
  openQuotePremium: Money,
  openLeadEstimatedPremium: Money,
): Money {
  return formatMoney(parseMoney(openQuotePremium) + parseMoney(openLeadEstimatedPremium));
}

// ---------------------------------------------------------------------------------------------
// Aging buckets — TWO SCHEMES, MEASURED, AND THEY ARE NOT THE SAME.
// ---------------------------------------------------------------------------------------------

/**
 * MEASURED CONTRADICTION AGAINST THE TASK BRIEF, PRESERVED DELIBERATELY.
 *
 * T-035's brief says to "define the canonical SQL fragments" for aging buckets, singular. There is
 * no single canonical scheme in the reference. Executive Overview and the pipeline aging report
 * bucket into FOUR (`0-3 days` .. `15+ days`, GetExecutiveOverviewQueryHandler.cs:230-233 and
 * PipelineAgingReportQueryHandler.cs:50-53) while the Pipeline dashboard buckets into SIX
 * (`0-3` .. `60+`, GetPipelineDashboardQueryHandler.cs:273-281) — different count, different
 * labels, different final boundary.
 *
 * Unifying them would silently change what two shipped dashboards report, so both are ported under
 * distinct names and neither is called "canonical". FLAGGED for the orchestrator rather than
 * resolved here.
 *
 * Both schemes' boundaries are INCLUSIVE upper bounds (`<= 3`, `<= 7`, ...).
 */
export const EXECUTIVE_AGING_BUCKETS = ['0-3 days', '4-7 days', '8-14 days', '15+ days'] as const;
export type ExecutiveAgingBucket = (typeof EXECUTIVE_AGING_BUCKETS)[number];

export const PIPELINE_AGING_BUCKETS = ['0-3', '4-7', '8-14', '15-30', '31-60', '60+'] as const;
export type PipelineAgingBucket = (typeof PIPELINE_AGING_BUCKETS)[number];

export function executiveAgingBucket(ageDays: number): ExecutiveAgingBucket {
  if (ageDays <= 3) return '0-3 days';
  if (ageDays <= 7) return '4-7 days';
  if (ageDays <= 14) return '8-14 days';
  return '15+ days';
}

export function pipelineAgingBucket(ageDays: number): PipelineAgingBucket {
  if (ageDays <= 3) return '0-3';
  if (ageDays <= 7) return '4-7';
  if (ageDays <= 14) return '8-14';
  if (ageDays <= 30) return '15-30';
  if (ageDays <= 60) return '31-60';
  return '60+';
}

/**
 * The canonical SQL fragments, exported so T-036/T-037 cannot re-derive the boundaries in a query
 * and drift from the functions above. `$1` is the age expression, `$2` is nothing — these are
 * `sql`-template bodies parameterised by textual substitution of the age expression only, never by
 * user input.
 */
export function executiveAgingBucketSql(ageExpression: string): string {
  return `case
      when ${ageExpression} <= 3 then '0-3 days'
      when ${ageExpression} <= 7 then '4-7 days'
      when ${ageExpression} <= 14 then '8-14 days'
      else '15+ days'
    end`;
}

export function pipelineAgingBucketSql(ageExpression: string): string {
  return `case
      when ${ageExpression} <= 3 then '0-3'
      when ${ageExpression} <= 7 then '4-7'
      when ${ageExpression} <= 14 then '8-14'
      when ${ageExpression} <= 30 then '15-30'
      when ${ageExpression} <= 60 then '31-60'
      else '60+'
    end`;
}

// ---------------------------------------------------------------------------------------------
// SLA status.
// ---------------------------------------------------------------------------------------------

export const SLA_STATUSES = ['on_track', 'breached', 'unknown'] as const;
export type SlaStatus = (typeof SLA_STATUSES)[number];

/**
 * SLA grading (GetRmPerformanceQueryHandler.cs:291): turnaround STRICTLY GREATER than the tenant's
 * `sla_received_to_sent_days` target is a breach. Exactly meeting the target is on track — an
 * off-by-one to `>=` here would mark every perfectly-compliant RM as breaching.
 *
 * `unknown` rather than `on_track` when there is no turnaround to grade: an RM who has sent no
 * quotes has not met the SLA, they simply have no measurement, and reporting them green would
 * hide the fact that nothing is moving.
 */
export function slaStatus(
  averageTurnaroundDays: number | null,
  slaTargetDays: number,
): SlaStatus {
  if (averageTurnaroundDays === null) return 'unknown';
  return averageTurnaroundDays > slaTargetDays ? 'breached' : 'on_track';
}

// ---------------------------------------------------------------------------------------------
// Executive escalation — ExecutiveEscalationRule.cs, ported one-for-one.
// ---------------------------------------------------------------------------------------------

export interface EscalationQuoteSnapshot {
  readonly isOpen: boolean;
  readonly validUntil: string | null;
}

export interface EscalationLeadSnapshot {
  readonly isOpen: boolean;
  readonly premiumAtRisk: Money | null;
  readonly isStrategicParty: boolean;
  readonly hasAnyQuote: boolean;
  /** ISO-8601 instant. */
  readonly lastActivityAt: string | null;
  readonly nextFollowUpDate: string | null;
  readonly quotes: readonly EscalationQuoteSnapshot[];
}

export interface EscalationSettings {
  readonly highValueThreshold: Money | null;
  readonly stalledLeadDays: number;
  readonly stalledQuoteDays: number;
  readonly quoteExpiryAlertDays: number;
}

/** The evaluation instant, passed in rather than read from a clock, so the rule stays pure. */
export interface EscalationClock {
  /** ISO-8601 instant, used for the idle-time comparison. */
  readonly now: string;
  /** `yyyy-MM-dd`, used for the date-only overdue and expiry comparisons. */
  readonly today: string;
}

/**
 * STALLED (ExecutiveEscalationRule.cs:60-72), shared verbatim with the high-value-stalled rule so
 * the two can never diverge on what "stalled" means.
 *
 * Two things here are load-bearing and both are easy to get backwards:
 *  - the threshold is the POST-quote one once the lead has any quote, and the pre-quote one
 *    otherwise. `stalledQuoteDays` is the longer of the two, so swapping them makes quoted leads
 *    escalate early and un-quoted ones escalate late.
 *  - a lead with NO recorded activity is NOT stalled. Treating null as infinitely idle would
 *    escalate every freshly-imported lead on day one.
 *
 * Idle time is STRICTLY greater than the threshold, so a lead idle for exactly the threshold is
 * not yet stalled.
 */
export function isStalled(
  lead: EscalationLeadSnapshot,
  settings: EscalationSettings,
  clock: EscalationClock,
): boolean {
  if (lead.lastActivityAt === null) return false;

  const idleDays = (Date.parse(clock.now) - Date.parse(lead.lastActivityAt)) / 86_400_000;
  const thresholdDays = lead.hasAnyQuote ? settings.stalledQuoteDays : settings.stalledLeadDays;
  return idleDays > thresholdDays;
}

/**
 * EXECUTIVE ESCALATION (ExecutiveEscalationRule.cs:31-53, FR-61, PRD 18.1):
 *
 *   (highValue AND (stalled OR overdue OR expiring)) OR (strategicParty AND stalled)
 *
 * The second disjunct pairs strategic ONLY with stalled — not with overdue or expiring. That
 * asymmetry looks like an oversight and is not: it is what the reference implements, and widening
 * it would escalate every strategic client with a late follow-up straight to the executive view.
 *
 * High value is premium STRICTLY greater than the tenant threshold, and the rule never fires on
 * that disjunct at all when the threshold is unset (:46-47) — an unconfigured tenant gets no
 * high-value escalations rather than all of them.
 */
export function qualifiesForExecutiveEscalation(
  lead: EscalationLeadSnapshot,
  settings: EscalationSettings,
  clock: EscalationClock,
): boolean {
  if (!lead.isOpen) return false;

  const stalled = isStalled(lead, settings, clock);
  const overdue = lead.nextFollowUpDate !== null && lead.nextFollowUpDate < clock.today;
  const expiring = lead.quotes.some(
    (quote) =>
      quote.isOpen &&
      quote.validUntil !== null &&
      quote.validUntil >= clock.today &&
      dayDifference(clock.today, quote.validUntil) <= settings.quoteExpiryAlertDays,
  );

  const highValue =
    lead.premiumAtRisk !== null &&
    settings.highValueThreshold !== null &&
    parseMoney(lead.premiumAtRisk) > parseMoney(settings.highValueThreshold);

  return (highValue && (stalled || overdue || expiring)) || (lead.isStrategicParty && stalled);
}

// ---------------------------------------------------------------------------------------------
// The catalog — WHAT EACH NUMBER COUNTS, stated explicitly (CLAUDE.md, AC-073).
// ---------------------------------------------------------------------------------------------

/**
 * Whether a metric counts LEADS, counts QUOTES, or is a PREMIUM amount.
 *
 * CLAUDE.md makes this a hard product requirement: "Dashboard and report queries must be ... clear
 * about whether they count Leads, Quotes, or Premium." A card labelled "Total: 128" that does not
 * say which is the defect that ships and is believed, so the basis travels with the label rather
 * than living in a UI string table where the two can drift.
 */
export type MetricBasis = 'lead' | 'quote' | 'premium';

/** How the UI renders the value; mirrors `ExecutiveKpiDto`'s `Kind*` constants. */
export type MetricKind = 'count' | 'percent' | 'currency' | 'days';

/** Whether a rising value is good (KpiValue.cs `GoodDirection`). */
export type GoodDirection = 'higherIsBetter' | 'lowerIsBetter';

export interface MetricDefinition {
  readonly label: string;
  readonly basis: MetricBasis;
  readonly kind: MetricKind;
  readonly goodDirection: GoodDirection;
}

/**
 * The catalogued metrics and their product-approved labels.
 *
 * `Quoted Premium` and `Bound Premium` are separate entries with separate labels on purpose: they
 * are different numbers over different populations (everything we quoted, versus what we actually
 * bound), and conflating them overstates performance by exactly the value of the business we lost.
 */
export const METRIC_CATALOG = {
  totalLeads: {
    label: 'Total Leads',
    basis: 'lead',
    kind: 'count',
    goodDirection: 'higherIsBetter',
  },
  totalQuotes: {
    label: 'Total Quotes',
    basis: 'quote',
    kind: 'count',
    goodDirection: 'higherIsBetter',
  },
  leadToQuoteRate: {
    label: 'Lead-to-Quote Rate',
    basis: 'lead',
    kind: 'percent',
    goodDirection: 'higherIsBetter',
  },
  quoteToWinRate: {
    label: 'Quote-to-Win Rate',
    basis: 'quote',
    kind: 'percent',
    goodDirection: 'higherIsBetter',
  },
  quoteToProposalRate: {
    label: 'Quote-to-Proposal Rate',
    basis: 'quote',
    kind: 'percent',
    goodDirection: 'higherIsBetter',
  },
  proposalToWinRate: {
    label: 'Proposal-to-Win Rate',
    basis: 'quote',
    kind: 'percent',
    goodDirection: 'higherIsBetter',
  },
  quotedPremium: {
    label: 'Quoted Premium',
    basis: 'premium',
    kind: 'currency',
    goodDirection: 'higherIsBetter',
  },
  boundPremium: {
    label: 'Bound Premium',
    basis: 'premium',
    kind: 'currency',
    goodDirection: 'higherIsBetter',
  },
  openPipelinePremium: {
    label: 'Open Pipeline Premium',
    basis: 'premium',
    kind: 'currency',
    goodDirection: 'higherIsBetter',
  },
  averageTurnaround: {
    label: 'Avg Turnaround',
    basis: 'quote',
    kind: 'days',
    goodDirection: 'lowerIsBetter',
  },
  averageLeadAge: {
    label: 'Avg Lead Age',
    basis: 'lead',
    kind: 'days',
    goodDirection: 'lowerIsBetter',
  },
  averageQuoteAge: {
    label: 'Avg Quote Age',
    basis: 'quote',
    kind: 'days',
    goodDirection: 'lowerIsBetter',
  },
  followUpCompliance: {
    label: 'Follow-up Compliance',
    basis: 'lead',
    kind: 'percent',
    goodDirection: 'higherIsBetter',
  },
  averagePriceGap: {
    label: 'Avg Price Gap',
    basis: 'quote',
    kind: 'percent',
    goodDirection: 'lowerIsBetter',
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_CATALOG;

export { ZERO_MONEY };
export type { Money };
