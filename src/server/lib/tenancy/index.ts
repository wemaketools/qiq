/**
 * Tenant context (T-013, M-05, N-01, spec §13).
 *
 * The boundary that turns an untrusted `X-Tenant-Id` header into a verified `TenantId`. Read
 * middleware.ts before changing any status code here, and context.ts before adding a route.
 */
export {
  CROSS_TENANT_PERMISSION,
  createTenantAccessValidator,
  type TenantAccessCheck,
  type TenantAccessDeps,
  type TenantAccessResult,
  type TenantAccessValidator,
} from './access.js';
export {
  GLOBAL_ROUTE_PREFIXES,
  classifyRoute,
  normalizeRoutePath,
  notFoundMessage,
  requireFound,
  requiresTenantContext,
  type RouteScope,
  type TenantContext,
} from './context.js';
export {
  TENANT_ACCESS_DENIED_MESSAGE,
  TENANT_HEADER,
  tenantContext,
  type TenantContextDeps,
} from './middleware.js';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { getDb } from '../db/index.js';
import { createTenantAccessValidator } from './access.js';
import type { TenantContextDeps } from './middleware.js';

/**
 * Production tenant wiring, mirroring `defaultAuthDeps(config)`.
 *
 * Every composition root passes this to `buildApp({ tenancy })`. It exists so that wiring the
 * tenant slot is a one-liner rather than five lines of plumbing a root might get subtly wrong —
 * and so `src/server/tests/integration/auth-wiring.test.ts` can pin that every root does it. An
 * unwired tenant slot is silent: with no tenant-scoped routes registered yet nothing fails today,
 * but the first such route added would run with no verified tenant at all.
 *
 * `getDb()` returns the process-wide pool; no request state is captured here.
 */
export function defaultTenancyDeps(): TenantContextDeps {
  const db = getDb();
  return {
    db,
    validateTenantAccess: createTenantAccessValidator({
      db,
      loadGrantGraph: createGrantGraphLoader(db),
    }),
  };
}
