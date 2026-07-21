/**
 * `quote_expired` — port of `QuoteExpiredRule.cs`.
 *
 * "Quote valid-until date has passed and the quote is not closed": an OPEN quote whose
 * `valid_until` is set and strictly before today. Critical severity.
 *
 * THIS RULE NEVER TOUCHES QUOTE STATUS
 * ====================================
 * It fires INDEPENDENTLY of the quote-expiry sweep (Job 1, T-032), which is the job that actually
 * transitions a Sent quote to Expired. This rule only ever materializes or resolves an `alerts`
 * row. Keeping that boundary is what stops two jobs from racing on the same status column — and it
 * is why an expired-but-not-yet-swept quote correctly shows an alert while still reading as open.
 */
import {
  isQuoteOpen,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const quoteExpiredRule: AlertRule = {
  type: 'quote_expired',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const candidates: AlertCandidate[] = [];

    for (const lead of context.leads) {
      for (const quote of lead.quotes) {
        if (!isQuoteOpen(quote) || quote.validUntil === null) continue;
        if (quote.validUntil >= context.today) continue;

        candidates.push({
          type: 'quote_expired',
          leadId: lead.leadId,
          quoteId: quote.quoteId,
          severity: 'critical',
          premiumAtRisk: quote.quotedPremium,
        });
      }
    }

    return candidates;
  },
};
