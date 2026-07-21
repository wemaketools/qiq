/**
 * Declarative per-route permission guard (T-012, AC-019, V-024; M-05, spec §13 AuthZ).
 *
 * Port of `src/api/QuoteIQ.Api/Auth/RequirePermissionFilter.cs` and its
 * `.RequirePermission("code")` endpoint extension. Usage is the same shape:
 *
 *     leads.get('/:id', requirePermission('leads.view'), handler);
 *
 * STATUS CODES — MEASURED FROM THE REFERENCE, NOT INTUITED
 * =======================================================
 * The reference filter did four things in order, and the split of 401 vs 403 across them is the
 * opposite of what "authenticated but unauthorized => 403" would suggest:
 *
 *   no subject claim                 -> 401   (RequirePermissionFilter.cs:35-38)
 *   no `users` row for the subject   -> 401   (:40-44, pinned by RequirePermissionTests.cs:90)
 *   user row exists but !IsActive    -> 401   (:40-44, pinned by RequirePermissionTests.cs:109)
 *   resolved ACTIVE user, no grant   -> 403   (:51-54, pinned by RequirePermissionTests.cs:69)
 *
 * The first three are already the authentication middleware's job (T-011 ported them there), so
 * what remains here is the fourth — plus a defensive 401, with the reference's exact wording, for
 * the case where no principal reached this middleware at all.
 *
 * The 403 detail is verbatim from `ForbiddenProblem` (:65-69): `Missing required permission 'x'.`
 * It names the permission and nothing else — no resource, no id, no hint whether the target exists.
 *
 * CACHING (N-02) — THE PART THAT MUST NOT BE "OPTIMIZED"
 * =====================================================
 * The reference memoized resolved permission sets in a request-scoped DI instance
 * (EffectivePermissionResolver.cs:20,29-33). That is safe under a per-request container and is NOT
 * safe here: a Vercel instance is reused across invocations, so anything cached at module scope
 * outlives the request and would serve one user's — or one tenant's — permissions to the next
 * caller. The memo below is therefore created INSIDE the middleware closure, per request. There is
 * no module-level state in this file, and there must never be: the same permission set is
 * recomputed on the next request even if the same user calls twice in the same millisecond.
 *
 * Within one request the memo still does real work: a route carrying several `requirePermission`
 * guards, or a handler that also asks for visibility breadth, hits the database once.
 */
import type { MiddlewareHandler } from 'hono';

import {
  createEffectiveAccess,
  type EffectiveAccess,
} from '../../domains/rbac/effective-permissions.js';
import type { PermissionCode } from '../../domains/rbac/permission-catalog.js';
import type { GrantGraphLoader } from '../../domains/rbac/repository.js';
import { parseInt8, toTenantId, type TenantId } from '../db/index.js';
import { ForbiddenError, InternalError, UnauthorizedError } from '../errors/index.js';
import type { ApiEnv } from '../router/env.js';
import { NO_ACTIVE_USER_MESSAGE } from './middleware.js';

/** Resolves the caller's effective access for a scope. `null` is the global/Internal scope. */
export type EffectiveAccessResolver = (tenantId: TenantId | null) => Promise<EffectiveAccess>;

export interface PermissionResolutionDeps {
  readonly loadGrantGraph: GrantGraphLoader;
}

/**
 * Installs the per-request effective-permission resolver. Mount once, after `authenticate()` and
 * after the tenant-context middleware (T-013), so both the user and the tenant are known by the
 * time a route guard asks.
 */
export function permissionResolution(
  deps: PermissionResolutionDeps,
): MiddlewareHandler<ApiEnv> {
  return async function permissionResolutionMiddleware(c, next) {
    // Per-request memo, keyed by scope. Declared here — inside the handler — so it is unreachable
    // from any other request and is garbage-collected with this one.
    const memo = new Map<number | 'global', Promise<EffectiveAccess>>();

    const resolve: EffectiveAccessResolver = async (tenantId) => {
      const key = tenantId ?? 'global';
      let pending = memo.get(key);
      if (pending === undefined) {
        const auth = c.get('auth');
        if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);
        // Memoize the PROMISE, not the result: two guards on one route run sequentially today, but
        // caching the promise makes a concurrent pair share the single query rather than race.
        pending = deps
          .loadGrantGraph(parseInt8(auth.userId))
          .then((graph) => createEffectiveAccess(graph, { tenantId }));
        memo.set(key, pending);
      }
      return await pending;
    };

    c.set('resolveAccess', resolve);

    await next();
  };
}

/**
 * The required permission is recorded on the middleware function so the route-table sweep (V-024)
 * can prove every registered route declares one, rather than trusting a hand-maintained list.
 */
const REQUIRED_PERMISSION = Symbol.for('quoteiq.requiredPermission');

interface PermissionTaggedHandler {
  [REQUIRED_PERMISSION]?: PermissionCode;
}

/** Reads the permission a handler was created with, if any. Used by the AC-019 route sweep. */
export function getRequiredPermission(handler: unknown): PermissionCode | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as PermissionTaggedHandler)[REQUIRED_PERMISSION];
}

/**
 * Gates a route behind one permission code.
 *
 * `permission` is typed to the seeded catalog (`PermissionCode`), so a typo is a compile error
 * rather than a route that quietly denies everyone — the failure mode a `string` parameter invites.
 */
export function requirePermission(permission: PermissionCode): MiddlewareHandler<ApiEnv> {
  const guard: MiddlewareHandler<ApiEnv> = async function requirePermissionMiddleware(c, next) {
    // Defensive parity with RequirePermissionFilter.cs:35-38. Under the composed pipeline the
    // authentication middleware has already rejected an anonymous caller, so reaching this line
    // means a misordered mount; answering 401 keeps the client-visible contract identical either way.
    if (c.get('auth') === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

    const resolveAccess = c.get('resolveAccess');
    if (resolveAccess === undefined) {
      // FAIL CLOSED. A missing resolver is a composition bug (permissionResolution() not mounted),
      // and the one thing this must never do is treat "cannot evaluate" as "allowed".
      throw new InternalError(
        'permissionResolution() middleware is not mounted; cannot evaluate route permissions.',
      );
    }

    const access = await resolveAccess(tenantScopeOf(c.get('tenantId')));

    if (!access.has(permission)) {
      c.get('logger').warn('permission denied', {
        route: `${c.req.method} ${c.req.path}`,
        requiredPermission: permission,
        // The permission set itself is deliberately NOT logged: it is the caller's full
        // authorization profile and has no place in a request log line.
      });
      throw new ForbiddenError(`Missing required permission '${permission}'.`);
    }

    await next();
  };

  (guard as PermissionTaggedHandler)[REQUIRED_PERMISSION] = permission;

  return guard;
}

/**
 * The tenant context carried on the request, as a scope. Absent tenant (no `X-Tenant-Id`, or a
 * route that is not tenant-scoped) resolves in the GLOBAL scope, where only global grants apply —
 * matching the reference, which passed `ITenantContext.TenantId` straight through as a nullable
 * (RequirePermissionFilter.cs:48-49).
 */
function tenantScopeOf(tenantId: string | undefined): TenantId | null {
  return tenantId === undefined ? null : toTenantId(parseInt8(tenantId));
}
