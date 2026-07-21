/**
 * The dashboard drill-through route (T-035; AC-076; V-095).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs:33` and `:106-139`:
 *
 *   GET /api/v1/dashboards/drill?widget=...&<shared filters>&page&pageSize    leads.view
 *
 * OUT OF SCOPE HERE, DELIBERATELY: the five dashboard endpoints themselves (`/executive`,
 * `/pipeline`, `/broker-performance`, `/rm-performance`, `/loss-analysis`, :34-38) belong to
 * T-036/T-037. They mount on this same group and each carries its own `dashboards.view_*` guard.
 *
 * WHY THIS ROUTE IS GATED ON `leads.view` AND NOT ON A DASHBOARD PERMISSION
 * ========================================================================
 * Measured, and it looks wrong until you read what the widget returns. The framework's one widget
 * returns LEAD ROWS, so the drill must require exactly what the Leads list requires — no more, or
 * a user who can read the Leads list could not drill into a chart built from it; no less, or the
 * drill becomes a way to read leads without `leads.view`. The reference says so in its own class
 * doc (:16-25) and adds that per-widget dashboard-permission gating is the seam for the tasks that
 * register dashboard-specific widget keys.
 *
 * `leads.view_all` gates nothing here either — it is visibility BREADTH, resolved server-side in
 * the service and applied inside the query. See `drill.service.ts`.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError, ValidationError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { dashboardFilterSchema } from './filters.js';
import { runDrill, type DashboardsDeps, type DrillActor } from './drill.service.js';

import type { Context } from 'hono';
import { z } from 'zod';

const positiveIntParam = z
  .string()
  .regex(/^\d+$/, { message: 'DASHBOARD_FILTER_INVALID|Paging values must be positive integers.' })
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value > 0, {
    message: 'DASHBOARD_FILTER_INVALID|Paging values must be positive integers.',
  })
  .optional();

/**
 * `widget` is REQUIRED (:111-117). The reference answers 400 with a plain problem body for a
 * missing/blank widget and reserves the 404 for a widget that is well-formed but unregistered —
 * "you asked wrong" versus "there is no such chart".
 */
const drillQuerySchema = dashboardFilterSchema.extend({
  widget: z
    .string({ message: "DASHBOARD_WIDGET_REQUIRED|The 'widget' query parameter is required." })
    .trim()
    .min(1, { message: "DASHBOARD_WIDGET_REQUIRED|The 'widget' query parameter is required." }),
  page: positiveIntParam,
  pageSize: positiveIntParam,
});

/**
 * The verified tenant, the acting user, and the SERVER-RESOLVED breadth decision.
 *
 * Breadth is read from the same per-request resolver the route guard used, so the guard and the
 * query cannot disagree about who this caller is. A missing tenant or resolver is a composition
 * fault and fails CLOSED with a 500 rather than running an unscoped or unfiltered aggregate —
 * which, unlike a broken list, would look like a perfectly plausible dashboard.
 */
async function actorFrom(c: Context<ApiEnv>): Promise<DrillActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Dashboard drill reached with no verified tenant context; refusing to run an unscoped query.',
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

export function dashboardRoutes(deps: DashboardsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/dashboards/drill', requirePermission('leads.view'), async (c) => {
    const parsed = drillQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new ValidationError(toFieldErrors(parsed.error), {
        status: 400,
        code: 'DASHBOARD_FILTER_INVALID',
      });
    }

    const { widget, page, pageSize, ...filter } = parsed.data;
    return c.json(await runDrill(deps, { widget, filter, page, pageSize }, await actorFrom(c)));
  });

  return routes;
}
