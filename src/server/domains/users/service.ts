/**
 * User Manager behaviour (T-017; AC-024, AC-029, AC-030, AC-031).
 *
 * Ports the six handlers under `src/api/QuoteIQ.Application/Features/Users/` plus the transaction
 * boundary from `UserStore.CreateAsync`.
 *
 * FOUR INVARIANTS THIS FILE EXISTS TO HOLD
 * ========================================
 *
 * 1. PROVISIONING IS ALL-OR-NOTHING (AC-031, V-041). The app `users` row needs the Auth identity's
 *    uuid (`users.auth_user_id` is NOT NULL and a hard FK onto `auth.users`), so the identity must
 *    be created FIRST and therefore outside the database transaction. The reference stopped there
 *    and accepted an orphaned Keycloak account on a later DB failure
 *    (CreateUserCommandHandler.cs:13-21). This port COMPENSATES instead: if anything after the
 *    provisioning call fails, the identity is deleted before the error propagates, so neither half
 *    survives. The compensating delete is itself best-effort — if it fails, the original error still
 *    wins, because reporting the compensation failure would hide the real cause.
 *
 * 2. TENANT CONFINEMENT ON EVERY BY-ID PATH (F-027). `users` is global with no tenant column, and
 *    Postgres RLS is not adopted (spec Q-10), so a by-id handler without an explicit membership
 *    check lets a tenant-A admin read, edit or deactivate a tenant-B-only user by guessing an
 *    integer. Every by-id function below calls `requireVisibleUser`, and a denial renders the SAME
 *    404 a missing id does (spec §14).
 *
 * 3. GRANT-NO-HIGHER-THAN-SELF (F-028/F-031). Holding `users.invite` or `users.edit` does not let a
 *    caller attach assignments: each input additionally requires its own `users.assign_*` /
 *    `users.grant_direct_permission` code IN THE AMBIENT TENANT, and no code may be granted —
 *    directly, through a role, or through a group's direct+role-carried set — that the caller does
 *    not themselves hold in every tenant the grant would apply to.
 *
 * 4. SELF-LOCKOUT. A caller may never deactivate themselves, nor change their own assignments
 *    through the full-replace PUT: both are irreversible by the person who did them.
 *
 * PER-TENANT ASSIGNMENT IS THE POINT OF THE UPDATE SHAPE (P-03, AC-030). `roleAssignments` and
 * `permissionAssignments` each carry their own `tenantId`, so a user genuinely holds different
 * access in different tenants — and `computeEffectivePermissions` honours that, which is why an
 * assignment made in tenant A yields nothing in tenant B.
 */
import { writeAudit } from '../audit/index.js';
import {
  callerHoldsAmbient,
  callerHoldsInAllScopes,
  isReadAccessible,
  GLOBAL_PERMISSION_PREFIX,
  type AdminActor,
} from '../rbac/admin-context.js';
import {
  existingPermissionCodes,
  findGroup,
  findRole,
  groupConveyedPermissionCodes,
  rolePermissionCodes,
} from '../rbac/admin-repository.js';
import { createEffectiveAccess, type GrantGraphLoader } from '../rbac/index.js';
import { toTenantId, withTransaction, type DbClient, type DbExecutor } from '../../lib/db/index.js';
import type { AuthAdminPort } from './auth-admin.js';
import {
  userAlreadyActiveError,
  userAlreadyInactiveError,
  userAuthProvisioningFailedError,
  userCannotChangeOwnAccessError,
  userCannotDeactivateSelfError,
  userDuplicateEmailError,
  userGroupNotFoundError,
  userGroupTenantMismatchError,
  userNotFoundError,
  userPermissionExceedsCallerGrantError,
  userPermissionNotFoundError,
  userRequiresAssignGroupError,
  userRequiresAssignRoleError,
  userRequiresAssignTenantError,
  userRequiresGrantDirectPermissionError,
  userRequiresTenantError,
  userRoleNotFoundError,
  userRoleTenantMismatchError,
  userTenantNotAllowedError,
  userTenantNotFoundError,
} from './errors.js';
import {
  emailExists,
  findUser,
  insertUser,
  isMemberOfTenant,
  listUsers,
  replaceGroupMemberships,
  replacePermissionAssignments,
  replaceRoleAssignments,
  replaceTenantAssignments,
  setUserActive,
  toUserDto,
  updateUserProfile,
  userGroupIds,
  userPermissionAssignments,
  userRoleAssignments,
  userTenantAssignments,
  userTenantIds,
  type PermissionAssignmentRecord,
  type RoleAssignmentRecord,
  type UserRecord,
} from './repository.js';
import {
  GLOBAL_SCOPE_KEY,
  type CreateUserInput,
  type CreateUserResultDto,
  type EffectiveAccessDto,
  type UpdateUserInput,
  type UserDto,
} from './schemas.js';

export interface UsersDeps {
  readonly db: DbClient;
  readonly authAdmin: AuthAdminPort;
  readonly loadGrantGraph: GrantGraphLoader;
}

export const USER_CREATED_ACTION = 'user.created';
export const USER_UPDATED_ACTION = 'user.updated';
export const USER_DEACTIVATED_ACTION = 'user.deactivated';
export const USER_ACTIVATED_ACTION = 'user.activated';

const ASSIGN_TENANT = 'users.assign_tenant';
const ASSIGN_ROLE = 'users.assign_role';
const ASSIGN_GROUP = 'users.assign_group';
const GRANT_DIRECT_PERMISSION = 'users.grant_direct_permission';

/**
 * F-027 confinement: resolves a user by id, or throws the uniform not-found when the caller may not
 * see them. A cross-tenant (Internal) caller sees everyone; everybody else sees only members of the
 * ambient tenant.
 */
async function requireVisibleUser(
  executor: DbExecutor,
  userId: number,
  actor: AdminActor,
): Promise<UserRecord> {
  const user = await findUser(executor, userId);
  if (user === undefined) throw userNotFoundError(userId);

  if (!actor.isCrossTenant) {
    if (actor.tenantId === null) throw userNotFoundError(userId);
    if (!(await isMemberOfTenant(executor, userId, actor.tenantId))) {
      throw userNotFoundError(userId);
    }
  }
  return user;
}

/** Every tenant in the input must be reachable by the caller AND must exist. */
async function assertTenantsAssignable(
  executor: DbExecutor,
  tenantIds: readonly number[],
  actor: AdminActor,
): Promise<void> {
  for (const tenantId of tenantIds) {
    if (!actor.isCrossTenant && tenantId !== actor.tenantId) {
      throw userTenantNotAllowedError(tenantId);
    }
    const tenant = await executor
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant === undefined) throw userTenantNotFoundError(tenantId);
  }
}

/**
 * F-028: each assignment input carries its own dedicated catalog permission, checked in the AMBIENT
 * tenant (the same scope every `requirePermission` check uses). `users.invite`/`users.edit` alone is
 * not enough to hand out access.
 */
async function assertAssignmentPermissions(
  actor: AdminActor,
  counts: {
    tenants: number;
    roles: number;
    groups: number;
    permissions: number;
  },
): Promise<void> {
  if (counts.tenants > 0 && !(await callerHoldsAmbient(actor, ASSIGN_TENANT))) {
    throw userRequiresAssignTenantError();
  }
  if (counts.roles > 0 && !(await callerHoldsAmbient(actor, ASSIGN_ROLE))) {
    throw userRequiresAssignRoleError();
  }
  if (counts.groups > 0 && !(await callerHoldsAmbient(actor, ASSIGN_GROUP))) {
    throw userRequiresAssignGroupError();
  }
  if (counts.permissions > 0 && !(await callerHoldsAmbient(actor, GRANT_DIRECT_PERMISSION))) {
    throw userRequiresGrantDirectPermissionError();
  }
}

/**
 * F-031 completeness: a group hands its members everything it conveys (direct grants UNION its
 * roles' grants), so assigning someone to an existing over-privileged group is the same escalation
 * as attaching an over-privileged role — and a cheaper one. Same ceiling, both routes.
 */
async function assertGroupsAssignable(
  executor: DbExecutor,
  groupIds: readonly number[],
  targetTenantIds: readonly number[],
  actor: AdminActor,
): Promise<void> {
  for (const groupId of groupIds) {
    const group = await findGroup(executor, groupId);
    // F-035: a group the caller cannot see answers NOT FOUND, never the 422 mismatch below —
    // otherwise the two responses form a cross-tenant existence oracle.
    if (group === undefined || !isReadAccessible(group.tenantId, actor)) {
      throw userGroupNotFoundError(groupId);
    }
    if (group.tenantId !== null && !targetTenantIds.includes(group.tenantId)) {
      throw userGroupTenantMismatchError(groupId);
    }

    for (const code of await groupConveyedPermissionCodes(executor, groupId)) {
      if (!(await callerHoldsInAllScopes(actor, code, group.tenantId, targetTenantIds))) {
        throw userPermissionExceedsCallerGrantError(code);
      }
    }
  }
}

async function assertPermissionCodesExist(
  executor: DbExecutor,
  codes: readonly string[],
): Promise<void> {
  const known = await existingPermissionCodes(executor, codes);
  for (const code of codes) {
    if (!known.has(code)) throw userPermissionNotFoundError(code);
  }
}

/* ----------------------------------------- queries ----------------------------------------- */

/** ListUsersQueryHandler — tenant-confined for ordinary callers, unrestricted for Internal ones. */
export async function listUsersForCaller(
  deps: UsersDeps,
  actor: AdminActor,
): Promise<UserDto[]> {
  const users = await listUsers(deps.db, actor.isCrossTenant ? null : actor.tenantId);

  const dtos: UserDto[] = [];
  for (const user of users) {
    dtos.push(toUserDto(user, await userTenantIds(deps.db, user.id)));
  }
  return dtos;
}

export async function getUser(
  deps: UsersDeps,
  userId: number,
  actor: AdminActor,
): Promise<UserDto> {
  const user = await requireVisibleUser(deps.db, userId, actor);
  return toUserDto(user, await userTenantIds(deps.db, userId));
}

/**
 * GetEffectiveAccessQueryHandler (FR-14, FR-15). The permission sets come from
 * `createEffectiveAccess` — T-012's engine — and are NEVER recomputed here: a second, independently
 * written union is how the view and the enforcement path drift apart.
 *
 * The grant graph is loaded ONCE and resolved per scope. The reference called its resolver inside
 * the membership loop (one query per tenant); `loadGrantGraph` is tenant-independent by design, so
 * one round trip answers every tenant plus the global scope.
 */
export async function getEffectiveAccess(
  deps: UsersDeps,
  userId: number,
  actor: AdminActor,
): Promise<EffectiveAccessDto> {
  await requireVisibleUser(deps.db, userId, actor);

  const roleAssignments = await userRoleAssignments(deps.db, userId);
  const roleNames = new Map<number, string>();
  for (const assignment of roleAssignments) {
    if (roleNames.has(assignment.roleId)) continue;
    const role = await findRole(deps.db, assignment.roleId);
    // A grant row can outlive its role only through direct SQL (there is no delete path), but the
    // reference rendered a placeholder rather than dropping the row, and dropping it would hide a
    // real grant from the view that exists to show every grant.
    roleNames.set(assignment.roleId, role?.name ?? '(deleted role)');
  }

  const groupIds = await userGroupIds(deps.db, userId);
  const groups: { groupId: number; groupName: string; tenantId: number | null }[] = [];
  for (const groupId of groupIds) {
    const group = await findGroup(deps.db, groupId);
    groups.push({
      groupId,
      groupName: group?.name ?? '(deleted group)',
      tenantId: group?.tenantId ?? null,
    });
  }

  const tenantAssignments = await userTenantAssignments(deps.db, userId);
  const graph = await deps.loadGrantGraph(userId);

  const effectivePermissionsByTenant: Record<string, string[]> = {
    [GLOBAL_SCOPE_KEY]: [...createEffectiveAccess(graph, { tenantId: null }).permissions].sort(),
  };
  for (const assignment of tenantAssignments) {
    effectivePermissionsByTenant[String(assignment.tenantId)] = [
      ...createEffectiveAccess(graph, { tenantId: toTenantId(assignment.tenantId) }).permissions,
    ].sort();
  }

  return {
    userId,
    directRoles: roleAssignments.map((assignment) => ({
      roleId: assignment.roleId,
      roleName: roleNames.get(assignment.roleId) ?? '(deleted role)',
      tenantId: assignment.tenantId,
    })),
    directPermissions: await userPermissionAssignments(deps.db, userId),
    groups,
    tenantAssignments,
    effectivePermissionsByTenant,
  };
}

/* ----------------------------------------- creation ---------------------------------------- */

export async function createUser(
  deps: UsersDeps,
  input: CreateUserInput,
  actor: AdminActor,
): Promise<CreateUserResultDto> {
  // FR-16 / AC-030: only a caller with Internal-level (`global.*`) capability may create a
  // zero-tenant user. Resolved in the GLOBAL scope, never in the ambient tenant.
  if (input.tenantIds.length === 0) {
    const globalAccess = await actor.resolveAccess(null);
    const hasGlobal = [...globalAccess.permissions].some((code) =>
      code.startsWith(GLOBAL_PERMISSION_PREFIX),
    );
    if (!hasGlobal) throw userRequiresTenantError();
  }

  if (await emailExists(deps.db, input.email, null)) {
    throw userDuplicateEmailError(input.email);
  }

  await assertTenantsAssignable(deps.db, input.tenantIds, actor);
  await assertAssignmentPermissions(actor, {
    tenants: input.tenantIds.length,
    roles: input.directRoleIds.length,
    groups: input.groupIds.length,
    permissions: input.directPermissions.length,
  });

  const roleAssignments: RoleAssignmentRecord[] = [];
  for (const roleId of input.directRoleIds) {
    const role = await findRole(deps.db, roleId);
    if (role === undefined || !isReadAccessible(role.tenantId, actor)) {
      throw userRoleNotFoundError(roleId);
    }
    if (role.tenantId !== null && !input.tenantIds.includes(role.tenantId)) {
      throw userRoleTenantMismatchError(roleId);
    }
    for (const code of await rolePermissionCodes(deps.db, roleId)) {
      if (!(await callerHoldsInAllScopes(actor, code, role.tenantId, input.tenantIds))) {
        throw userPermissionExceedsCallerGrantError(code);
      }
    }
    roleAssignments.push({ roleId, tenantId: role.tenantId });
  }

  await assertGroupsAssignable(deps.db, input.groupIds, input.tenantIds, actor);
  await assertPermissionCodesExist(deps.db, input.directPermissions);

  for (const code of input.directPermissions) {
    if (!(await callerHoldsInAllScopes(actor, code, null, input.tenantIds))) {
      throw userPermissionExceedsCallerGrantError(code);
    }
  }

  // CreateUserCommandHandler.cs:198-210: a flat permission list is materialised once per target
  // tenant, or once globally when the user has no tenants (an Internal user).
  const permissionAssignments: PermissionAssignmentRecord[] =
    input.tenantIds.length === 0
      ? input.directPermissions.map((permissionCode) => ({ permissionCode, tenantId: null }))
      : input.tenantIds.flatMap((tenantId) =>
          input.directPermissions.map((permissionCode) => ({ permissionCode, tenantId })),
        );

  // Provision the identity FIRST — the app row's auth_user_id is NOT NULL and references
  // auth.users(id), so there is no valid app row to write before this succeeds.
  let authUserId: string;
  try {
    authUserId = await deps.authAdmin.createUser({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
    });
  } catch {
    // The auth-side message is deliberately not propagated; it can echo an address.
    throw userAuthProvisioningFailedError();
  }

  let user: UserRecord;
  try {
    user = await withTransaction(deps.db, async (trx) => {
      const created = await insertUser(trx, {
        authUserId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        actorUserId: actor.userId,
      });

      await replaceTenantAssignments(trx, created.id, input.tenantIds, actor.userId);
      await replaceRoleAssignments(trx, created.id, roleAssignments, actor.userId);
      await replacePermissionAssignments(trx, created.id, permissionAssignments, actor.userId);
      await replaceGroupMemberships(trx, created.id, input.groupIds, actor.userId);

      await writeAudit(trx, {
        entityType: 'user',
        entityId: String(created.id),
        action: USER_CREATED_ACTION,
        actorUserId: actor.userId,
        tenantId: actor.tenantId,
        before: null,
        after: {
          firstName: created.firstName,
          lastName: created.lastName,
          email: created.email,
          tenantIds: [...input.tenantIds],
          directRoleIds: [...input.directRoleIds],
          directPermissions: [...input.directPermissions],
          groupIds: [...input.groupIds],
        },
        ...(actor.correlationId === undefined
          ? {}
          : { context: { correlationId: actor.correlationId } }),
      });

      return created;
    });
  } catch (error) {
    // COMPENSATION (AC-031, V-041): the transaction rolled back, so no app row exists. Remove the
    // identity too, or the address is permanently unusable — Auth would reject a retry as a
    // duplicate while the app has no record of the user at all.
    try {
      await deps.authAdmin.deleteUser(authUserId);
    } catch {
      // The original failure is the one worth reporting; a failed cleanup must not mask it.
    }
    throw error;
  }

  // Best effort, exactly as the reference's reset-password email was: a mail failure must not undo
  // a created account. Reported to the caller rather than swallowed.
  const emailSent = await deps.authAdmin.sendRecoveryEmail(user.email);

  return { userId: user.id, email: user.email, isActive: user.isActive, emailSent };
}

/* ------------------------------------------ update ----------------------------------------- */

export async function updateUser(
  deps: UsersDeps,
  userId: number,
  input: UpdateUserInput,
  actor: AdminActor,
): Promise<UserDto> {
  const user = await requireVisibleUser(deps.db, userId, actor);
  const existingTenantIds = await userTenantIds(deps.db, userId);
  const existingRoleAssignments = await userRoleAssignments(deps.db, userId);
  const existingPermissionAssignments = await userPermissionAssignments(deps.db, userId);
  const existingGroupIds = await userGroupIds(deps.db, userId);

  /*
   * F-027: a non-cross-tenant caller's `tenantIds` is restricted (below) to the ambient tenant, so
   * it expresses their intent for THAT tenant only — not the user's whole cross-tenant membership.
   * Replacing the full set wholesale would let a tenant-A admin silently strip a tenant-B
   * membership. Every other tenant's membership is preserved; only a cross-tenant caller, who
   * validated each entry itself, may replace the whole set.
   */
  const finalTenantIds = actor.isCrossTenant
    ? [...input.tenantIds]
    : [
        ...new Set([
          ...existingTenantIds.filter((tenantId) => tenantId !== actor.tenantId),
          ...input.tenantIds,
        ]),
      ];

  /*
   * F-027 EXTENDED TO ASSIGNMENTS: the replaces below are full delete-and-insert, so a
   * non-cross-tenant caller submitting only what they can see would silently strip every other
   * scope's rows — and resubmitting those rows themselves would trip the escalation ceiling they
   * cannot hold in a foreign tenant. Their payload therefore expresses intent for the AMBIENT
   * tenant only: assignments scoped to any other tenant AND global-scope (tenant_id null)
   * role/permission rows are carried over untouched. Global GROUPS stay caller-managed — a
   * membership is scope-less, the group is visible in the caller's own picker, and
   * `assertGroupsAssignable` ceiling-checks it on submit.
   */
  const preservedRoleAssignments = actor.isCrossTenant
    ? []
    : existingRoleAssignments.filter((assignment) => assignment.tenantId !== actor.tenantId);
  const preservedPermissionAssignments = actor.isCrossTenant
    ? []
    : existingPermissionAssignments.filter((assignment) => assignment.tenantId !== actor.tenantId);
  const preservedGroupIds: number[] = [];
  if (!actor.isCrossTenant) {
    for (const groupId of existingGroupIds) {
      const group = await findGroup(deps.db, groupId);
      if (group !== undefined && group.tenantId !== null && group.tenantId !== actor.tenantId) {
        preservedGroupIds.push(groupId);
      }
    }
  }

  // Self-lockout: a self-edit may change profile fields but never the caller's own assignments.
  // PUT is full-replace, so a self-edit dropping `users.edit` is irreversible by the caller.
  // Compared as FINAL sets (submitted + preserved), so resubmitting current state — or, for a
  // tenant-scoped caller, resubmitting just their own tenant's slice of it — passes.
  if (userId === actor.userId) {
    const currentRoleIds = new Set(existingRoleAssignments.map((assignment) => assignment.roleId));
    const currentPermissionCodes = new Set(
      existingPermissionAssignments.map((assignment) => assignment.permissionCode),
    );
    const currentGroupIds = new Set(existingGroupIds);

    const changed =
      !sameSet(new Set(finalTenantIds), new Set(existingTenantIds)) ||
      !sameSet(
        new Set([
          ...input.roleAssignments.map((a) => a.roleId),
          ...preservedRoleAssignments.map((a) => a.roleId),
        ]),
        currentRoleIds,
      ) ||
      !sameSet(
        new Set([
          ...input.permissionAssignments.map((a) => a.permissionCode),
          ...preservedPermissionAssignments.map((a) => a.permissionCode),
        ]),
        currentPermissionCodes,
      ) ||
      !sameSet(new Set([...input.groupIds, ...preservedGroupIds]), currentGroupIds);

    if (changed) throw userCannotChangeOwnAccessError();
  }

  await assertTenantsAssignable(deps.db, input.tenantIds, actor);
  await assertAssignmentPermissions(actor, {
    tenants: input.tenantIds.length,
    roles: input.roleAssignments.length,
    groups: input.groupIds.length,
    permissions: input.permissionAssignments.length,
  });

  const roleAssignments: RoleAssignmentRecord[] = [];
  for (const assignment of input.roleAssignments) {
    const role = await findRole(deps.db, assignment.roleId);
    if (role === undefined || !isReadAccessible(role.tenantId, actor)) {
      throw userRoleNotFoundError(assignment.roleId);
    }

    const effectiveTenantId = assignment.tenantId ?? role.tenantId;
    if (effectiveTenantId !== null) {
      if (!actor.isCrossTenant && effectiveTenantId !== actor.tenantId) {
        throw userTenantNotAllowedError(effectiveTenantId);
      }
      if (role.tenantId !== null && role.tenantId !== effectiveTenantId) {
        throw userRoleTenantMismatchError(assignment.roleId);
      }
    }

    for (const code of await rolePermissionCodes(deps.db, assignment.roleId)) {
      if (!(await callerHoldsInAllScopes(actor, code, effectiveTenantId, input.tenantIds))) {
        throw userPermissionExceedsCallerGrantError(code);
      }
    }

    roleAssignments.push({ roleId: assignment.roleId, tenantId: effectiveTenantId });
  }

  await assertPermissionCodesExist(
    deps.db,
    input.permissionAssignments.map((assignment) => assignment.permissionCode),
  );

  const permissionAssignments: PermissionAssignmentRecord[] = [];
  for (const assignment of input.permissionAssignments) {
    if (
      assignment.tenantId !== null &&
      !actor.isCrossTenant &&
      assignment.tenantId !== actor.tenantId
    ) {
      throw userTenantNotAllowedError(assignment.tenantId);
    }
    if (
      !(await callerHoldsInAllScopes(
        actor,
        assignment.permissionCode,
        assignment.tenantId,
        input.tenantIds,
      ))
    ) {
      throw userPermissionExceedsCallerGrantError(assignment.permissionCode);
    }
    permissionAssignments.push({
      permissionCode: assignment.permissionCode,
      tenantId: assignment.tenantId,
    });
  }

  await assertGroupsAssignable(deps.db, input.groupIds, input.tenantIds, actor);

  // The written (and audited) state is the validated submission PLUS the preserved foreign-scope
  // rows — mirroring exactly what `finalTenantIds` already does for memberships.
  const finalRoleAssignments = [...roleAssignments, ...preservedRoleAssignments];
  const finalPermissionAssignments = [...permissionAssignments, ...preservedPermissionAssignments];
  const finalGroupIds = [...new Set([...input.groupIds, ...preservedGroupIds])];

  return await withTransaction(deps.db, async (trx) => {
    const updated = await updateUserProfile(trx, userId, {
      firstName: input.firstName,
      lastName: input.lastName,
      actorUserId: actor.userId,
    });

    await replaceTenantAssignments(trx, userId, finalTenantIds, actor.userId);
    await replaceRoleAssignments(trx, userId, finalRoleAssignments, actor.userId);
    await replacePermissionAssignments(trx, userId, finalPermissionAssignments, actor.userId);
    await replaceGroupMemberships(trx, userId, finalGroupIds, actor.userId);

    await writeAudit(trx, {
      entityType: 'user',
      entityId: String(userId),
      action: USER_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: {
        firstName: user.firstName,
        lastName: user.lastName,
        tenantIds: existingTenantIds,
      },
      after: {
        firstName: updated.firstName,
        lastName: updated.lastName,
        tenantIds: finalTenantIds,
        roleAssignments: finalRoleAssignments.map((assignment) => ({
          roleId: assignment.roleId,
          tenantId: assignment.tenantId,
        })),
        permissionAssignments: finalPermissionAssignments.map((assignment) => ({
          permissionCode: assignment.permissionCode,
          tenantId: assignment.tenantId,
        })),
        groupIds: finalGroupIds,
      },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });

    return toUserDto(updated, finalTenantIds);
  });
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

/* ---------------------------------------- lifecycle ---------------------------------------- */

/**
 * DeactivateUserCommandHandler. `is_active = false` AND the Auth identity is banned, so the user is
 * refused both at sign-in (GoTrue) and at the API (T-011's middleware rejects an inactive app user).
 * Never a delete: the row, every assignment and every audit entry survive (AC-029).
 *
 * The database change commits BEFORE the Auth call, matching the reference's ordering
 * (DeactivateUserCommandHandler.cs:60-64). A failure of the Auth call therefore leaves a user who
 * cannot use the API but could still mint a token — which is why the failure propagates as an error
 * the administrator sees and can retry, rather than being swallowed.
 */
export async function deactivateUser(
  deps: UsersDeps,
  userId: number,
  actor: AdminActor,
): Promise<void> {
  if (userId === actor.userId) throw userCannotDeactivateSelfError();

  const user = await requireVisibleUser(deps.db, userId, actor);
  if (!user.isActive) throw userAlreadyInactiveError(userId);

  await withTransaction(deps.db, async (trx) => {
    await setUserActive(trx, userId, false, actor.userId);

    await writeAudit(trx, {
      entityType: 'user',
      entityId: String(userId),
      action: USER_DEACTIVATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { email: user.email, isActive: true },
      after: { email: user.email, isActive: false },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });

  await deps.authAdmin.setDisabled(user.authUserId, true);
}

/**
 * REACTIVATION — NO .NET REFERENCE ROUTE EXISTS, FLAGGED.
 *
 * `UserEndpoints.cs` maps deactivate and nothing else; there was no way to bring a user back
 * through the API. AC-029 and V-038 both require reactivation ("reactivation restores access",
 * `POST /api/v1/users/{id}/activate`), so the route is added here as the exact mirror of
 * deactivate: `is_active = true`, the Auth ban lifted, and its own audit action.
 *
 * PERMISSION GATE — a decision with no reference to measure: the catalog (which is FIXED, P-03) has
 * no `users.activate` code, so the route is gated on `users.deactivate`, read as the user-lifecycle
 * permission. The alternative — adding a catalog code — would change the seeded catalog, the SPA's
 * mirror, and the drift guards, which is out of this task's scope.
 */
export async function activateUser(
  deps: UsersDeps,
  userId: number,
  actor: AdminActor,
): Promise<void> {
  const user = await requireVisibleUser(deps.db, userId, actor);
  if (user.isActive) throw userAlreadyActiveError(userId);

  await withTransaction(deps.db, async (trx) => {
    await setUserActive(trx, userId, true, actor.userId);

    await writeAudit(trx, {
      entityType: 'user',
      entityId: String(userId),
      action: USER_ACTIVATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { email: user.email, isActive: false },
      after: { email: user.email, isActive: true },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });

  await deps.authAdmin.setDisabled(user.authUserId, false);
}
