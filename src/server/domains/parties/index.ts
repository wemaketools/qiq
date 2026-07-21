/**
 * Parties: the tenant-scoped list/detail/create/update surface over `parties`, plus the party
 * detail page's leads card (T-023, AC-041; spec FR-26..FR-28, P-05).
 *
 * There is deliberately no delete export, because there is no delete route (P-05, PRD 12.9).
 */
export {
  DUPLICATE_NAME_WARNING_CODE,
  PARTY_PHONE_PATTERN,
  PARTY_SORT_FIELDS,
  type LeadListItemDto,
  type PartyDto,
  type PartyListDto,
  type PartyMutationResultDto,
  type PartySortField,
  type PartyWarningDto,
  type PartyWarningMatchDto,
} from './schemas.js';
export {
  DUPLICATE_NAME_SIMILARITY_THRESHOLD,
  MAX_DUPLICATE_MATCHES,
  TYPE_AHEAD_SIMILARITY_THRESHOLD,
  normalizePartyName,
} from './name-matching.js';
export { partyRoutes } from './routes.js';
export {
  PARTY_CREATED_ACTION,
  PARTY_UPDATED_ACTION,
  parsePartySort,
  type PartiesActor,
  type PartiesDeps,
} from './service.js';

import { getDb } from '../../lib/db/index.js';
import type { PartiesDeps } from './service.js';

/**
 * Production wiring for the parties endpoints.
 *
 * Mirrors `defaultReferenceDataDeps()`. `getDb()` returns the process-wide pool and captures no
 * request state; the tenant is supplied per request by the route handlers from the verified
 * `TenantContext`, never from here.
 */
export function defaultPartiesDeps(): PartiesDeps {
  return { db: getDb() };
}
