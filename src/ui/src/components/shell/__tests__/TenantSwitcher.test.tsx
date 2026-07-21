import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import { listTenants } from '../../../features/tenantManager/tenantsApi';
import TenantSwitcher from '../TenantSwitcher';

vi.mock('../../../api/me', () => ({
  setMePreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../features/tenantManager/tenantsApi', () => ({
  listTenants: vi.fn(),
}));

vi.mock('../../../features/settings/settingsApi', () => ({
  fetchFullBusinessRules: vi.fn().mockResolvedValue({ currencyCode: 'ZAR', currencySymbol: 'R' }),
}));

function renderWithSession(
  memberships: { tenantId: number; tenantName: string; currencyCode?: string; currencySymbol?: string; permissions: string[] }[],
  globalPermissions: string[] = [],
) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: memberships.map((m) => ({ currencyCode: 'BWP', currencySymbol: 'BWP', ...m })),
      globalPermissions,
      activeTenantId: memberships[0]?.tenantId ?? null,
      themePreference: 'light',
    }),
  );
  render(
    <Provider store={store}>
      <TenantSwitcher />
    </Provider>,
  );
  return store;
}

/** Tenant switcher visibility + cross-tenant switching rules (spec FR-10/PRD 5.3, AC-009, V-009, T-045). */
describe('TenantSwitcher', () => {
  beforeEach(() => {
    vi.mocked(listTenants).mockReset();
    vi.mocked(listTenants).mockResolvedValue([]);
  });

  it('render_WhenSingleTenantMembershipWithoutGlobalPermission_ShouldRenderNothing', () => {
    // Arrange & Act
    renderWithSession([{ tenantId: 1, tenantName: 'Brittany Insurance', permissions: ['leads.view'] }]);

    // Assert
    expect(screen.queryByTestId('tenant-switcher')).not.toBeInTheDocument();
  });

  it('render_WhenMultipleTenantMemberships_ShouldRenderSwitcherWithActiveTenantName', () => {
    // Arrange & Act
    renderWithSession([
      { tenantId: 1, tenantName: 'Brittany Insurance', permissions: [] },
      { tenantId: 2, tenantName: 'Second Tenant', permissions: [] },
    ]);

    // Assert
    expect(screen.getByTestId('tenant-switcher')).toBeInTheDocument();
    expect(screen.getByTestId('active-tenant-name')).toHaveTextContent('Brittany Insurance');
  });

  it('render_WhenSingleTenantMembershipWithGlobalViewAnyTenant_ShouldRenderSwitcher', () => {
    // Arrange & Act
    renderWithSession([{ tenantId: 1, tenantName: 'Brittany Insurance', permissions: ['global.view_any_tenant'] }]);

    // Assert
    expect(screen.getByTestId('tenant-switcher')).toBeInTheDocument();
  });

  it('render_WhenZeroMembershipInternalUser_ShouldOfferAllActiveTenants', async () => {
    // Arrange: the T-045 case — no memberships at all, global grants only.
    vi.mocked(listTenants).mockResolvedValue([
      { id: 7, name: 'The Brittany', contactName: null, contactEmail: null, contactPhone: null, status: 'active', removedAt: null },
      { id: 8, name: 'Removed Tenant', contactName: null, contactEmail: null, contactPhone: null, status: 'removed', removedAt: '2026-01-01' },
    ]);

    // Act
    renderWithSession([], ['global.view_any_tenant', 'tenants.view']);

    // Assert: switcher shows with no active tenant, offering only the active cross-tenant option.
    expect(screen.getByTestId('tenant-switcher')).toBeInTheDocument();
    expect(screen.getByTestId('active-tenant-name')).toHaveTextContent('—');
    expect(await screen.findByRole('option', { name: 'The Brittany' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Removed Tenant' })).not.toBeInTheDocument();
  });

  it('change_WhenInternalUserPicksNonMemberTenant_ShouldSynthesizeMembershipFromGlobalGrants', async () => {
    // Arrange
    vi.mocked(listTenants).mockResolvedValue([
      { id: 7, name: 'The Brittany', contactName: null, contactEmail: null, contactPhone: null, status: 'active', removedAt: null },
    ]);
    const store = renderWithSession([], ['global.view_any_tenant', 'tenants.view']);
    await screen.findByRole('option', { name: 'The Brittany' });

    // Act
    fireEvent.change(screen.getByLabelText('Switch tenant'), { target: { value: '7' } });

    // Assert: active tenant switches and the synthesized membership carries the global grants
    // (a non-member's effective set in any tenant per EffectivePermissionResolver), then the
    // display currency is corrected from the tenant's business rules.
    await waitFor(() => {
      const session = store.getState().session;
      expect(session.activeTenantId).toBe(7);
      const synthesized = session.memberships.find((m) => m.tenantId === 7);
      expect(synthesized?.permissions).toEqual(['global.view_any_tenant', 'tenants.view']);
      expect(synthesized?.currencyCode).toBe('ZAR');
    });
  });
});
