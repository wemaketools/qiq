/**
 * Parties routes (T-023, AC-022, AC-041; V-027, V-053, V-054; spec FR-26..FR-28, §12).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/PartyEndpoints.cs:22-30` plus the one party route that
 * lives in `LeadEndpoints.cs:39-41`, permission for permission:
 *
 *   GET  /api/v1/parties              parties.view    (PartyEndpoints.cs:26)
 *   POST /api/v1/parties              parties.create  (:27)
 *   GET  /api/v1/parties/{id:long}    parties.view    (:28)
 *   PUT  /api/v1/parties/{id:long}    parties.update  (:29)
 *   GET  /api/v1/parties/{id}/leads   parties.view    (LeadEndpoints.cs:40)
 *
 * THE LEADS CARD IS GATED BY `parties.view`, NOT `leads.view` — MEASURED, AND NOT AN OVERSIGHT
 * ===========================================================================================
 * `GET /parties/{id}/leads` is declared in `LeadEndpoints` (because it projects a lead DTO) but is
 * mounted on a second `TenantScopedGroup("/api/v1/parties")` and guarded by
 * `PermissionCatalog.Parties.View` (:40) while every route in its own file uses `Leads.View`. It is
 * the party detail page's card, so it follows the party permission — a user who can open a party
 * can see that party's leads. Gating it on `leads.view` here would 403 the card for exactly the
 * roles the reference lets through, so the measured permission is preserved and the suite pins it
 * with a user holding `parties.view` and NOT `leads.view`.
 *
 * THERE IS NO `DELETE /parties/{id}` — AND THAT IS A REQUIREMENT, NOT AN OMISSION (P-05, PRD 12.9)
 * ================================================================================================
 * The reference maps no DELETE route and the SPA exports no delete call. Parties are corrected via
 * Edit only, because leads reference parties and a deleted party would orphan a lead's client name
 * (20260718003000_parties.sql:37-40). V-053 asserts the absence of the route.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * `/api/v1/parties` is NOT on `GLOBAL_ROUTE_PREFIXES` (lib/tenancy/context.ts), so it is classified
 * tenant-scoped and the T-013 middleware demands a verified `X-Tenant-Id` before any handler here
 * runs. Every handler reads `c.get('tenant')` — never the raw header. There is no database-level
 * net beneath the resulting predicates (Postgres RLS is not adopted, spec Q-10), so `actorFrom`
 * throwing rather than defaulting is load-bearing.
 *
 * MEASURED RESPONSE SHAPES (PartyEndpoints.cs)
 * ===========================================
 *   list   -> 200 PartyListDto                                            (:40)
 *   create -> 201 + Location: /api/v1/parties/{id}, PartyMutationResultDto (:51)
 *   get    -> 200 PartyDto                                                (:58)
 *   update -> 200 PartyMutationResultDto                                  (:69)
 *   leads  -> 200 LeadListItemDto[]                                       (LeadEndpoints.cs:130-133)
 *
 * NOTE THAT UPDATE RETURNS THE MUTATION ENVELOPE (party + warnings), NOT A BARE `PartyDto` — an
 * edit that renames a party into a near-duplicate warns exactly as a create does.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { partyValidationError, unreadableBodyError } from './errors.js';
import { listPartiesQuerySchema, partyWriteSchema } from './schemas.js';
import {
  createParty,
  getPartyById,
  getPartyLeads,
  listPartiesForTenant,
  updatePartyById,
  type PartiesActor,
  type PartiesDeps,
} from './service.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

/**
 * Validates with a parties-domain schema. Deliberately NOT `lib/validation`'s `validateBody`: that
 * helper throws the generic `VALIDATION_FAILED` code, and the reference's mapper emits
 * `PARTY_VALIDATION_FAILED` — which is what appears in `detail`, in the `code` extension, and in
 * the reference's own tests.
 */
function parseOr422<S extends ZodType>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw partyValidationError(toFieldErrors(result.error));
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
 * The `{id:long}` route constraint (PartyEndpoints.cs:28-29).
 *
 * In ASP.NET a non-numeric id does not MATCH the route at all, so the caller gets a routing 404 —
 * not a validation error. Hono has no equivalent constraint syntax, so the check is explicit and
 * raises the same 404 the app's own `notFound` handler would have produced. Same treatment as
 * tenants/routes.ts and reference-data/routes.ts, for the same reason.
 */
function partyIdOf(c: Context<ApiEnv>): number {
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
 * A missing tenant here is a composition fault (the route misclassified as global, or the tenancy
 * slot left unwired) and it fails CLOSED with a 500 rather than proceeding unscoped. There is no
 * fallback to the header, and there must never be one.
 */
function actorFrom(c: Context<ApiEnv>): PartiesActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Parties route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function partyRoutes(deps: PartiesDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/parties', requirePermission('parties.view'), async (c) => {
    const query = parseOr422(listPartiesQuerySchema, c.req.query());
    return c.json(await listPartiesForTenant(deps, query, actorFrom(c)));
  });

  routes.post('/parties', requirePermission('parties.create'), async (c) => {
    const input = parseOr422(partyWriteSchema, await readJsonBody(c));
    const result = await createParty(deps, input, actorFrom(c));

    c.header('Location', `/api/v1/parties/${result.party.id}`);
    return c.json(result, 201);
  });

  // Registered BEFORE `/parties/:id` so the more specific path wins regardless of Hono's matching
  // order guarantees; `/parties/leads` could otherwise be read as an id.
  routes.get('/parties/:id/leads', requirePermission('parties.view'), async (c) =>
    c.json(await getPartyLeads(deps, partyIdOf(c), actorFrom(c))),
  );

  routes.get('/parties/:id', requirePermission('parties.view'), async (c) =>
    c.json(await getPartyById(deps, partyIdOf(c), actorFrom(c))),
  );

  routes.put('/parties/:id', requirePermission('parties.update'), async (c) => {
    const id = partyIdOf(c);
    const input = parseOr422(partyWriteSchema, await readJsonBody(c));
    return c.json(await updatePartyById(deps, id, input, actorFrom(c)));
  });

  return routes;
}
