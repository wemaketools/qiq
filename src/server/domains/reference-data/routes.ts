/**
 * Tenant reference-data routes (T-019, AC-022, AC-035, AC-036; V-045, V-047; spec §12 Settings).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/ReferenceDataEndpoints.cs:27-36`, permission for permission:
 *
 *   GET  /api/v1/settings/reference-data/{listType}              (none — membership only)  (:31)
 *   POST /api/v1/settings/reference-data/{listType}              reference_data.manage     (:32)
 *   PUT  /api/v1/settings/reference-data/{listType}/{id:long}    reference_data.manage     (:33)
 *   POST /api/v1/settings/reference-data/{listType}/{id}/disable reference_data.manage     (:34)
 *   POST /api/v1/settings/reference-data/{listType}/reorder      reference_data.manage     (:35)
 *
 * THE LIST READ IS DELIBERATELY UNGUARDED BEYOND TENANT MEMBERSHIP — AND THAT IS A BUG FIX,
 * NOT A RELAXATION
 * ============================================================================================
 * The endpoint's own doc comment (:16-23) records that this route WAS gated by
 * `reference_data.manage` and that the gate was removed on 2026-07-13 because it 403'd the lead and
 * party intake forms and every filter bar for every non-admin role: reference lists ARE the
 * dropdowns. Membership is still required and still verified server-side — `/api/v1/settings/...`
 * is NOT on `GLOBAL_ROUTE_PREFIXES`, so lib/tenancy classifies it tenant-scoped and the T-013
 * middleware demands a verified `X-Tenant-Id` before any handler here runs. Re-adding the
 * permission would re-break intake, so the suite pins a plain tenant member's 200 on GET alongside
 * their 403 on POST.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * Every handler reads `c.get('tenant')`, the verified `TenantContext` — never the raw header. There
 * is no database-level net beneath the resulting predicates (Postgres RLS is not adopted, spec
 * Q-10), so `tenantOf` throwing rather than defaulting is load-bearing: a handler that ran with an
 * absent tenant would be an unscoped query against every tenant's rows.
 *
 * MEASURED RESPONSE SHAPES (ReferenceDataEndpoints.cs)
 * ===================================================
 *   list     -> 200 ReferenceItemDto[]                                          (:49)
 *   create   -> 201 + Location: /api/v1/settings/reference-data/{listType}/{id} (:63)
 *   update   -> 200 ReferenceItemDto                                            (:77)
 *   disable  -> 200 with an EMPTY body (`Results.Ok()`, not `Ok(value)`)        (:90)
 *   reorder  -> 200 with an EMPTY body                                          (:104)
 *   bad list -> 400, message inline, NO `code` extension                        (:107-108)
 * The empty 200s are preserved rather than modernised to 204: the SPA's `apiPost<void>` handles
 * both, but this task's bar is contract preservation.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import type { TenantId } from '../../lib/db/index.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { invalidListTypeError, referenceValidationError, unreadableBodyError } from './errors.js';
import { parseReferenceListType, type ReferenceListType } from './list-types.js';
import {
  createItemSchema,
  listItemsQuerySchema,
  reorderItemsSchema,
  updateItemSchema,
} from './schemas.js';
import {
  createReferenceItem,
  disableReferenceItem,
  listReferenceItems,
  reorderReferenceItems,
  updateReferenceItem,
  type ReferenceDataActor,
  type ReferenceDataDeps,
} from './service.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

const BASE_PATH = '/settings/reference-data';

/**
 * Validates with a reference-data schema. Deliberately NOT `lib/validation`'s `validateBody`: that
 * helper throws a `ValidationError` carrying the generic `VALIDATION_FAILED` code, and the
 * reference's mapper emits `REFERENCE_DATA_VALIDATION_FAILED` — which is what appears in `detail`
 * and in the `code` extension the SPA and the reference's tests both read.
 */
function parseOr422<S extends ZodType>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw referenceValidationError(toFieldErrors(result.error));
  return result.data as ReturnType<S['parse']>;
}

async function readJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw unreadableBodyError();
  }
}

/** `ReferenceListTypes.TryParse(listType) is null -> InvalidListTypeProblem` (:41-44). */
function listTypeOf(c: Context<ApiEnv>): ReferenceListType {
  const raw = c.req.param('listType') ?? '';
  const parsed = parseReferenceListType(raw);
  if (parsed === null) throw invalidListTypeError(raw);
  return parsed;
}

/**
 * The `{id:long}` route constraint (:33).
 *
 * In ASP.NET a non-numeric id does not MATCH the route at all, so the caller gets a routing 404 —
 * not a validation error. Hono has no equivalent constraint syntax, so the check is explicit and
 * raises the same 404 the app's own `notFound` handler would have produced. Same treatment as
 * tenants/routes.ts:106-125, for the same reason.
 */
function itemIdOf(c: Context<ApiEnv>): number {
  const raw = c.req.param('id') ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

/**
 * The VERIFIED tenant, plus the acting user.
 *
 * A missing tenant here is a composition fault (the route would have to have been misclassified as
 * global, or the tenancy slot left unwired), and it fails CLOSED with a 500 rather than proceeding
 * unscoped. There is no fallback to the header, and there must never be one.
 */
function actorFrom(c: Context<ApiEnv>): ReferenceDataActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Reference-data route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function referenceDataRoutes(deps: ReferenceDataDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(`${BASE_PATH}/:listType`, async (c) => {
    const listType = listTypeOf(c);
    const { includeDisabled } = parseOr422(listItemsQuerySchema, c.req.query());
    return c.json(await listReferenceItems(deps, listType, includeDisabled, actorFrom(c)));
  });

  routes.post(
    `${BASE_PATH}/:listType/reorder`,
    requirePermission('reference_data.manage'),
    async (c) => {
      const listType = listTypeOf(c);
      const { orderedIds } = parseOr422(reorderItemsSchema, await readJsonBody(c));
      await reorderReferenceItems(deps, listType, orderedIds, actorFrom(c));
      return c.body(null, 200);
    },
  );

  routes.post(BASE_PATH + '/:listType', requirePermission('reference_data.manage'), async (c) => {
    const listType = listTypeOf(c);
    const input = parseOr422(createItemSchema(listType), await readJsonBody(c));
    const created = await createReferenceItem(deps, listType, input, actorFrom(c));

    c.header('Location', `/api/v1${BASE_PATH}/${listType}/${created.id}`);
    return c.json(created, 201);
  });

  routes.put(
    `${BASE_PATH}/:listType/:id`,
    requirePermission('reference_data.manage'),
    async (c) => {
      // The list type is parsed and validated but NOT passed down: the reference addresses the item
      // by id alone (:69-75). See repository.ts's `findItem`.
      listTypeOf(c);
      const id = itemIdOf(c);
      const input = parseOr422(updateItemSchema, await readJsonBody(c));
      return c.json(await updateReferenceItem(deps, id, input, actorFrom(c)));
    },
  );

  routes.post(
    `${BASE_PATH}/:listType/:id/disable`,
    requirePermission('reference_data.manage'),
    async (c) => {
      listTypeOf(c);
      await disableReferenceItem(deps, itemIdOf(c), actorFrom(c));
      return c.body(null, 200);
    },
  );

  return routes;
}
