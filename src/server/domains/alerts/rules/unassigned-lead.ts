/**
 * `unassigned_lead` — port of `UnassignedLeadRule.cs`.
 *
 * "Lead has been received but not assigned within the tenant-configured threshold": an open lead
 * still in its `new` canonical status whose age since creation STRICTLY exceeds
 * `unassignedLeadHours`.
 *
 * The predicate keys off the canonical STATUS, not `date_assigned` (which the reference snapshot
 * carries but no rule reads). That is the reference's deliberate choice, recorded in its own doc
 * comment: the Assign operation moves the lead out of `new`, so the workflow engine's status is the
 * single source of truth for "unassigned" and a second definition could disagree with it.
 */
import {
  elapsedHours,
  isLeadOpen,
  leadPremiumAtRisk,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const unassignedLeadRule: AlertRule = {
  type: 'unassigned_lead',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const threshold = context.thresholds.unassignedLeadHours;

    return context.leads
      .filter(
        (lead) =>
          isLeadOpen(lead) &&
          lead.statusCanonicalKey === 'new' &&
          elapsedHours(context.now, lead.createdAt) > threshold,
      )
      .map((lead) => ({
        type: 'unassigned_lead' as const,
        leadId: lead.leadId,
        quoteId: null,
        severity: 'warning' as const,
        premiumAtRisk: leadPremiumAtRisk(lead),
      }));
  },
};
