/**
 * `pending_pricing_approval` — port of `PendingPricingApprovalRule.cs`.
 *
 * "A pricing approval request has been pending beyond the tenant-configured target": the lead's
 * denormalized `pricing_approval_state` is `pending` and the age since the most recent PENDING
 * request's `requested_at` strictly exceeds `pricingApprovalTargetDays`.
 *
 * MEASURED: no `IsOpen` filter (:18-24), so a closed lead left in the pending state still raises
 * this alert. Pinned by a named unit test; recorded as a finding rather than corrected.
 */
import {
  elapsedDays,
  leadPremiumAtRisk,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const pendingPricingApprovalRule: AlertRule = {
  type: 'pending_pricing_approval',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const threshold = context.thresholds.pricingApprovalTargetDays;

    return context.leads
      .filter(
        (lead) =>
          lead.pricingApprovalState === 'pending' &&
          lead.pricingPendingSince !== null &&
          elapsedDays(context.now, lead.pricingPendingSince) > threshold,
      )
      .map((lead) => ({
        type: 'pending_pricing_approval' as const,
        leadId: lead.leadId,
        quoteId: null,
        severity: 'warning' as const,
        premiumAtRisk: leadPremiumAtRisk(lead),
      }));
  },
};
