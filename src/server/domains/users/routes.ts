/**
 * User Manager routes (T-017; AC-029, AC-030, AC-031; V-038, V-040, V-041; spec §12.2).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/UserEndpoints.cs:28-36`, permission for permission:
 *
 *   GET    /api/v1/users                        users.view        (:30)
 *   GET    /api/v1/users/{id}                   users.view        (:31)
 *   POST   /api/v1/users                        users.invite      (:32)
 *   PUT    /api/v1/users/{id}                   users.edit        (:33)
 *   POST   /api/v1/users/{id}/deactivate        users.deactivate  (:34)
 *   GET    /api/v1/users/{id}/effective-access  users.view        (:35)
 *
 * plus ONE route with no reference counterpart:
 *
 *   POST   /api/v1/users/{id}/activate          users.deactivate  (AC-029, V-038 — see service.ts)
 *
 * THERE IS NO `DELETE /users/{id}` — AND THAT IS A REQUIREMENT, NOT AN OMISSION (AC-029, N-09).
 * The reference has none either. Users are deactivated; their rows, assignments and history are
 * preserved. V-038 asserts the absence of the route, not merely that nobody calls it.
 *
 * TENANT-SCOPED. The reference registers this group on `TenantScopedGroup` (:28) and `/users` is
 * deliberately absent from `GLOBAL_ROUTE_PREFIXES`, so a verified `X-Tenant-Id` is required and
 * every `requirePermission` resolves in THAT tenant. A `users.view` grant held in tenant A opens
 * nothing in tenant B, and the handlers additionally confine every by-id lookup to members of the
 * ambient tenant (service.ts `requireVisibleUser`) — the route guard alone would still let a
 * tenant-A admin read a tenant-B user by id.
 *
 * MEASURED RESPONSE SHAPES (UserEndpoints.cs)
 *   list             -> 200 UserDto[]                                       (:43)
 *   get              -> 200 UserDto                                         (:50)
 *   create           -> 201 + Location: /api/v1/users/{id}, CreateUserResult (:67-69)
 *   update           -> 200 UserDto                                         (:86)
 *   deactivate       -> 200 with an EMPTY body (`Results.Ok()`)             (:93)
 *   effective-access -> 200 EffectiveAccessDto                              (:101)
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import {
  adminActorFrom,
  numericIdOf,
  parseOr422,
  readJsonBody,
} from '../rbac/admin-routes-support.js';
import { userValidationError } from './errors.js';
import { createUserSchema, updateUserSchema } from './schemas.js';
import {
  activateUser,
  createUser,
  deactivateUser,
  getEffectiveAccess,
  getUser,
  listUsersForCaller,
  updateUser,
  type UsersDeps,
} from './service.js';

export function userRoutes(deps: UsersDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/users', requirePermission('users.view'), async (c) =>
    c.json(await listUsersForCaller(deps, adminActorFrom(c))),
  );

  routes.get('/users/:id', requirePermission('users.view'), async (c) =>
    c.json(await getUser(deps, numericIdOf(c, 'id'), adminActorFrom(c))),
  );

  routes.get('/users/:id/effective-access', requirePermission('users.view'), async (c) =>
    c.json(await getEffectiveAccess(deps, numericIdOf(c, 'id'), adminActorFrom(c))),
  );

  routes.post('/users', requirePermission('users.invite'), async (c) => {
    const input = parseOr422(createUserSchema, await readJsonBody(c), userValidationError);
    const created = await createUser(deps, input, adminActorFrom(c));

    c.header('Location', `/api/v1/users/${created.userId}`);
    return c.json(created, 201);
  });

  routes.put('/users/:id', requirePermission('users.edit'), async (c) => {
    const userId = numericIdOf(c, 'id');
    const input = parseOr422(updateUserSchema, await readJsonBody(c), userValidationError);
    return c.json(await updateUser(deps, userId, input, adminActorFrom(c)));
  });

  routes.post('/users/:id/deactivate', requirePermission('users.deactivate'), async (c) => {
    await deactivateUser(deps, numericIdOf(c, 'id'), adminActorFrom(c));
    return c.body(null, 200);
  });

  routes.post('/users/:id/activate', requirePermission('users.deactivate'), async (c) => {
    await activateUser(deps, numericIdOf(c, 'id'), adminActorFrom(c));
    return c.body(null, 200);
  });

  return routes;
}
