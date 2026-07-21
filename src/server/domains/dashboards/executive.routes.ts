/**
 * The Executive Overview dashboard route (T-036; AC-077; V-096).
 *
 * Port of `DashboardEndpoints.cs:34` and `:94-105`:
 *
 *   GET /api/v1/dashboards/executive?<shared filters>     dashboards.view_executive
 *
 * WHY THIS ROUTE'S PERMISSION IS NOT `leads.view`
 * ===============================================
 * The drill endpoint returns LEAD ROWS, so it requires exactly what the Leads list requires. This
 * endpoint returns AGGREGATES over the whole tenant, which is a different disclosure: a caller who
 * may read the leads assigned to them is not thereby entitled to the tenant's total bound premium.
 * The reference gates each of the five dashboards on its own `dashboards.view_*` permission, and
 * that separation is what makes tenant-wide aggregation an explicit grant rather than a side
 * effect of list access.
 *
 * A MISSING TENANT OR RESOLVER FAILS CLOSED WITH A 500, NEVER WITH AN UNSCOPED AGGREGATE. An
 * unscoped list is visibly wrong; an unscoped SUM is just a larger number that looks plausible.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError, ValidationError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { dashboardFilterSchema } from './filters.js';
import {
  getExecutiveOverview,
  type DashboardActor,
  type DashboardServiceDeps,
} from './executive.service.js';

import type { Context } from 'hono';

/**
 * The verified tenant, the acting user, and the SERVER-RESOLVED visibility breadth. All three come
 * from middleware, never from the wire — a caller that could assert its own `leads.view_all` would
 * widen every aggregate on the page by asking for it.
 *
 * Breadth is resolved through the same per-request resolver the route guard used, so the guard and
 * the aggregation cannot disagree about who this caller is. A missing resolver is a COMPOSITION
 * fault and fails closed with a 500 rather than defaulting to "sees everything": an over-wide
 * aggregate is not a visibly broken page, only a larger number that looks plausible.
 */
export async function dashboardActorFrom(c: Context<ApiEnv>): Promise<DashboardActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Dashboard reached with no verified tenant context; refusing to run an unscoped aggregate.',
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
    canViewAllLeads: access.canViewAll('leads'),
  };
}

/**
 * Parses the eight shared filter parameters.
 *
 * A malformed filter is a 400 rather than a silently-ignored parameter. Dropping an unparseable
 * `brokerId` would render a WIDER dashboard than the caller asked for and label it with the
 * filter they thought they applied.
 */
export function parseDashboardFilter(c: Context<ApiEnv>): ReturnType<typeof dashboardFilterSchema.parse> {
  const parsed = dashboardFilterSchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new ValidationError(toFieldErrors(parsed.error), {
      status: 400,
      code: 'DASHBOARD_FILTER_INVALID',
    });
  }
  return parsed.data;
}

export function executiveDashboardRoutes(deps: DashboardServiceDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(
    '/dashboards/executive',
    requirePermission('dashboards.view_executive'),
    async (c) =>
      c.json(await getExecutiveOverview(deps, await dashboardActorFrom(c), parseDashboardFilter(c))),
  );

  return routes;
}
