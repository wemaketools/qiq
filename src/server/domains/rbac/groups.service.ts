/**
 * User-group administration behaviour (T-017, AC-030, AC-024).
 *
 * Ports the nine handlers under `src/api/QuoteIQ.Application/Features/Groups/`.
 *
 * THE GROUP PATH IS THE ESCALATION BACK DOOR, AND THAT IS WHY THIS FILE IS GUARD-HEAVY
 * ===================================================================================
 * A group conveys permissions to every member through TWO paths the resolver joins live
 * (`group_direct` and `group_role`, rbac/repository.ts). So a `groups.manage`-only caller who could
 * attach an over-privileged role or permission to a group and then add themselves to it would
 * acquire those grants immediately — bypassing every ceiling the Users surface applies (F-031/F-033).
 * Both halves are therefore gated by the same grant-no-higher-than-self ceiling:
 *
 *   setGroupPermissions / setGroupRoles  — the caller must hold every code being ATTACHED
 *   addGroupMember                       — the caller must hold every code the group CONVEYS
 *
 * and `removeGroupMember` refuses to let a caller drop their own membership of an admin-carrying
 * group (self-lockout), because that strips their ability to reverse it.
 *
 * Every by-id path is tenant-confined explicitly (`roles`/`user_groups` are unpartitioned with a
 * nullable tenant_id and there is no RLS underneath — spec Q-10), and every denial renders the same
 * 404 a missing id does.
 */
import { writeAudit } from '../audit/index.js';
import { withTransaction, type DbClient, type DbExecutor } from '../../lib/db/index.js';
import {
  callerHolds,
  callerHoldsInAllScopes,
  isAccessAdminCode,
  isReadAccessible,
  isWriteAccessible,
  MANAGE_GLOBAL_DEFAULTS,
  type AdminActor,
} from './admin-context.js';
import {
  groupAlreadyMemberError,
  groupDuplicateNameError,
  groupGlobalForbiddenError,
  groupNotFoundError,
  groupNotMemberError,
  groupPermissionExceedsCallerGrantError,
  groupPermissionNotFoundError,
  groupRoleNotFoundError,
  groupRoleTenantMismatchError,
  groupSelfLockoutLeaveError,
  groupTenantRequiredError,
  groupUserNotFoundError,
} from './admin-errors.js';
import {
  addGroupMember as addGroupMemberRow,
  deactivateGroup,
  existingPermissionCodes,
  findGroup,
  findRole,
  groupConveyedPermissionCodes,
  groupMemberUserIds,
  groupNameExists,
  groupPermissionCodes,
  groupRoleIds,
  insertGroup,
  isGroupMember,
  listGroups,
  removeGroupMember as removeGroupMemberRow,
  renameGroup,
  replaceGroupPermissions,
  replaceGroupRoles,
  rolePermissionCodes,
  type GroupRecord,
} from './admin-repository.js';
import type {
  CreateGroupInput,
  GroupDetailDto,
  GroupDto,
  SetGroupPermissionsInput,
  SetGroupRolesInput,
  UpdateGroupInput,
} from './admin-schemas.js';

export interface GroupsDeps {
  readonly db: DbClient;
}

export const GROUP_CREATED_ACTION = 'group.created';
export const GROUP_UPDATED_ACTION = 'group.updated';
export const GROUP_DISABLED_ACTION = 'group.disabled';
export const GROUP_MEMBER_ADDED_ACTION = 'group.member_added';
export const GROUP_MEMBER_REMOVED_ACTION = 'group.member_removed';
export const GROUP_ROLES_SET_ACTION = 'group.roles_set';
export const GROUP_PERMISSIONS_SET_ACTION = 'group.permissions_set';

function toDto(group: GroupRecord): GroupDto {
  return {
    id: group.id,
    tenantId: group.tenantId,
    name: group.name,
    isActive: group.isActive,
  };
}

/** Resolves a group for a WRITE, or throws the uniform not-found. */
async function requireWritableGroup(
  executor: DbExecutor,
  groupId: number,
  actor: AdminActor,
): Promise<GroupRecord> {
  const group = await findGroup(executor, groupId);
  if (group === undefined || !(await isWriteAccessible(group.tenantId, actor))) {
    throw groupNotFoundError(groupId);
  }
  return group;
}

export async function listGroupsForCaller(
  deps: GroupsDeps,
  actor: AdminActor,
): Promise<GroupDto[]> {
  const groups = await listGroups(deps.db, actor.isCrossTenant ? null : actor.tenantId);
  return groups.map(toDto);
}

export async function getGroup(
  deps: GroupsDeps,
  groupId: number,
  actor: AdminActor,
): Promise<GroupDetailDto> {
  const group = await findGroup(deps.db, groupId);
  if (group === undefined || !isReadAccessible(group.tenantId, actor)) {
    throw groupNotFoundError(groupId);
  }

  return {
    ...toDto(group),
    memberUserIds: await groupMemberUserIds(deps.db, groupId),
    roleIds: await groupRoleIds(deps.db, groupId),
    permissionCodes: await groupPermissionCodes(deps.db, groupId),
  };
}

export async function createGroup(
  deps: GroupsDeps,
  input: CreateGroupInput,
  actor: AdminActor,
): Promise<GroupDto> {
  let tenantId: number | null;
  if (input.global) {
    if (!(await callerHolds(actor, MANAGE_GLOBAL_DEFAULTS, null))) throw groupGlobalForbiddenError();
    tenantId = null;
  } else {
    if (actor.tenantId === null) throw groupTenantRequiredError();
    tenantId = actor.tenantId;
  }

  if (await groupNameExists(deps.db, tenantId, input.name, null)) {
    throw groupDuplicateNameError(input.name);
  }

  return await withTransaction(deps.db, async (trx) => {
    const group = await insertGroup(trx, { tenantId, name: input.name, actorUserId: actor.userId });

    await writeAudit(trx, {
      entityType: 'group',
      entityId: String(group.id),
      action: GROUP_CREATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: { name: group.name, tenantId: group.tenantId },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });

    return toDto(group);
  });
}

export async function updateGroup(
  deps: GroupsDeps,
  groupId: number,
  input: UpdateGroupInput,
  actor: AdminActor,
): Promise<GroupDto> {
  const group = await requireWritableGroup(deps.db, groupId, actor);

  if (await groupNameExists(deps.db, group.tenantId, input.name, groupId)) {
    throw groupDuplicateNameError(input.name);
  }

  return await withTransaction(deps.db, async (trx) => {
    const renamed = await renameGroup(trx, groupId, input.name, actor.userId);

    await writeAudit(trx, {
      entityType: 'group',
      entityId: String(groupId),
      action: GROUP_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { name: group.name },
      after: { name: renamed.name },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });

    return toDto(renamed);
  });
}

export async function disableGroup(
  deps: GroupsDeps,
  groupId: number,
  actor: AdminActor,
): Promise<void> {
  const group = await requireWritableGroup(deps.db, groupId, actor);

  await withTransaction(deps.db, async (trx) => {
    await deactivateGroup(trx, groupId, actor.userId);

    await writeAudit(trx, {
      entityType: 'group',
      entityId: String(groupId),
      action: GROUP_DISABLED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { name: group.name, isActive: true },
      after: { name: group.name, isActive: false },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}

export async function addGroupMember(
  deps: GroupsDeps,
  groupId: number,
  userId: number,
  actor: AdminActor,
): Promise<void> {
  const group = await requireWritableGroup(deps.db, groupId, actor);

  const target = await deps.db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (target === undefined) throw groupUserNotFoundError(userId);

  // F-031: the added member must belong to the ambient tenant. Without this a tenant-A admin could
  // add a tenant-B user id (or their own out-of-scope id) to a group and have the resolver honour
  // the group's grants for them. Same not-found shape as a missing user (spec §14).
  if (!actor.isCrossTenant) {
    const membership = await deps.db
      .selectFrom('user_tenants')
      .select('id')
      .where('user_id', '=', userId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (actor.tenantId === null || membership === undefined) throw groupUserNotFoundError(userId);
  }

  if (await isGroupMember(deps.db, groupId, userId)) throw groupAlreadyMemberError(userId);

  // F-033: joining someone to a group hands them everything the group conveys, so the ceiling has
  // to be applied here as well as on the set-roles/set-permissions routes.
  for (const code of await groupConveyedPermissionCodes(deps.db, groupId)) {
    if (!(await callerHoldsInAllScopes(actor, code, group.tenantId, []))) {
      throw groupPermissionExceedsCallerGrantError(code);
    }
  }

  await withTransaction(deps.db, async (trx) => {
    await addGroupMemberRow(trx, groupId, userId, actor.userId);

    await writeAudit(trx, {
      entityType: 'group',
      entityId: String(groupId),
      action: GROUP_MEMBER_ADDED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: { userId },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}

export async function removeGroupMember(
  deps: GroupsDeps,
  groupId: number,
  userId: number,
  actor: AdminActor,
): Promise<void> {
  await requireWritableGroup(deps.db, groupId, actor);

  if (!(await isGroupMember(deps.db, groupId, userId))) throw groupNotMemberError(userId);

  if (userId === actor.userId) {
    const conveyed = await groupConveyedPermissionCodes(deps.db, groupId);
    if ([...conveyed].some(isAccessAdminCode)) throw groupSelfLockoutLeaveError();
  }

  await withTransaction(deps.db, async (trx) => {
    await removeGroupMemberRow(trx, groupId, userId);

    await writeAudit(trx, {
      entityType: 'group',
      entityId: String(groupId),
      action: GROUP_MEMBER_REMOVED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { userId },
      after: null,
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}

export async function setGroupRoles(
  deps: GroupsDeps,
  groupId: number,
  input: SetGroupRolesInput,
  actor: AdminActor,
): Promise<void> {
  const group = await requireWritableGroup(deps.db, groupId, actor);

  for (const roleId of input.roleIds) {
    const role = await findRole(deps.db, roleId);
    // F-035: a role the caller cannot see must answer NOT FOUND, not the 422 mismatch below —
    // otherwise the two distinct responses form a cross-tenant existence oracle.
    if (role === undefined || !isReadAccessible(role.tenantId, actor)) {
      throw groupRoleNotFoundError(roleId);
    }
    if (role.tenantId !== null && role.tenantId !== group.tenantId) {
      throw groupRoleTenantMismatchError(roleId);
    }

    for (const code of await rolePermissionCodes(deps.db, roleId)) {
      if (!(await callerHoldsInAllScopes(actor, code, group.tenantId, []))) {
        throw groupPermissionExceedsCallerGrantError(code);
      }
    }
  }

  const before = await groupRoleIds(deps.db, groupId);

  await withTransaction(deps.db, async (trx) => {
    await replaceGroupRoles(trx, groupId, input.roleIds, actor.userId);

    await writeAudit(trx, {
      entityType: 'group',
      entityId: String(groupId),
      action: GROUP_ROLES_SET_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { roleIds: before },
      after: { roleIds: [...input.roleIds] },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}

export async function setGroupPermissions(
  deps: GroupsDeps,
  groupId: number,
  input: SetGroupPermissionsInput,
  actor: AdminActor,
): Promise<void> {
  const group = await requireWritableGroup(deps.db, groupId, actor);

  const known = await existingPermissionCodes(deps.db, input.permissionCodes);
  for (const code of input.permissionCodes) {
    if (!known.has(code)) throw groupPermissionNotFoundError(code);
  }

  for (const code of input.permissionCodes) {
    if (!(await callerHoldsInAllScopes(actor, code, group.tenantId, []))) {
      throw groupPermissionExceedsCallerGrantError(code);
    }
  }

  const before = await groupPermissionCodes(deps.db, groupId);

  await withTransaction(deps.db, async (trx) => {
    await replaceGroupPermissions(trx, groupId, input.permissionCodes, actor.userId);

    await writeAudit(trx, {
      entityType: 'group',
      entityId: String(groupId),
      action: GROUP_PERMISSIONS_SET_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { permissionCodes: before },
      after: { permissionCodes: [...input.permissionCodes] },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}
