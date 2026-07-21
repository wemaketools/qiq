/**
 * `quote_expiring` — port of `QuoteExpiringRule.cs`.
 *
 * "Quote valid-until date is within the configured threshold": an OPEN quote whose `valid_until` is
 * set, NOT yet in the past, and within `quoteExpiryAlertDays` calendar days of today.
 *
 * Note the asymmetry with the day-count thresholds elsewhere: this comparison is INCLUSIVE
 * (`<= thresholdDays`), so a quote expiring exactly `quoteExpiryAlertDays` from today DOES fire,
 * while a lead idle exactly `stalledLeadDays` does NOT. Both are the reference's semantics and both
 * are pinned individually, because "the boundary is the same everywhere" is the natural and wrong
 * assumption.
 */
import {
  dayNumberDifference,
  isQuoteOpen,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const quoteExpiringRule: AlertRule = {
  type: 'quote_expiring',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const threshold = context.thresholds.quoteExpiryAlertDays;
    const candidates: AlertCandidate[] = [];

    for (const lead of context.leads) {
      for (const quote of lead.quotes) {
        if (!isQuoteOpen(quote) || quote.validUntil === null) continue;
        if (quote.validUntil < context.today) continue;
        if (dayNumberDifference(quote.validUntil, context.today) > threshold) continue;

        candidates.push({
          type: 'quote_expiring',
          leadId: lead.leadId,
          quoteId: quote.quoteId,
          severity: 'warning',
          premiumAtRisk: quote.quotedPremium,
        });
      }
    }

    return candidates;
  },
};
