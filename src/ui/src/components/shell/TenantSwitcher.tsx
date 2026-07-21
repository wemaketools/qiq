import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import {
  selectActiveTenant,
  selectGlobalPermissions,
  selectHasPermission,
  selectSession,
  selectShowTenantSwitcher,
  setActiveTenant,
  updateActiveTenantCurrency,
  upsertCrossTenantMembership,
} from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import { setMePreferences } from '../../api/me';
import { listTenants, type TenantDto } from '../../features/tenantManager/tenantsApi';
import { fetchFullBusinessRules } from '../../features/settings/settingsApi';

/**
 * Tenant switcher (spec FR-10, AC-009): visible only for multi-tenant/Internal users (more than one
 * membership, or the `global.view_any_tenant` permission); the active tenant is always visible.
 * Switching updates `session.activeTenantId` (the header source every tenant-scoped
 * `apiGet/apiPost/apiPut` call and every screen's data-fetch effect reads from) and persists the
 * choice via `PUT /me/preferences` so a later login restores it (FR-04).
 *
 * `global.view_any_tenant` holders (T-045, PRD 5.3) can switch into ANY active tenant, not only
 * their memberships: the option list is extended from `GET /tenants` (permitted for Internal users
 * via their global `tenants.view`; degrades to memberships-only if that read fails), and choosing a
 * non-member tenant synthesizes a session membership whose permission set is the caller's global
 * grants — exactly what the backend's `EffectivePermissionResolver` yields for a non-member — then
 * corrects the display currency from the tenant's business rules (a membership/cross-tenant read).
 */
function TenantSwitcher() {
  const dispatch = useAppDispatch();
  const visible = useAppSelector(selectShowTenantSwitcher);
  const { memberships } = useAppSelector(selectSession);
  const globalPermissions = useAppSelector(selectGlobalPermissions);
  const activeTenant = useAppSelector(selectActiveTenant);
  const canViewAnyTenant = useAppSelector(selectHasPermission(PermissionCodes.GlobalViewAnyTenant));
  const [allTenants, setAllTenants] = useState<TenantDto[] | null>(null);

  useEffect(() => {
    if (!visible || !canViewAnyTenant) {
      return;
    }
    listTenants(false)
      .then(setAllTenants)
      .catch(() => setAllTenants(null));
  }, [visible, canViewAnyTenant]);

  if (!visible) {
    return null;
  }

  const membershipIds = new Set(memberships.map((m) => m.tenantId));
  const crossTenantOptions = (allTenants ?? []).filter((t) => !membershipIds.has(t.id) && t.status === 'active');

  async function handleChange(tenantId: number): Promise<void> {
    const crossTenant = crossTenantOptions.find((t) => t.id === tenantId);
    if (crossTenant) {
      dispatch(
        upsertCrossTenantMembership({
          tenantId: crossTenant.id,
          tenantName: crossTenant.name,
          // Placeholder until the rules fetch below resolves the tenant's real display currency.
          currencyCode: 'BWP',
          currencySymbol: 'BWP',
          permissions: globalPermissions,
        }),
      );
    }
    dispatch(setActiveTenant(tenantId));
    if (crossTenant) {
      try {
        const rules = await fetchFullBusinessRules();
        dispatch(updateActiveTenantCurrency({ currencyCode: rules.currencyCode, currencySymbol: rules.currencySymbol }));
      } catch {
        // Keep the placeholder currency; the switch itself already succeeded.
      }
    }
    await setMePreferences({ lastTenantId: tenantId });
  }

  return (
    <div
      data-testid="tenant-switcher"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--qiq-space-1)',
        padding: 'var(--qiq-space-2) var(--qiq-space-4)',
        // Pinned below the scrollable nav: never shrink/collapse, so the switcher keeps its own
        // reserved space and can no longer be pushed over the nav's links (T-052, F-043-4).
        flexShrink: 0,
      }}
    >
      <span
        data-testid="active-tenant-name"
        style={{
          fontSize: '10.5px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          opacity: 0.65,
        }}
      >
        {activeTenant?.tenantName ?? '—'}
      </span>
      <select
        aria-label="Switch tenant"
        value={activeTenant?.tenantId ?? ''}
        onChange={(event) => void handleChange(Number(event.target.value))}
      >
        {activeTenant === null && <option value="">Select a tenant…</option>}
        {memberships.map((membership) => (
          <option key={membership.tenantId} value={membership.tenantId}>
            {membership.tenantName}
          </option>
        ))}
        {crossTenantOptions.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export default TenantSwitcher;
