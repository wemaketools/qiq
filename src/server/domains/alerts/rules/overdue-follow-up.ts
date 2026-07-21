/**
 * `overdue_follow_up` — port of `OverdueFollowUpRule.cs`.
 *
 * "Next follow-up date is in the past and the lead is still open": `next_follow_up_date` strictly
 * before today, on an open lead.
 *
 * MEASURED: the reference does NOT apply `follow_up_overdue_grace_days`, despite the setting
 * existing on `tenant_settings` and reading as though it belongs here. The predicate is a bare
 * `NextFollowUpDate < Today` (:12-19). Applying the grace would shift every tenant's overdue set
 * relative to the system being replaced, so the port keeps the reference behaviour and the task file
 * flags the unused setting rather than silently choosing.
 */
import {
  hasOverdueFollowUp,
  isLeadOpen,
  leadPremiumAtRisk,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const overdueFollowUpRule: AlertRule = {
  type: 'overdue_follow_up',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    return context.leads
      .filter((lead) => isLeadOpen(lead) && hasOverdueFollowUp(lead, context))
      .map((lead) => ({
        type: 'overdue_follow_up' as const,
        leadId: lead.leadId,
        quoteId: null,
        severity: 'warning' as const,
        premiumAtRisk: leadPremiumAtRisk(lead),
      }));
  },
};
