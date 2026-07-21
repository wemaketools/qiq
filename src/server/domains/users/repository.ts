/**
 * `users` and its assignment tables (T-017, AC-029, AC-030, AC-031).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Security/UserStore.cs`. Every function takes a
 * `DbExecutor` so the same code runs standalone and inside the provisioning transaction.
 *
 * THERE IS NO DELETE FUNCTION FOR A USER IN THIS FILE, AND THERE MUST NOT BE (AC-029, N-09).
 * Users are deactivated (`is_active = false`); the row, every assignment, and every audit and
 * history row referencing them stay exactly where they are. The assignment tables DO have
 * replace-semantics deletes — those remove GRANTS, not people, and are how the reference's
 * `Replace*Async` methods worked.
 *
 * TENANT SCOPING — WHERE IT LIVES AND WHY IT IS NOT `forTenant`
 * ============================================================
 * `users` is a global table (a user may belong to several tenants) and `user_roles`/
 * `user_permissions` carry a NULLABLE tenant_id (a null is a GLOBAL grant), so none of them is in
 * `TENANT_SCOPED_TABLES` and `forTenant` is not applicable. The only tenant-scoped table here is
 * `user_tenants`, and the isolation guarantee for the whole surface comes from `listUsers`'s
 * explicit membership join plus the by-id `isMemberOfTenant` check every handler performs. With RLS
 * not adopted (spec Q-10) those predicates are the entire boundary.
 */
import type { DbExecutor } from '../../lib/db/index.js';
import type { UserDto } from './schemas.js';

export interface UserRecord {
  readonly id: number;
  readonly authUserId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly isActive: boolean;
}

interface UserRow {
  readonly id: number;
  readonly auth_user_id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
  readonly is_active: boolean;
}

const USER_COLUMNS = ['id', 'auth_user_id', 'first_name', 'last_name', 'email', 'is_active'] as const;

function toRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    authUserId: row.auth_user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: String(row.email),
    isActive: row.is_active,
  };
}

export function toUserDto(user: UserRecord, tenantIds: readonly number[]): UserDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    isActive: user.isActive,
    tenantIds,
  };
}

export async function findUser(
  executor: DbExecutor,
  userId: number,
): Promise<UserRecord | undefined> {
  const row = await executor
    .selectFrom('users')
    .select(USER_COLUMNS)
    .where('id', '=', userId)
    .executeTakeFirst();
  return row === undefined ? undefined : toRecord(row as UserRow);
}

/** `users.email` is `citext`, so this comparison is case-insensitive at the database level. */
export async function emailExists(
  executor: DbExecutor,
  email: string,
  excludeUserId: number | null,
): Promise<boolean> {
  let query = executor.selectFrom('users').select('id').where('email', '=', email);
  if (excludeUserId !== null) query = query.where('id', '!=', excludeUserId);
  return (await query.executeTakeFirst()) !== undefined;
}

/**
 * UserStore.ListAsync. `tenantId: null` means NO NARROWING and is reserved for cross-tenant
 * (Internal) callers — ListUsersQueryHandler.cs:22 derives it from `ITenantContext.IsCrossTenant`,
 * never from a request parameter, so a tenant-scoped caller cannot widen the query by payload.
 */
export async function listUsers(
  executor: DbExecutor,
  tenantId: number | null,
): Promise<UserRecord[]> {
  if (tenantId === null) {
    const rows = await executor
      .selectFrom('users')
      .select(USER_COLUMNS)
      .orderBy('email')
      .execute();
    return rows.map((row) => toRecord(row as UserRow));
  }

  const rows = await executor
    .selectFrom('users')
    .innerJoin('user_tenants', 'user_tenants.user_id', 'users.id')
    .select(USER_COLUMNS.map((column) => `users.${column}` as `users.${typeof column}`))
    .where('user_tenants.tenant_id', '=', tenantId)
    .distinct()
    .orderBy('users.email')
    .execute();
  return rows.map((row) => toRecord(row as unknown as UserRow));
}

export async function userTenantIds(executor: DbExecutor, userId: number): Promise<number[]> {
  const rows = await executor
    .selectFrom('user_tenants')
    .select('tenant_id')
    .where('user_id', '=', userId)
    .orderBy('tenant_id')
    .execute();
  return rows.map((row) => Number(row.tenant_id));
}

/** Tenant assignments joined to the tenant name, for the effective-access view. */
export async function userTenantAssignments(
  executor: DbExecutor,
  userId: number,
): Promise<{ tenantId: number; tenantName: string }[]> {
  const rows = await executor
    .selectFrom('user_tenants')
    .innerJoin('tenants', 'tenants.id', 'user_tenants.tenant_id')
    .select(['tenants.id as tenant_id', 'tenants.name as tenant_name'])
    .where('user_tenants.user_id', '=', userId)
    .orderBy('tenants.name')
    .execute();
  return rows.map((row) => ({ tenantId: Number(row.tenant_id), tenantName: row.tenant_name }));
}

export interface RoleAssignmentRecord {
  readonly roleId: number;
  readonly tenantId: number | null;
}

export interface PermissionAssignmentRecord {
  readonly permissionCode: string;
  readonly tenantId: number | null;
}

export async function userRoleAssignments(
  executor: DbExecutor,
  userId: number,
): Promise<RoleAssignmentRecord[]> {
  const rows = await executor
    .selectFrom('user_roles')
    .select(['role_id', 'tenant_id'])
    .where('user_id', '=', userId)
    .orderBy('role_id')
    .execute();
  return rows.map((row) => ({
    roleId: Number(row.role_id),
    tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
  }));
}

export async function userPermissionAssignments(
  executor: DbExecutor,
  userId: number,
): Promise<PermissionAssignmentRecord[]> {
  const rows = await executor
    .selectFrom('user_permissions')
    .select(['permission_code', 'tenant_id'])
    .where('user_id', '=', userId)
    .orderBy('permission_code')
    .execute();
  return rows.map((row) => ({
    permissionCode: row.permission_code,
    tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
  }));
}

export async function userGroupIds(executor: DbExecutor, userId: number): Promise<number[]> {
  const rows = await executor
    .selectFrom('group_members')
    .select('group_id')
    .where('user_id', '=', userId)
    .orderBy('group_id')
    .execute();
  return rows.map((row) => Number(row.group_id));
}

export async function isMemberOfTenant(
  executor: DbExecutor,
  userId: number,
  tenantId: number,
): Promise<boolean> {
  const row = await executor
    .selectFrom('user_tenants')
    .select('id')
    .where('user_id', '=', userId)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return row !== undefined;
}

export interface InsertUserValues {
  readonly authUserId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly actorUserId: number;
}

export async function insertUser(
  executor: DbExecutor,
  values: InsertUserValues,
): Promise<UserRecord> {
  const now = new Date().toISOString();
  const row = await executor
    .insertInto('users')
    .values({
      auth_user_id: values.authUserId,
      first_name: values.firstName,
      last_name: values.lastName,
      email: values.email,
      is_active: true,
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(USER_COLUMNS)
    .executeTakeFirstOrThrow();
  return toRecord(row as UserRow);
}

export async function updateUserProfile(
  executor: DbExecutor,
  userId: number,
  values: { firstName: string; lastName: string; actorUserId: number },
): Promise<UserRecord> {
  const row = await executor
    .updateTable('users')
    .set({
      first_name: values.firstName,
      last_name: values.lastName,
      updated_at: new Date().toISOString(),
      updated_by: values.actorUserId,
    })
    .where('id', '=', userId)
    .returning(USER_COLUMNS)
    .executeTakeFirstOrThrow();
  return toRecord(row as UserRow);
}

/** Deactivate/reactivate. NEVER a delete — AC-029 asserts the absence of that path. */
export async function setUserActive(
  executor: DbExecutor,
  userId: number,
  isActive: boolean,
  actorUserId: number,
): Promise<void> {
  await executor
    .updateTable('users')
    .set({ is_active: isActive, updated_at: new Date().toISOString(), updated_by: actorUserId })
    .where('id', '=', userId)
    .execute();
}

/* ---------------------------------- assignment replacement --------------------------------- */

export async function replaceTenantAssignments(
  executor: DbExecutor,
  userId: number,
  tenantIds: readonly number[],
  actorUserId: number,
): Promise<void> {
  await executor.deleteFrom('user_tenants').where('user_id', '=', userId).execute();
  if (tenantIds.length === 0) return;

  const now = new Date().toISOString();
  await executor
    .insertInto('user_tenants')
    .values(
      [...new Set(tenantIds)].map((tenantId) => ({
        tenant_id: tenantId,
        user_id: userId,
        created_at: now,
        created_by: actorUserId,
      })),
    )
    .execute();
}

export async function replaceRoleAssignments(
  executor: DbExecutor,
  userId: number,
  assignments: readonly RoleAssignmentRecord[],
  actorUserId: number,
): Promise<void> {
  await executor.deleteFrom('user_roles').where('user_id', '=', userId).execute();
  if (assignments.length === 0) return;

  const now = new Date().toISOString();
  const unique = new Map(
    assignments.map((assignment) => [
      `${assignment.roleId}:${assignment.tenantId ?? 'global'}`,
      assignment,
    ]),
  );
  await executor
    .insertInto('user_roles')
    .values(
      [...unique.values()].map((assignment) => ({
        user_id: userId,
        role_id: assignment.roleId,
        tenant_id: assignment.tenantId,
        created_at: now,
        created_by: actorUserId,
      })),
    )
    .execute();
}

export async function replacePermissionAssignments(
  executor: DbExecutor,
  userId: number,
  assignments: readonly PermissionAssignmentRecord[],
  actorUserId: number,
): Promise<void> {
  await executor.deleteFrom('user_permissions').where('user_id', '=', userId).execute();
  if (assignments.length === 0) return;

  const now = new Date().toISOString();
  const unique = new Map(
    assignments.map((assignment) => [
      `${assignment.permissionCode}:${assignment.tenantId ?? 'global'}`,
      assignment,
    ]),
  );
  await executor
    .insertInto('user_permissions')
    .values(
      [...unique.values()].map((assignment) => ({
        user_id: userId,
        permission_code: assignment.permissionCode,
        tenant_id: assignment.tenantId,
        created_at: now,
        created_by: actorUserId,
      })),
    )
    .execute();
}

export async function replaceGroupMemberships(
  executor: DbExecutor,
  userId: number,
  groupIds: readonly number[],
  actorUserId: number,
): Promise<void> {
  await executor.deleteFrom('group_members').where('user_id', '=', userId).execute();
  if (groupIds.length === 0) return;

  const now = new Date().toISOString();
  await executor
    .insertInto('group_members')
    .values(
      [...new Set(groupIds)].map((groupId) => ({
        group_id: groupId,
        user_id: userId,
        created_at: now,
        created_by: actorUserId,
      })),
    )
    .execute();
}
