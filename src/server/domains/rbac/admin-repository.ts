/**
 * Roles, groups and permission-catalog persistence for the User Manager (T-017, AC-030).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Security/RoleStore.cs`, `GroupStore.cs` and the
 * `permissions` reads behind `PermissionCatalog`. Every function takes a `DbExecutor`, so the same
 * code runs standalone and inside a transaction (lib/db/types.ts's repository contract).
 *
 * NONE OF THESE TABLES CAN BE `forTenant(...)`-SCOPED, AND THAT IS THE HAZARD
 * ==========================================================================
 * `roles`, `user_groups` and all four grant tables carry a NULLABLE `tenant_id` because a row may be
 * tenant-scoped OR global/Internal (20260718001200_rbac.sql), so they are unpartitioned and outside
 * `TENANT_SCOPED_TABLES`. `forTenant` emits `tenant_id = $1`, which would silently drop every global
 * row. The predicate this domain needs is `tenant_id is null or tenant_id = $1`, written explicitly
 * below — and with RLS not adopted (spec Q-10), that predicate is the ONLY thing standing between a
 * tenant-A admin and tenant B's roles. List queries apply it here; by-id lookups return the row and
 * leave confinement to `admin-context.ts`, so the caller can answer the uniform not-found.
 */
import { sql } from 'kysely';

import type { DbExecutor } from '../../lib/db/index.js';

export interface RoleRecord {
  readonly id: number;
  readonly tenantId: number | null;
  readonly name: string;
  readonly isActive: boolean;
}

export interface GroupRecord {
  readonly id: number;
  readonly tenantId: number | null;
  readonly name: string;
  readonly isActive: boolean;
}

export interface PermissionCatalogEntry {
  readonly code: string;
  readonly category: string;
  readonly description: string;
}

interface RoleRow {
  readonly id: number;
  readonly tenant_id: number | null;
  readonly name: string;
  readonly is_active: boolean;
}

function toRole(row: RoleRow): RoleRecord {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
    name: row.name,
    isActive: row.is_active,
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Permission catalog                                                                          */
/* ------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/permissions` (spec §375). Read from the SEEDED `permissions` table rather than from
 * the TypeScript constant: the table is what every `role_permissions`/`group_permissions`/
 * `user_permissions` foreign key resolves against, so a code the API offers but the database has
 * never heard of would be selectable in the picker and rejected on save. `permission-catalog.ts` is
 * separately pinned against seed.sql by the unit suite, so the two cannot drift apart quietly.
 */
export async function listPermissionCatalog(
  executor: DbExecutor,
): Promise<PermissionCatalogEntry[]> {
  const rows = await executor
    .selectFrom('permissions')
    .select(['code', 'category', 'description'])
    .orderBy('code')
    .execute();

  return rows.map((row) => ({
    code: row.code,
    category: row.category,
    description: row.description,
  }));
}

/** Codes that exist in the catalog, for validating a submitted permission set in one round trip. */
export async function existingPermissionCodes(
  executor: DbExecutor,
  codes: readonly string[],
): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  const rows = await executor
    .selectFrom('permissions')
    .select('code')
    .where('code', 'in', [...codes])
    .execute();
  return new Set(rows.map((row) => row.code));
}

/* ------------------------------------------------------------------------------------------- */
/* Roles                                                                                        */
/* ------------------------------------------------------------------------------------------- */

export async function findRole(
  executor: DbExecutor,
  roleId: number,
): Promise<RoleRecord | undefined> {
  const row = await executor
    .selectFrom('roles')
    .select(['id', 'tenant_id', 'name', 'is_active'])
    .where('id', '=', roleId)
    .executeTakeFirst();
  return row === undefined ? undefined : toRole(row as RoleRow);
}

/**
 * RoleStore.ListAsync — the ambient tenant's roles PLUS global ones, or every role for a
 * cross-tenant caller (`tenantId: null` here means "no narrowing", matching
 * ListRolesQueryHandler.cs:19).
 */
export async function listRoles(
  executor: DbExecutor,
  tenantId: number | null,
): Promise<RoleRecord[]> {
  let query = executor
    .selectFrom('roles')
    .select(['id', 'tenant_id', 'name', 'is_active'])
    .orderBy('name');

  if (tenantId !== null) {
    query = query.where((eb) =>
      eb.or([eb('tenant_id', 'is', null), eb('tenant_id', '=', tenantId)]),
    );
  }

  return (await query.execute()).map((row) => toRole(row as RoleRow));
}

/** RoleStore.NameExistsAsync — unique per (tenant scope, name); `null` scope means global. */
export async function roleNameExists(
  executor: DbExecutor,
  tenantId: number | null,
  name: string,
  excludeRoleId: number | null,
): Promise<boolean> {
  let query = executor
    .selectFrom('roles')
    .select('id')
    .where(sql<boolean>`lower(name) = lower(${name})`);

  query = tenantId === null
    ? query.where('tenant_id', 'is', null)
    : query.where('tenant_id', '=', tenantId);

  if (excludeRoleId !== null) query = query.where('id', '!=', excludeRoleId);

  return (await query.executeTakeFirst()) !== undefined;
}

export async function insertRole(
  executor: DbExecutor,
  values: { tenantId: number | null; name: string; actorUserId: number },
): Promise<RoleRecord> {
  const now = new Date().toISOString();
  const row = await executor
    .insertInto('roles')
    .values({
      tenant_id: values.tenantId,
      name: values.name,
      is_active: true,
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(['id', 'tenant_id', 'name', 'is_active'])
    .executeTakeFirstOrThrow();
  return toRole(row as RoleRow);
}

export async function renameRole(
  executor: DbExecutor,
  roleId: number,
  name: string,
  actorUserId: number,
): Promise<RoleRecord> {
  const row = await executor
    .updateTable('roles')
    .set({ name, updated_at: new Date().toISOString(), updated_by: actorUserId })
    .where('id', '=', roleId)
    .returning(['id', 'tenant_id', 'name', 'is_active'])
    .executeTakeFirstOrThrow();
  return toRole(row as RoleRow);
}

/**
 * DisableRoleCommandHandler:88 — `is_active = false`, never a delete. Every historical grant row
 * stays; the resolver simply stops honouring the path (`pathActive`, rbac/types.ts).
 */
export async function deactivateRole(
  executor: DbExecutor,
  roleId: number,
  actorUserId: number,
): Promise<void> {
  await executor
    .updateTable('roles')
    .set({ is_active: false, updated_at: new Date().toISOString(), updated_by: actorUserId })
    .where('id', '=', roleId)
    .execute();
}

export async function rolePermissionCodes(
  executor: DbExecutor,
  roleId: number,
): Promise<string[]> {
  const rows = await executor
    .selectFrom('role_permissions')
    .select('permission_code')
    .where('role_id', '=', roleId)
    .orderBy('permission_code')
    .execute();
  return rows.map((row) => row.permission_code);
}

/** Permission codes for MANY roles at once — the N+1 the reference's per-role loop invited. */
export async function permissionCodesForRoles(
  executor: DbExecutor,
  roleIds: readonly number[],
): Promise<Map<number, string[]>> {
  const byRole = new Map<number, string[]>();
  if (roleIds.length === 0) return byRole;

  const rows = await executor
    .selectFrom('role_permissions')
    .select(['role_id', 'permission_code'])
    .where('role_id', 'in', [...roleIds])
    .orderBy('permission_code')
    .execute();

  for (const row of rows) {
    const key = Number(row.role_id);
    const codes = byRole.get(key) ?? [];
    codes.push(row.permission_code);
    byRole.set(key, codes);
  }
  return byRole;
}

export async function replaceRolePermissions(
  executor: DbExecutor,
  roleId: number,
  codes: readonly string[],
  actorUserId: number,
): Promise<void> {
  await executor.deleteFrom('role_permissions').where('role_id', '=', roleId).execute();
  if (codes.length === 0) return;

  const now = new Date().toISOString();
  await executor
    .insertInto('role_permissions')
    .values(
      [...new Set(codes)].map((code) => ({
        role_id: roleId,
        permission_code: code,
        created_at: now,
        created_by: actorUserId,
      })),
    )
    .execute();
}

export interface RoleUsage {
  readonly users: readonly { userId: number; email: string; tenantId: number | null }[];
  readonly groups: readonly { groupId: number; name: string; tenantId: number | null }[];
}

/**
 * RoleStore.GetUsageAsync — everyone who would lose access if this role were disabled (spec §12.2,
 * "usage visibility before disable/remove"). Answered BEFORE the disable, so the caller sees the
 * blast radius rather than discovering it afterwards.
 */
export async function roleUsage(executor: DbExecutor, roleId: number): Promise<RoleUsage> {
  const userRows = await executor
    .selectFrom('user_roles')
    .innerJoin('users', 'users.id', 'user_roles.user_id')
    .select([
      'user_roles.user_id as user_id',
      'users.email as email',
      'user_roles.tenant_id as tenant_id',
    ])
    .where('user_roles.role_id', '=', roleId)
    .orderBy('user_roles.user_id')
    .execute();

  const groupRows = await executor
    .selectFrom('group_roles')
    .innerJoin('user_groups', 'user_groups.id', 'group_roles.group_id')
    .select([
      'group_roles.group_id as group_id',
      'user_groups.name as name',
      'user_groups.tenant_id as tenant_id',
    ])
    .where('group_roles.role_id', '=', roleId)
    .orderBy('group_roles.group_id')
    .execute();

  return {
    users: userRows.map((row) => ({
      userId: Number(row.user_id),
      email: String(row.email),
      tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
    })),
    groups: groupRows.map((row) => ({
      groupId: Number(row.group_id),
      name: row.name,
      tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
    })),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Groups                                                                                       */
/* ------------------------------------------------------------------------------------------- */

export async function findGroup(
  executor: DbExecutor,
  groupId: number,
): Promise<GroupRecord | undefined> {
  const row = await executor
    .selectFrom('user_groups')
    .select(['id', 'tenant_id', 'name', 'is_active'])
    .where('id', '=', groupId)
    .executeTakeFirst();
  return row === undefined ? undefined : toRole(row as RoleRow);
}

export async function listGroups(
  executor: DbExecutor,
  tenantId: number | null,
): Promise<GroupRecord[]> {
  let query = executor
    .selectFrom('user_groups')
    .select(['id', 'tenant_id', 'name', 'is_active'])
    .orderBy('name');

  if (tenantId !== null) {
    query = query.where((eb) =>
      eb.or([eb('tenant_id', 'is', null), eb('tenant_id', '=', tenantId)]),
    );
  }

  return (await query.execute()).map((row) => toRole(row as RoleRow));
}

export async function groupNameExists(
  executor: DbExecutor,
  tenantId: number | null,
  name: string,
  excludeGroupId: number | null,
): Promise<boolean> {
  let query = executor
    .selectFrom('user_groups')
    .select('id')
    .where(sql<boolean>`lower(name) = lower(${name})`);

  query = tenantId === null
    ? query.where('tenant_id', 'is', null)
    : query.where('tenant_id', '=', tenantId);

  if (excludeGroupId !== null) query = query.where('id', '!=', excludeGroupId);

  return (await query.executeTakeFirst()) !== undefined;
}

export async function insertGroup(
  executor: DbExecutor,
  values: { tenantId: number | null; name: string; actorUserId: number },
): Promise<GroupRecord> {
  const now = new Date().toISOString();
  const row = await executor
    .insertInto('user_groups')
    .values({
      tenant_id: values.tenantId,
      name: values.name,
      is_active: true,
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(['id', 'tenant_id', 'name', 'is_active'])
    .executeTakeFirstOrThrow();
  return toRole(row as RoleRow);
}

export async function renameGroup(
  executor: DbExecutor,
  groupId: number,
  name: string,
  actorUserId: number,
): Promise<GroupRecord> {
  const row = await executor
    .updateTable('user_groups')
    .set({ name, updated_at: new Date().toISOString(), updated_by: actorUserId })
    .where('id', '=', groupId)
    .returning(['id', 'tenant_id', 'name', 'is_active'])
    .executeTakeFirstOrThrow();
  return toRole(row as RoleRow);
}

export async function deactivateGroup(
  executor: DbExecutor,
  groupId: number,
  actorUserId: number,
): Promise<void> {
  await executor
    .updateTable('user_groups')
    .set({ is_active: false, updated_at: new Date().toISOString(), updated_by: actorUserId })
    .where('id', '=', groupId)
    .execute();
}

export async function groupMemberUserIds(
  executor: DbExecutor,
  groupId: number,
): Promise<number[]> {
  const rows = await executor
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .orderBy('user_id')
    .execute();
  return rows.map((row) => Number(row.user_id));
}

export async function isGroupMember(
  executor: DbExecutor,
  groupId: number,
  userId: number,
): Promise<boolean> {
  const row = await executor
    .selectFrom('group_members')
    .select('id')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function addGroupMember(
  executor: DbExecutor,
  groupId: number,
  userId: number,
  actorUserId: number,
): Promise<void> {
  await executor
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      created_at: new Date().toISOString(),
      created_by: actorUserId,
    })
    .execute();
}

export async function removeGroupMember(
  executor: DbExecutor,
  groupId: number,
  userId: number,
): Promise<void> {
  await executor
    .deleteFrom('group_members')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .execute();
}

export async function groupRoleIds(executor: DbExecutor, groupId: number): Promise<number[]> {
  const rows = await executor
    .selectFrom('group_roles')
    .select('role_id')
    .where('group_id', '=', groupId)
    .orderBy('role_id')
    .execute();
  return rows.map((row) => Number(row.role_id));
}

export async function replaceGroupRoles(
  executor: DbExecutor,
  groupId: number,
  roleIds: readonly number[],
  actorUserId: number,
): Promise<void> {
  await executor.deleteFrom('group_roles').where('group_id', '=', groupId).execute();
  if (roleIds.length === 0) return;

  const now = new Date().toISOString();
  await executor
    .insertInto('group_roles')
    .values(
      [...new Set(roleIds)].map((roleId) => ({
        group_id: groupId,
        role_id: roleId,
        created_at: now,
        created_by: actorUserId,
      })),
    )
    .execute();
}

export async function groupPermissionCodes(
  executor: DbExecutor,
  groupId: number,
): Promise<string[]> {
  const rows = await executor
    .selectFrom('group_permissions')
    .select('permission_code')
    .where('group_id', '=', groupId)
    .orderBy('permission_code')
    .execute();
  return rows.map((row) => row.permission_code);
}

export async function replaceGroupPermissions(
  executor: DbExecutor,
  groupId: number,
  codes: readonly string[],
  actorUserId: number,
): Promise<void> {
  await executor.deleteFrom('group_permissions').where('group_id', '=', groupId).execute();
  if (codes.length === 0) return;

  const now = new Date().toISOString();
  await executor
    .insertInto('group_permissions')
    .values(
      [...new Set(codes)].map((code) => ({
        group_id: groupId,
        permission_code: code,
        created_at: now,
        created_by: actorUserId,
      })),
    )
    .execute();
}

/**
 * Every permission a group conveys: its direct grants UNION the grants of every role attached to
 * it. This is the set the escalation ceiling is measured against (F-031/F-033) — a caller who could
 * attach an over-privileged ROLE to a group, then self-join, would bypass the direct-permission
 * ceiling entirely, so both halves are always resolved together.
 */
export async function groupConveyedPermissionCodes(
  executor: DbExecutor,
  groupId: number,
): Promise<Set<string>> {
  const conveyed = new Set(await groupPermissionCodes(executor, groupId));
  const roleIds = await groupRoleIds(executor, groupId);
  const byRole = await permissionCodesForRoles(executor, roleIds);
  for (const codes of byRole.values()) {
    for (const code of codes) conveyed.add(code);
  }
  return conveyed;
}
