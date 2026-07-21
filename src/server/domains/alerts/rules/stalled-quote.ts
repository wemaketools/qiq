/**
 * `stalled_quote` — port of `StalledQuoteRule.cs`.
 *
 * "No activity for a configured number of days AFTER a quote is issued": one candidate per OPEN
 * quote, aged against the PARENT LEAD's `last_activity_at` (quote activity always stamps lead
 * activity, so the lead carries the whole item's activity clock) against `stalledQuoteDays`.
 *
 * MEASURED: this rule has NO `lead.IsOpen` filter, unlike every other lead-level rule (:16-25).
 * Quote openness alone gates it, so an open quote on a closed lead still raises a stalled_quote
 * alert. That looks like an oversight in the reference and may well be one — but it is the observed
 * behaviour, it is pinned by a named unit test, and changing it would silently drop alerts a tenant
 * sees today. Recorded as a finding rather than "fixed" here.
 */
import {
  elapsedDays,
  isQuoteOpen,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
} from './types.js';

export const stalledQuoteRule: AlertRule = {
  type: 'stalled_quote',

  evaluate(context: AlertEvaluationContext): readonly AlertCandidate[] {
    const threshold = context.thresholds.stalledQuoteDays;
    const candidates: AlertCandidate[] = [];

    for (const lead of context.leads) {
      if (lead.lastActivityAt === null) continue;
      if (elapsedDays(context.now, lead.lastActivityAt) <= threshold) continue;

      for (const quote of lead.quotes) {
        if (!isQuoteOpen(quote)) continue;
        candidates.push({
          type: 'stalled_quote',
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
