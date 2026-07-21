import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import TenantListPage from '../TenantListPage';
import { listTenants } from '../tenantsApi';
import type { TenantDto } from '../tenantsApi';

vi.mock('../tenantsApi', () => ({
  listTenants: vi.fn(),
  removeTenant: vi.fn(),
  restoreTenant: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function renderList(permissions: string[]) {
  const store = configureStore({ reducer: { session: sessionReducer } });
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
        <TenantListPage />
      </MemoryRouter>
    </Provider>,
  );
}

const ACTIVE_TENANT: TenantDto = {
  id: 1,
  name: 'Active Co',
  contactName: 'Jane',
  contactEmail: 'jane@active.test',
  contactPhone: null,
  status: 'active',
  removedAt: null,
};

const REMOVED_TENANT: TenantDto = {
  id: 2,
  name: 'Removed Co',
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  status: 'removed',
  removedAt: '2026-01-01T00:00:00Z',
};

/**
 * Tenant Manager list (spec FR-06/FR-07, AC-006, verification.json V-006): include-removed
 * visibility gated by `tenants.view_removed`, and status chips rendered for Active/Removed rows.
 */
describe('TenantListPage', () => {
  beforeEach(() => {
    vi.mocked(listTenants).mockReset();
  });

  it('render_WhenUserLacksViewRemovedPermission_ShouldHideIncludeRemovedToggle', async () => {
    // Arrange
    vi.mocked(listTenants).mockResolvedValue([ACTIVE_TENANT]);

    // Act
    renderList(['tenants.view']);

    // Assert
    await screen.findByTestId('tenant-list');
    expect(screen.queryByTestId('include-removed-toggle')).not.toBeInTheDocument();
  });

  it('render_WhenUserHasViewRemovedPermission_ShouldShowIncludeRemovedToggle', async () => {
    // Arrange
    vi.mocked(listTenants).mockResolvedValue([ACTIVE_TENANT]);

    // Act
    renderList(['tenants.view', 'tenants.view_removed']);

    // Assert
    expect(await screen.findByTestId('include-removed-toggle')).toBeInTheDocument();
  });

  it('render_WhenTenantsLoaded_ShouldRenderActiveAndRemovedStatusChips', async () => {
    // Arrange
    vi.mocked(listTenants).mockResolvedValue([ACTIVE_TENANT, REMOVED_TENANT]);

    // Act
    renderList(['tenants.view', 'tenants.view_removed']);

    // Assert
    const chips = await screen.findAllByTestId('status-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('Active');
    expect(chips[1]).toHaveTextContent('Removed');
  });

  it('render_WhenNoTenants_ShouldShowEmptyState', async () => {
    // Arrange
    vi.mocked(listTenants).mockResolvedValue([]);

    // Act
    renderList(['tenants.view']);

    // Assert
    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
  });

  it('render_WhenLoadFails_ShouldShowErrorBannerWithRetry', async () => {
    // Arrange
    vi.mocked(listTenants).mockRejectedValue({ status: 500, title: 'Server error', fieldErrors: [] });

    // Act
    renderList(['tenants.view']);

    // Assert
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });

  it('render_WhenUserLacksCreatePermission_ShouldHideNewTenantButton', async () => {
    // Arrange
    vi.mocked(listTenants).mockResolvedValue([ACTIVE_TENANT]);

    // Act
    renderList(['tenants.view']);
    await screen.findByTestId('tenant-list');

    // Assert
    expect(screen.queryByRole('button', { name: '+ New Tenant' })).not.toBeInTheDocument();
  });
});
