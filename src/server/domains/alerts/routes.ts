/**
 * Alerts Center routes (T-033; AC-022, AC-070; V-027, V-087).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/AlertEndpoints.cs:20-25`, permission for permission:
 *
 *   GET  /api/v1/alerts/summary      alerts.view   (:22)
 *   GET  /api/v1/alerts              alerts.view   (:23)
 *   GET  /api/v1/alerts/badge        alerts.view   (:24)
 *   POST /api/v1/alerts/badge/reset  alerts.view   (:25)
 *
 * THE BADGE ROUTES ARE GATED TOO, INCLUDING THE RESET
 * ==================================================
 * The reference gates all four on `alerts.view` and the reason is stated in its own doc comment: a
 * badge count reveals the existence and volume of alerts to someone not permitted to see them. The
 * reset is a WRITE (it upserts `user_alert_views`), yet it takes the same view permission rather
 * than a manage-level one — deliberate, because it writes nothing but the caller's own read marker.
 * `alerts.assign_owner`/`escalate`/`resolve` gate no route here: they belong to the contextual
 * actions, which are lead/quote workflow operations owned by T-025.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * `/api/v1/alerts` is not on `GLOBAL_ROUTE_PREFIXES`, so it is classified tenant-scoped and the
 * T-013 middleware demands a verified `X-Tenant-Id` before any handler runs. Every handler reads
 * `c.get('tenant')`, never the raw header, and `actorFrom` throws rather than defaulting — with RLS
 * not adopted (Q-10) there is nothing beneath the resulting predicates.
 *
 * MEASURED RESPONSE SHAPES (AlertEndpoints.cs)
 * ===========================================
 *   summary      -> 200 AlertSummaryDto  (:34)
 *   list         -> 200 AlertListDto     (:46)
 *   badge        -> 200 AlertBadgeDto    (:52)
 *   badge/reset  -> **204 No Content**   (:58)
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { parseOrThrow } from '../../lib/validation/index.js';
import { listAlertsQuerySchema } from './schemas.js';
import {
  getAlertBadge,
  getAlertSummary,
  listAlertsForTenant,
  resetAlertBadge,
  type AlertsActor,
  type AlertsDeps,
} from './service.js';

import type { Context } from 'hono';

/** The VERIFIED tenant plus the acting user. A missing tenant fails CLOSED with a 500. */
function actorFrom(c: Context<ApiEnv>): AlertsActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Alerts route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function alertRoutes(deps: AlertsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  // Registered BEFORE the bare `/alerts` list so the literal segments can never be matched as
  // part of the queue route's own query surface, and so adding `/alerts/:id` later cannot shadow
  // them.
  routes.get('/alerts/summary', requirePermission('alerts.view'), async (c) =>
    c.json(await getAlertSummary(deps, actorFrom(c))),
  );

  routes.get('/alerts/badge', requirePermission('alerts.view'), async (c) =>
    c.json(await getAlertBadge(deps, actorFrom(c))),
  );

  routes.post('/alerts/badge/reset', requirePermission('alerts.view'), async (c) => {
    await resetAlertBadge(deps, actorFrom(c));
    return c.body(null, 204);
  });

  routes.get('/alerts', requirePermission('alerts.view'), async (c) => {
    const query = parseOrThrow(listAlertsQuerySchema, c.req.query());
    return c.json(await listAlertsForTenant(deps, query, actorFrom(c)));
  });

  return routes;
}
