/**
 * Global type-ahead search application logic (T-038, spec FR-53/A-14; AC-022, AC-080).
 *
 * Port of `GlobalSearchQueryHandler` (GlobalSearchQueryHandler.cs): trims the query, short-circuits
 * to an empty grouped result below the minimum length, floors a non-positive `limitPerType` at the
 * reference default, and delegates the four grouped queries to the repository.
 *
 * BREADTH IS RESOLVED SERVER-SIDE, FROM THE CALLER'S GRANTS, NEVER FROM THE WIRE. The route resolves
 * the caller's effective access from the same per-request resolver the guard used and passes
 * `hasLeadViewAll` in on the actor — a client cannot widen its own lead/quote visibility by lying on
 * the query string (GlobalSearchQueryHandler.cs:43-45, same pattern as `ListLeadsQueryHandler`).
 */
import type { DbClient, TenantId } from '../../lib/db/index.js';
import { searchTenant } from './repository.js';
import {
  EMPTY_GLOBAL_SEARCH,
  SEARCH_DEFAULT_LIMIT_PER_TYPE,
  SEARCH_MIN_QUERY_LENGTH,
  type GlobalSearchDto,
} from './schemas.js';

export interface SearchDeps {
  readonly db: DbClient;
}

/** Who is searching, in which verified tenant, with what lead-visibility breadth. */
export interface SearchActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  /** Server-resolved `leads.view_all`; when false the leads/quotes groups are breadth-limited. */
  readonly hasLeadViewAll: boolean;
}

export interface GlobalSearchInput {
  readonly q: string | undefined;
  readonly limitPerType: number | undefined;
}

/**
 * `GlobalSearchQueryHandler.Handle` (GlobalSearchQueryHandler.cs:33-51).
 *
 * A query shorter than `SEARCH_MIN_QUERY_LENGTH` after trimming yields the empty grouped result
 * (200), not an error — the top-bar dropdown simply shows nothing until enough is typed
 * (GlobalSearchQuery.cs:16-18, verification V-052). A `limitPerType < 1` falls back to the default;
 * a positive value is used as supplied (the reference imposes no upper cap — recorded, not invented).
 */
export async function globalSearch(
  deps: SearchDeps,
  input: GlobalSearchInput,
  actor: SearchActor,
): Promise<GlobalSearchDto> {
  const trimmed = (input.q ?? '').trim();
  if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) {
    return EMPTY_GLOBAL_SEARCH;
  }

  const limitPerType =
    input.limitPerType === undefined || input.limitPerType < 1
      ? SEARCH_DEFAULT_LIMIT_PER_TYPE
      : input.limitPerType;

  return await searchTenant(deps.db, actor.tenantId, {
    q: trimmed,
    limitPerType,
    callerUserId: actor.userId,
    callerHasLeadViewAll: actor.hasLeadViewAll,
  });
}
