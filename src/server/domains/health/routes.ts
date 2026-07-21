/**
 * GET /api/v1/health — anonymous liveness probe (T-009, spec §9.2).
 *
 * The .NET reference returned `{"status":"ok"}` (HealthEndpoint.cs, AllowAnonymous). `version` is
 * additive: no consumer parses this payload, and it makes a deployed function self-identify.
 */
import { Hono } from 'hono';

import type { ApiEnv } from '../../lib/router/env.js';

export function healthRoutes(version: string): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/health', (c) => c.json({ status: 'ok', version }));

  return routes;
}
