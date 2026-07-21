/**
 * Server-side tenant access verification (T-013, AC-020, V-025; M-05, spec §13).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Tenancy/TenantAccessValidator.cs`, preserving its order
 * of checks exactly (:26-61):
 *
 *   1. tenant row exists            -> else TenantNotFound      (:30-33)
 *   2. tenant status is active      -> else TenantNotActive     (:35-38)   soft-deleted tenants out
 *   3. `user_tenants` membership    -> Ok, isCrossTenant: false (:46-53)
 *   4. global `view_any_tenant`     -> Ok, isCrossTenant: true  (:55-59)
 *   5. otherwise                    -> NotMember                (:61)
 *
 * Membership is read from `user_tenants` — the same rows the tenant switcher renders — and NOT from
 * anything the client sent. The reference needed `IgnoreQueryFilters()` here (:47) because its
 * ambient tenant filter would otherwise hide the very membership rows it was about to establish;
 * this port has no ambient filter to defeat, so the query is written plainly.
 *
 * Step 4 resolves in the GLOBAL scope (`tenantId: null`, matching :55): `global.view_any_tenant`
 * is meaningful only as a global grant. A grant scoped to tenant A must not let its holder into
 * tenant B — which is exactly what resolving it in the requested tenant's scope would allow.
 */
import { createEffectiveAccess } from '../../domains/rbac/effective-permissions.js';
import type { GrantGraphLoader } from '../../domains/rbac/repository.js';
import type { DbExecutor } from '../db/index.js';

export type TenantAccessResult = 'ok' | 'tenant_not_found' | 'tenant_not_active' | 'not_member';

export interface TenantAccessCheck {
  readonly result: TenantAccessResult;
  /** True only when access came from the Internal grant rather than membership. */
  readonly isCrossTenant: boolean;
}

/** The Internal capability that permits entering a tenant without membership. */
export const CROSS_TENANT_PERMISSION = 'global.view_any_tenant';

export type TenantAccessValidator = (
  userId: number,
  tenantId: number,
) => Promise<TenantAccessCheck>;

const DENIED = (result: TenantAccessResult): TenantAccessCheck => ({
  result,
  isCrossTenant: false,
});

export interface TenantAccessDeps {
  readonly db: DbExecutor;
  readonly loadGrantGraph: GrantGraphLoader;
}

export function createTenantAccessValidator(deps: TenantAccessDeps): TenantAccessValidator {
  return async function validateTenantAccess(userId, tenantId) {
    const tenant = await deps.db
      .selectFrom('tenants')
      .select(['id', 'status'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (tenant === undefined) return DENIED('tenant_not_found');
    // Soft-deleted tenants are not valid workflow contexts (spec §13, tenants.status check
    // constraint allows only 'active' | 'removed').
    if (tenant.status !== 'active') return DENIED('tenant_not_active');

    const membership = await deps.db
      .selectFrom('user_tenants')
      .select('id')
      .where('user_id', '=', userId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    if (membership !== undefined) return { result: 'ok', isCrossTenant: false };

    const globalAccess = createEffectiveAccess(await deps.loadGrantGraph(userId), {
      tenantId: null,
    });
    if (globalAccess.has(CROSS_TENANT_PERMISSION)) {
      return { result: 'ok', isCrossTenant: true };
    }

    return DENIED('not_member');
  };
}
