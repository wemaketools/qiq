/**
 * Effective-permission domain types (T-012, P-03, spec §13 AuthZ).
 *
 * WHY THE GRANT GRAPH CARRIES SCOPES INSTEAD OF PRE-FILTERED CODES
 * ===============================================================
 * The .NET reference (`EffectivePermissionResolver.cs`) pushed every tenant/active predicate into
 * SQL and returned a bare list of codes. Ported literally, the "pure resolution module" this task
 * asks for would be a one-line union whose unit tests could not fail — the interesting logic (which
 * grants are in scope) would live in a query no unit test can see.
 *
 * So the split is drawn one layer lower: the repository fetches the user's grants *with* the tenant
 * scopes and active flags of every hop on the grant path, and `computeEffectivePermissions` applies
 * the scoping rule. The rule is then covered twice — by unit tests over the graph and by
 * integration tests over real rows — and deleting the tenant predicate fails both.
 *
 * THE SCOPING RULE, PORTED VERBATIM
 * =================================
 * Each grant path in the reference is guarded by one predicate per hop, of the form
 * `(x.TenantId == null || x.TenantId == tenantId)`, plus `IsActive` on roles and groups:
 *
 *   direct       user_permissions.tenant_id                            (EffectivePermissionResolver.cs:35-37)
 *   role         user_roles.tenant_id AND roles.tenant_id, roles.is_active            (:39-47)
 *   group_role   user_groups.tenant_id AND roles.tenant_id, both is_active            (:49-60)
 *   group_direct user_groups.tenant_id, user_groups.is_active                         (:62-69)
 *
 * `pathScopes` is therefore a LIST — a grant reached through a group-assigned role must satisfy the
 * group's scope *and* the role's scope, and collapsing the two into one value would silently widen
 * access. `pathActive` is the conjunction of the `is_active` flags on the same path.
 *
 * Note the asymmetries, which are the reference's behaviour and not oversights:
 *   - `user_permissions` has no `is_active` column, so a direct grant is always active.
 *   - `group_members` is not tenant-scoped, so membership itself contributes no scope constraint.
 */
import type { TenantId } from '../../lib/db/index.js';

/** Which of the four grant paths conferred a permission. Diagnostic; never affects the union. */
export type GrantSource = 'direct' | 'role' | 'group_role' | 'group_direct';

/**
 * A tenant scope on a grant path. `null` means the row is GLOBAL (Internal scope) and applies in
 * every tenant — the `x.TenantId == null` half of the reference predicate.
 */
export type TenantScopeValue = number | null;

/** One permission grant, with every scope constraint on the path that produced it. */
export interface PermissionGrant {
  readonly permissionCode: string;
  readonly source: GrantSource;
  /** Every hop's tenant scope. ALL must be satisfied for the grant to apply. */
  readonly pathScopes: readonly TenantScopeValue[];
  /** Conjunction of the `is_active` flags on the path (roles/groups). */
  readonly pathActive: boolean;
}

/**
 * Everything the resolver needs about one user, loaded in a single round trip and valid for ANY
 * tenant scope. Loading it once per request and resolving it per tenant is what lets the
 * effective-access view answer for several tenants without re-querying.
 */
export interface GrantGraph {
  /** Application `users.id`. */
  readonly userId: number;
  readonly grants: readonly PermissionGrant[];
}

/**
 * The scope a grant graph is resolved against.
 *
 * `tenantId: null` is the GLOBAL scope, and is a real, reachable case rather than a placeholder: an
 * Internal user with zero tenant memberships resolves here, and under the rule below only grants
 * whose every hop is global apply. It is also what a request carries before the tenant-context
 * middleware (T-013) has selected a tenant.
 */
export interface PermissionScope {
  readonly tenantId: TenantId | null;
}
