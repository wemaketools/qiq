/**
 * The eligible-assignee reverse lookup (T-020 amended scope, AC-022, AC-038).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Security/EligibleAssigneeReader.cs`.
 *
 * THIS IS THE INVERSE OF THE PERMISSION RESOLVER, WHICH IS WHY IT IS ITS OWN QUERY
 * ===============================================================================
 * `rbac/effective-permissions.ts` answers "what may THIS user do"; these two functions answer
 * "WHICH users may do this" across every member of a tenant. The reference makes exactly this point
 * (IEligibleAssigneeReader.cs:10-13) and notes that no reverse-lookup seam existed before. The two
 * must agree on the grant paths or a picker will offer a user the workflow then refuses — so the
 * union below is a deliberate mirror of the resolver's paths, and is asserted branch by branch in
 * `business-assignments.test.ts` rather than assumed.
 *
 * NONE OF THESE TABLES CAN BE `forTenant(...)`-SCOPED, AND THAT IS THE HAZARD
 * ==========================================================================
 * `users`, `user_roles`, `user_permissions`, `user_groups`, `group_members`, `group_roles` and
 * `group_permissions` are global/unpartitioned. Four of them carry a NULLABLE `tenant_id` (a grant
 * may be global or tenant-scoped) and three carry none at all — `group_roles` and
 * `group_permissions` inherit their tenant from the OWNING GROUP, so their tenant predicate has to
 * be written against `user_groups.tenant_id`. `forTenant` emits `tenant_id = $1`, which would both
 * fail to compile against the latter and silently drop every GLOBAL grant from the former.
 *
 * So every predicate here is explicit, exactly as `rbac/admin-repository.ts` documents for the same
 * reason. With RLS not adopted (spec Q-10, human decision 2026-07-20) there is NOTHING beneath
 * them. The one that matters most is the `user_tenants` membership filter in `resolveEligibleUsers`:
 * without it this reader answers "who holds this role anywhere", and the Assign dialog of tenant A
 * would offer — and then accept — a member of tenant B as the accountable owner of tenant A's
 * leads. That is an authorization leak, not merely a disclosure one, and it has its own test.
 */
import { sql } from 'kysely';

import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import type { EligibleAssigneeDto } from './schemas.js';

/**
 * A candidate-user-id subquery: the union of the grant paths for a role or for a permission. Kept
 * as a BUILDER rather than a materialised id array so it lands as a single `IN (subquery)` —
 * fetching the ids first would be an extra round trip and would grow unboundedly with tenant size.
 */
type CandidateUserIdQuery =
  | ReturnType<typeof candidateIdsHoldingRole>
  | ReturnType<typeof candidateIdsHoldingPermission>;

interface EligibleUserRow {
  readonly id: number;
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
}

function toDto(row: EligibleUserRow): EligibleAssigneeDto {
  return {
    userId: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
  };
}

/**
 * `EligibleAssigneeReader.ResolveEligibleUsersAsync` (:86-116): narrow a candidate-id set to the
 * active members of one tenant, optionally name/email-filtered, ordered by first then last name.
 *
 * THE SEARCH IS `IsNullOrWhiteSpace`-GUARDED (:101), NOT MERELY NULL-GUARDED. A whitespace-only
 * term must be treated as "no filter" — building `%   %` from it would match nothing and silently
 * empty the dropdown, which reads as "there are no eligible users" rather than as a bad search.
 *
 * `%` and `_` inside the term keep their LIKE-wildcard meaning, exactly as the reference's
 * `$"%{search.Trim()}%"` did. That is a preserved quirk, not an injection risk — the term is a
 * bound parameter throughout.
 */
async function resolveEligibleUsers(
  executor: DbExecutor,
  tenantId: TenantId,
  candidateUserIds: CandidateUserIdQuery,
  search: string | null,
): Promise<EligibleAssigneeDto[]> {
  let query = executor
    .selectFrom('users')
    .select(['id', 'first_name', 'last_name', 'email'])
    // `u.IsActive` (:96): a deactivated user must never be offered as an assignee.
    .where('is_active', '=', true)
    .where('id', 'in', candidateUserIds)
    // The membership narrowing (:89-98) — see this file's header for why it is load-bearing.
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('user_tenants')
          .select('user_tenants.user_id')
          .whereRef('user_tenants.user_id', '=', 'users.id')
          .where('user_tenants.tenant_id', '=', tenantId),
      ),
    );

  if (search !== null && search.trim().length > 0) {
    const pattern = `%${search.trim()}%`;
    query = query.where(({ eb, or }) =>
      or([
        eb('first_name', 'ilike', pattern),
        eb('last_name', 'ilike', pattern),
        // `email` is citext, so ILIKE is redundant on it but harmless — and it keeps the three
        // branches identical rather than making one column look special.
        eb(sql<string>`users.email::text`, 'ilike', pattern),
      ]),
    );
  }

  const rows = await query.orderBy('first_name').orderBy('last_name').execute();
  // `.Distinct()` (:112) is a no-op in this shape and deliberately not reproduced: the candidate
  // set is applied as a subquery `IN`, which cannot duplicate a `users` row the way a JOIN would.
  // The "appears exactly once when several grant paths apply" test pins the OUTCOME, so a future
  // rewrite that reintroduces a join has to keep it true rather than merely keep the keyword.
  return rows.map((row) => toDto(row as EligibleUserRow));
}

/**
 * `GetUsersHoldingRoleAsync`'s candidate union (:28-40): the role held DIRECTLY, or via membership
 * of an ACTIVE group that carries it.
 *
 * NOTE WHAT IS *NOT* CHECKED, PORTED AS MEASURED: the ROLE's own `is_active`. The permission
 * variant below checks `r.IsActive` on every path (:57,:70), but the role variant does not — so a
 * role deactivated AFTER being configured into a slot still yields its holders here. The slot PUT
 * rejects an inactive role (service.ts), so this is only reachable by deactivating a role that is
 * already slotted. Preserved rather than silently tightened, because tightening it would empty a
 * tenant's Assign dialog with no error to explain why. Flagged in the task file.
 */
function candidateIdsHoldingRole(executor: DbExecutor, roleId: number, tenantId: TenantId) {
  const direct = executor
    .selectFrom('user_roles')
    .select('user_id')
    .where('role_id', '=', roleId)
    // A grant may be GLOBAL (tenant_id null) or scoped to this tenant (:30).
    .where(({ eb, or }) => or([eb('tenant_id', 'is', null), eb('tenant_id', '=', tenantId)]));

  const viaGroup = executor
    .selectFrom('group_members')
    .innerJoin('user_groups', 'user_groups.id', 'group_members.group_id')
    .innerJoin('group_roles', 'group_roles.group_id', 'user_groups.id')
    .select('group_members.user_id')
    .where('group_roles.role_id', '=', roleId)
    .where('user_groups.is_active', '=', true)
    // group_roles has no tenant_id of its own: the group owns the tenant scope (:37).
    .where(({ eb, or }) =>
      or([eb('user_groups.tenant_id', 'is', null), eb('user_groups.tenant_id', '=', tenantId)]),
    );

  return direct.union(viaGroup);
}

/**
 * `GetUsersHoldingPermissionAsync`'s candidate union (:46-81) — FOUR grant paths, and every one of
 * them is separately reachable in production:
 *
 *   1. direct `user_permissions`
 *   2. a role the user holds that carries the permission
 *   3. a group the user is in whose ROLE carries the permission
 *   4. a group the user is in that carries the permission DIRECTLY
 *
 * Dropping any single branch leaves a reader that still looks right on most fixtures, which is why
 * each branch has its own test with its own fixture user.
 */
function candidateIdsHoldingPermission(
  executor: DbExecutor,
  permissionCode: string,
  tenantId: TenantId,
) {
  const direct = executor
    .selectFrom('user_permissions')
    .select('user_id')
    .where('permission_code', '=', permissionCode)
    .where(({ eb, or }) =>
      or([
        eb('user_permissions.tenant_id', 'is', null),
        eb('user_permissions.tenant_id', '=', tenantId),
      ]),
    );

  const viaRole = executor
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .innerJoin('role_permissions', 'role_permissions.role_id', 'roles.id')
    .select('user_roles.user_id')
    .where('role_permissions.permission_code', '=', permissionCode)
    .where('roles.is_active', '=', true)
    .where(({ eb, or }) =>
      or([eb('user_roles.tenant_id', 'is', null), eb('user_roles.tenant_id', '=', tenantId)]),
    )
    .where(({ eb, or }) =>
      or([eb('roles.tenant_id', 'is', null), eb('roles.tenant_id', '=', tenantId)]),
    );

  const viaGroupRole = executor
    .selectFrom('group_members')
    .innerJoin('user_groups', 'user_groups.id', 'group_members.group_id')
    .innerJoin('group_roles', 'group_roles.group_id', 'user_groups.id')
    .innerJoin('roles', 'roles.id', 'group_roles.role_id')
    .innerJoin('role_permissions', 'role_permissions.role_id', 'roles.id')
    .select('group_members.user_id')
    .where('role_permissions.permission_code', '=', permissionCode)
    .where('user_groups.is_active', '=', true)
    .where('roles.is_active', '=', true)
    .where(({ eb, or }) =>
      or([eb('user_groups.tenant_id', 'is', null), eb('user_groups.tenant_id', '=', tenantId)]),
    )
    .where(({ eb, or }) =>
      or([eb('roles.tenant_id', 'is', null), eb('roles.tenant_id', '=', tenantId)]),
    );

  const viaGroupDirect = executor
    .selectFrom('group_members')
    .innerJoin('user_groups', 'user_groups.id', 'group_members.group_id')
    .innerJoin('group_permissions', 'group_permissions.group_id', 'user_groups.id')
    .select('group_members.user_id')
    .where('group_permissions.permission_code', '=', permissionCode)
    .where('user_groups.is_active', '=', true)
    .where(({ eb, or }) =>
      or([eb('user_groups.tenant_id', 'is', null), eb('user_groups.tenant_id', '=', tenantId)]),
    );

  return direct.union(viaRole).union(viaGroupRole).union(viaGroupDirect);
}

/** `IEligibleAssigneeReader.GetUsersHoldingRoleAsync` (:18-19). */
export async function listUsersHoldingRole(
  executor: DbExecutor,
  roleId: number,
  tenantId: TenantId,
  search: string | null,
): Promise<EligibleAssigneeDto[]> {
  return await resolveEligibleUsers(
    executor,
    tenantId,
    candidateIdsHoldingRole(executor, roleId, tenantId),
    search,
  );
}

/** `IEligibleAssigneeReader.GetUsersHoldingPermissionAsync` (:22-23). */
export async function listUsersHoldingPermission(
  executor: DbExecutor,
  permissionCode: string,
  tenantId: TenantId,
  search: string | null,
): Promise<EligibleAssigneeDto[]> {
  return await resolveEligibleUsers(
    executor,
    tenantId,
    candidateIdsHoldingPermission(executor, permissionCode, tenantId),
    search,
  );
}
