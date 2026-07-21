/**
 * The effective-permission resolver (T-012, AC-018, V-022; P-03, spec §13 AuthZ).
 *
 * PURE BY CONSTRUCTION: no database handle, no clock, no request context, no I/O. It takes a grant
 * graph (repository.ts loads one) and a scope, and returns a set. That is what makes the scoping
 * rule — the part that leaks tenant data when it is wrong — exhaustively unit-testable, and it is
 * the single source of truth shared by the route guard and the User Manager effective-access view.
 *
 * Ported from `src/api/QuoteIQ.Infrastructure/Security/EffectivePermissionResolver.cs`. The union of
 * the four grant paths lives in the repository query; the SCOPE PREDICATE lives here.
 *
 * CACHING (N-02): there is deliberately no cache in this module and no module-level state at all.
 * The .NET resolver memoized per (user, tenant) in a request-scoped DI instance
 * (EffectivePermissionResolver.cs:20,29-33,78) — safe there because the container was per request.
 * On Vercel a module-level map outlives the request and is shared by every subsequent invocation on
 * a warm instance, so the same memo would serve one user's permissions to another. The equivalent
 * per-request memo lives in `lib/auth/require-permission.ts`, created inside the request closure.
 */
import {
  VISIBILITY_BREADTH_PERMISSIONS,
  type PermissionCode,
  type VisibilityDomain,
} from './permission-catalog.js';
import type { GrantGraph, PermissionScope, TenantScopeValue } from './types.js';
import type { TenantId } from '../../lib/db/index.js';

/**
 * One hop's scope test, ported from `(x.TenantId == null || x.TenantId == tenantId)`.
 *
 * `null` scope = global, applies everywhere. Otherwise the scope must equal the requested tenant —
 * and when the requested scope is itself global (`tenantId === null`), that equality can only be
 * satisfied by another global row, which is exactly how an Internal user with no tenant memberships
 * resolves global grants and nothing else.
 */
function scopeApplies(scope: TenantScopeValue, tenantId: TenantId | null): boolean {
  return scope === null || scope === tenantId;
}

/** True when every hop on the grant path is in scope and no role/group on it is disabled. */
function grantApplies(
  grant: { readonly pathScopes: readonly TenantScopeValue[]; readonly pathActive: boolean },
  tenantId: TenantId | null,
): boolean {
  return grant.pathActive && grant.pathScopes.every((scope) => scopeApplies(scope, tenantId));
}

/**
 * The effective permission set for `scope`: the union of every grant path whose scopes all apply.
 *
 * Returns a FROZEN set — callers (including the guard) must not be able to widen a resolved set.
 */
export function computeEffectivePermissions(
  graph: GrantGraph,
  scope: PermissionScope,
): ReadonlySet<string> {
  const effective = new Set<string>();

  for (const grant of graph.grants) {
    if (grantApplies(grant, scope.tenantId)) {
      effective.add(grant.permissionCode);
    }
  }

  return freezeSet(effective);
}

/**
 * A resolved set becomes read-only rather than merely typed read-only: `ReadonlySet` is erased at
 * runtime, so a single `(set as Set<string>).add(...)` anywhere downstream would silently escalate
 * privilege. Mutators are replaced with throwing stubs so that attempt fails loudly instead.
 */
function freezeSet(set: Set<string>): ReadonlySet<string> {
  const reject = (): never => {
    throw new TypeError('An effective permission set is immutable once resolved.');
  };
  return Object.freeze(
    Object.assign(set, { add: reject, delete: reject, clear: reject }),
  ) as ReadonlySet<string>;
}

/**
 * The resolved authorization capability for one (user, tenant) pair.
 *
 * This — not the bare `Set` — is what routes, query filters and the effective-access view consume,
 * so that "may the caller do X" and "how much may the caller see" are asked in one vocabulary.
 */
export interface EffectiveAccess {
  /** The scope this was resolved for; `null` is the global/Internal scope. */
  readonly tenantId: TenantId | null;
  /** The raw union, for serialization (GET /me, effective-access view). */
  readonly permissions: ReadonlySet<string>;
  /** Operation check. Typed to the catalog, so an invented code will not compile. */
  has(permission: PermissionCode): boolean;
  /**
   * RECORD-LEVEL VISIBILITY BREADTH (P-03/P-08) — the seam the later query-filter tasks consume.
   *
   * The reference threaded a `callerHasViewAll` boolean from the permission set into every
   * dashboard/search/export store (`DrillCallerContext.cs:9`, `GetDrillQueryHandler.cs:45`,
   * `ExportDrillQueryHandler.cs:54`, `ILeadStore.cs:51`). Repository functions here should take the
   * same boolean, obtained from this method — NOT a `has('leads.view_all')` string check repeated
   * at each call site, and NOT an `EffectiveAccess` parameter, which would let a store decide its
   * own filtering rule.
   *
   * `false` means "own records only"; `true` means "every record in the tenant".
   */
  canViewAll(domain: VisibilityDomain): boolean;
}

/** Resolves a grant graph into the capability object described above. */
export function createEffectiveAccess(graph: GrantGraph, scope: PermissionScope): EffectiveAccess {
  const permissions = computeEffectivePermissions(graph, scope);

  return {
    tenantId: scope.tenantId,
    permissions,
    has: (permission) => permissions.has(permission),
    canViewAll: (domain) => permissions.has(VISIBILITY_BREADTH_PERMISSIONS[domain]),
  };
}
