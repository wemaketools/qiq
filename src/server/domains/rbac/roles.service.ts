/**
 * Role administration behaviour (T-017, AC-030, AC-024).
 *
 * Ports the six handlers under `src/api/QuoteIQ.Application/Features/Roles/`. Three protections
 * matter more than the CRUD and are the reason this file is not a thin wrapper over the repository:
 *
 * 1. TENANT CONFINEMENT ON EVERY BY-ID PATH. `roles` is global/unpartitioned with a nullable
 *    tenant_id and there is no RLS beneath it (spec Q-10), so a by-id handler without an explicit
 *    check lets a tenant-A admin read and mutate tenant-B's roles by guessing an integer. Reads use
 *    `isReadAccessible`; writes use `isWriteAccessible`, which additionally requires
 *    `global.manage_global_defaults` for GLOBAL rows (F-032). Both translate a denial into the SAME
 *    404 a missing id produces (spec §14).
 *
 * 2. GRANT-NO-HIGHER-THAN-SELF ON ADDED CODES (F-034). `computeEffectivePermissions` joins
 *    `role_permissions` live, so widening an in-use role instantly escalates every holder. Only
 *    ADDED codes are gated; removals never are.
 *
 * 3. SELF-LOCKOUT. Removing an access-administration code from a role the caller holds, or disabling
 *    such a role, strips the caller's own ability to undo it. Blocked regardless of `force`.
 */
import { writeAudit } from '../audit/index.js';
import { withTransaction, type DbClient } from '../../lib/db/index.js';
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
  roleDuplicateNameError,
  roleGlobalForbiddenError,
  roleInUseError,
  roleNotFoundError,
  rolePermissionExceedsCallerGrantError,
  rolePermissionNotFoundError,
  roleSelfLockoutDisableError,
  roleSelfLockoutRemovalError,
  roleTenantRequiredError,
} from './admin-errors.js';
import {
  deactivateRole,
  existingPermissionCodes,
  findRole,
  insertRole,
  listRoles,
  permissionCodesForRoles,
  renameRole,
  replaceRolePermissions,
  roleNameExists,
  rolePermissionCodes,
  roleUsage,
  type RoleRecord,
  type RoleUsage,
} from './admin-repository.js';
import type {
  CreateRoleInput,
  RoleDto,
  RoleUsageDto,
  UpdateRoleInput,
} from './admin-schemas.js';
import type { DbExecutor } from '../../lib/db/index.js';

export interface RolesDeps {
  readonly db: DbClient;
}

export const ROLE_CREATED_ACTION = 'role.created';
export const ROLE_UPDATED_ACTION = 'role.updated';
export const ROLE_DISABLED_ACTION = 'role.disabled';

function toDto(role: RoleRecord, permissionCodes: readonly string[]): RoleDto {
  return {
    id: role.id,
    tenantId: role.tenantId,
    name: role.name,
    isActive: role.isActive,
    permissionCodes,
  };
}

/** Rejects any submitted code the seeded catalog does not contain (CreateRoleCommandHandler.cs:71-78). */
async function assertCatalogCodes(executor: DbExecutor, codes: readonly string[]): Promise<void> {
  const known = await existingPermissionCodes(executor, codes);
  for (const code of codes) {
    if (!known.has(code)) throw rolePermissionNotFoundError(code);
  }
}

/**
 * `SelfLockout.CallerHoldsRoleAsync` — directly (`user_roles`) or through a group the caller belongs
 * to (`group_members` -> `group_roles`).
 */
async function callerHoldsRole(
  executor: DbExecutor,
  roleId: number,
  actor: AdminActor,
): Promise<boolean> {
  const usage = await roleUsage(executor, roleId);
  if (usage.users.some((user) => user.userId === actor.userId)) return true;
  if (usage.groups.length === 0) return false;

  const memberships = await executor
    .selectFrom('group_members')
    .select('group_id')
    .where('user_id', '=', actor.userId)
    .execute();
  const callerGroupIds = new Set(memberships.map((row) => Number(row.group_id)));
  return usage.groups.some((group) => callerGroupIds.has(group.groupId));
}

/** ListRolesQueryHandler:19 — ambient tenant + global rows; everything for a cross-tenant caller. */
export async function listRolesForCaller(
  deps: RolesDeps,
  actor: AdminActor,
): Promise<RoleDto[]> {
  const roles = await listRoles(deps.db, actor.isCrossTenant ? null : actor.tenantId);
  const byRole = await permissionCodesForRoles(deps.db, roles.map((role) => role.id));
  return roles.map((role) => toDto(role, byRole.get(role.id) ?? []));
}

export async function getRole(
  deps: RolesDeps,
  roleId: number,
  actor: AdminActor,
): Promise<RoleDto> {
  const role = await findRole(deps.db, roleId);
  if (role === undefined || !isReadAccessible(role.tenantId, actor)) {
    throw roleNotFoundError(roleId);
  }
  return toDto(role, await rolePermissionCodes(deps.db, roleId));
}

export async function getRoleUsage(
  deps: RolesDeps,
  roleId: number,
  actor: AdminActor,
): Promise<RoleUsageDto> {
  const role = await findRole(deps.db, roleId);
  if (role === undefined || !isReadAccessible(role.tenantId, actor)) {
    throw roleNotFoundError(roleId);
  }
  const usage: RoleUsage = await roleUsage(deps.db, roleId);
  return { users: usage.users, groups: usage.groups };
}

export async function createRole(
  deps: RolesDeps,
  input: CreateRoleInput,
  actor: AdminActor,
): Promise<RoleDto> {
  // CreateRoleCommandHandler.cs:52-67. A GLOBAL role is an Internal-scope object: creating one
  // needs `global.manage_global_defaults` resolved in the GLOBAL scope, never a tenant grant.
  let tenantId: number | null;
  if (input.global) {
    if (!(await callerHolds(actor, MANAGE_GLOBAL_DEFAULTS, null))) throw roleGlobalForbiddenError();
    tenantId = null;
  } else {
    if (actor.tenantId === null) throw roleTenantRequiredError();
    tenantId = actor.tenantId;
  }

  if (await roleNameExists(deps.db, tenantId, input.name, null)) {
    throw roleDuplicateNameError(input.name);
  }

  await assertCatalogCodes(deps.db, input.permissionCodes);

  // F-034 applies at creation too: a role is a permission bundle, and creating one carrying codes
  // the caller does not hold is the same escalation as adding them by update a second later.
  for (const code of input.permissionCodes) {
    if (!(await callerHoldsInAllScopes(actor, code, tenantId, []))) {
      throw rolePermissionExceedsCallerGrantError(code);
    }
  }

  return await withTransaction(deps.db, async (trx) => {
    const role = await insertRole(trx, { tenantId, name: input.name, actorUserId: actor.userId });
    await replaceRolePermissions(trx, role.id, input.permissionCodes, actor.userId);

    await writeAudit(trx, {
      entityType: 'role',
      entityId: String(role.id),
      action: ROLE_CREATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: {
        name: role.name,
        tenantId: role.tenantId,
        permissionCodes: [...input.permissionCodes],
      },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });

    return toDto(role, input.permissionCodes);
  });
}

export async function updateRole(
  deps: RolesDeps,
  roleId: number,
  input: UpdateRoleInput,
  actor: AdminActor,
): Promise<RoleDto> {
  const role = await findRole(deps.db, roleId);
  if (role === undefined || !(await isWriteAccessible(role.tenantId, actor))) {
    throw roleNotFoundError(roleId);
  }

  if (await roleNameExists(deps.db, role.tenantId, input.name, roleId)) {
    throw roleDuplicateNameError(input.name);
  }

  await assertCatalogCodes(deps.db, input.permissionCodes);

  const existing = await rolePermissionCodes(deps.db, roleId);
  const existingSet = new Set(existing);

  // F-034: ADDED codes only. Removing a code is never gated — narrowing a role cannot escalate.
  for (const code of input.permissionCodes) {
    if (existingSet.has(code)) continue;
    if (!(await callerHoldsInAllScopes(actor, code, role.tenantId, []))) {
      throw rolePermissionExceedsCallerGrantError(code);
    }
  }

  const submitted = new Set(input.permissionCodes);
  const removedAdminCodes = existing.filter(
    (code) => !submitted.has(code) && isAccessAdminCode(code),
  );
  if (removedAdminCodes.length > 0 && (await callerHoldsRole(deps.db, roleId, actor))) {
    throw roleSelfLockoutRemovalError(removedAdminCodes[0] as string);
  }

  return await withTransaction(deps.db, async (trx) => {
    const renamed = await renameRole(trx, roleId, input.name, actor.userId);
    await replaceRolePermissions(trx, roleId, input.permissionCodes, actor.userId);

    await writeAudit(trx, {
      entityType: 'role',
      entityId: String(roleId),
      action: ROLE_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { name: role.name, permissionCodes: existing },
      after: { name: renamed.name, permissionCodes: [...input.permissionCodes] },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });

    return toDto(renamed, input.permissionCodes);
  });
}

/**
 * DisableRoleCommandHandler. Usage is checked BEFORE disabling unless `force`, so an administrator
 * sees who loses access rather than discovering it from a support ticket. Self-lockout is checked
 * first and is NOT overridable by `force`.
 */
export async function disableRole(
  deps: RolesDeps,
  roleId: number,
  force: boolean,
  actor: AdminActor,
): Promise<void> {
  const role = await findRole(deps.db, roleId);
  if (role === undefined || !(await isWriteAccessible(role.tenantId, actor))) {
    throw roleNotFoundError(roleId);
  }

  if (await callerHoldsRole(deps.db, roleId, actor)) {
    const codes = await rolePermissionCodes(deps.db, roleId);
    if (codes.some(isAccessAdminCode)) throw roleSelfLockoutDisableError();
  }

  if (!force) {
    const usage = await roleUsage(deps.db, roleId);
    if (usage.users.length > 0 || usage.groups.length > 0) throw roleInUseError(usage);
  }

  await withTransaction(deps.db, async (trx) => {
    await deactivateRole(trx, roleId, actor.userId);

    await writeAudit(trx, {
      entityType: 'role',
      entityId: String(roleId),
      action: ROLE_DISABLED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { name: role.name, isActive: true },
      after: { name: role.name, isActive: false, force },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}
