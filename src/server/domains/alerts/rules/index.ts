/**
 * The rule catalog — port of `AlertRuleCatalog.cs` (T-033, AC-069).
 *
 * Eleven pure, stateless rules, one module each, in the reference's declaration order. One shared,
 * statically-built list is safe to reuse across every tenant precisely BECAUSE the rules hold no
 * state: everything a rule reads arrives in its `AlertEvaluationContext` argument.
 *
 * This module is the single place the SET of active rules is decided (the P-10 MetricDefinitions
 * analog): adding an alert type means adding a module and one line here, and `alert-rules.test.ts`
 * asserts the catalog covers exactly the eleven values `alerts_type_check` admits — so a rule that
 * is written but never registered fails the suite instead of silently never firing.
 */
import { awaitingUnderwritingRule } from './awaiting-underwriting.js';
import { executiveEscalationRule } from './executive-escalation.js';
import { highValueStalledRule } from './high-value-stalled.js';
import { overdueFollowUpRule } from './overdue-follow-up.js';
import { pendingPricingApprovalRule } from './pending-pricing-approval.js';
import { quoteExpiredRule } from './quote-expired.js';
import { quoteExpiringRule } from './quote-expiring.js';
import { slaBreachRule } from './sla-breach.js';
import { stalledLeadRule } from './stalled-lead.js';
import { stalledQuoteRule } from './stalled-quote.js';
import { unassignedLeadRule } from './unassigned-lead.js';
import type { AlertCandidate, AlertEvaluationContext, AlertRule, AlertType } from './types.js';

export * from './types.js';

export const ALERT_RULES: readonly AlertRule[] = [
  unassignedLeadRule,
  overdueFollowUpRule,
  stalledLeadRule,
  stalledQuoteRule,
  quoteExpiringRule,
  quoteExpiredRule,
  slaBreachRule,
  highValueStalledRule,
  pendingPricingApprovalRule,
  awaitingUnderwritingRule,
  executiveEscalationRule,
];

const BY_TYPE: ReadonlyMap<AlertType, AlertRule> = new Map(
  ALERT_RULES.map((rule) => [rule.type, rule]),
);

/** Throws rather than returning undefined: an unknown type here is a programming error. */
export function ruleFor(type: AlertType): AlertRule {
  const rule = BY_TYPE.get(type);
  if (rule === undefined) throw new Error(`No alert rule is registered for type "${type}".`);
  return rule;
}

/** Every rule's matches for one tenant — the candidate set reconciliation diffs against. */
export function evaluateAllRules(context: AlertEvaluationContext): readonly AlertCandidate[] {
  return ALERT_RULES.flatMap((rule) => rule.evaluate(context));
}
