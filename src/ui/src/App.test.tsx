import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from './app/store';
import App from './App';

vi.mock('./auth/supabase', () => ({
  getCurrentSession: vi.fn().mockResolvedValue({ access_token: 'test-token' }),
  getAccessToken: vi.fn().mockResolvedValue('test-token'),
  onAuthStateChange: vi.fn().mockReturnValue(() => undefined),
  handleUnauthorized: vi.fn().mockResolvedValue(undefined),
  signOut: vi.fn().mockResolvedValue(undefined),
  signInWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  completePasswordReset: vi.fn(),
  SIGN_IN_ROUTE: '/sign-in',
  FORGOT_PASSWORD_ROUTE: '/forgot-password',
  RESET_PASSWORD_ROUTE: '/reset-password',
  GENERIC_SIGN_IN_FAILURE: 'Sign-in failed. Check your details and try again.',
  UNIFORM_RESET_CONFIRMATION: 'If an account exists for that email address, a password reset link is on its way.',
  GENERIC_RESET_FAILURE: 'That reset link is no longer valid. Request a new one and try again.',
}));

vi.mock('./api/me', () => ({
  fetchMe: vi.fn().mockResolvedValue({
    userId: 1,
    email: 'sales.head@brittany.test',
    firstName: 'Sales',
    lastName: 'Head',
    lastTenantId: 1,
    themePreference: 'light',
    memberships: [
      {
        tenantId: 1,
        tenantName: 'Brittany Insurance',
        currencyCode: 'BWP',
        currencySymbol: 'BWP',
        effectivePermissions: ['dashboards.view_executive'],
      },
    ],
  }),
  setMePreferences: vi.fn().mockResolvedValue(undefined),
}));

describe('App', () => {
  it('render_WhenAuthenticated_ShouldShowAppShell', async () => {
    // Arrange & Act
    render(
      <Provider store={store}>
        <App />
      </Provider>,
    );

    // Assert
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeInTheDocument());
  });
});
