import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import Footer from '../Footer';

function renderFooterWithMembership(currencyCode: string, permissions: string[] = []) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Tenant', currencyCode, currencySymbol: currencyCode, permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );
  return render(
    <Provider store={store}>
      <Footer />
    </Provider>,
  );
}

/**
 * Footer display currency (spec A-3, AC-074): must reflect the active tenant's real display
 * currency for every member, sourced from the session (GET /me), never a hard-coded default masking
 * a missing `business_rules.view` permission.
 */
describe('Footer', () => {
  it('render_WhenActiveTenantCurrencyIsNonBwp_ShouldShowThatCurrency', () => {
    // Arrange & Act
    renderFooterWithMembership('ZAR');

    // Assert
    expect(screen.getByTestId('footer-currency')).toHaveTextContent('All amounts in ZAR');
  });

  it('render_WhenCallerLacksAllPermissionsInActiveTenant_ShouldStillShowRealCurrency', () => {
    // Arrange & Act: no business_rules.view (nor any other permission) granted for this membership.
    renderFooterWithMembership('ZAR', []);

    // Assert
    expect(screen.getByTestId('footer-currency')).toHaveTextContent('All amounts in ZAR');
    expect(screen.queryByText(/All amounts in BWP/)).not.toBeInTheDocument();
  });
});
