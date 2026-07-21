/**
 * RBAC domain (T-012, P-03, spec §13 AuthZ).
 *
 * The effective-permission model: a pure resolver, the single-round-trip grant-graph lookup that
 * feeds it, and the fixed permission catalog. The route guard that consumes all three lives in
 * `lib/auth/require-permission.ts`, next to the authentication middleware it composes with.
 */
export {
  computeEffectivePermissions,
  createEffectiveAccess,
  type EffectiveAccess,
} from './effective-permissions.js';
export {
  isPermissionCode,
  PERMISSION_CODES,
  VISIBILITY_BREADTH_PERMISSIONS,
  type PermissionCode,
  type VisibilityDomain,
} from './permission-catalog.js';
export {
  createGrantGraphLoader,
  loadGrantGraph,
  type GrantGraphLoader,
} from './repository.js';
export type {
  GrantGraph,
  GrantSource,
  PermissionGrant,
  PermissionScope,
  TenantScopeValue,
} from './types.js';

/* User Manager administration surface (T-017): roles, groups, permission catalog. */
export {
  callerHolds,
  callerHoldsAmbient,
  callerHoldsInAllScopes,
  isAccessAdminCode,
  isReadAccessible,
  isWriteAccessible,
  MANAGE_GLOBAL_DEFAULTS,
  type AdminActor,
} from './admin-context.js';
export { roleRoutes } from './roles.routes.js';
export { groupRoutes } from './groups.routes.js';
export { permissionRoutes, type PermissionsDeps } from './permissions.routes.js';
export {
  ROLE_CREATED_ACTION,
  ROLE_DISABLED_ACTION,
  ROLE_UPDATED_ACTION,
  type RolesDeps,
} from './roles.service.js';
export {
  GROUP_CREATED_ACTION,
  GROUP_DISABLED_ACTION,
  GROUP_MEMBER_ADDED_ACTION,
  GROUP_MEMBER_REMOVED_ACTION,
  GROUP_PERMISSIONS_SET_ACTION,
  GROUP_ROLES_SET_ACTION,
  GROUP_UPDATED_ACTION,
  type GroupsDeps,
} from './groups.service.js';
export type {
  GroupDetailDto,
  GroupDto,
  PermissionCatalogDto,
  RoleDto,
  RoleUsageDto,
} from './admin-schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { PermissionResolutionDeps } from '../../lib/auth/require-permission.js';
import { createGrantGraphLoader as createLoader } from './repository.js';

/**
 * Production wiring for the effective-permission resolver (T-012), mirroring `defaultAuthDeps` and
 * `defaultTenancyDeps`.
 *
 * A root that omits this leaves every `requirePermission(...)` route failing CLOSED with a 500
 * (require-permission.ts) — loud rather than permissive, but still broken, so both roots pass it
 * and tests/integration/auth-wiring.test.ts pins that they do.
 *
 * That pin was MISSING when this comment first claimed it existed: deleting `rbac:` from an
 * entrypoint left all 873 tests green (finding F-016-1), because the suites compose their own app
 * and never read the production roots. The pin is real now — but the lesson is that a comment
 * asserting a guard is not evidence the guard exists.
 */
export function defaultRbacDeps(): PermissionResolutionDeps {
  return { loadGrantGraph: createLoader(getDb()) };
}
