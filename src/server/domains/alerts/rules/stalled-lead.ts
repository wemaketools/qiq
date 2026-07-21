/**
 * `stalled_lead` — port of `StalledLeadRule.cs`.
 *
 * "No activity for a configured number of days BEFORE a quote is issued": an open lead with no
 * quote yet whose idle time strictly exceeds `stalledLeadDays`. A lead with no activity timestamp
 * at all is never a candidate — there is nothing to measure staleness against.
 */
import {
  elapsedDays,
  hasAnyQuote,
  isLeadOpen,
  leadPremiumAtRisk,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const stalledLeadRule: AlertRule = {
  type: 'stalled_lead',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const threshold = context.thresholds.stalledLeadDays;

    return context.leads
      .filter(
        (lead) =>
          isLeadOpen(lead) &&
          !hasAnyQuote(lead) &&
          lead.lastActivityAt !== null &&
          elapsedDays(context.now, lead.lastActivityAt) > threshold,
      )
      .map((lead) => ({
        type: 'stalled_lead' as const,
        leadId: lead.leadId,
        quoteId: null,
        severity: 'warning' as const,
        premiumAtRisk: leadPremiumAtRisk(lead),
      }));
  },
};
