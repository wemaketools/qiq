/**
 * `GET /api/v1/dashboards/rm-performance` (T-037; AC-075, AC-078).
 *
 * Port of `DashboardEndpoints.cs:37` and `:55-66`. Gated on `dashboards.view_rm_performance` — the
 * dedicated per-dashboard permission (PRD 20.5), not a fallback to `view_executive`.
 *
 * This is the ONLY dashboard whose filter bar sends `teamOrRmId` and `brokerTypeId`
 * (`src/ui/src/features/dashboards/rmApi.ts` `buildRmQuery`), and it is the only one that applies
 * them. Both are parsed by the SAME eight-dimension schema every dashboard uses, so the precedence
 * rule between `teamOrRmId` and `rmUserId` lives in one place (`effectiveRmUserId`) rather than
 * being re-decided here.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { ValidationError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { dashboardFilterSchema } from './filters.js';
import { dashboardActorFrom } from './executive.routes.js';
import { getRmPerformance, type RmDashboardDeps } from './rm.service.js';

export function rmPerformanceRoutes(deps: RmDashboardDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(
    '/dashboards/rm-performance',
    requirePermission('dashboards.view_rm_performance'),
    async (c) => {
      const parsed = dashboardFilterSchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ValidationError(toFieldErrors(parsed.error), {
          status: 400,
          code: 'DASHBOARD_FILTER_INVALID',
        });
      }

      return c.json(await getRmPerformance(deps, await dashboardActorFrom(c), parsed.data));
    },
  );

  return routes;
}
