/**
 * Grant-graph lookups (T-012, AC-018, V-023; P-03, spec §13).
 *
 * ONE ROUND TRIP, BY CONSTRUCTION
 * ==============================
 * All four grant paths are fetched as a single `UNION ALL` — one statement, one round trip,
 * regardless of how many roles or groups the user has. This mirrors the reference, where EF's
 * `direct.Union(viaRole).Union(viaGroupRole).Union(viaGroupDirect)` compiled to one SQL statement
 * (`EffectivePermissionResolver.cs:71-75`). The N+1 shape this avoids — fetch memberships, then
 * query each group's roles, then each role's permissions — is the obvious way to write this and is
 * why the count is asserted rather than assumed
 * (`src/server/tests/integration/rbac-repository.test.ts`).
 *
 * `UNION ALL`, not `UNION`: de-duplication happens in the resolver's `Set`, so making Postgres sort
 * to distinct rows would be wasted work. It also keeps duplicate rows visible, which is what lets
 * `source` remain meaningful for the effective-access view ("granted via group X").
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ==================================
 * It does not filter by tenant. The graph is loaded once for a user and is valid for ANY scope;
 * `computeEffectivePermissions` applies the tenant predicate. Two consequences worth being explicit
 * about:
 *
 *   - The effective-access view can answer for several tenants from one fetch.
 *   - The tenant predicate is enforced in ONE place, in pure code, covered by unit tests AND by the
 *     cross-tenant integration tests. It is not enforced here, so nothing downstream should consume
 *     `GrantGraph.grants` directly — go through the resolver.
 *
 * `forTenant()` is intentionally not used: it emits `tenant_id = $1`, whereas every predicate in
 * this model is `tenant_id is null or tenant_id = $1` (a null scope is a GLOBAL grant, not an
 * unscoped row). Using the tenant scope helper here would silently drop every global/Internal grant.
 */
import { sql } from 'kysely';

import type { GrantGraph, GrantSource, PermissionGrant, TenantScopeValue } from './types.js';
import type { DbExecutor } from '../../lib/db/index.js';

interface GrantRow {
  readonly permission_code: string;
  readonly source: GrantSource;
  /** First hop's tenant scope: the assignment (user_roles) or the group. */
  readonly scope_a: TenantScopeValue;
  /** Second hop's tenant scope: the role's own scope. `null` where the path has one hop. */
  readonly scope_b: TenantScopeValue;
  readonly path_active: boolean;
}

/**
 * A one-hop path encodes its unused second scope as `null`. That is not a special case: `null` means
 * "unconstrained/global" in the scope predicate, so an absent hop and a global hop behave
 * identically and correctly.
 */
function toGrant(row: GrantRow): PermissionGrant {
  return {
    permissionCode: row.permission_code,
    source: row.source,
    pathScopes: [row.scope_a, row.scope_b],
    pathActive: row.path_active,
  };
}

/**
 * Loads every permission grant reachable by `userId`, across all tenants and global scope.
 *
 * The caller resolves it against a scope with `computeEffectivePermissions` / `createEffectiveAccess`.
 */
export async function loadGrantGraph(db: DbExecutor, userId: number): Promise<GrantGraph> {
  // Direct grants: user_permissions has no is_active column, so a direct grant is always active
  // (EffectivePermissionResolver.cs:35-37).
  const direct = db
    .selectFrom('user_permissions as up')
    .where('up.user_id', '=', userId)
    .select([
      'up.permission_code as permission_code',
      sql<GrantSource>`'direct'`.as('source'),
      'up.tenant_id as scope_a',
      sql<TenantScopeValue>`null::bigint`.as('scope_b'),
      sql<boolean>`true`.as('path_active'),
    ]);

  // Directly-assigned roles: BOTH the assignment scope and the role's own scope must apply
  // (EffectivePermissionResolver.cs:39-47).
  const viaRole = db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .where('ur.user_id', '=', userId)
    .select([
      'rp.permission_code as permission_code',
      sql<GrantSource>`'role'`.as('source'),
      'ur.tenant_id as scope_a',
      'r.tenant_id as scope_b',
      sql<boolean>`r.is_active`.as('path_active'),
    ]);

  // Roles held through a group: the group's scope AND the role's scope, and both must be active
  // (EffectivePermissionResolver.cs:49-60). group_members is not tenant-scoped, so membership adds
  // no scope constraint of its own.
  const viaGroupRole = db
    .selectFrom('group_members as gm')
    .innerJoin('user_groups as g', 'g.id', 'gm.group_id')
    .innerJoin('group_roles as gr', 'gr.group_id', 'g.id')
    .innerJoin('roles as r', 'r.id', 'gr.role_id')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .where('gm.user_id', '=', userId)
    .select([
      'rp.permission_code as permission_code',
      sql<GrantSource>`'group_role'`.as('source'),
      'g.tenant_id as scope_a',
      'r.tenant_id as scope_b',
      sql<boolean>`(g.is_active and r.is_active)`.as('path_active'),
    ]);

  // Permissions granted straight to a group (EffectivePermissionResolver.cs:62-69).
  const viaGroupDirect = db
    .selectFrom('group_members as gm')
    .innerJoin('user_groups as g', 'g.id', 'gm.group_id')
    .innerJoin('group_permissions as gp', 'gp.group_id', 'g.id')
    .where('gm.user_id', '=', userId)
    .select([
      'gp.permission_code as permission_code',
      sql<GrantSource>`'group_direct'`.as('source'),
      'g.tenant_id as scope_a',
      sql<TenantScopeValue>`null::bigint`.as('scope_b'),
      sql<boolean>`g.is_active`.as('path_active'),
    ]);

  const rows: readonly GrantRow[] = await direct
    .unionAll(viaRole)
    .unionAll(viaGroupRole)
    .unionAll(viaGroupDirect)
    .execute();

  return { userId, grants: rows.map(toGrant) };
}

/** The shape the route guard depends on, so it can be substituted in tests without a database. */
export type GrantGraphLoader = (userId: number) => Promise<GrantGraph>;

/** Binds a loader to a database handle. */
export function createGrantGraphLoader(db: DbExecutor): GrantGraphLoader {
  return (userId) => loadGrantGraph(db, userId);
}
