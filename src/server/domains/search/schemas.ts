/**
 * Wire shapes for the global type-ahead search (T-038, spec FR-53/A-14).
 *
 * These mirror `src/api/QuoteIQ.Application/Features/Search/GlobalSearchDto.cs` field for field, AND
 * the SPA's `src/ui/src/features/search/searchApi.ts` interfaces the top-bar dropdown already
 * consumes (`components/shell/GlobalSearch.tsx`). BOTH sides were read before these were written: a
 * renamed field here silently breaks the top-bar. The `id` fields are `number` because
 * node-postgres bigints are Number()'d in the repository and the SPA types them as `number`.
 */

/** One lead hit: `SearchLeadDto` (GlobalSearchDto.cs:6). */
export interface SearchLeadDto {
  readonly id: number;
  readonly ref: string;
  readonly partyName: string;
  readonly status: string;
}

/**
 * One quote hit: `SearchQuoteDto` (GlobalSearchDto.cs:16). Carries `leadId`/`leadRef` so the SPA
 * opens the quote inside its lead (`/leads/{leadId}?highlightQuote={id}`, GlobalSearch.tsx:92).
 */
export interface SearchQuoteDto {
  readonly id: number;
  readonly ref: string;
  readonly leadId: number;
  readonly leadRef: string;
  readonly partyName: string;
  readonly status: string;
}

/** One party hit: `SearchPartyDto` (GlobalSearchDto.cs:23). */
export interface SearchPartyDto {
  readonly id: number;
  readonly name: string;
  readonly type: string;
}

/** One broker hit: `SearchBrokerDto` (GlobalSearchDto.cs:29). `tier` is the broker-type name (nullable). */
export interface SearchBrokerDto {
  readonly id: number;
  readonly name: string;
  readonly tier: string | null;
}

/**
 * The grouped response (`GlobalSearchDto`, GlobalSearchDto.cs:39): up to `limitPerType` hits per
 * type. Empty groups are ALWAYS empty arrays, never null/omitted, so the client renders a
 * consistent grouped dropdown (GlobalSearchDto.cs:34-37).
 */
export interface GlobalSearchDto {
  readonly leads: SearchLeadDto[];
  readonly quotes: SearchQuoteDto[];
  readonly parties: SearchPartyDto[];
  readonly brokers: SearchBrokerDto[];
}

/** `GlobalSearchDto.Empty` (GlobalSearchDto.cs:45). */
export const EMPTY_GLOBAL_SEARCH: GlobalSearchDto = Object.freeze({
  leads: [],
  quotes: [],
  parties: [],
  brokers: [],
});

/** `GlobalSearchQuery.MinQueryLength` (GlobalSearchQuery.cs:22): trimmed q shorter than this -> empty. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** `GlobalSearchQuery.DefaultLimitPerType` (GlobalSearchQuery.cs:23). */
export const SEARCH_DEFAULT_LIMIT_PER_TYPE = 5;
