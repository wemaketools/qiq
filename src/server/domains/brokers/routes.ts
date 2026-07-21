/**
 * Broker administration routes (T-021, AC-022, AC-039; V-027, V-050; spec §12 Settings brokers).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/BrokerEndpoints.cs:27-42`, permission for permission:
 *
 *   GET    /api/v1/brokers                                 (none — membership only)  (:33)
 *   POST   /api/v1/brokers                                 brokers.manage            (:34)
 *   GET    /api/v1/brokers/{id:long}                       brokers.view              (:35)
 *   PUT    /api/v1/brokers/{id:long}                       brokers.manage            (:36)
 *   POST   /api/v1/brokers/{id:long}/disable               brokers.manage            (:37)
 *   POST   /api/v1/brokers/{id}/contacts                   brokers.manage            (:39)
 *   PUT    /api/v1/brokers/{id}/contacts/{contactId}       brokers.manage            (:40)
 *   DELETE /api/v1/brokers/{id}/contacts/{contactId}       brokers.manage            (:41)
 *   POST   /api/v1/brokers/{id}/contacts/{contactId}/set-primary  brokers.manage     (:42)
 *
 * THE LIST READ IS DELIBERATELY UNGUARDED BEYOND TENANT MEMBERSHIP — AND THAT IS A BUG FIX,
 * NOT A RELAXATION
 * ============================================================================================
 * The endpoint's own comment (:29-32) records the 2026-07-13 fix: the Broker dropdown appears in
 * every leads filter row, the intake form and every dashboard filter bar (PRD 12.2), and
 * `BrokerSummaryDto` is the picker-safe projection — no contacts, no contact emails or phones.
 * The contact-bearing DETAIL read stays behind `brokers.view`, and every mutation behind
 * `brokers.manage`. Membership is still required and still verified server-side: `/api/v1/brokers`
 * is NOT on `GLOBAL_ROUTE_PREFIXES`, so lib/tenancy classifies it tenant-scoped and the T-013
 * middleware demands a verified `X-Tenant-Id` before any handler here runs. Re-adding a permission
 * to the list would re-break intake, so the suite pins a plain tenant member's 200 on the list
 * alongside their 403 on the detail.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * Every handler reads `c.get('tenant')`, the verified `TenantContext` — never the raw header. There
 * is no database-level net beneath the resulting predicates (Postgres RLS is not adopted, spec
 * Q-10), so `actorFrom` throwing rather than defaulting is load-bearing: a handler that ran with an
 * absent tenant would be an unscoped query against every tenant's rows.
 *
 * MEASURED RESPONSE SHAPES (BrokerEndpoints.cs)
 * ============================================
 *   list        -> 200 BrokerListDto                                        (:52)
 *   create      -> 201 + Location: /api/v1/brokers/{id}                     (:61)
 *   get         -> 200 BrokerDetailDto                                      (:68)
 *   update      -> 200 BrokerDetailDto                                      (:77)
 *   disable     -> 200 with an EMPTY body (`Results.Ok()`, not `Ok(value)`) (:83)
 *   add contact -> 201 + Location: /api/v1/brokers/{id}/contacts/{cid}      (:92)
 *   update ct.  -> 200 BrokerContactDto                                     (:101)
 *   remove ct.  -> 200 with an EMPTY body                                   (:107)
 *   set primary -> 200 BrokerContactDto                                     (:115)
 * The empty 200s are preserved rather than modernised to 204: the SPA's `apiPost<void>` handles
 * both, but this task's bar is contract preservation.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import {
  brokerContactValidationError,
  brokerValidationError,
  unreadableBodyError,
} from './errors.js';
import {
  addContactSchema,
  createBrokerSchema,
  listBrokersQuerySchema,
  updateBrokerSchema,
  updateContactSchema,
} from './schemas.js';
import {
  addContact,
  createBroker,
  disableBroker,
  getBroker,
  listBrokers,
  removeContact,
  setPrimaryContact,
  updateBroker,
  updateContact,
  type BrokersActor,
  type BrokersDeps,
} from './service.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

const BASE_PATH = '/brokers';

/**
 * Validates with a broker schema. Deliberately NOT `lib/validation`'s `validateBody`: that helper
 * throws a `ValidationError` carrying the generic `VALIDATION_FAILED` code, and this mapper emits
 * `BROKER_VALIDATION_FAILED` / `BROKER_CONTACT_VALIDATION_FAILED` — which is what appears in
 * `detail` and in the `code` extension the SPA and the reference's tests both read. The two codes
 * are separate in the reference (BrokerErrors.cs:8,19), so which one a route uses is a contract
 * detail, not a stylistic choice.
 */
function parseOr422<S extends ZodType>(
  schema: S,
  value: unknown,
  kind: 'broker' | 'contact',
): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors = toFieldErrors(result.error);
    throw kind === 'broker'
      ? brokerValidationError(fieldErrors)
      : brokerContactValidationError(fieldErrors);
  }
  return result.data as ReturnType<S['parse']>;
}

async function readJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw unreadableBodyError();
  }
}

/**
 * The `{id:long}` / `{contactId:long}` route constraints (:35,40).
 *
 * In ASP.NET a non-numeric id does not MATCH the route at all, so the caller gets a routing 404 —
 * not a validation error. Hono has no equivalent constraint syntax, so the check is explicit and
 * raises the same 404 the app's own `notFound` handler would have produced. Same treatment as
 * reference-data/routes.ts:109-116 and tenants/routes.ts:106-125, for the same reason.
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
 * A missing tenant here is a composition fault (the route would have to have been misclassified as
 * global, or the tenancy slot left unwired), and it fails CLOSED with a 500 rather than proceeding
 * unscoped. There is no fallback to the header, and there must never be one.
 */
function actorFrom(c: Context<ApiEnv>): BrokersActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Broker route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function brokerRoutes(deps: BrokersDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(BASE_PATH, async (c) => {
    const query = parseOr422(listBrokersQuerySchema, c.req.query(), 'broker');
    return c.json(await listBrokers(deps, query, actorFrom(c)));
  });

  routes.post(BASE_PATH, requirePermission('brokers.manage'), async (c) => {
    const input = parseOr422(createBrokerSchema, await readJsonBody(c), 'broker');
    const created = await createBroker(deps, input, actorFrom(c));

    c.header('Location', `/api/v1${BASE_PATH}/${String(created.id)}`);
    return c.json(created, 201);
  });

  routes.get(`${BASE_PATH}/:id`, requirePermission('brokers.view'), async (c) =>
    c.json(await getBroker(deps, numericParam(c, 'id'), actorFrom(c))),
  );

  routes.put(`${BASE_PATH}/:id`, requirePermission('brokers.manage'), async (c) => {
    const id = numericParam(c, 'id');
    const input = parseOr422(updateBrokerSchema, await readJsonBody(c), 'broker');
    return c.json(await updateBroker(deps, id, input, actorFrom(c)));
  });

  routes.post(`${BASE_PATH}/:id/disable`, requirePermission('brokers.manage'), async (c) => {
    await disableBroker(deps, numericParam(c, 'id'), actorFrom(c));
    return c.body(null, 200);
  });

  routes.post(`${BASE_PATH}/:id/contacts`, requirePermission('brokers.manage'), async (c) => {
    const brokerId = numericParam(c, 'id');
    const input = parseOr422(addContactSchema, await readJsonBody(c), 'contact');
    const created = await addContact(deps, brokerId, input, actorFrom(c));

    c.header(
      'Location',
      `/api/v1${BASE_PATH}/${String(brokerId)}/contacts/${String(created.id)}`,
    );
    return c.json(created, 201);
  });

  // Registered BEFORE the two-segment contact routes below would otherwise be able to shadow it —
  // Hono matches in registration order, and `/contacts/:contactId` does not match a three-segment
  // path, but keeping set-primary first makes the precedence explicit rather than incidental.
  routes.post(
    `${BASE_PATH}/:id/contacts/:contactId/set-primary`,
    requirePermission('brokers.manage'),
    async (c) => {
      const brokerId = numericParam(c, 'id');
      const contactId = numericParam(c, 'contactId');
      return c.json(await setPrimaryContact(deps, brokerId, contactId, actorFrom(c)));
    },
  );

  routes.put(
    `${BASE_PATH}/:id/contacts/:contactId`,
    requirePermission('brokers.manage'),
    async (c) => {
      const brokerId = numericParam(c, 'id');
      const contactId = numericParam(c, 'contactId');
      const input = parseOr422(updateContactSchema, await readJsonBody(c), 'contact');
      return c.json(await updateContact(deps, brokerId, contactId, input, actorFrom(c)));
    },
  );

  routes.delete(
    `${BASE_PATH}/:id/contacts/:contactId`,
    requirePermission('brokers.manage'),
    async (c) => {
      const brokerId = numericParam(c, 'id');
      const contactId = numericParam(c, 'contactId');
      await removeContact(deps, brokerId, contactId, actorFrom(c));
      return c.body(null, 200);
    },
  );

  return routes;
}
