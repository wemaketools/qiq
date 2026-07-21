/**
 * The permission catalog endpoint (T-017, AC-030; V-040; spec §375 "`GET /permissions`").
 *
 * NO .NET REFERENCE EXISTS FOR THIS ROUTE — FLAGGED, NOT SILENTLY INVENTED
 * =======================================================================
 * `PermissionCatalog.All` was an in-process static list in the reference, consumed only by
 * `PermissionCatalogSeeder`; it was never surfaced over HTTP. The SPA therefore ships a hand-copied
 * mirror (`src/ui/src/features/userManager/permissionCatalog.ts`, whose header records exactly this
 * gap and says "if a real catalog endpoint is added later, this module is the single place to swap
 * the static array for a fetched one"). Spec §375 and AC-030 require the endpoint, so it is added
 * here. Two decisions had to be made without reference behaviour to measure, and are recorded:
 *
 *   1. RESPONSE SHAPE — `{ code, category, description }[]`, ordered by code. That is exactly the
 *      SPA's existing `PermissionCatalogEntry`, so T-018 can drop the static array without touching
 *      any picker-rendering code.
 *   2. PERMISSION GATE — `roles.view`. The catalog is the input to the role and group permission
 *      pickers, so anyone who may look at a role may see the list of codes a role can contain. It
 *      discloses no tenant data, but it is not left ungated: every route on this surface declares a
 *      permission, and an ungated one would be the single exception a route sweep has to special-case.
 *
 * The rows come from the SEEDED `permissions` table rather than from `permission-catalog.ts`, so the
 * codes offered are by construction the codes the `role_permissions`/`group_permissions`/
 * `user_permissions` foreign keys will accept.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import type { DbClient } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { listPermissionCatalog } from './admin-repository.js';

export interface PermissionsDeps {
  readonly db: DbClient;
}

export function permissionRoutes(deps: PermissionsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/permissions', requirePermission('roles.view'), async (c) =>
    c.json(await listPermissionCatalog(deps.db)),
  );

  return routes;
}
