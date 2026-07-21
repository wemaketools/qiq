/**
 * `GET /api/v1/me` and `PUT /api/v1/me/preferences` (T-015, AC-025, AC-027, AC-034; P-01, spec §12).
 *
 * Port of src/api/QuoteIQ.Api/Endpoints/MeEndpoints.cs.
 *
 * NO `requirePermission` GATE — DELIBERATELY
 * =========================================
 * The reference registered these on `GlobalGroup` with no permission filter (MeEndpoints.cs:8-22):
 * every authenticated user may read their own identity and set their own preferences. Adding a
 * permission code here would be a lockout, not a hardening — a zero-membership Internal user has no
 * tenant-scoped grants at all, and gating `/me` on one would leave them unable to bootstrap the
 * shell they are entitled to use. Authentication (T-011) is the gate; the payload is already scoped
 * to the caller's own `users.id` in the service.
 *
 * NO `X-Tenant-Id` EITHER: `/api/v1/me` is on `GLOBAL_ROUTE_PREFIXES` (lib/tenancy/context.ts,
 * ported from TenantContextMiddleware.cs:20-26), which is what makes the login round trip possible
 * at all — the SPA cannot send a tenant header before `/me` has told it which tenants exist.
 *
 * MEASURED STATUS CODES (MeEndpoints.cs:28-52)
 * ===========================================
 *   no active application user   -> 401
 *   lastTenantId not permitted   -> 403   (`TENANT_NOT_A_MEMBER`)
 *   theme outside the allow-list -> 422   (`PREFERENCES_VALIDATION_FAILED`)
 *   success (PUT)                -> 200 with an EMPTY body (`Results.Ok()`, not `Ok(value)`)
 *
 * The 200-with-no-body is preserved rather than "modernised" to 204: the SPA's client reads
 * `response.text()` and tolerates an empty string (src/ui/src/api/client.ts:94-99), so both would
 * work today — but 204 is a different response to every other consumer, and this task's bar is
 * contract preservation, not taste.
 */
import { Hono } from 'hono';

import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/index.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { validateBody } from '../../lib/validation/index.js';
import { setMePreferencesSchema } from './me.schemas.js';
import { getMe, setMePreferences, type MeDeps } from './me.service.js';

/** Verbatim from `SetMePreferencesCommandHandler.NotAMember` (SetMePreferencesCommandHandler.cs:28). */
export const TENANT_NOT_A_MEMBER_MESSAGE = 'Caller is not a member of the requested tenant.';

/**
 * The caller's application `users.id`.
 *
 * Reads the id the authentication middleware resolved from the VERIFIED token subject — never a
 * body field, query parameter or header. There is no supported way for a caller to ask this
 * endpoint about somebody else.
 */
function callerUserId(auth: { readonly userId: string } | undefined): number {
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);
  return Number(auth.userId);
}

export function meRoutes(deps: MeDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/me', async (c) => {
    const profile = await getMe(deps, callerUserId(c.get('auth')));
    // Defensive: the authentication middleware already rejects a principal with no active `users`
    // row, so this is reachable only if the row vanished mid-request. 401 matches the reference's
    // `UNAUTHENTICATED` mapping (MeEndpoints.cs:30) rather than inventing a 404 for the caller's
    // own identity.
    if (profile === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);
    return c.json(profile);
  });

  routes.put('/me/preferences', async (c) => {
    const input = await validateBody(c, setMePreferencesSchema);
    const outcome = await setMePreferences(deps, callerUserId(c.get('auth')), input);

    if (outcome === 'tenant_not_permitted') {
      throw new ForbiddenError(TENANT_NOT_A_MEMBER_MESSAGE);
    }

    // `Results.Ok()` — 200, empty body. See the header note on why this is not a 204.
    return c.body(null, 200);
  });

  return routes;
}
