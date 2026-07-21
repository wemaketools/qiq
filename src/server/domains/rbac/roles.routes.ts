/**
 * Role administration routes (T-017, AC-030; V-040; spec §12.2).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/RoleEndpoints.cs:20-28`, permission for permission:
 *
 *   GET    /api/v1/roles              roles.view    (:22)
 *   GET    /api/v1/roles/{id}         roles.view    (:23)
 *   POST   /api/v1/roles              roles.manage  (:24)
 *   PUT    /api/v1/roles/{id}         roles.manage  (:25)
 *   POST   /api/v1/roles/{id}/disable roles.manage  (:26)
 *   GET    /api/v1/roles/{id}/usage   roles.view    (:27)
 *
 * TENANT-SCOPED, unlike `/tenants`: the reference registers these on `TenantScopedGroup`
 * (RoleEndpoints.cs:20), and `/roles` is deliberately absent from `GLOBAL_ROUTE_PREFIXES`
 * (lib/tenancy/context.ts), so the tenant middleware requires a verified `X-Tenant-Id` and
 * `requirePermission` resolves in THAT tenant's scope. A `roles.manage` grant held in tenant A
 * therefore opens nothing in tenant B — pinned by the isolation cases in roles-groups.test.ts.
 *
 * MEASURED RESPONSE SHAPES (RoleEndpoints.cs)
 *   list    -> 200 RoleDto[]                                    (:33)
 *   get     -> 200 RoleDto                                      (:39)
 *   create  -> 201 + Location: /api/v1/roles/{id}, RoleDto      (:47-49)
 *   update  -> 200 RoleDto                                      (:57)
 *   disable -> 200 with an EMPTY body (`Results.Ok()`)          (:65)
 *   usage   -> 200 RoleUsageDto                                 (:71)
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { roleValidationError } from './admin-errors.js';
import {
  adminActorFrom,
  numericIdOf,
  parseOr422,
  readJsonBody,
} from './admin-routes-support.js';
import {
  createRoleSchema,
  disableRoleSchema,
  updateRoleSchema,
} from './admin-schemas.js';
import {
  createRole,
  disableRole,
  getRole,
  getRoleUsage,
  listRolesForCaller,
  updateRole,
  type RolesDeps,
} from './roles.service.js';

export function roleRoutes(deps: RolesDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/roles', requirePermission('roles.view'), async (c) =>
    c.json(await listRolesForCaller(deps, adminActorFrom(c))),
  );

  routes.get('/roles/:id', requirePermission('roles.view'), async (c) =>
    c.json(await getRole(deps, numericIdOf(c, 'id'), adminActorFrom(c))),
  );

  routes.get('/roles/:id/usage', requirePermission('roles.view'), async (c) =>
    c.json(await getRoleUsage(deps, numericIdOf(c, 'id'), adminActorFrom(c))),
  );

  routes.post('/roles', requirePermission('roles.manage'), async (c) => {
    const input = parseOr422(createRoleSchema, await readJsonBody(c), roleValidationError);
    const created = await createRole(deps, input, adminActorFrom(c));

    c.header('Location', `/api/v1/roles/${created.id}`);
    return c.json(created, 201);
  });

  routes.put('/roles/:id', requirePermission('roles.manage'), async (c) => {
    const roleId = numericIdOf(c, 'id');
    const input = parseOr422(updateRoleSchema, await readJsonBody(c), roleValidationError);
    return c.json(await updateRole(deps, roleId, input, adminActorFrom(c)));
  });

  routes.post('/roles/:id/disable', requirePermission('roles.manage'), async (c) => {
    const roleId = numericIdOf(c, 'id');
    // `DisableRoleRequest? request` is nullable in the reference (RoleEndpoints.cs:60): a bodiless
    // POST means force=false rather than a 400.
    const input = parseOr422(
      disableRoleSchema,
      await readJsonBody(c, { optional: true }),
      roleValidationError,
    );
    await disableRole(deps, roleId, input.force, adminActorFrom(c));
    return c.body(null, 200);
  });

  return routes;
}
