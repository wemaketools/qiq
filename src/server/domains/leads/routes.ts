/**
 * Leads routes (T-024; AC-021, AC-042..AC-046; V-026, V-055..V-059).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/LeadEndpoints.cs:28-41`, permission for permission:
 *
 *   GET  /api/v1/leads                leads.view      (:32)
 *   POST /api/v1/leads                leads.create    (:33)
 *   GET  /api/v1/leads/{id:long}      leads.view      (:34)
 *   PUT  /api/v1/leads/{id:long}      leads.update    (:36)
 *   POST /api/v1/leads/bulk-reassign  leads.reassign  (:37)
 *
 * `GET /leads/{id}/timeline` (:35) is T-029's and lives in `timeline.routes.ts`, mounted on the
 * SAME leads deps slot. It reuses this file's `leadIdOf` and `actorFrom` rather than restating
 * them: `actorFrom` is where the verified tenant and the caller's resolved access are read, and a
 * second copy of it is a second place for that to go wrong.
 *
 * OUT OF SCOPE HERE, DELIBERATELY:
 * `GET /parties/{id}/leads` (:40) already shipped in T-023 mounted on the PARTIES group and gated
 * by `parties.view` — it is NOT re-registered here, or the two registrations would race.
 *
 * `leads.view_all` GATES NO ROUTE, AND THAT IS CORRECT
 * ===================================================
 * It is a VISIBILITY-BREADTH permission (P-03), not an operation permission: it widens WHICH rows
 * the list returns rather than granting access to an endpoint. It is consumed inside the repository
 * query via `EffectiveAccess.canViewAll('leads')`. A route guard on it would be wrong twice over —
 * it would 403 the restricted users who are supposed to see their OWN leads, and it would leave the
 * actual row filtering unenforced.
 *
 * BULK-REASSIGN IS REGISTERED BEFORE `/:id`
 * =========================================
 * `/leads/bulk-reassign` would otherwise be matchable as an id path. It is a POST while `/:id` is a
 * GET/PUT so they do not currently collide, but the ordering is kept explicit so adding
 * `POST /leads/:id` later cannot silently shadow it. Same treatment as parties/routes.ts.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * `/api/v1/leads` is not on `GLOBAL_ROUTE_PREFIXES`, so it is classified tenant-scoped and the
 * T-013 middleware demands a verified `X-Tenant-Id` before any handler runs. Every handler reads
 * `c.get('tenant')`, never the raw header, and `actorFrom` throws rather than defaulting — with RLS
 * not adopted (Q-10) there is nothing beneath the resulting predicates.
 *
 * MEASURED RESPONSE SHAPES (LeadEndpoints.cs)
 * ==========================================
 *   list           -> 200 LeadListDto                                          (:59)
 *   create         -> 201 + Location: /api/v1/leads/{id}, CreateLeadOutcomeDto (:90)
 *   create (dup)   -> **409** CreateLeadOutcomeDto, requiresConfirmation true  (:85-88)
 *   get            -> 200 LeadDto                                              (:96)
 *   update         -> 200                                                      (:116)
 *   bulk-reassign  -> 200 BulkReassignResultDto                                (:125)
 *
 * The 409 is the confirm-gate, not an error: it carries the duplicate list so the SPA can show
 * "create anyway?". It is emitted as a normal JSON body, NOT problem+json, exactly as the reference
 * does (`Results.Json(..., statusCode: 409)`).
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { leadValidationError, unreadableBodyError } from './errors.js';
import {
  bulkReassignSchema,
  createLeadSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
} from './schemas.js';
import {
  bulkReassignLeads,
  createLead,
  getLeadById,
  listLeadsForTenant,
  updateLeadById,
  type LeadsActor,
  type LeadsDeps,
} from './service.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

/**
 * Validates with a leads-domain schema. Deliberately NOT `lib/validation`'s `validateBody`: that
 * helper throws the generic `VALIDATION_FAILED` code, and the reference's mapper emits
 * `LEAD_VALIDATION_FAILED` — which is what appears in `detail`, in the `code` extension, and in the
 * reference's own tests.
 */
function parseOr422<S extends ZodType>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw leadValidationError(toFieldErrors(result.error));
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
 * The `{id:long}` route constraint (:34, :36).
 *
 * In ASP.NET a non-numeric id does not MATCH the route at all, so the caller gets a routing 404 —
 * not a validation error. Hono has no equivalent constraint syntax, so the check is explicit and
 * raises the same 404 the app's own `notFound` handler would have produced.
 */
export function leadIdOf(c: Context<ApiEnv>): number {
  const raw = c.req.param('id') ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

/**
 * The VERIFIED tenant, the acting user, and the caller's resolved effective access.
 *
 * `access` is resolved HERE rather than in the service so the breadth decision is made from the
 * same per-request resolver the route guards used — a service that re-derived it could disagree
 * with the guard that just let the request through. A missing tenant or resolver is a composition
 * fault and fails CLOSED with a 500 rather than proceeding unscoped or unfiltered.
 */
export async function actorFrom(c: Context<ApiEnv>): Promise<LeadsActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Leads route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const resolveAccess = c.get('resolveAccess');
  if (resolveAccess === undefined) {
    throw new InternalError(
      'permissionResolution() middleware is not mounted; cannot evaluate visibility breadth.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    access: await resolveAccess(tenant.tenantId),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function leadRoutes(deps: LeadsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/leads', requirePermission('leads.view'), async (c) => {
    const query = parseOr422(listLeadsQuerySchema, c.req.query());
    return c.json(await listLeadsForTenant(deps, query, await actorFrom(c)));
  });

  routes.post('/leads', requirePermission('leads.create'), async (c) => {
    const input = parseOr422(createLeadSchema, await readJsonBody(c));
    const result = await createLead(deps, input, await actorFrom(c));

    // The confirm-gate: nothing was persisted, so there is no Location header and no 201.
    if (result.requiresConfirmation) return c.json(result, 409);

    c.header('Location', `/api/v1/leads/${String(result.lead?.id)}`);
    return c.json(result, 201);
  });

  // Registered BEFORE `/leads/:id` — see the file header.
  routes.post('/leads/bulk-reassign', requirePermission('leads.reassign'), async (c) => {
    const input = parseOr422(bulkReassignSchema, await readJsonBody(c));
    return c.json(await bulkReassignLeads(deps, input, await actorFrom(c)));
  });

  routes.get('/leads/:id', requirePermission('leads.view'), async (c) =>
    c.json(await getLeadById(deps, leadIdOf(c), await actorFrom(c))),
  );

  routes.put('/leads/:id', requirePermission('leads.update'), async (c) => {
    const id = leadIdOf(c);
    const input = parseOr422(updateLeadSchema, await readJsonBody(c));
    return c.json(await updateLeadById(deps, id, input, await actorFrom(c)));
  });

  return routes;
}
