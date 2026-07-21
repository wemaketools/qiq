import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { sessionReducer, setSession } from '../slices/sessionSlice';
import { alertsBadgeReducer } from '../slices/alertsBadgeSlice';
import { dashboardFiltersReducer } from '../slices/dashboardFiltersSlice';
import DefaultLanding from '../DefaultLanding';

/**
 * Post-login landing (T-044): the index route must land each user on the first sidebar entry
 * their effective permissions allow, instead of unconditionally navigating to /overview and
 * showing "You don't have permission" to every role without dashboards.view_executive
 * (PRD 12.1's permission-gated nav, AC-016's hidden-not-disabled principle).
 */
function renderLanding(permissions: string[], globalPermissions: string[] = [], withMembership = true) {
  const store = configureStore({
    reducer: { session: sessionReducer, alertsBadge: alertsBadgeReducer, dashboardFilters: dashboardFiltersReducer },
  });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: withMembership
        ? [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }]
        : [],
      globalPermissions,
      activeTenantId: withMembership ? 1 : null,
      themePreference: 'light',
    }),
  );

  const router = createMemoryRouter(
    [
      { index: true, element: <DefaultLanding /> },
      { path: '/overview', element: <div data-testid="landed-overview" /> },
      { path: '/leads', element: <div data-testid="landed-leads" /> },
      { path: '/alerts', element: <div data-testid="landed-alerts" /> },
      { path: '/admin/tenants', element: <div data-testid="landed-tenant-manager" /> },
    ],
    { initialEntries: ['/'] },
  );

  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
}

describe('DefaultLanding', () => {
  it('render_WhenUserHasExecutiveDashboardPermission_ShouldLandOnOverview', () => {
    renderLanding(['dashboards.view_executive', 'leads.view']);
    expect(screen.getByTestId('landed-overview')).toBeInTheDocument();
  });

  it('render_WhenUserLacksOverviewButCanViewLeads_ShouldLandOnLeads', () => {
    // The relationship-manager case that previously landed on a Forbidden page.
    renderLanding(['leads.view', 'leads.create', 'dashboards.view_pipeline']);
    expect(screen.getByTestId('landed-leads')).toBeInTheDocument();
  });

  it('render_WhenUserHasOnlyAlertsPermission_ShouldLandOnAlerts', () => {
    renderLanding(['alerts.view']);
    expect(screen.getByTestId('landed-alerts')).toBeInTheDocument();
  });

  it('render_WhenUserHasOnlyAdminPermissions_ShouldLandOnFirstAdminSection', () => {
    renderLanding(['tenants.view']);
    expect(screen.getByTestId('landed-tenant-manager')).toBeInTheDocument();
  });

  it('render_WhenUserHasNoNavPermissions_ShouldFallBackToOverview', () => {
    renderLanding([]);
    expect(screen.getByTestId('landed-overview')).toBeInTheDocument();
  });

  it('render_WhenZeroMembershipInternalUserHasGlobalTenantsView_ShouldLandOnTenantManager', () => {
    // The T-045 case: no memberships (no active tenant at all), tenant-less global grants only.
    renderLanding([], ['global.view_any_tenant', 'tenants.view'], false);
    expect(screen.getByTestId('landed-tenant-manager')).toBeInTheDocument();
  });
});
