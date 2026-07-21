/**
 * Global search route (T-038; AC-022, AC-080; V-027, V-101; spec FR-53/A-14).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/SearchEndpoints.cs`:
 *
 *   GET /api/v1/search   leads.view   (SearchEndpoints.cs:25)
 *
 * GATED ON `leads.view`, MEASURED — NOT `search.*`. The top-bar search is part of the lead-first
 * working shell every persona holds (PRD 20.4/AC-083), and the gate ALSO resolves the caller's app
 * user onto the request so the handler can apply the leads/quotes breadth rule. `leads.view_all` is
 * a VISIBILITY-BREADTH permission (P-03), not an operation permission, so it gates no route: it is
 * read inside the query via `EffectiveAccess.canViewAll('leads')` (same as `/leads`).
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE. `/api/v1/search` is not on
 * `GLOBAL_ROUTE_PREFIXES`, so the T-013 middleware demands a verified `X-Tenant-Id` before this
 * handler runs. `actorFrom` reads `c.get('tenant')` — never the raw header — and throws (fails
 * CLOSED with a 500) rather than proceeding unscoped; with RLS not adopted (Q-10) there is nothing
 * beneath the resulting predicates.
 *
 * A query shorter than the minimum length returns an empty grouped result (200), matching V-052.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { globalSearch, type SearchActor, type SearchDeps } from './service.js';

import type { Context } from 'hono';

/**
 * The verified tenant, the acting user, and the caller's server-resolved lead-visibility breadth.
 *
 * `access` is resolved from the same per-request resolver the route guard used, so the breadth
 * decision cannot disagree with the guard that just let the request through. A missing tenant or
 * resolver is a composition fault and fails CLOSED with a 500 rather than proceeding unscoped or
 * unfiltered.
 */
async function actorFrom(c: Context<ApiEnv>): Promise<SearchActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Search route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const resolveAccess = c.get('resolveAccess');
  if (resolveAccess === undefined) {
    throw new InternalError(
      'permissionResolution() middleware is not mounted; cannot evaluate visibility breadth.',
    );
  }

  const access = await resolveAccess(tenant.tenantId);
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    hasLeadViewAll: access.canViewAll('leads'),
  };
}

/**
 * `int? limitPerType` (SearchEndpoints.cs:29). ASP.NET binds NULL for a value that will not parse, so
 * a hand-edited `?limitPerType=abc` falls through to the default rather than 400ing. A non-positive
 * or non-integer value is treated as "unspecified"; the service floors it at the reference default.
 */
function parseLimitPerType(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

export function searchRoutes(deps: SearchDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/search', requirePermission('leads.view'), async (c) => {
    const actor = await actorFrom(c);
    const result = await globalSearch(
      deps,
      { q: c.req.query('q'), limitPerType: parseLimitPerType(c.req.query('limitPerType')) },
      actor,
    );
    return c.json(result);
  });

  return routes;
}
