/**
 * `awaiting_underwriting` — port of `AwaitingUnderwritingRule.cs`.
 *
 * "Lead is assigned to underwriting beyond target": a lead currently in the `underwriting` canonical
 * status whose age since the MOST RECENT transition into that status (from lead status history)
 * strictly exceeds `slaUnderwritingDays`.
 *
 * Measuring from the last entry rather than the first is what makes a lead that bounced out of
 * underwriting and back in start its clock again, instead of alerting immediately on re-entry.
 */
import {
  elapsedDays,
  leadPremiumAtRisk,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const awaitingUnderwritingRule: AlertRule = {
  type: 'awaiting_underwriting',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const threshold = context.thresholds.slaUnderwritingDays;

    return context.leads
      .filter(
        (lead) =>
          lead.statusCanonicalKey === 'underwriting' &&
          lead.underwritingEnteredAt !== null &&
          elapsedDays(context.now, lead.underwritingEnteredAt) > threshold,
      )
      .map((lead) => ({
        type: 'awaiting_underwriting' as const,
        leadId: lead.leadId,
        quoteId: null,
        severity: 'warning' as const,
        premiumAtRisk: leadPremiumAtRisk(lead),
      }));
  },
};
