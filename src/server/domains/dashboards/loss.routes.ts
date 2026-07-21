/**
 * `GET /api/v1/dashboards/loss-analysis` (T-037; AC-075, AC-078).
 *
 * Port of `DashboardEndpoints.cs:38` and `:42-53`. Gated on `dashboards.view_loss_analysis` — the
 * dedicated per-dashboard permission (PRD 20.5), and the reference flagged that choice explicitly
 * rather than falling back to `view_executive`. Loss data names competitors and carries commercial
 * commentary, so it is the dashboard most worth being separately grantable.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { ValidationError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { dashboardFilterSchema } from './filters.js';
import { dashboardActorFrom } from './executive.routes.js';
import { getLossAnalysis, type LossDashboardDeps } from './loss.service.js';

export function lossAnalysisRoutes(deps: LossDashboardDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(
    '/dashboards/loss-analysis',
    requirePermission('dashboards.view_loss_analysis'),
    async (c) => {
      const parsed = dashboardFilterSchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ValidationError(toFieldErrors(parsed.error), {
          status: 400,
          code: 'DASHBOARD_FILTER_INVALID',
        });
      }

      return c.json(await getLossAnalysis(deps, await dashboardActorFrom(c), parsed.data));
    },
  );

  return routes;
}
