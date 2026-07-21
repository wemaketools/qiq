import { apiGet, apiPost, apiPut } from '../../api/client';
import type { LeadListItemDto } from '../leads/leadsApi';

/**
 * Parties backend contract (src/api/QuoteIQ.Api/Endpoints/PartyEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Parties/*, T-017, spec FR-26..FR-28). Fetch-wrapper module,
 * matching the established convention (`leadsApi.ts`/`tenantsApi.ts`/`usersApi.ts`/`settingsApi.ts`)
 * rather than RTK Query — this codebase has no RTK Query store configured anywhere (`app/store.ts`
 * is a plain `configureStore`), so introducing it for this task alone would be a new, unapproved
 * data-fetching framework (CLAUDE.md: "Do not introduce new frameworks or tools without approval").
 *
 * There is deliberately no `deleteParty`/`removeParty` export: `PartyEndpoints` maps no DELETE route
 * (PRD 12.9 — "parties cannot be deleted", AC-027) and no such endpoint exists to call.
 */

/** Wire shape of `PartyDto` (`src/api/.../Features/Parties/PartyDto.cs`). Reference ids only — the UI
 * resolves display names (type/segment/industry/region) via `settingsApi.listReferenceItems`, same as
 * `LeadsFilterBar`'s reference-option pattern, since the backend DTO carries ids, not names. */
export interface PartyDto {
  id: number;
  name: string;
  partyTypeId: number;
  segmentId: number | null;
  industryId: number | null;
  regionId: number | null;
  isStrategic: boolean;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  lastActivityAt: string | null;
  openLeadsCount: number;
  totalLeadsCount: number;
}

/** Wire shape of `PartyListDto`. */
export interface PartyListDto {
  items: PartyDto[];
  totalCount: number;
  page: number;
  pageSize: number;
}

/** Wire shape of `PartyWarningMatchDto` (one near-duplicate match, spec FR-28). */
export interface PartyWarningMatchDto {
  id: number;
  name: string;
}

/** Wire shape of `PartyWarningDto`. Only `DUPLICATE_NAME` is emitted today. */
export interface PartyWarningDto {
  code: string;
  matches: PartyWarningMatchDto[];
}

export const DUPLICATE_NAME_WARNING_CODE = 'DUPLICATE_NAME';

/** Wire shape of `PartyMutationResultDto`: the persisted party plus any non-blocking warnings. */
export interface PartyMutationResultDto {
  party: PartyDto;
  warnings: PartyWarningDto[];
}

/**
 * Sortable Parties-list columns and the backend sort key each maps to (spec FR-26/PRD 12.9,
 * `PartyStore.ApplySortAsync`, `src/api/.../QuoteIQ.Infrastructure/Parties/PartyStore.cs`). The
 * backend takes each key bare for ascending or `-`-prefixed for descending, so the pre-existing
 * `sort=-name` links still resolve to exactly the same ordering.
 *
 * Type/Segment/Industry/Region sort by the *reference item's name* server-side, not by the raw id
 * `PartyDto` carries — i.e. by what the grid actually renders once `settingsApi.listReferenceItems`
 * resolves those ids.
 */
export const PARTIES_SORT_KEYS = {
  name: 'name',
  type: 'type',
  segment: 'segment',
  industry: 'industry',
  region: 'region',
  strategic: 'strategic',
  openLeads: 'open_leads',
  totalLeads: 'total_leads',
  lastActivity: 'last_activity',
} as const;

export type PartiesSortField = keyof typeof PARTIES_SORT_KEYS;
export type PartiesSortDirection = 'asc' | 'desc';

export interface PartiesSortState {
  field: PartiesSortField;
  direction: PartiesSortDirection;
}

/** Spec FR-26/FR-28 / backend default: alphabetical by name. */
export const DEFAULT_PARTIES_SORT: PartiesSortState = { field: 'name', direction: 'asc' };

export function buildPartiesSortParam(sort: PartiesSortState | null | undefined): string | undefined {
  if (!sort) {
    return undefined;
  }
  const key = PARTIES_SORT_KEYS[sort.field];
  return sort.direction === 'desc' ? `-${key}` : key;
}

export const PARTIES_PAGE_SIZE = 25;

export interface ListPartiesParams {
  search?: string | null;
  partyTypeId?: number | null;
  segmentId?: number | null;
  industryId?: number | null;
  regionId?: number | null;
  strategic?: boolean | null;
  /** Backend sort key, as built by `buildPartiesSortParam`. */
  sort?: string | null;
  page?: number;
  pageSize?: number;
}

function buildListPartiesQuery(params: ListPartiesParams): string {
  const searchParams = new URLSearchParams();
  if (params.search) {
    searchParams.set('search', params.search);
  }
  if (params.partyTypeId != null) {
    searchParams.set('partyTypeId', String(params.partyTypeId));
  }
  if (params.segmentId != null) {
    searchParams.set('segmentId', String(params.segmentId));
  }
  if (params.industryId != null) {
    searchParams.set('industryId', String(params.industryId));
  }
  if (params.regionId != null) {
    searchParams.set('regionId', String(params.regionId));
  }
  if (params.strategic != null) {
    searchParams.set('strategic', String(params.strategic));
  }
  if (params.sort) {
    searchParams.set('sort', params.sort);
  }
  searchParams.set('page', String(params.page ?? 1));
  searchParams.set('pageSize', String(params.pageSize ?? PARTIES_PAGE_SIZE));
  return searchParams.toString();
}

export function listParties(params: ListPartiesParams): Promise<PartyListDto> {
  return apiGet<PartyListDto>(`/parties?${buildListPartiesQuery(params)}`);
}

export function getParty(id: number): Promise<PartyDto> {
  return apiGet<PartyDto>(`/parties/${id}`);
}

export interface PartyWritePayload {
  name: string;
  partyTypeId: number;
  segmentId: number | null;
  industryId: number | null;
  regionId: number | null;
  isStrategic: boolean;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export function createParty(payload: PartyWritePayload): Promise<PartyMutationResultDto> {
  return apiPost<PartyMutationResultDto>('/parties', payload);
}

export function updateParty(id: number, payload: PartyWritePayload): Promise<PartyMutationResultDto> {
  return apiPut<PartyMutationResultDto>(`/parties/${id}`, payload);
}

/**
 * Every lead for one party, newest-received first (`GET /parties/{id}/leads`,
 * `GetPartyLeadsQuery`/`GetPartyLeadsQueryHandler`, T-018 completing T-017's Leads card). Unlike
 * `leadsApi.listLeads`, this is not paginated/filterable — the backend returns the party's full
 * lead set in one call, matching PRD 12.9's "Leads card" (a bounded, per-party list, not the
 * working-queue Leads list).
 */
export function getPartyLeads(partyId: number): Promise<LeadListItemDto[]> {
  return apiGet<LeadListItemDto[]>(`/parties/${partyId}/leads`);
}
