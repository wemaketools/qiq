/**
 * `GET /api/v1/dashboards/broker-performance` (T-037; AC-075, AC-078).
 *
 * Port of `DashboardEndpoints.cs:36` and `:68-79`. Gated on
 * `dashboards.view_broker_performance` — the dedicated per-dashboard permission, NOT a fallback to
 * `view_executive`: each dashboard is separately grantable (PRD 20.5) precisely so a broker manager
 * can be given this screen without the executive one.
 *
 * The shared filter binds all EIGHT dimensions here even though this dashboard narrows on five of
 * them (see broker.service.ts). That is not sloppiness: the SPA's filter bar is shared across
 * dashboards, so a user who selects a broker type on RM Performance and navigates here must get a
 * 200 with an unnarrowed board — which is what the reference does — rather than a 400 on a
 * parameter the endpoint declared and then rejected.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError, ValidationError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { dashboardFilterSchema } from './filters.js';
import { getBrokerPerformance, type BrokerDashboardDeps } from './broker.service.js';
import { dashboardActorFrom } from './executive.routes.js';

import type { Context } from 'hono';

/**
 * The verified tenant. A missing tenant context is a COMPOSITION fault and fails closed with a 500
 * rather than running an unscoped aggregate — which, unlike a broken list, would look like a
 * perfectly ordinary dashboard.
 */
export function tenantFrom(c: Context<ApiEnv>): TenantId {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Dashboard reached with no verified tenant context; refusing to run an unscoped aggregate.',
    );
  }

  return tenant.tenantId satisfies TenantId;
}

export function brokerPerformanceRoutes(deps: BrokerDashboardDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(
    '/dashboards/broker-performance',
    requirePermission('dashboards.view_broker_performance'),
    async (c) => {
      const parsed = dashboardFilterSchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ValidationError(toFieldErrors(parsed.error), {
          status: 400,
          code: 'DASHBOARD_FILTER_INVALID',
        });
      }

      return c.json(await getBrokerPerformance(deps, await dashboardActorFrom(c), parsed.data));
    },
  );

  return routes;
}
