/**
 * The lead timeline route (T-029; AC-022, AC-060; V-027, V-076).
 *
 * Port of `LeadEndpoints.cs:35` + `GetLeadTimelineAsync` (:99-105), permission for permission:
 *
 *   GET /api/v1/leads/{id:long}/timeline   leads.view
 *
 * `leads.view`, NOT a timeline-specific permission and NOT `leads.view_all`: the reference guards
 * this route with exactly the same permission as lead detail, and breadth is a list-query filter in
 * this codebase, never a route guard (see `routes.ts`'s header).
 *
 * ITS OWN ROUTER, THE LEADS DEPS SLOT
 * ===================================
 * Mounted from `deps.leads` alongside `leadRoutes` and `leadWorkflowRoutes` — the timeline reads
 * the same tenant-scoped lead surface and has no deps of its own, so a separate slot would only
 * create a composition root that can wire the leads surface with the timeline silently missing.
 * A separate FILE (rather than another handler inside `routes.ts`) keeps the concurrent-task
 * footprint on that shared file to the two helper exports.
 *
 * `?page=` IS A HINT, NOT A VALIDATED INPUT
 * =========================================
 * The reference binds `int? page` and defaults it to 1 (:103), so an absent page is page 1. A
 * NON-INTEGER `page` would fail ASP.NET model binding with a 400; here it is treated as absent.
 * This is a deliberate, flagged divergence on a display-only pagination hint: the value cannot
 * widen visibility, cannot reach the database except as a bounded offset, and a 400 on a garbage
 * query string is not behaviour any caller in this repo depends on. Everything else about the
 * paging contract (1-based, floors at 1, fixed size 50) is the reference's, in the service.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { actorFrom, leadIdOf } from './routes.js';
import type { LeadsDeps } from './service.js';
import { getLeadTimeline } from './timeline.service.js';

import type { Context } from 'hono';

/** `int? page` -> `page ?? 1`; the service floors a non-positive value. */
function pageOf(c: Context<ApiEnv>): number {
  const raw = c.req.query('page');
  if (raw === undefined || !/^-?\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) ? page : 1;
}

export function leadTimelineRoutes(deps: LeadsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/leads/:id/timeline', requirePermission('leads.view'), async (c) =>
    c.json(await getLeadTimeline(deps, leadIdOf(c), pageOf(c), await actorFrom(c))),
  );

  return routes;
}
