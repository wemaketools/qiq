import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import BrokersTab from '../BrokersTab';
import { listBrokers, listReferenceItems } from '../settingsApi';
import { ToastProvider } from '../../../components/common/Toast';

vi.mock('../settingsApi', async () => {
  const actual = await vi.importActual<typeof import('../settingsApi')>('../settingsApi');
  return { ...actual, listBrokers: vi.fn(), listReferenceItems: vi.fn() };
});

function renderTab(permissions: string[]) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'admin@brittany.test', firstName: 'Admin', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  return render(
    <Provider store={store}>
      <ToastProvider>
        <BrokersTab />
      </ToastProvider>
    </Provider>,
  );
}

/**
 * Brokers tab (spec FR-24, AC-023, T-016): renders the broker list including disabled brokers with
 * a status chip, and gates the add/edit affordances behind `brokers.manage` (view-only users see a
 * "View" action instead of "Edit"/"+ Add broker").
 */
describe('BrokersTab', () => {
  beforeEach(() => {
    vi.mocked(listBrokers).mockReset();
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(listReferenceItems).mockResolvedValue([]);
    vi.mocked(listBrokers).mockResolvedValue({
      items: [
        { id: 1, name: 'Active Brokers Ltd', brokerTypeId: null, branch: null, status: 'active' },
        { id: 2, name: 'Disabled Brokers Ltd', brokerTypeId: null, branch: null, status: 'disabled' },
      ],
      totalCount: 2,
      page: 1,
      pageSize: 200,
    });
  });

  it('render_WhenUserCanManage_ShouldShowAddBrokerButtonAndEditActions', async () => {
    // Arrange & Act
    renderTab(['brokers.manage']);

    // Assert
    expect(await screen.findByText('Active Brokers Ltd')).toBeInTheDocument();
    expect(screen.getByText('Disabled Brokers Ltd')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add broker' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
  });

  it('render_WhenUserCanOnlyView_ShouldHideAddBrokerAndShowViewInsteadOfEdit', async () => {
    // Arrange & Act
    renderTab(['brokers.view']);

    // Assert
    await waitFor(() => expect(listBrokers).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '+ Add broker' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'View' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('render_WhenBrokerIsDisabled_ShouldShowDisabledStatusChip', async () => {
    // Arrange & Act
    renderTab(['brokers.view']);

    // Assert
    const row = (await screen.findByText('Disabled Brokers Ltd')).closest('tr');
    expect(row).not.toBeNull();
    expect(row && row.textContent).toContain('Disabled');
  });
});
