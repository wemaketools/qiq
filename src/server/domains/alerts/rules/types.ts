/**
 * The pure inputs every alert rule reads (T-033; AC-069; spec §9.5 Job 3, P-11).
 *
 * Port of `src/api/QuoteIQ.Domain/Alerts/AlertEvaluationContext.cs`, `AlertCandidate.cs`,
 * `AlertType.cs` and `AlertSeverity.cs`.
 *
 * WHY THE RULES TAKE A PREFETCHED SNAPSHOT RATHER THAN A DATABASE HANDLE
 * =====================================================================
 * A rule that could query would be a rule that has to be tested against Postgres, and the eleven
 * boundary conditions below ("strictly exceeds", "not yet in the past", "no quote yet") are exactly
 * the kind of thing that is cheap to get wrong and expensive to notice. Keeping every predicate a
 * pure function over plain data is what lets `alert-rules.test.ts` pin every boundary with a
 * fixture, and it is the same seam the reference chose (`IAlertRule`'s doc comment).
 *
 * MONEY IS A STRING HERE, DELIBERATELY
 * ====================================
 * `estimated_premium`, `quoted_premium` and `high_value_threshold` are all `numeric(18,2)`, which
 * node-postgres returns as a STRING so it never passes through an IEEE-754 double. The high-value
 * comparison is a BUSINESS DECISION made on money, so it is made on exact cents via
 * `dashboards/money.ts`, not on `Number(...)`.
 *
 * FIELDS THE REFERENCE CARRIES THAT ARE NOT HERE
 * ==============================================
 * `QuoteAlertSnapshot.PreparedDate`/`SentDate` and `LeadAlertSnapshot.DateAssigned` exist on the
 * reference's records but are read by NO rule (measured across all eleven classes; `DateAssigned`
 * even carries a doc comment explaining why `UnassignedLeadRule` deliberately ignores it in favour
 * of the canonical status). They are omitted rather than prefetched, so the context cannot suggest
 * a rule input that does not exist. `statusCanonicalKey` on a quote is likewise unread by any rule —
 * quote openness comes from the reporting category — and is omitted for the same reason.
 */
import { compareMoney, type Money } from '../../dashboards/money.js';

/** `AlertType.cs:12-22` — the eleven values `alerts_type_check` admits. */
export const ALERT_TYPES = [
  'unassigned_lead',
  'overdue_follow_up',
  'stalled_lead',
  'stalled_quote',
  'quote_expiring',
  'quote_expired',
  'sla_breach',
  'high_value_stalled',
  'pending_pricing_approval',
  'awaiting_underwriting',
  'executive_escalation',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

/** `AlertSeverity.cs` — escalation-shaped types are critical, everything else warning. */
export const ALERT_SEVERITIES = ['critical', 'warning'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * The reporting categories that mean "not yet closed" (`LeadAlertSnapshot.IsOpen`,
 * `QuoteAlertSnapshot.IsOpen`) — the same two values `leads/schemas.ts` calls
 * `OPEN_REPORTING_CATEGORIES`.
 */
export const OPEN_ALERT_CATEGORIES: readonly string[] = ['open', 'quoted'];

/** The threshold settings the eleven rules read. Days/hours are integers; money stays a string. */
export interface AlertThresholds {
  readonly unassignedLeadHours: number;
  readonly stalledLeadDays: number;
  readonly stalledQuoteDays: number;
  readonly quoteExpiryAlertDays: number;
  readonly pricingApprovalTargetDays: number;
  readonly slaAssignmentDays: number;
  readonly slaUnderwritingDays: number;
  readonly slaReceivedToSentDays: number;
  /** `null` disables the high-value rules entirely (`HighValueStalledRule.cs:21-24`). */
  readonly highValueThreshold: Money | null;
}

/** `QuoteAlertSnapshot` — only the fields a rule reads. */
export interface QuoteAlertSnapshot {
  readonly quoteId: number;
  readonly leadId: number;
  readonly reportingCategory: string | null;
  /** `yyyy-MM-dd`, or null when the quote carries no validity date. */
  readonly validUntil: string | null;
  /** The CURRENT version's quoted premium; `0.00` when the quote has no current version. */
  readonly quotedPremium: Money;
}

/** `LeadAlertSnapshot` — only the fields a rule reads, plus the lead's quotes. */
export interface LeadAlertSnapshot {
  readonly leadId: number;
  readonly statusCanonicalKey: string | null;
  readonly reportingCategory: string | null;
  readonly createdAt: Date;
  readonly lastActivityAt: Date | null;
  /** `yyyy-MM-dd`. */
  readonly nextFollowUpDate: string | null;
  readonly pricingApprovalState: string;
  /** The most recent PENDING pricing approval's `requested_at`. */
  readonly pricingPendingSince: Date | null;
  /** The most recent transition INTO the `underwriting` canonical status. */
  readonly underwritingEnteredAt: Date | null;
  readonly estimatedPremium: Money | null;
  readonly isStrategicParty: boolean;
  readonly quotes: readonly QuoteAlertSnapshot[];
}

/** `AlertEvaluationContext` — one tenant's whole evaluation input. */
export interface AlertEvaluationContext {
  readonly thresholds: AlertThresholds;
  /** `yyyy-MM-dd`, UTC — the reference's `DateOnly.FromDateTime(now.UtcDateTime)`. */
  readonly today: string;
  readonly now: Date;
  readonly leads: readonly LeadAlertSnapshot[];
}

/** `AlertCandidate` — one rule match. `quoteId` is null for lead-level types. */
export interface AlertCandidate {
  readonly type: AlertType;
  readonly leadId: number;
  readonly quoteId: number | null;
  readonly severity: AlertSeverity;
  readonly premiumAtRisk: Money | null;
}

/** `IAlertRule` — one alert type's pure predicate. */
export interface AlertRule {
  readonly type: AlertType;
  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[];
}

// ---------------------------------------------------------------------------------------------
// Shared derivations (the reference's computed properties on the snapshot records)
// ---------------------------------------------------------------------------------------------

export function isLeadOpen(lead: LeadAlertSnapshot): boolean {
  return lead.reportingCategory !== null && OPEN_ALERT_CATEGORIES.includes(lead.reportingCategory);
}

export function isQuoteOpen(quote: QuoteAlertSnapshot): boolean {
  return (
    quote.reportingCategory !== null && OPEN_ALERT_CATEGORIES.includes(quote.reportingCategory)
  );
}

export function hasAnyQuote(lead: LeadAlertSnapshot): boolean {
  return lead.quotes.length > 0;
}

/** `LeadAlertSnapshot.MaxQuotedPremium` — exact, via cents, never `Math.max` on doubles. */
export function maxQuotedPremium(lead: LeadAlertSnapshot): Money | null {
  let highest: Money | null = null;
  for (const quote of lead.quotes) {
    if (highest === null || compareMoney(quote.quotedPremium, highest) > 0) {
      highest = quote.quotedPremium;
    }
  }
  return highest;
}

/**
 * `LeadAlertSnapshot.PremiumAtRisk` — the lead's own intake estimate, falling back to its highest
 * quoted premium. This is the value lead-level alert rows carry as `premium_at_risk`.
 */
export function leadPremiumAtRisk(lead: LeadAlertSnapshot): Money | null {
  return lead.estimatedPremium ?? maxQuotedPremium(lead);
}

/** Fractional elapsed days, matching `(now - t).TotalDays`. */
export function elapsedDays(now: Date, since: Date): number {
  return (now.getTime() - since.getTime()) / 86_400_000;
}

/** Fractional elapsed hours, matching `(now - t).TotalHours`. */
export function elapsedHours(now: Date, since: Date): number {
  return (now.getTime() - since.getTime()) / 3_600_000;
}

/**
 * Whole calendar days between two `yyyy-MM-dd` dates, matching `DateOnly.DayNumber` arithmetic.
 * Parsed as UTC midnights so a host timezone can never shift the boundary by a day.
 */
export function dayNumberDifference(later: string, earlier: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}

/**
 * The SHARED "stalled" definition (`ExecutiveEscalationRule.IsStalled`, :63-75): pre-quote age
 * against `stalledLeadDays`, post-quote age against `stalledQuoteDays`. Used verbatim by both the
 * high-value-stalled and executive-escalation rules so the two can never diverge on what stalled
 * means. A lead with no activity timestamp at all is never stalled — there is nothing to measure.
 */
export function isStalled(lead: LeadAlertSnapshot, context: AlertEvaluationContext): boolean {
  if (lead.lastActivityAt === null) return false;
  const threshold = hasAnyQuote(lead)
    ? context.thresholds.stalledQuoteDays
    : context.thresholds.stalledLeadDays;
  return elapsedDays(context.now, lead.lastActivityAt) > threshold;
}

/** `OverdueFollowUpRule`'s predicate, shared with the two high-value compositions. */
export function hasOverdueFollowUp(
  lead: LeadAlertSnapshot,
  context: AlertEvaluationContext,
): boolean {
  return lead.nextFollowUpDate !== null && lead.nextFollowUpDate < context.today;
}

/**
 * `premium > highValueThreshold`, STRICTLY, on exact cents. False when either side is null — an
 * unset threshold disables the high-value rules entirely.
 */
export function isHighValue(premium: Money | null, threshold: Money | null): boolean {
  if (premium === null || threshold === null) return false;
  return compareMoney(premium, threshold) > 0;
}
