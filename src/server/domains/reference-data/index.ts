/**
 * Reference data: the GLOBAL default template plus the per-tenant seeding that copies it (T-016),
 * and the tenant-scoped CRUD/disable/reorder surface over `reference_items` (T-019).
 */
export {
  REFERENCE_LIST_TYPES,
  REPORTING_CATEGORIES,
  REQUIRED_CANONICAL_STATUSES,
  type CanonicalStatus,
  type ReferenceListType,
} from './canonical-statuses.js';
export {
  TEMPLATE_REPLACED_ACTION,
  globalTemplateRoutes,
  type GlobalTemplateDeps,
} from './global-template.routes.js';
export {
  listDefaultReferenceItems,
  replaceDefaultReferenceItems,
  type DefaultReferenceItemInput,
  type DefaultReferenceItemRecord,
} from './template-repository.js';
export {
  REFERENCE_SEEDED_ACTION,
  TemplateSeedingError,
  seedTenantReferenceData,
  type SeedCounts,
} from './tenant-seeder.js';

export {
  INTERMEDIATE_REPORTING_CATEGORIES,
  carriesBrokerChannelFlag,
  isIntermediateReportingCategory,
  isStatusListType,
  parseReferenceListType,
  requiresProductLine,
} from './list-types.js';
export { referenceDataRoutes } from './routes.js';
export {
  REFERENCE_ITEM_CREATED_ACTION,
  REFERENCE_ITEM_DISABLED_ACTION,
  REFERENCE_ITEM_REORDERED_ACTION,
  REFERENCE_ITEM_UPDATED_ACTION,
  type ReferenceDataActor,
  type ReferenceDataDeps,
} from './service.js';
export type { ReferenceItemDto } from './schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { GlobalTemplateDeps } from './global-template.routes.js';
import type { ReferenceDataDeps } from './service.js';

/** Production wiring for the global default-template endpoints. */
export function defaultGlobalTemplateDeps(): GlobalTemplateDeps {
  return { db: getDb() };
}

/**
 * Production wiring for the tenant reference-data endpoints.
 *
 * Mirrors `defaultTenantsDeps()`/`defaultUserManagerDeps()`. `getDb()` returns the process-wide
 * pool and captures no request state; the tenant is supplied per request by the route handlers from
 * the verified `TenantContext`, never from here.
 */
export function defaultReferenceDataDeps(): ReferenceDataDeps {
  return { db: getDb() };
}
