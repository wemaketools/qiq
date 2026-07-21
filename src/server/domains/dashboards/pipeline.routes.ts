/**
 * The Pipeline & Conversion dashboard route (T-036; AC-077; V-096).
 *
 * Port of `DashboardEndpoints.cs:35` and `:81-93`:
 *
 *   GET /api/v1/dashboards/pipeline?<shared filters>      dashboards.view_pipeline
 *
 * A SEPARATE PERMISSION FROM THE EXECUTIVE OVERVIEW, deliberately. The two dashboards expose
 * different cuts of the same tenant — the Executive Overview surfaces bound premium and the
 * high-value client table, the Pipeline dashboard surfaces per-RM workload and at-risk leads — and
 * the reference grants them independently so a tenant can hand an operations lead the pipeline view
 * without also handing over the executive revenue picture.
 *
 * The actor and filter helpers are shared with `executive.routes.ts` so the tenant-resolution and
 * fail-closed behaviour cannot differ between two endpoints that must behave identically.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { dashboardActorFrom, parseDashboardFilter } from './executive.routes.js';
import type { DashboardServiceDeps } from './executive.service.js';
import { getPipelineDashboard } from './pipeline.service.js';

export function pipelineDashboardRoutes(deps: DashboardServiceDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(
    '/dashboards/pipeline',
    requirePermission('dashboards.view_pipeline'),
    async (c) =>
      c.json(await getPipelineDashboard(deps, await dashboardActorFrom(c), parseDashboardFilter(c))),
  );

  return routes;
}
