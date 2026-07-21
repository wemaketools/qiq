/**
 * Global tenant-scoped type-ahead search across leads, quotes, parties and brokers (T-038, FR-53).
 */
export { searchRoutes } from './routes.js';
export type { SearchActor, SearchDeps } from './service.js';
export type {
  GlobalSearchDto,
  SearchBrokerDto,
  SearchLeadDto,
  SearchPartyDto,
  SearchQuoteDto,
} from './schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { SearchDeps } from './service.js';

/**
 * Production wiring for the search endpoint.
 *
 * Mirrors `defaultBrokersDeps()`/`defaultPartiesDeps()`. `getDb()` returns the process-wide pool and
 * captures no request state; the tenant and caller are supplied per request by the route handler
 * from the verified `TenantContext` and resolved access, never from here.
 */
export function defaultSearchDeps(): SearchDeps {
  return { db: getDb() };
}
