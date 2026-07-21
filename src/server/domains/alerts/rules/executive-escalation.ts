/**
 * `executive_escalation` — port of `ExecutiveEscalationRule.cs` (Q-10).
 *
 * The composition, isolated in exactly this one module so it can be changed in a single place:
 *
 *     (high-value AND (stalled OR overdue OR expiring))  OR  (strategic party AND stalled)
 *
 *   high-value — premium-at-risk STRICTLY exceeds `highValueThreshold` (never fires when unset)
 *   stalled    — the shared `isStalled` definition, identical to high_value_stalled's
 *   overdue    — next follow-up date in the past
 *   expiring   — any OPEN quote with `valid_until` today-or-later and within `quoteExpiryAlertDays`
 *   strategic  — the lead's party is flagged strategic
 *
 * The strategic leg is STALLED-ONLY: a strategic party that is merely overdue does not escalate.
 * And the expiring leg deliberately excludes already-expired quotes (`valid_until >= today`), so an
 * expired quote escalates only through the high-value/stalled legs. Both asymmetries are the
 * reference's and both are pinned by named unit tests.
 */
import {
  dayNumberDifference,
  hasOverdueFollowUp,
  isHighValue,
  isLeadOpen,
  isQuoteOpen,
  isStalled,
  leadPremiumAtRisk,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
  type LeadAlertSnapshot,
} from './types.js';

function hasExpiringQuote(lead: LeadAlertSnapshot, context: AlertEvaluationContext): boolean {
  return lead.quotes.some(
    (quote) =>
      isQuoteOpen(quote) &&
      quote.validUntil !== null &&
      quote.validUntil >= context.today &&
      dayNumberDifference(quote.validUntil, context.today) <=
        context.thresholds.quoteExpiryAlertDays,
  );
}

export const executiveEscalationRule: AlertRule = {
  type: 'executive_escalation',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const candidates: AlertCandidate[] = [];

    for (const lead of context.leads) {
      if (!isLeadOpen(lead)) continue;

      const stalled = isStalled(lead, context);
      const premium = leadPremiumAtRisk(lead);
      const highValue = isHighValue(premium, context.thresholds.highValueThreshold);

      const qualifies =
        (highValue && (stalled || hasOverdueFollowUp(lead, context) || hasExpiringQuote(lead, context))) ||
        (lead.isStrategicParty && stalled);

      if (qualifies) {
        candidates.push({
          type: 'executive_escalation',
          leadId: lead.leadId,
          quoteId: null,
          severity: 'critical',
          premiumAtRisk: premium,
        });
      }
    }

    return candidates;
  },
};
