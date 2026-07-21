/**
 * `sla_breach` — port of `SlaBreachRule.cs`.
 *
 * "Lead, quote, or underwriting turnaround exceeds target". The reference records that PRD 18.1
 * does not enumerate the sub-conditions and that its own wording OVERLAPS with
 * `awaiting_underwriting`; its concrete, non-overlapping split — reproduced here verbatim — is:
 *
 *   (a) ASSIGNMENT leg      — an open lead still in `new` whose age exceeds `slaAssignmentDays`
 *   (b) RECEIVED-TO-SENT leg — an open lead with NO quote yet whose age exceeds
 *                              `slaReceivedToSentDays`
 *
 * The underwriting turnaround leg lives in `awaiting_underwriting` so the two types never
 * double-count the same condition.
 *
 * ONE CANDIDATE, NOT TWO, WHEN BOTH LEGS BREACH. A new quote-less lead breaches both, and the open
 * alert uniqueness index is keyed on (type, lead, quote) — so emitting two would make every sweep
 * collide with itself. The legs are OR'd into a single candidate, matching the reference.
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

export const slaBreachRule: AlertRule = {
  type: 'sla_breach',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const { slaAssignmentDays, slaReceivedToSentDays } = context.thresholds;
    const candidates: AlertCandidate[] = [];

    for (const lead of context.leads) {
      if (!isLeadOpen(lead)) continue;

      const ageDays = elapsedDays(context.now, lead.createdAt);
      const assignmentBreached = lead.statusCanonicalKey === 'new' && ageDays > slaAssignmentDays;
      const receivedToSentBreached = !hasAnyQuote(lead) && ageDays > slaReceivedToSentDays;

      if (assignmentBreached || receivedToSentBreached) {
        candidates.push({
          type: 'sla_breach',
          leadId: lead.leadId,
          quoteId: null,
          severity: 'critical',
          premiumAtRisk: leadPremiumAtRisk(lead),
        });
      }
    }

    return candidates;
  },
};
