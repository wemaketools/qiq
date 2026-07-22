/**
 * User-group administration routes (T-017, AC-030; V-040; spec §12.2).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/GroupEndpoints.cs:29-40`, permission for permission:
 *
 *   GET    /api/v1/groups                                  groups.view    (:31)
 *   GET    /api/v1/groups/{id}                             groups.view    (:32)
 *   POST   /api/v1/groups                                  groups.manage  (:33)
 *   PUT    /api/v1/groups/{id}                             groups.manage  (:34)
 *   POST   /api/v1/groups/{id}/disable                     groups.manage  (:35)
 *   POST   /api/v1/groups/{id}/members                     groups.manage  (:36)
 *   POST   /api/v1/groups/{id}/members/{userId}/remove     groups.manage  (:37)
 *   POST   /api/v1/groups/{id}/roles                       groups.manage  (:38)
 *   POST   /api/v1/groups/{id}/permissions                 groups.manage  (:39)
 *
 * MEMBER REMOVAL IS `POST .../remove`, NOT `DELETE` — deliberately, per the reference's own note
 * (GroupEndpoints.cs:21-23): this API's mutations are action-shaped so the feature never resembles
 * the hard-delete routes AC-029/V-038 assert are absent. Group disable is `is_active = false` and
 * membership/grant rows survive it.
 *
 * Tenant-scoped like the roles surface; see roles.routes.ts for why that matters.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { groupValidationError } from './admin-errors.js';
import {
  adminActorFrom,
  numericIdOf,
  parseOr422,
  readJsonBody,
} from './admin-routes-support.js';
import {
  addGroupMemberSchema,
  createGroupSchema,
  setGroupPermissionsSchema,
  setGroupRolesSchema,
  updateGroupSchema,
} from './admin-schemas.js';
import {
  addGroupMember,
  createGroup,
  disableGroup,
  getGroup,
  listGroupsForCaller,
  removeGroupMember,
  setGroupPermissions,
  setGroupRoles,
  updateGroup,
  type GroupsDeps,
} from './groups.service.js';

export function groupRoutes(deps: GroupsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/groups', requirePermission('groups.view'), async (c) =>
    c.json(await listGroupsForCaller(deps, await adminActorFrom(c))),
  );

  routes.get('/groups/:id', requirePermission('groups.view'), async (c) =>
    c.json(await getGroup(deps, numericIdOf(c, 'id'), await adminActorFrom(c))),
  );

  routes.post('/groups', requirePermission('groups.manage'), async (c) => {
    const input = parseOr422(createGroupSchema, await readJsonBody(c), groupValidationError);
    const created = await createGroup(deps, input, await adminActorFrom(c));

    c.header('Location', `/api/v1/groups/${created.id}`);
    return c.json(created, 201);
  });

  routes.put('/groups/:id', requirePermission('groups.manage'), async (c) => {
    const groupId = numericIdOf(c, 'id');
    const input = parseOr422(updateGroupSchema, await readJsonBody(c), groupValidationError);
    return c.json(await updateGroup(deps, groupId, input, await adminActorFrom(c)));
  });

  routes.post('/groups/:id/disable', requirePermission('groups.manage'), async (c) => {
    await disableGroup(deps, numericIdOf(c, 'id'), await adminActorFrom(c));
    return c.body(null, 200);
  });

  routes.post('/groups/:id/members', requirePermission('groups.manage'), async (c) => {
    const groupId = numericIdOf(c, 'id');
    const input = parseOr422(addGroupMemberSchema, await readJsonBody(c), groupValidationError);
    await addGroupMember(deps, groupId, input.userId, await adminActorFrom(c));
    return c.body(null, 200);
  });

  routes.post(
    '/groups/:id/members/:userId/remove',
    requirePermission('groups.manage'),
    async (c) => {
      const groupId = numericIdOf(c, 'id');
      const userId = numericIdOf(c, 'userId');
      await removeGroupMember(deps, groupId, userId, await adminActorFrom(c));
      return c.body(null, 200);
    },
  );

  routes.post('/groups/:id/roles', requirePermission('groups.manage'), async (c) => {
    const groupId = numericIdOf(c, 'id');
    const input = parseOr422(
      setGroupRolesSchema,
      await readJsonBody(c, { optional: true }),
      groupValidationError,
    );
    await setGroupRoles(deps, groupId, input, await adminActorFrom(c));
    return c.body(null, 200);
  });

  routes.post('/groups/:id/permissions', requirePermission('groups.manage'), async (c) => {
    const groupId = numericIdOf(c, 'id');
    const input = parseOr422(
      setGroupPermissionsSchema,
      await readJsonBody(c, { optional: true }),
      groupValidationError,
    );
    await setGroupPermissions(deps, groupId, input, await adminActorFrom(c));
    return c.body(null, 200);
  });

  return routes;
}
