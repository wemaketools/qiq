/**
 * `high_value_stalled` — port of `HighValueStalledRule.cs`.
 *
 * "Premium exceeds the tenant threshold AND the opportunity is stale, overdue, or blocked": an open
 * lead whose premium-at-risk STRICTLY exceeds `highValueThreshold`, plus at least one of
 *
 *   stale   — the shared `isStalled` definition (also used by executive escalation)
 *   overdue — an overdue follow-up
 *   blocked — a pricing approval pending beyond `pricingApprovalTargetDays`
 *
 * DISABLED ENTIRELY WHEN THE TENANT HAS NO THRESHOLD. A null `high_value_threshold` means "this
 * tenant has not defined high value", not "everything is high value" — the rule returns nothing
 * rather than treating null as zero.
 *
 * DELIBERATELY NOT THE SAME COMPOSITION AS EXECUTIVE ESCALATION. This one does not react to an
 * expiring quote and knows nothing about strategic parties; that is the other rule's job (Q-10).
 * The two are separate named modules precisely so either composition can change alone.
 */
import {
  elapsedDays,
  hasOverdueFollowUp,
  isHighValue,
  isLeadOpen,
  isStalled,
  leadPremiumAtRisk,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const highValueStalledRule: AlertRule = {
  type: 'high_value_stalled',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const { highValueThreshold, pricingApprovalTargetDays } = context.thresholds;
    if (highValueThreshold === null) return [];

    const candidates: AlertCandidate[] = [];

    for (const lead of context.leads) {
      if (!isLeadOpen(lead)) continue;

      const premium = leadPremiumAtRisk(lead);
      if (!isHighValue(premium, highValueThreshold)) continue;

      const blocked =
        lead.pricingApprovalState === 'pending' &&
        lead.pricingPendingSince !== null &&
        elapsedDays(context.now, lead.pricingPendingSince) > pricingApprovalTargetDays;

      if (isStalled(lead, context) || hasOverdueFollowUp(lead, context) || blocked) {
        candidates.push({
          type: 'high_value_stalled',
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
