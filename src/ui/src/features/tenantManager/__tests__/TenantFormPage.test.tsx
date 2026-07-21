import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import TenantFormPage from '../TenantFormPage';
import { createTenant, getTenant, updateTenant } from '../tenantsApi';

vi.mock('../tenantsApi', () => ({
  createTenant: vi.fn(),
  updateTenant: vi.fn(),
  getTenant: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function renderForm(initialPath: string, permissions: string[] = ['tenants.create', 'tenants.edit']) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  // useUnsavedChanges' useBlocker requires a data router (createMemoryRouter), not the plain
  // <MemoryRouter>/<Routes> component API.
  const router = createMemoryRouter(
    [
      { path: '/admin/tenants/new', element: <TenantFormPage /> },
      { path: '/admin/tenants/:tenantId', element: <TenantFormPage /> },
      { path: '/admin/tenants', element: <div data-testid="tenant-list-route" /> },
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
 * Tenant add/edit form (spec FR-06, AC-006, verification.json V-006): required name, email
 * format validation with inline errors, and successful create/update submission.
 */
describe('TenantFormPage', () => {
  beforeEach(() => {
    vi.mocked(createTenant).mockReset();
    vi.mocked(updateTenant).mockReset();
    vi.mocked(getTenant).mockReset();
    vi.mocked(createTenant).mockResolvedValue({ tenantId: 1, name: 'Acme', status: 'active' });
    vi.mocked(updateTenant).mockResolvedValue({
      id: 1,
      name: 'Acme',
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      status: 'active',
      removedAt: null,
    });
  });

  it('submit_WhenNameLeftBlank_ShouldShowInlineRequiredError', async () => {
    // Arrange
    renderForm('/admin/tenants/new');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText('Tenant name is required.')).toBeInTheDocument();
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('blur_WhenContactEmailIsInvalidFormat_ShouldShowInlineFormatError', async () => {
    // Arrange
    renderForm('/admin/tenants/new');

    // Act
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme Insurance' } });
    const emailInput = screen.getByLabelText('Contact email');
    fireEvent.change(emailInput, { target: { value: 'not-an-email' } });
    fireEvent.blur(emailInput);

    // Assert
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('submit_WhenFormValid_ShouldCallCreateTenantAndNavigateToList', async () => {
    // Arrange
    renderForm('/admin/tenants/new');

    // Act
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme Insurance' } });
    fireEvent.change(screen.getByLabelText('Contact email'), { target: { value: 'jane@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(createTenant).toHaveBeenCalledWith({
        name: 'Acme Insurance',
        contactName: null,
        contactEmail: 'jane@acme.test',
        contactPhone: null,
      }),
    );
    expect(await screen.findByTestId('tenant-list-route')).toBeInTheDocument();
  });

  it('submit_WhenEditingExistingTenant_ShouldLoadValuesAndCallUpdateTenant', async () => {
    // Arrange
    vi.mocked(getTenant).mockResolvedValue({
      id: 42,
      name: 'Existing Co',
      contactName: 'Jane',
      contactEmail: 'jane@existing.test',
      contactPhone: null,
      status: 'active',
      removedAt: null,
    });
    renderForm('/admin/tenants/42');

    // Assert values loaded
    expect(await screen.findByDisplayValue('Existing Co')).toBeInTheDocument();

    // Act
    const emailInput = screen.getByLabelText('Contact email');
    fireEvent.change(emailInput, { target: { value: 'new@existing.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(updateTenant).toHaveBeenCalledWith(42, {
        name: 'Existing Co',
        contactName: 'Jane',
        contactEmail: 'new@existing.test',
        contactPhone: null,
      }),
    );
  });

  it('render_WhenUserLacksCreatePermission_ShouldHideSaveButton', () => {
    // Arrange & Act
    renderForm('/admin/tenants/new', []);

    // Assert
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
