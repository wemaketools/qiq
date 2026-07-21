import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import SettingsLayout from '../SettingsLayout';

function renderLayout(permissions: string[], initialPath = '/settings') {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'admin@brittany.test', firstName: 'Admin', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  const router = createMemoryRouter(
    [
      {
        path: '/settings',
        element: <SettingsLayout />,
        children: [
          { path: 'brokers', element: <div data-testid="tab-content-brokers" /> },
          { path: 'reference-data', element: <div data-testid="tab-content-reference-data" /> },
          { path: 'business-rules', element: <div data-testid="tab-content-business-rules" /> },
          { path: 'business-assignments', element: <div data-testid="tab-content-business-assignments" /> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );

  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
}

/**
 * Settings vertical-tab gating (spec FR-18, AC-017, V-017, T-016): only subsections whose
 * permission the active tenant grants render as tabs, and `/settings` itself redirects to the
 * first permitted subsection.
 */
describe('SettingsLayout', () => {
  it('render_WhenUserHasOnlyBrokersPermission_ShouldShowOnlyBrokersTab', () => {
    // Arrange & Act
    renderLayout(['brokers.manage']);

    // Assert
    expect(screen.getByTestId('settings-tab-brokers')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-tab-reference-data')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-tab-business-rules')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-tab-business-assignments')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-content-brokers')).toBeInTheDocument();
  });

  it('render_WhenUserHasEveryPermission_ShouldShowEveryTab', () => {
    // Arrange & Act
    renderLayout([
      'brokers.view',
      'reference_data.manage',
      'business_rules.view',
      'business_assignments.view',
    ]);

    // Assert
    expect(screen.getByTestId('settings-tab-brokers')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-reference-data')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-business-rules')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-business-assignments')).toBeInTheDocument();
  });

  it('render_WhenDeepLinkedToAPermittedTab_ShouldNotRedirectAwayFromIt', () => {
    // Arrange & Act
    renderLayout(['reference_data.manage'], '/settings/reference-data');

    // Assert
    expect(screen.getByTestId('tab-content-reference-data')).toBeInTheDocument();
  });
});
