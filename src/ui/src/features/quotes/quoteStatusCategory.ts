import type { ReportingCategory } from '../../components/common/StatusChip';

/** The four terminal quote canonical keys (`QuoteStatusKeys`, `src/api/.../QuoteIQ.Domain/Workflow/QuoteStatusKeys.cs`, T-020) — a quote in any of these is closed. */
const TERMINAL_QUOTE_CANONICAL_KEYS = new Set(['won', 'lost', 'expired', 'withdrawn']);

/**
 * Derives a quote's `StatusChip` `ReportingCategory` from its server-projected `statusCanonicalKey`
 * (`QuoteDetailDto.statusCanonicalKey`/`QuoteListItemDto.statusCanonicalKey`) — unlike
 * `leadStatusCategory.ts`'s name-based stopgap (`LeadListItemDto` omits a canonical key), quotes
 * project the real, rename-safe key on both the list and detail DTOs, so this is authoritative
 * rather than a best-effort guess.
 */
export function deriveQuoteReportingCategory(statusCanonicalKey: string | null): ReportingCategory {
  switch (statusCanonicalKey) {
    case 'won':
      return 'won';
    case 'lost':
      return 'lost';
    case 'expired':
      return 'expired';
    case 'withdrawn':
      return 'withdrawn';
    case 'sent':
    case 'revised':
      return 'quoted';
    default:
      return 'open';
  }
}

/** True when the quote's status is one of the four terminal canonical keys (Won/Lost/Expired/Withdrawn, spec FR-38/FR-48/FR-49) — drives closed-quote attachment/edit gating. */
export function isQuoteClosed(statusCanonicalKey: string | null): boolean {
  return statusCanonicalKey !== null && TERMINAL_QUOTE_CANONICAL_KEYS.has(statusCanonicalKey);
}
