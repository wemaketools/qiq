/**
 * Bearer authentication middleware (T-011, AC-016, V-019; spec §13 AuthN).
 *
 * Fills the auth slot prepared by T-009, between the error boundary and the routes, so every
 * 401 it raises is mapped to problem+json by the existing boundary and appears in the existing
 * request log line with the resolved userId.
 *
 * 401 vs 403 — MEASURED AGAINST THE REFERENCE, NOT ASSUMED.
 * `src/api/QuoteIQ.Api/Auth/RequirePermissionFilter.cs` returns 401 for all three of: no subject
 * claim, no `users` row for the subject, and `!user.IsActive` — 403 is reserved exclusively for a
 * *resolved, active* user missing the required permission. The .NET test suite pins this:
 * `RequirePermissionTests.RequirePermission_WhenNoAppUserForPrincipal_ShouldReturn401` and
 * `..._WhenAppUserIsInactive_ShouldReturn401`. This middleware therefore returns 401 for an
 * unknown or deactivated user; permission 403s belong to T-012.
 *
 * Failure detail is never returned to the client — every rejection produces the same generic
 * body (V-019: "without leaking verification detail"). The specific reason goes to the server log
 * only, and the token itself is never logged in any form.
 */
import type { MiddlewareHandler } from 'hono';

import { UnauthorizedError } from '../errors/index.js';
import type { ApiEnv } from '../router/env.js';
import type { AuthContext } from './context.js';
import { extractBearerToken, type TokenRejectionReason } from './token.js';
import type { AppUserLookup } from './user-lookup.js';
import type { AccessTokenVerifier } from './verify.js';

export interface AuthenticateDeps {
  readonly verifyAccessToken: AccessTokenVerifier;
  readonly lookupAppUser: AppUserLookup;
  /**
   * Exact paths served without authentication. `/api/v1/health` is the only one today; the
   * Q-19 hashed-API-key intake route (T-030) authenticates differently and will be added here
   * (or, better, mounted with its own credential middleware) rather than by weakening this one.
   */
  readonly publicPaths?: readonly string[];
}

/** Generic client-facing messages. Both are 401; neither reveals which check failed. */
const TOKEN_REJECTED_MESSAGE = 'A valid access token is required to call this endpoint.';
/**
 * Preserved verbatim from RequirePermissionFilter.UnauthorizedProblem().
 * Exported so the permission guard (T-012) answers an absent principal with the same body rather
 * than a second, subtly different 401.
 */
export const NO_ACTIVE_USER_MESSAGE =
  'No active application user could be resolved for the authenticated principal.';

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * True when the request matched a real route handler (as opposed to only middleware).
 *
 * ASP.NET resolved the endpoint before running authorization, so an unknown path returned 404 to
 * an anonymous caller rather than 401 (and T-009's V-017 test pins that 404). Hono runs
 * path-pattern middleware regardless of whether a handler exists, so the same behaviour has to be
 * asked for explicitly. `app.use()` registers with method 'ALL'; a route registered with
 * `.get()`/`.post()`/... keeps its verb, which is what distinguishes the two here.
 */
function matchedARouteHandler(matchedRoutes: readonly { method: string }[]): boolean {
  return matchedRoutes.some((route) => route.method !== 'ALL');
}

export function authenticate(deps: AuthenticateDeps): MiddlewareHandler<ApiEnv> {
  const publicPaths = new Set((deps.publicPaths ?? []).map(normalizePath));

  return async function authenticateMiddleware(c, next) {
    const path = normalizePath(c.req.path);

    if (publicPaths.has(path) || !matchedARouteHandler(c.req.matchedRoutes)) {
      await next();
      return;
    }

    const logger = c.get('logger');

    const unauthorized = (
      reason: TokenRejectionReason | 'no_app_user' | 'user_inactive',
    ): UnauthorizedError => {
      // The reason is diagnostic and stays server-side; no token material is included.
      logger.warn('authentication rejected', { reason, route: `${c.req.method} ${path}` });
      // Deliberately no `code` extension: RequirePermissionFilter.cs emitted a bare 401
      // problem+json (status/title/detail only), and lib/errors/problem.ts records that contract.
      return new UnauthorizedError(
        reason === 'no_app_user' || reason === 'user_inactive'
          ? NO_ACTIVE_USER_MESSAGE
          : TOKEN_REJECTED_MESSAGE,
      );
    };

    const bearer = extractBearerToken(c.req.header('authorization'));
    if (!bearer.ok) throw unauthorized(bearer.error);

    const verified = await deps.verifyAccessToken(bearer.value);
    if (!verified.ok) throw unauthorized(verified.error);

    const appUser = await deps.lookupAppUser(verified.value.authUserId);
    if (appUser === null) throw unauthorized('no_app_user');
    if (!appUser.isActive) throw unauthorized('user_inactive');

    const auth: AuthContext = {
      userId: appUser.id,
      authUserId: appUser.authUserId,
      email: appUser.email,
      firstName: appUser.firstName,
      lastName: appUser.lastName,
      tokenAlgorithm: verified.value.algorithm,
    };

    c.set('auth', auth);
    // Mirrored onto the flat variable the T-009 request-log line already reads.
    c.set('userId', auth.userId);

    await next();
  };
}
