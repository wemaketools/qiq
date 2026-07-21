import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { configureStore } from '@reduxjs/toolkit';

const { getCurrentSession, onAuthStateChange, fetchMe } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  fetchMe: vi.fn(),
}));

vi.mock('./supabase', () => ({
  getCurrentSession,
  onAuthStateChange,
  SIGN_IN_ROUTE: '/sign-in',
}));

vi.mock('../api/me', () => ({ fetchMe }));
vi.mock('../features/tenantManager/tenantsApi', () => ({ getTenant: vi.fn() }));
vi.mock('../features/settings/settingsApi', () => ({ fetchFullBusinessRules: vi.fn() }));

import AuthProvider from './AuthProvider';
import { sessionReducer } from '../app/slices/sessionSlice';

const ME_RESPONSE = {
  userId: 1,
  email: 'sales.head@brittany.test',
  firstName: 'Sales',
  lastName: 'Head',
  lastTenantId: 2,
  themePreference: 'dark',
  globalPermissions: [],
  memberships: [
    {
      tenantId: 1,
      tenantName: 'Tenant One',
      currencyCode: 'BWP',
      currencySymbol: 'BWP',
      effectivePermissions: ['leads.view'],
    },
    {
      tenantId: 2,
      tenantName: 'Tenant Two',
      currencyCode: 'USD',
      currencySymbol: '$',
      effectivePermissions: ['leads.view'],
    },
  ],
};

function makeStore() {
  return configureStore({ reducer: { session: sessionReducer } });
}

function renderProvider(store = makeStore(), initialEntry = '/leads') {
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/sign-in" element={<div data-testid="sign-in-page">sign in</div>} />
          <Route
            element={
              <AuthProvider>
                <div data-testid="protected">protected</div>
              </AuthProvider>
            }
          >
            <Route path="/leads" element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
  return store;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onAuthStateChange.mockReturnValue(() => undefined);
    fetchMe.mockResolvedValue(ME_RESPONSE);
    getCurrentSession.mockResolvedValue({ access_token: 'jwt' });
  });

  it('render_WhenNoSupabaseSession_ShouldRedirectToTheSpaSignInPage', async () => {
    // Arrange
    getCurrentSession.mockResolvedValue(null);

    // Act
    renderProvider();

    // Assert
    expect(await screen.findByTestId('sign-in-page')).toBeInTheDocument();
  });

  it('render_WhenNoSupabaseSession_ShouldNotCallMe', async () => {
    // Arrange
    getCurrentSession.mockResolvedValue(null);

    // Act
    renderProvider();
    await screen.findByTestId('sign-in-page');

    // Assert
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it('render_WhenSessionExistsAndMeResolves_ShouldPopulateTheSessionSliceAndRenderChildren', async () => {
    // Arrange & Act
    const store = renderProvider();

    // Assert
    expect(await screen.findByTestId('protected')).toBeInTheDocument();
    await waitFor(() => {
      const session = store.getState().session;
      expect(session.isAuthenticated).toBe(true);
      expect(session.user?.email).toBe('sales.head@brittany.test');
      // FR-04: land in the caller's remembered last active tenant.
      expect(session.activeTenantId).toBe(2);
      expect(session.themePreference).toBe('dark');
    });
  });

  it('render_WhenMeFails_ShouldShowTheSessionErrorStateRatherThanTheApp', async () => {
    // Arrange
    fetchMe.mockRejectedValue(new Error('boom'));

    // Act
    renderProvider();

    // Assert
    const status = await screen.findByTestId('auth-loading');
    expect(status).toHaveTextContent(/unable to load your session/i);
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('authStateChange_WhenSignedOut_ShouldClearTenantScopedSessionState', async () => {
    // Arrange
    const store = renderProvider();
    await screen.findByTestId('protected');
    const handler = onAuthStateChange.mock.calls[0]?.[0] as (event: string) => void;

    // Act
    handler('SIGNED_OUT');

    // Assert
    await waitFor(() => {
      const session = store.getState().session;
      expect(session.isAuthenticated).toBe(false);
      expect(session.activeTenantId).toBeNull();
      expect(session.memberships).toEqual([]);
    });
  });

  it('unmount_WhenCalled_ShouldUnsubscribeFromSupabaseAuthStateChanges', async () => {
    // Arrange
    const unsubscribe = vi.fn();
    onAuthStateChange.mockReturnValue(unsubscribe);
    const { unmount } = render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/leads']}>
          <Routes>
            <Route path="/sign-in" element={<div />} />
            <Route
              path="/leads"
              element={
                <AuthProvider>
                  <div data-testid="protected">protected</div>
                </AuthProvider>
              }
            />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    await screen.findByTestId('protected');

    // Act
    unmount();

    // Assert
    expect(unsubscribe).toHaveBeenCalled();
  });
});
