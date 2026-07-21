/**
 * Tenant Manager domain (T-016, P-02, spec §12).
 *
 * The cross-tenant, global-permission-bound registry surface: list/get/create/update, soft
 * remove and restore. Read service.ts before touching creation — it is one transaction on purpose.
 */
export { tenantRoutes } from './routes.js';
export {
  TENANT_CREATED_ACTION,
  TENANT_REMOVED_ACTION,
  TENANT_RESTORED_ACTION,
  TENANT_UPDATED_ACTION,
  createTenant,
  getTenant,
  listTenantsForCaller,
  removeTenant,
  restoreTenantById,
  updateTenantProfile,
  type TenantActor,
  type TenantsDeps,
} from './service.js';
export {
  TENANT_STATUS_ACTIVE,
  TENANT_STATUS_REMOVED,
  type CreateTenantResultDto,
  type TenantDto,
} from './schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { TenantsDeps } from './service.js';

/** Production wiring for the Tenant Manager surface; `getDb()` is the process-wide pool (T-008). */
export function defaultTenantsDeps(): TenantsDeps {
  return { db: getDb() };
}
