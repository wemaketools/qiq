/**
 * API-credential administration routes (T-022, AC-022, AC-024, AC-040; V-027, V-031, V-051, V-052).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/ApiAccessEndpoints.cs:33-41`, permission for permission:
 *
 *   GET  /api/v1/settings/api-credentials                        api_access.view              (:35)
 *   POST /api/v1/settings/api-credentials                        api_access.enable            (:36)
 *   POST /api/v1/settings/api-credentials/broker/{brokerId:long} api_access.enable            (:37)
 *   POST /api/v1/settings/api-credentials/{id:long}/reveal       api_access.view              (:38)
 *   POST /api/v1/settings/api-credentials/{id:long}/regenerate   api_access.regenerate_secret (:39)
 *   POST /api/v1/settings/api-credentials/{id:long}/disable      api_access.disable           (:40)
 *
 * THE BASE PATH IS `/settings/api-credentials`, NOT `/api-credentials`
 * ===================================================================
 * V-051 names `POST /api/v1/api-credentials`. The reference group is
 * `endpoints.TenantScopedGroup("/api/v1/settings/api-credentials")` (:33) and the SPA calls
 * `/settings/api-credentials` (settingsApi.ts:301-322). The measured contract wins; the shorter
 * path would 404 the Settings API-access tab and the broker API section. Recorded as a
 * verification-plan contradiction in T-022's task file rather than silently chosen.
 *
 * THE RETIRED REVEAL ROUTE
 * ========================
 * The reference re-served the secret by calling Keycloak live. Under Q-19 the stored form is a
 * salted hash, so there is nothing to re-serve and the migration header forbids growing a successor
 * path. The route stays REGISTERED and answers 410 `API_CREDENTIAL_NOT_REVEALABLE` rather than
 * being deleted, because the SPA still calls it and a bare 404 there is indistinguishable from a
 * wiring bug. It is deliberately NOT aliased to regenerate: that would rotate a live integration's
 * key on a click that reads as a read. Flagged for a product ruling in T-022's task file.
 *
 * Note it keeps the reference's `api_access.view` guard (:38) — the guard is checked before the
 * 410, so an unpermitted caller still gets 403 and cannot use this route to probe which credential
 * ids exist.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * `/api/v1/settings/...` is not on `GLOBAL_ROUTE_PREFIXES`, so lib/tenancy classifies it
 * tenant-scoped and the T-013 middleware demands a verified `X-Tenant-Id` before any handler here
 * runs. Every handler reads `c.get('tenant')`, never the raw header, and `actorFrom` throws rather
 * than defaulting: with no RLS underneath (spec Q-10), a handler that ran with an absent tenant
 * would be an unscoped query against every tenant's credentials.
 *
 * MEASURED RESPONSE SHAPES (ApiAccessEndpoints.cs)
 * ===============================================
 *   list        -> 200 ApiCredentialListDto                                        (:45-47)
 *   provision   -> 201 + Location: /api/v1/settings/api-credentials/{id}           (:53-55)
 *   regenerate  -> 200 CredentialSecretDto                                         (:78)
 *   disable     -> 200 ApiCredentialDto                                            (:86)
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { AppError } from '../../lib/errors/index.js';
import { API_CREDENTIAL_VALIDATION_FAILED, credentialNotRevealableError } from './errors.js';
import { listCredentialsQuerySchema } from './schemas.js';
import {
  disableCredential,
  listCredentials,
  provisionCredential,
  regenerateSecret,
  type ApiAccessActor,
  type ApiAccessDeps,
} from './service.js';

import type { Context } from 'hono';

const BASE_PATH = '/settings/api-credentials';

/**
 * The `{id:long}` / `{brokerId:long}` route constraints (:37-40).
 *
 * In ASP.NET a non-numeric id does not MATCH the route at all, so the caller gets a routing 404 —
 * not a validation error. Hono has no equivalent constraint syntax, so the check is explicit and
 * raises the same 404 the app's own `notFound` handler would have produced. Same treatment as
 * brokers/routes.ts:118-125, for the same reason.
 */
function numericParam(c: Context<ApiEnv>, name: string): number {
  const raw = c.req.param(name) ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

/**
 * The VERIFIED tenant, plus the acting user.
 *
 * A missing tenant here is a composition fault (the route misclassified as global, or the tenancy
 * slot left unwired) and fails CLOSED with a 500 rather than proceeding unscoped. There is no
 * fallback to the header, and there must never be one.
 */
function actorFrom(c: Context<ApiEnv>): ApiAccessActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'API-credential route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function apiAccessRoutes(deps: ApiAccessDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(BASE_PATH, requirePermission('api_access.view'), async (c) => {
    const parsed = listCredentialsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      const fieldErrors = toFieldErrors(parsed.error);
      throw new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
        code: API_CREDENTIAL_VALIDATION_FAILED,
        fieldErrors,
      });
    }
    return c.json(await listCredentials(deps, parsed.data, actorFrom(c)));
  });

  routes.post(BASE_PATH, requirePermission('api_access.enable'), async (c) => {
    const issued = await provisionCredential(deps, null, actorFrom(c));
    c.header('Location', `/api/v1${BASE_PATH}/${String(issued.credential.id)}`);
    return c.json(issued, 201);
  });

  routes.post(
    `${BASE_PATH}/broker/:brokerId`,
    requirePermission('api_access.enable'),
    async (c) => {
      const brokerId = numericParam(c, 'brokerId');
      const issued = await provisionCredential(deps, brokerId, actorFrom(c));
      c.header('Location', `/api/v1${BASE_PATH}/${String(issued.credential.id)}`);
      return c.json(issued, 201);
    },
  );

  // Registered BEFORE the sibling `/:id/...` routes to make precedence explicit: `/broker/:brokerId`
  // and `/:id/reveal` have different segment counts so they cannot actually collide, but relying on
  // that silently is how a later route addition breaks one of them.
  routes.post(`${BASE_PATH}/:id/reveal`, requirePermission('api_access.view'), (c) => {
    // The id is still validated, so a nonsense id answers 404 rather than 410 — the 410 is a
    // statement about a real credential, not a catch-all.
    numericParam(c, 'id');
    throw credentialNotRevealableError();
  });

  routes.post(
    `${BASE_PATH}/:id/regenerate`,
    requirePermission('api_access.regenerate_secret'),
    async (c) => c.json(await regenerateSecret(deps, numericParam(c, 'id'), actorFrom(c))),
  );

  routes.post(`${BASE_PATH}/:id/disable`, requirePermission('api_access.disable'), async (c) =>
    c.json(await disableCredential(deps, numericParam(c, 'id'), actorFrom(c))),
  );

  return routes;
}
