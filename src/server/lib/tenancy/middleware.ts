/**
 * Tenant-context middleware (T-013, AC-020, V-025; M-05, P-13, spec §13).
 *
 * Fills the tenant slot T-009 prepared at app.ts:167 — after `authenticate()` (it needs the
 * principal) and before `permissionResolution()` (whose resolved set is scoped to the tenant this
 * middleware verifies). Port of
 * `src/api/QuoteIQ.Api/Tenancy/TenantContextMiddleware.cs`.
 *
 * STATUS CODES — MEASURED FROM THE REFERENCE, NOT INTUITED
 * =======================================================
 * A MALFORMED OR MISSING `X-Tenant-Id` IS 403, NOT 400. TenantContextMiddleware.cs:50-55 folds both
 * into one branch:
 *
 *     if (!Headers.TryGetValue("X-Tenant-Id", out var v) || !long.TryParse(v.ToString(), out var id))
 *         await WriteForbiddenAsync(context, "Missing or invalid X-Tenant-Id header.");
 *
 * and `WriteForbiddenAsync` (:120-132) writes 403. Intuition says a syntactically bad header is a
 * 400 "bad request"; the reference disagrees, and it is also the better answer here — a 400/403
 * split would tell an attacker which of "this header is garbage" and "you may not have this tenant"
 * happened, and V-025 asks for the preserved contract specifically. Every rejection from this
 * middleware is therefore an identical 403.
 *
 * ONE DENIAL MESSAGE — A DELIBERATE, REPORTED DEVIATION
 * ====================================================
 * The reference returned a DIFFERENT detail per reason (DescribeDenial, :112-118): "Tenant does not
 * exist." vs "Tenant is not active." vs "Caller is not a member of the requested tenant.". Those
 * three strings are an existence oracle: any caller can probe ids and learn which tenants exist and
 * which are soft-deleted, without belonging to any of them. That contradicts AC-020 ("no
 * leakage"), spec §384 ("403 permission/tenant violation (no leakage)") and the N-01 principle this
 * task exists to enforce, so this port collapses them into one constant message. The status code —
 * the part any client could branch on — is unchanged at 403. The specific reason is logged
 * server-side, where it is a diagnostic rather than a disclosure.
 *
 * CROSS-TENANT ACCESS IS AUDITED (AC-020, spec §13)
 * =================================================
 * When an Internal user enters a tenant they do not belong to, a row is written to `audit_log`
 * BEFORE the request proceeds. Writing it up front means the access is recorded even if the handler
 * below then throws; the audit trail is evidence of the attempt, not just of successes.
 */
import type { MiddlewareHandler } from 'hono';

import {
  CROSS_TENANT_ACCESS_ACTION,
  writeAudit,
  type AuditEntry,
} from '../../domains/audit/index.js';
import { parseInt8, toTenantId, type DbExecutor } from '../db/index.js';
import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../auth/middleware.js';
import type { ApiEnv } from '../router/env.js';
import type { TenantAccessResult, TenantAccessValidator } from './access.js';
import { classifyRoute, type TenantContext } from './context.js';

export const TENANT_HEADER = 'X-Tenant-Id';

/**
 * The single client-facing rejection detail. Every failure path returns exactly this string:
 * missing header, unparseable header, nonexistent tenant, soft-deleted tenant, and plain
 * non-membership are indistinguishable from outside.
 */
export const TENANT_ACCESS_DENIED_MESSAGE =
  'A valid X-Tenant-Id header naming a tenant you have access to is required for this endpoint.';

/** Reasons, for the server log only. Never rendered to a client. */
type DenialReason = TenantAccessResult | 'missing_header' | 'malformed_header' | 'no_principal';

export interface TenantContextDeps {
  readonly validateTenantAccess: TenantAccessValidator;
  /** Handle used for the cross-tenant audit row. */
  readonly db: DbExecutor;
  /** Seam for tests; defaults to the real writer. */
  readonly writeAuditEntry?: (executor: DbExecutor, entry: AuditEntry) => Promise<void>;
}

/**
 * True when the request matched a real route handler.
 *
 * Same reasoning as `authenticate()` (auth/middleware.ts:63-65): Hono runs path-pattern middleware
 * whether or not a handler exists, so without this an unknown path under `/api/v1` would answer 403
 * instead of 404 — which would leak the shape of the route table to unauthenticated callers and
 * break T-009's V-017 test. `app.use()` registers as method 'ALL'; a real route keeps its verb.
 */
function matchedARouteHandler(matchedRoutes: readonly { method: string }[]): boolean {
  return matchedRoutes.some((route) => route.method !== 'ALL');
}

/**
 * Parses the header. Returns null for anything that is not a positive integer — including `1.5`,
 * `1e3`, `0x10`, `" "`, `12abc` and values beyond the safe-integer range. `Number()` alone would
 * accept several of those, so the digits are checked explicitly first.
 */
function parseTenantHeader(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function tenantContext(deps: TenantContextDeps): MiddlewareHandler<ApiEnv> {
  const writeAuditEntry = deps.writeAuditEntry ?? writeAudit;

  return async function tenantContextMiddleware(c, next) {
    const path = c.req.path;

    // Global routes and unmatched paths pass through untouched. Note this sets NO tenant, so a
    // handler on a global route that reaches for `c.get('tenantId')` gets undefined rather than
    // some other request's tenant.
    if (classifyRoute(path) === 'global' || !matchedARouteHandler(c.req.matchedRoutes)) {
      await next();
      return;
    }

    const logger = c.get('logger');

    const deny = (reason: DenialReason): ForbiddenError => {
      logger.warn('tenant context rejected', { reason, route: `${c.req.method} ${path}` });
      return new ForbiddenError(TENANT_ACCESS_DENIED_MESSAGE);
    };

    const auth = c.get('auth');
    if (auth === undefined) {
      // Defensive: under the composed pipeline `authenticate()` has already rejected an anonymous
      // caller. Reaching here means a misordered mount, and 401 keeps that indistinguishable from
      // the normal anonymous path rather than reporting it as a tenant problem.
      logger.warn('tenant context rejected', {
        reason: 'no_principal' satisfies DenialReason,
        route: `${c.req.method} ${path}`,
      });
      throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);
    }

    const header = c.req.header(TENANT_HEADER);
    if (header === undefined) throw deny('missing_header');

    const requested = parseTenantHeader(header);
    if (requested === null) throw deny('malformed_header');

    const access = await deps.validateTenantAccess(parseInt8(auth.userId), requested);
    if (access.result !== 'ok') throw deny(access.result);

    // Only NOW does the value become a TenantId. Everything downstream — including
    // `forTenant(db, tenantId)` — consumes this verified value, never `c.req.header(...)`.
    const tenant: TenantContext = {
      tenantId: toTenantId(requested),
      isCrossTenant: access.isCrossTenant,
    };

    c.set('tenant', tenant);
    // Mirrored onto the flat variable the T-009 request-log line and T-012's guard already read.
    c.set('tenantId', String(tenant.tenantId));

    if (tenant.isCrossTenant) {
      await writeAuditEntry(deps.db, {
        entityType: 'tenant',
        entityId: String(tenant.tenantId),
        action: CROSS_TENANT_ACCESS_ACTION,
        actorUserId: parseInt8(auth.userId),
        tenantId: tenant.tenantId,
        before: null,
        after: {
          // Enough to answer "who reached into which tenant, and how" — and nothing about the
          // business data the request went on to read.
          accessedTenantId: tenant.tenantId,
          route: `${c.req.method} ${path}`,
        },
        context: { correlationId: c.get('correlationId') },
      });
    }

    await next();
  };
}
