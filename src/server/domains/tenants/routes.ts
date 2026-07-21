/**
 * Tenant Manager routes (T-016, AC-027, AC-028; V-035, V-037; spec §12).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/TenantEndpoints.cs:21-31`, permission for permission:
 *
 *   GET    /api/v1/tenants              tenants.view        (:25)
 *   GET    /api/v1/tenants/{id}         tenants.view        (:26)
 *   POST   /api/v1/tenants              tenants.create      (:27)
 *   PUT    /api/v1/tenants/{id}         tenants.edit        (:28)
 *   POST   /api/v1/tenants/{id}/remove  tenants.deactivate  (:29)
 *   POST   /api/v1/tenants/{id}/restore tenants.restore     (:30)
 *
 * plus the second gate on `?includeRemoved=true`, which additionally needs `tenants.view_removed`
 * (ListTenantsQueryHandler.cs:25-33).
 *
 * THERE IS NO `DELETE /tenants/{id}` — AND THAT IS A REQUIREMENT, NOT AN OMISSION (AC-027, N-09).
 * The reference has no such route either. Removal is the soft `POST /{id}/remove`; nothing in this
 * surface can destroy a tenant's history. V-035 asserts the absence of the route.
 *
 * CROSS-TENANT BY CLASSIFICATION, GLOBAL-PERMISSION-BOUND BY GUARD
 * ===============================================================
 * `/api/v1/tenants` is on `GLOBAL_ROUTE_PREFIXES` (lib/tenancy/context.ts, ported from
 * TenantContextMiddleware.cs:20-26), so no `X-Tenant-Id` is required or consulted — a Tenant
 * Manager operating ACROSS tenants cannot be scoped to one of them. Being exempt from the tenant
 * middleware is not an authorization decision, and it grants nothing: with no tenant on the
 * request, `requirePermission` resolves in the GLOBAL scope (require-permission.ts:tenantScopeOf),
 * so a grant a user holds inside some tenant does NOT open these routes. The suite proves that with
 * a user holding tenant-scoped `tenants.view` and nothing global, who is denied.
 *
 * MEASURED RESPONSE SHAPES (TenantEndpoints.cs)
 * ============================================
 *   list    -> 200 TenantDto[]                                           (:39)
 *   get     -> 200 TenantDto                                             (:47)
 *   create  -> 201 + Location: /api/v1/tenants/{id}, CreateTenantResult  (:56-58)
 *   update  -> 200 TenantDto                                             (:67)
 *   remove  -> 200 with an EMPTY body (`Results.Ok()`, not `Ok(value)`)  (:75)
 *   restore -> 200 with an EMPTY body                                    (:83)
 * The empty 200s are preserved rather than modernised to 204, for the reason MeEndpoints' port
 * gives: both work for today's SPA, but this task's bar is contract preservation.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import {
  tenantValidationError,
  unreadableBodyError,
  viewRemovedForbiddenError,
} from './errors.js';
import {
  createTenantSchema,
  listTenantsQuerySchema,
  updateTenantSchema,
} from './schemas.js';
import {
  createTenant,
  getTenant,
  listTenantsForCaller,
  removeTenant,
  restoreTenantById,
  updateTenantProfile,
  type TenantActor,
  type TenantsDeps,
} from './service.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

/** The permission `?includeRemoved=true` additionally requires, in the global scope. */
const VIEW_REMOVED_PERMISSION = 'tenants.view_removed';

/**
 * Validates with a tenant-domain schema. Deliberately NOT `lib/validation`'s `validateBody`: that
 * helper throws a `ValidationError`, which carries a `code` and therefore renders
 * `detail: "VALIDATION_FAILED: ..."`. TenantEndpoints.cs:88 emits the bare message with no code
 * extension (see errors.ts), so the mapping is done here instead of changing shared behaviour.
 */
function parseOr422<S extends ZodType>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw tenantValidationError(toFieldErrors(result.error));
  return result.data as ReturnType<S['parse']>;
}

async function readJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw unreadableBodyError();
  }
}

/** The acting user, from the VERIFIED token subject the auth middleware resolved. */
function actorFrom(c: Context<ApiEnv>): TenantActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);
  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

/**
 * The `{id:long}` route constraint (TenantEndpoints.cs:26,28,29,30).
 *
 * In ASP.NET a non-numeric id does not MATCH the route at all, so the caller gets a routing 404 —
 * not a validation error. Hono has no equivalent constraint syntax, so the check is explicit and
 * raises the same 404 the app's own `notFound` handler would have produced for an unmatched path.
 * Answering 422 here instead would be a visible contract change on a route a client can hit with
 * any string.
 */
function tenantIdOf(c: Context<ApiEnv>): number {
  const raw = c.req.param('id') ?? '';
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

export function tenantRoutes(deps: TenantsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/tenants', requirePermission('tenants.view'), async (c) => {
    const { includeRemoved } = parseOr422(listTenantsQuerySchema, c.req.query());

    if (includeRemoved) {
      // ListTenantsQueryHandler.cs:28 resolves in the GLOBAL scope (`null`), not in some tenant's:
      // a per-tenant grant must not reveal the full cross-tenant registry.
      const resolveAccess = c.get('resolveAccess');
      const access = await resolveAccess?.(null);
      if (access === undefined || !access.has(VIEW_REMOVED_PERMISSION)) {
        throw viewRemovedForbiddenError();
      }
    }

    return c.json(await listTenantsForCaller(deps, includeRemoved));
  });

  routes.get('/tenants/:id', requirePermission('tenants.view'), async (c) =>
    c.json(await getTenant(deps, tenantIdOf(c))),
  );

  routes.post('/tenants', requirePermission('tenants.create'), async (c) => {
    const input = parseOr422(createTenantSchema, await readJsonBody(c));
    const created = await createTenant(deps, input, actorFrom(c));

    c.header('Location', `/api/v1/tenants/${created.tenantId}`);
    return c.json(created, 201);
  });

  routes.put('/tenants/:id', requirePermission('tenants.edit'), async (c) => {
    const tenantId = tenantIdOf(c);
    const input = parseOr422(updateTenantSchema, await readJsonBody(c));
    return c.json(await updateTenantProfile(deps, tenantId, input, actorFrom(c)));
  });

  routes.post('/tenants/:id/remove', requirePermission('tenants.deactivate'), async (c) => {
    await removeTenant(deps, tenantIdOf(c), actorFrom(c));
    return c.body(null, 200);
  });

  routes.post('/tenants/:id/restore', requirePermission('tenants.restore'), async (c) => {
    await restoreTenantById(deps, tenantIdOf(c), actorFrom(c));
    return c.body(null, 200);
  });

  return routes;
}
