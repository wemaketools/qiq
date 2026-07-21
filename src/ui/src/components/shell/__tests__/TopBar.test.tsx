import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import { alertsBadgeReducer } from '../../../app/slices/alertsBadgeSlice';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import TopBar from '../TopBar';

/**
 * TopBar design-system contract (T-043, AC-082): bell/help are accessible icon buttons carrying
 * svg glyphs (never the literal placeholder texts the pre-T-043 shell rendered), and the global
 * + New Lead action is the screen's one primary button (UI Standards §7/§9).
 */
function renderTopBar(permissions: string[] = ['leads.create']) {
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
        <TopBar title="Executive Overview" />
      </MemoryRouter>
    </Provider>,
  );
}

describe('TopBar', () => {
  it('render_WhenShellMounts_ShouldRenderBellAndHelpAsIconButtonsNotTextPlaceholders', () => {
    // Arrange & Act
    renderTopBar();

    // Assert
    const bell = screen.getByTestId('notification-bell');
    const help = screen.getByTestId('help-button');
    expect(bell.querySelector('svg')).not.toBeNull();
    expect(help.querySelector('svg')).not.toBeNull();
    expect(bell).not.toHaveTextContent('Bell');
    expect(help).not.toHaveTextContent('Help');
    expect(bell).toHaveAccessibleName('Notifications');
    expect(help).toHaveAccessibleName('Help');
  });

  it('render_WhenUserCanCreateLeads_ShouldRenderNewLeadAsPrimaryButton', () => {
    // Arrange & Act
    renderTopBar(['leads.create']);

    // Assert
    expect(screen.getByTestId('new-lead-button')).toHaveClass('qiq-btn', 'qiq-btn--primary');
  });
});
