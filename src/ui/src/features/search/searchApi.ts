import { apiGet } from '../../api/client';

/**
 * Global search backend contract (src/api/QuoteIQ.Api/Endpoints/SearchEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Search/*, T-038, spec FR-53/A-14). Fetch-wrapper module,
 * matching the established convention (`partiesApi.ts`/`leadsApi.ts`/`alertsApi.ts`) rather than RTK
 * Query — this codebase configures no RTK Query store (`app/store.ts` is a plain `configureStore`),
 * so introducing it for this task alone would be a new, unapproved data-fetching framework
 * (CLAUDE.md: "Do not introduce new frameworks or tools without approval").
 */

/** Wire shape of `SearchLeadDto`. */
export interface SearchLeadDto {
  id: number;
  ref: string;
  partyName: string;
  status: string;
}

/** Wire shape of `SearchQuoteDto`. Carries `leadId`/`leadRef` so a quote hit opens inside its lead (FR-45). */
export interface SearchQuoteDto {
  id: number;
  ref: string;
  leadId: number;
  leadRef: string;
  partyName: string;
  status: string;
}

/** Wire shape of `SearchPartyDto`. */
export interface SearchPartyDto {
  id: number;
  name: string;
  type: string;
}

/** Wire shape of `SearchBrokerDto`. `tier` is the broker's broker-type name (nullable). */
export interface SearchBrokerDto {
  id: number;
  name: string;
  tier: string | null;
}

/** Wire shape of `GlobalSearchDto`: the grouped result buckets. */
export interface GlobalSearchDto {
  leads: SearchLeadDto[];
  quotes: SearchQuoteDto[];
  parties: SearchPartyDto[];
  brokers: SearchBrokerDto[];
}

/** The client-side minimum query length before a search fires (mirrors the backend's 2-char minimum). */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** `GET /api/v1/search?q=` — grouped tenant-scoped type-ahead across leads/quotes/parties/brokers (FR-53). */
export function globalSearch(q: string, limitPerType?: number): Promise<GlobalSearchDto> {
  const params = new URLSearchParams({ q });
  if (limitPerType != null) {
    params.set('limitPerType', String(limitPerType));
  }
  return apiGet<GlobalSearchDto>(`/search?${params.toString()}`);
}
