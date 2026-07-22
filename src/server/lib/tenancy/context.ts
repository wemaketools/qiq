/**
 * Tenant context and route classification (T-013, AC-020, AC-021, V-025, V-026; M-05, N-01, spec §13).
 *
 * THE HEADER IS AN ASSERTION, NOT A CREDENTIAL
 * ============================================
 * `X-Tenant-Id` says which tenant the caller *wants*. It never says which tenant the caller *may*
 * have. The value is turned into a `TenantId` only after a server-side membership lookup
 * (`user_tenants`) or an explicit Internal cross-tenant grant. Spec §13: "no browser trust".
 *
 * ROUTE CLASSIFICATION IS EXPLICIT AND FAILS CLOSED
 * ================================================
 * Every `/api/v1` route is TENANT-SCOPED unless its prefix appears in `GLOBAL_ROUTE_PREFIXES`.
 * That default is the whole point: a route added tomorrow that nobody remembered to classify
 * requires a verified tenant and answers 403 without one. The dangerous alternative — defaulting to
 * "global" and requiring routes to opt *in* to tenant scoping — makes a forgotten declaration a
 * silent cross-tenant hole. A forgotten declaration here is a loud 403 instead.
 *
 * The exempt list is ported verbatim from
 * `src/api/QuoteIQ.Api/Tenancy/TenantContextMiddleware.cs:20-26` and matches spec §374
 * ("Tenant Manager (cross-tenant, global-permission-bound, no X-Tenant-Id)"). Being on this list
 * is NOT a grant of anything: those routes carry their own `requirePermission(...)` global codes.
 */
import type { TenantId } from '../db/index.js';
import { NotFoundError } from '../errors/index.js';

/** The verified tenant for one request. Only the middleware constructs this. */
export interface TenantContext {
  /** Verified — the caller is a member, or holds the Internal cross-tenant grant. */
  readonly tenantId: TenantId;
  /**
   * True when access was granted by `global.view_any_tenant` rather than by membership — this is
   * ENTRY MODE, not capability. The middleware writes an audit row for exactly these requests
   * (AC-020, spec §13), and the cross-tenant export gate keys on it (AC-084). A caller who holds
   * the grant AND a membership enters with `false`; code that needs "does the caller hold the
   * cross-tenant capability?" must resolve `global.view_any_tenant` in the global scope instead,
   * as `adminActorFrom` (rbac/admin-routes-support.ts) does.
   */
  readonly isCrossTenant: boolean;
}

export type RouteScope = 'tenant-scoped' | 'global';

/**
 * Routes that legitimately have no single tenant, ported from TenantContextMiddleware.cs:20-26:
 *   /tenants  — Tenant Manager, which operates *across* tenants (spec §374)
 *   /global   — Internal global templates / default reference items
 *   /me       — the caller's own profile, incl. the tenant list the switcher renders
 *   /intake   — the Q-19 API-key intake route, which carries its tenant in its own credential
 * `/health` is added here (it is `/api/v1/health` in this port, whereas the .NET health endpoint
 * lived outside `/api/v1` and was never reached by that middleware at all).
 */
export const GLOBAL_ROUTE_PREFIXES: readonly string[] = [
  '/api/v1/health',
  '/api/v1/tenants',
  '/api/v1/global',
  '/api/v1/me',
  '/api/v1/intake',
];

const API_PREFIX = '/api/v1';

/**
 * True when `path` IS `prefix` or a sub-path of it.
 *
 * A bare `startsWith` would exempt any sibling that merely shares the leading characters —
 * `/api/v1/tenantsummary` would inherit `/api/v1/tenants`'s exemption and become an unscoped route.
 * Ported from TenantContextMiddleware.IsExempt (:102-110), including that reasoning.
 */
function isUnderPrefix(path: string, prefix: string): boolean {
  const lowerPath = path.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerPath.startsWith(lowerPrefix)) return false;
  return lowerPath.length === lowerPrefix.length || lowerPath[lowerPrefix.length] === '/';
}

/** Trailing slashes are not significant; `/api/v1/leads/` classifies like `/api/v1/leads`. */
export function normalizeRoutePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Classifies a request path. Anything outside `/api/v1` is `global` (the middleware leaves it
 * alone, matching RequiresTenantContext at :86-94); inside it, anything not explicitly exempt is
 * tenant-scoped.
 */
export function classifyRoute(path: string): RouteScope {
  const normalized = normalizeRoutePath(path);
  if (!isUnderPrefix(normalized, API_PREFIX)) return 'global';
  return GLOBAL_ROUTE_PREFIXES.some((prefix) => isUnderPrefix(normalized, prefix))
    ? 'global'
    : 'tenant-scoped';
}

/** Convenience inverse of `classifyRoute`, mirroring the reference's method name. */
export function requiresTenantContext(path: string): boolean {
  return classifyRoute(path) === 'tenant-scoped';
}

/**
 * The single client-visible message for a not-found OR cross-tenant id (N-01, AC-021).
 *
 * Deliberately says nothing about which entity was asked for beyond its type, and NOTHING about
 * whether a row with that id exists in some other tenant. Two callers — one asking for a genuinely
 * nonexistent id, one asking for a real id belonging to another tenant — must receive byte-identical
 * bodies, or the 404 becomes an existence oracle that enumerates another tenant's primary keys.
 */
export function notFoundMessage(entityType: string): string {
  return `${entityType} not found.`;
}

/**
 * Narrows a repository result to a present value, or throws the uniform 404.
 *
 * Correct use depends on the lookup having ALREADY been tenant-scoped (`forTenant(db, tenantId)`),
 * so a cross-tenant row arrives here as `undefined` — identical to a nonexistent one. That is what
 * makes the two cases indistinguishable *by construction* rather than by remembering to compare
 * strings: there is no branch here that could tell them apart even if it wanted to.
 */
export function requireFound<T>(value: T | null | undefined, entityType: string): T {
  if (value === null || value === undefined) {
    throw new NotFoundError(notFoundMessage(entityType));
  }
  return value;
}
