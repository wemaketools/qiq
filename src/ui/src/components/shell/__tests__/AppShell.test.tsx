import { describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { sessionReducer, setActiveTenant, setSession } from '../../../app/slices/sessionSlice';
import AppShell from '../AppShell';

// The shell's chrome is irrelevant here — this suite verifies the routed-content remount contract,
// so every sibling of <main> is stubbed out along with the tenant-scoped badge poller.
vi.mock('../Sidebar', () => ({ default: () => null }));
vi.mock('../TopBar', () => ({ default: () => null }));
vi.mock('../Footer', () => ({ default: () => null }));
vi.mock('../UserCard', () => ({ default: () => null }));
vi.mock('../TenantSwitcher', () => ({ default: () => null }));
vi.mock('../../../features/alerts/useAlertsBadgePolling', () => ({
  useAlertsBadgePolling: () => undefined,
}));

/** Counts mount-effect runs — the same shape as every page's on-mount data-fetch effect. */
function makeProbePage(onMount: () => void) {
  return function ProbePage() {
    useEffect(() => {
      onMount();
    }, []);
    return <div data-testid="probe-page" />;
  };
}

function renderShell(onMount: () => void) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: [
        { tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions: [] },
        { tenantId: 2, tenantName: 'Second Tenant', currencyCode: 'ZAR', currencySymbol: 'R', permissions: [] },
      ],
      globalPermissions: [],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );
  const ProbePage = makeProbePage(onMount);
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/overview']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/overview" element={<ProbePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
  return store;
}

/** Tenant switching must reload the current page's data (CLAUDE.md tenant-switch refresh rule). */
describe('AppShell', () => {
  it('switchTenant_WhenActiveTenantChanges_ShouldRemountRoutedPageSoItRefetches', () => {
    // Arrange
    const onMount = vi.fn();
    const store = renderShell(onMount);
    expect(screen.getByTestId('probe-page')).toBeInTheDocument();
    expect(onMount).toHaveBeenCalledTimes(1);

    // Act: what TenantSwitcher dispatches on selection.
    act(() => {
      store.dispatch(setActiveTenant(2));
    });

    // Assert: the routed page remounted, re-running its on-mount data-fetch effect.
    expect(screen.getByTestId('probe-page')).toBeInTheDocument();
    expect(onMount).toHaveBeenCalledTimes(2);
  });

  it('rerender_WhenActiveTenantUnchanged_ShouldNotRemountRoutedPage', () => {
    // Arrange
    const onMount = vi.fn();
    const store = renderShell(onMount);
    expect(onMount).toHaveBeenCalledTimes(1);

    // Act: a same-tenant dispatch (e.g. re-selecting the current tenant) must not thrash the page.
    act(() => {
      store.dispatch(setActiveTenant(1));
    });

    // Assert
    expect(onMount).toHaveBeenCalledTimes(1);
  });
});
