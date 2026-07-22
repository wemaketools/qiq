/**
 * Shared administration context and privilege-escalation guards for the User Manager surface
 * (T-017; AC-029, AC-030; P-03, spec §12.2, §13).
 *
 * Ports three .NET helpers that every Users/Roles/Groups handler leaned on:
 *
 *   src/api/QuoteIQ.Application/Abstractions/TenantConfinement.cs  -> isReadAccessible / isWriteAccessible
 *   src/api/QuoteIQ.Application/Security/AssignmentGuard.cs        -> AssignmentGuard
 *   src/api/QuoteIQ.Application/Security/SelfLockout.cs            -> isAccessAdminCode / callerHoldsRole
 *
 * WHY THE ACTOR CARRIES ITS OWN RESOLVER
 * =====================================
 * The reference injected `IEffectivePermissionResolver` + `ICurrentUser` + `ITenantContext` as
 * request-scoped DI services. None of those can be ambient here: a warm Vercel instance is shared
 * across invocations, so an ambient "current user"/"current tenant" is one async-context bug away
 * from evaluating one caller's escalation ceiling against another caller's grants (the same reason
 * `writeAudit` takes an explicit actor — see domains/audit/writer.ts). The route therefore builds an
 * `AdminActor` from its VERIFIED request context and hands it down explicitly.
 *
 * `resolveAccess` is the very resolver `permissionResolution()` installed (lib/auth/require-permission.ts):
 * per-request, memoized per scope, and never shared. Reusing it rather than issuing fresh grant-graph
 * queries here is what keeps "what the route guard checked" and "what the escalation ceiling checks"
 * the same computation — two independently-written permission resolutions are how they drift.
 *
 * TENANT ISOLATION HAS NO NET UNDERNEATH IT
 * =========================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20), and `roles`/`user_groups` are
 * global/unpartitioned tables with a NULLABLE `tenant_id` (20260718001200_rbac.sql), so there is no
 * `forTenant(...)` narrowing available for them either. Every by-id handler in this domain MUST call
 * `isReadAccessible` / `isWriteAccessible` explicitly, and must translate a `false` into the SAME
 * not-found error a genuinely missing id produces (spec §14: cross-tenant existence must not be
 * probeable). There is nothing below this file that would catch a forgotten check.
 */
import type { EffectiveAccessResolver } from '../../lib/auth/require-permission.js';
import { toTenantId } from '../../lib/db/index.js';

/** The `global.manage_global_defaults` gate on mutating GLOBAL (tenant_id null) roles/groups. */
export const MANAGE_GLOBAL_DEFAULTS = 'global.manage_global_defaults';

/** The `global.` prefix test CreateUser used to decide whether a zero-tenant user is permitted. */
export const GLOBAL_PERMISSION_PREFIX = 'global.';

/**
 * Everything a User Manager handler needs to know about who is acting, resolved from the request's
 * verified auth + tenant context. Never reconstructed from anything the browser sent.
 */
export interface AdminActor {
  /** Application `users.id` of the caller. */
  readonly userId: number;
  /** The VERIFIED ambient tenant, or null on a route with no tenant context. */
  readonly tenantId: number | null;
  /**
   * True when the caller HOLDS the Internal cross-tenant capability — `global.view_any_tenant` as
   * a GLOBAL grant — whether or not they are also a member of the ambient tenant. NOT the same as
   * `TenantContext.isCrossTenant`, which records how the caller ENTERED the tenant and stays false
   * for a member; `adminActorFrom` resolves the grant itself so a membership cannot lower what the
   * grant permits.
   */
  readonly isCrossTenant: boolean;
  /** The per-request effective-permission resolver installed by `permissionResolution()`. */
  readonly resolveAccess: EffectiveAccessResolver;
  readonly correlationId?: string;
}

/** Resolves the caller's permission set in a tenant scope; `null` is the GLOBAL scope. */
async function permissionsIn(
  actor: AdminActor,
  tenantId: number | null,
): Promise<ReadonlySet<string>> {
  const access = await actor.resolveAccess(tenantId === null ? null : toTenantId(tenantId));
  return access.permissions;
}

/** Does the caller hold `code` in `tenantId` (null = global scope)? */
export async function callerHolds(
  actor: AdminActor,
  code: string,
  tenantId: number | null,
): Promise<boolean> {
  return (await permissionsIn(actor, tenantId)).has(code);
}

/** Does the caller hold `code` in the AMBIENT tenant? (`AssignmentGuard.CallerHoldsAmbientAsync`) */
export async function callerHoldsAmbient(actor: AdminActor, code: string): Promise<boolean> {
  return await callerHolds(actor, code, actor.tenantId);
}

/**
 * Grant-no-higher-than-self (`AssignmentGuard.CallerHoldsInAllScopesAsync`, AssignmentGuard.cs:818-843).
 *
 * When `entityTenantId` is non-null (a tenant-scoped role/group, or a per-assignment tenant) only
 * that tenant is checked. When it is null (a GLOBAL role/group, or a flat permission applied across
 * every target tenant) the caller must hold the code in EVERY `targetTenantIds` entry — or, when
 * that list is empty, globally.
 *
 * A caller whose own grant is global satisfies every per-tenant check automatically, because
 * `computeEffectivePermissions` already unions global rows into each tenant-scoped result. No
 * cross-tenant carve-out is needed, and adding one would widen the ceiling.
 */
export async function callerHoldsInAllScopes(
  actor: AdminActor,
  code: string,
  entityTenantId: number | null,
  targetTenantIds: readonly number[],
): Promise<boolean> {
  if (entityTenantId !== null) return await callerHolds(actor, code, entityTenantId);
  if (targetTenantIds.length === 0) return await callerHolds(actor, code, null);

  for (const tenantId of targetTenantIds) {
    if (!(await callerHolds(actor, code, tenantId))) return false;
  }
  return true;
}

/**
 * READ-path confinement (TenantConfinement.IsAccessible): a GLOBAL row (tenant_id null) is readable
 * by everyone — spec §12.4, tenants see and use Internal-managed global defaults — and a
 * tenant-scoped row only by a cross-tenant caller or a member of that tenant.
 */
export function isReadAccessible(entityTenantId: number | null, actor: AdminActor): boolean {
  return (
    entityTenantId === null || actor.isCrossTenant || entityTenantId === actor.tenantId
  );
}

/**
 * WRITE-path confinement (TenantConfinement.IsWriteAccessibleAsync, F-032). Same rule for a
 * tenant-scoped row; a GLOBAL row may be MUTATED only by a cross-tenant caller or one holding
 * `global.manage_global_defaults`. Reads treating global rows as universally visible must not make
 * a tenant-scoped `roles.manage` admin able to rename or re-permission an Internal-managed default.
 */
export async function isWriteAccessible(
  entityTenantId: number | null,
  actor: AdminActor,
): Promise<boolean> {
  if (entityTenantId !== null) {
    return actor.isCrossTenant || entityTenantId === actor.tenantId;
  }
  if (actor.isCrossTenant) return true;
  return await callerHolds(actor, MANAGE_GLOBAL_DEFAULTS, null);
}

/**
 * Self-lockout policy (SelfLockout.IsAccessAdminCode): the categories that let an administrator
 * operate the User Manager at all. No caller may take an action whose direct effect is stripping
 * these from themselves — a de-permissioned admin cannot undo their own mistake.
 */
export function isAccessAdminCode(code: string): boolean {
  return (
    code.startsWith('users.') || code.startsWith('roles.') || code.startsWith('groups.')
  );
}
