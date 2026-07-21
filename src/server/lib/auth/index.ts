/**
 * Server-side authentication (T-011, spec §13 AuthN).
 *
 * Composition: `defaultAuthDeps(config)` is what every composition root (the Vercel function
 * entrypoint and the local dev runner) passes to `buildApp({ auth })`. Tests build their own deps
 * so they can drive the rejection cases without a live pool.
 */
import type { AppConfig } from '../config/index.js';
import type { AuthenticateDeps } from './middleware.js';
import { getAppUserLookup } from './user-lookup.js';
import { createAccessTokenVerifier } from './verify.js';

export { authenticate, NO_ACTIVE_USER_MESSAGE, type AuthenticateDeps } from './middleware.js';
export type { AuthContext } from './context.js';
export {
  getRequiredPermission,
  permissionResolution,
  requirePermission,
  type EffectiveAccessResolver,
  type PermissionResolutionDeps,
} from './require-permission.js';
export {
  ALLOWED_JWT_ALGORITHMS,
  decodeJwtHeader,
  expectedIssuer,
  extractBearerToken,
  isAllowedAlgorithm,
  issuerMatches,
  type JwtHeader,
  type TokenRejectionReason,
} from './token.js';
export {
  closeSharedAppUserLookup,
  createPgAppUserLookup,
  getAppUserLookup,
  type AppUserLookup,
  type AppUserRecord,
} from './user-lookup.js';
export {
  createAccessTokenVerifier,
  type AccessTokenVerifier,
  type VerifiedToken,
} from './verify.js';

/** Production authentication wiring: real JWKS-backed verification + the real users table. */
export function defaultAuthDeps(config: AppConfig): AuthenticateDeps {
  return {
    verifyAccessToken: createAccessTokenVerifier({ config }),
    lookupAppUser: getAppUserLookup(config),
  };
}
