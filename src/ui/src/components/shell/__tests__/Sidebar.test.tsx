import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import { alertsBadgeReducer } from '../../../app/slices/alertsBadgeSlice';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import Sidebar from '../Sidebar';

/**
 * Sidebar permission gating (spec FR-17, AC-016, verification.json V-016): the security-sensitive
 * UX surface — admin nav entries (Settings, User Manager, Tenant Manager) must be absent from the
 * DOM (not merely disabled) for a user without the corresponding permission, and present for a user
 * who has it.
 */
function renderSidebarWithPermissions(permissions: string[]) {
  const store = configureStore({
    reducer: { session: sessionReducer, alertsBadge: alertsBadgeReducer, dashboardFilters: dashboardFiltersReducer },
  });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  return render(
    <Provider store={store}>
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    </Provider>,
  );
}

describe('Sidebar', () => {
  it('render_WhenUserLacksAdminPermissions_ShouldHideAdminNavEntries', () => {
    // Arrange & Act
    renderSidebarWithPermissions(['leads.view']);

    // Assert
    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-user-manager')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-tenant-manager')).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-leads')).toBeInTheDocument();
  });

  it('render_WhenUserHasAdminPermissions_ShouldShowAdminNavEntries', () => {
    // Arrange & Act
    renderSidebarWithPermissions(['business_rules.view', 'users.view', 'tenants.view']);

    // Assert
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();
    expect(screen.getByTestId('nav-user-manager')).toBeInTheDocument();
    expect(screen.getByTestId('nav-tenant-manager')).toBeInTheDocument();
  });

  it('render_WhenUserLacksStandardPermission_ShouldHideThatNavEntryOnly', () => {
    // Arrange & Act
    renderSidebarWithPermissions(['leads.view']);

    // Assert
    expect(screen.queryByTestId('nav-overview')).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-leads')).toBeInTheDocument();
  });

  it('render_Always_ShouldBoundTheNavAsItsOwnScrollRegion', () => {
    // Guards the T-052/F-043-4 fix at the unit level: the nav must be a bounded, internally
    // scrollable region (`overflow-y: auto` + a min-height of 0 that lets `flex: 1` shrink it below
    // its content) so overflowing nav content never spills over the pinned TenantSwitcher and
    // steals its clicks. jsdom cannot lay this out, so the authoritative pointer-interception check
    // lives in e2e (shell-nav-overflow.spec.ts); this is a cheap regression tripwire for the style.
    renderSidebarWithPermissions(['leads.view']);

    const nav = screen.getByTestId('sidebar-nav');

    expect(nav.style.overflowY).toBe('auto');
    expect(['0', '0px']).toContain(nav.style.minHeight);
    expect(nav.style.flex).toBe('1 1 0%');
  });
});
