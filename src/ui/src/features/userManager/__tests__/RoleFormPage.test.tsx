import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import RoleFormPage from '../RoleFormPage';
import { createRole } from '../rolesApi';

vi.mock('../rolesApi', () => ({
  createRole: vi.fn(),
  getRole: vi.fn(),
  updateRole: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function renderForm(permissions: string[]) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'admin@brittany.test', firstName: 'Admin', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  // useUnsavedChanges' useBlocker requires a data router (createMemoryRouter), not the plain
  // <MemoryRouter>/<Routes> component API (see TenantFormPage.test.tsx for the same pattern).
  const router = createMemoryRouter(
    [
      { path: '/admin/roles/new', element: <RoleFormPage /> },
      { path: '/admin/roles/:roleId', element: <RoleFormPage /> },
      { path: '/admin/roles', element: <div data-testid="role-list-route" /> },
    ],
    { initialEntries: ['/admin/roles/new'] },
  );

  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
}

/**
 * Role permission picker (spec FR-12/FR-13, AC-012, T-007 permission catalog): grouped by
 * category, disables codes the caller doesn't themselves hold (grant-no-higher-than-self UX
 * affordance, F-034), and validates the role name before save.
 */
describe('RoleFormPage', () => {
  beforeEach(() => {
    vi.mocked(createRole).mockReset();
  });

  it('render_WhenLoaded_ShouldGroupPermissionsByCategory', () => {
    // Arrange & Act
    renderForm(['roles.manage']);

    // Assert
    expect(screen.getByTestId('permission-group-leads')).toBeInTheDocument();
    expect(screen.getByTestId('permission-group-users')).toBeInTheDocument();
    expect(screen.getByTestId('permission-group-tenants')).toBeInTheDocument();
  });

  it('render_WhenCallerLacksAPermission_ShouldDisableThatCheckbox', () => {
    // Arrange & Act
    renderForm(['roles.manage', 'leads.view']);

    // Assert
    expect(screen.getByLabelText(/^leads\.view($| )/)).not.toBeDisabled();
    expect(screen.getByLabelText(/^tenants\.create($| )/)).toBeDisabled();
  });

  it('submit_WhenNameEmpty_ShouldShowInlineErrorAndNotSave', async () => {
    // Arrange
    renderForm(['roles.manage']);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByTestId('field-error')).toHaveTextContent('Role name is required.');
    expect(createRole).not.toHaveBeenCalled();
  });

  it('submit_WhenValid_ShouldCallCreateRoleWithSelectedPermissions', async () => {
    // Arrange
    vi.mocked(createRole).mockResolvedValue({ id: 1, tenantId: 1, name: 'Underwriter', isActive: true, permissionCodes: ['leads.view'] });
    renderForm(['roles.manage', 'leads.view']);

    // Act
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Underwriter' } });
    fireEvent.click(screen.getByLabelText(/^leads\.view($| )/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(createRole).toHaveBeenCalledWith({ name: 'Underwriter', permissionCodes: ['leads.view'] }),
    );
  });

  it('submit_WhenServerRejectsExceedsCallerGrant_ShouldShowFriendlyInlineErrorNotCrash', async () => {
    // Arrange: the server is the sole authority on grant-no-higher-than-self (F-034); this proves
    // the 403 ROLE_PERMISSION_EXCEEDS_CALLER_GRANT problem+json response (surfaced by the shared
    // API client as NormalizedError.title, which already carries "{code}: {message}" per
    // RoleEndpoints.ProblemFromError) renders as an inline banner rather than throwing.
    vi.mocked(createRole).mockRejectedValue({
      status: 403,
      title: 'ROLE_PERMISSION_EXCEEDS_CALLER_GRANT: Caller cannot add permission \'tenants.create\' to this role because they do not hold it themselves in this scope.',
      fieldErrors: [],
    });
    renderForm(['roles.manage']);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Escalated Role' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText(/ROLE_PERMISSION_EXCEEDS_CALLER_GRANT/)).toBeInTheDocument();
    expect(screen.getByTestId('role-form-page')).toBeInTheDocument();
  });
});
