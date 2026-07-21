/**
 * Users domain — the caller's own session surface (T-015, P-01, spec §12).
 *
 * `defaultMeDeps()` mirrors `defaultAuthDeps(config)` / `defaultTenancyDeps()`: every composition
 * root wires the slot with one call rather than five lines of plumbing it might get subtly wrong.
 * `getDb()` returns the process-wide pool — no request state is captured here (T-008).
 */
export {
  ALLOWED_THEMES,
  INVALID_THEME_MESSAGE,
  setMePreferencesSchema,
  type MeMembershipDto,
  type MeResponseDto,
  type SetMePreferencesInput,
  type ThemePreference,
} from './me.schemas.js';
export { meRoutes, TENANT_NOT_A_MEMBER_MESSAGE } from './me.routes.js';
export {
  getMe,
  setMePreferences,
  type MeDeps,
  type SetPreferencesOutcome,
} from './me.service.js';
export { createSupabaseAuthAdmin, type AuthAdminPort } from './auth-admin.js';
export { userRoutes } from './routes.js';
export {
  USER_ACTIVATED_ACTION,
  USER_CREATED_ACTION,
  USER_DEACTIVATED_ACTION,
  USER_UPDATED_ACTION,
  type UsersDeps,
} from './service.js';
export {
  GLOBAL_SCOPE_KEY,
  type CreateUserResultDto,
  type EffectiveAccessDto,
  type UserDto,
} from './schemas.js';

import { createGrantGraphLoader } from '../rbac/index.js';
import { getDb } from '../../lib/db/index.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { createSupabaseAuthAdmin } from './auth-admin.js';
import type { MeDeps } from './me.service.js';
import type { UsersDeps } from './service.js';

/**
 * Production wiring for the whole User Manager surface (T-017): users, roles, groups and the
 * permission catalog. One slot rather than four, because the four routers are one feature and a
 * root that wired three of them would ship a half-working admin screen.
 *
 * `buildApp({ userManager })` is optional (app.ts registers domain routers conditionally), so a
 * root that OMITS it 404s the entire User Manager in production while every test stays green — the
 * exact failure F-016-3 recorded for the tenants slot. `auth-wiring.test.ts` pins both roots.
 */
export function defaultUserManagerDeps(): UsersDeps {
  const db = getDb();
  return {
    db,
    authAdmin: createSupabaseAuthAdmin(),
    loadGrantGraph: createGrantGraphLoader(db),
  };
}

export function defaultMeDeps(): MeDeps {
  const db = getDb();
  const loadGrantGraph = createGrantGraphLoader(db);
  return {
    db,
    loadGrantGraph,
    // The same validator the tenant middleware uses, so "may I persist tenant X" and "may I enter
    // tenant X" can never answer differently.
    validateTenantAccess: createTenantAccessValidator({ db, loadGrantGraph }),
  };
}
