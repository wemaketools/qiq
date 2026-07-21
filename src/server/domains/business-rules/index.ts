/**
 * Tenant business rules: the `/settings/business-rules` surface over `tenant_settings` (T-020),
 * the reference-number template grammar it validates (shared with T-024's generator), and the
 * server-side settings reader downstream features consume.
 */
export {
  formatReference,
  parseReferenceFormat,
  validateReferenceFormat,
  type ReferenceFormatSegment,
  type ReferenceFormatSegmentKind,
  type ReferenceFormatValidation,
} from './reference-format.js';
export {
  BUSINESS_RULES_NOT_FOUND,
  BUSINESS_RULES_VALIDATION_FAILED,
} from './errors.js';
export { businessRulesRoutes } from './routes.js';
export {
  TENANT_SETTINGS_ENTITY_TYPE,
  TENANT_SETTINGS_UPDATED_ACTION,
  getBusinessRules,
  getTenantSettings,
  updateBusinessRules,
  type BusinessRulesActor,
  type BusinessRulesDeps,
} from './service.js';
export { toBusinessRulesDto } from './repository.js';
export {
  BUSINESS_RULES_DTO_FIELDS,
  DEFAULT_TENANT_SETTINGS,
  type BusinessRulesDto,
  type TenantSettings,
  type UpdateBusinessRulesInput,
} from './schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { BusinessRulesDeps } from './service.js';

/**
 * Production wiring for the business-rules endpoints.
 *
 * Mirrors `defaultReferenceDataDeps()`. `getDb()` returns the process-wide pool and captures no
 * request state; the tenant is supplied per request by the route handlers from the verified
 * `TenantContext`, never from here.
 */
export function defaultBusinessRulesDeps(): BusinessRulesDeps {
  return { db: getDb() };
}
