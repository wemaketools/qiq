import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import UserFormPage from '../UserFormPage';
import { createUser } from '../usersApi';
import { listRoles } from '../rolesApi';
import { listGroups } from '../groupsApi';

vi.mock('../usersApi', () => ({
  createUser: vi.fn(),
}));

vi.mock('../rolesApi', () => ({
  listRoles: vi.fn(),
}));

vi.mock('../groupsApi', () => ({
  listGroups: vi.fn(),
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

  return render(
    <Provider store={store}>
      <MemoryRouter>
        <UserFormPage />
      </MemoryRouter>
    </Provider>,
  );
}

function fillProfile() {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'E2E' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'User' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'e2e-user@brittany.test' } });
}

/**
 * New User form (spec FR-13/FR-16, AC-012, verification.json V-012): required first/last name and
 * email format; the created user is silently assigned to the ACTIVE tenant (no tenant field); a
 * single role OR group pick is required; direct permissions are grouped checkboxes.
 */
describe('UserFormPage', () => {
  beforeEach(() => {
    vi.mocked(createUser).mockReset();
    vi.mocked(listRoles).mockResolvedValue([
      { id: 1, tenantId: 1, name: 'Admin', isActive: true, permissionCodes: [] },
      { id: 2, tenantId: 2, name: 'Foreign Admin', isActive: true, permissionCodes: [] },
      { id: 3, tenantId: null, name: 'Internal Operations', isActive: true, permissionCodes: [] },
    ]);
    vi.mocked(listGroups).mockResolvedValue([
      { id: 5, tenantId: 1, name: 'Underwriters', isActive: true },
      { id: 6, tenantId: 2, name: 'Foreign Group', isActive: true },
    ]);
  });

  it('submit_WhenRequiredFieldsEmpty_ShouldShowInlineErrors', async () => {
    // Arrange
    renderForm(['users.invite']);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert: first/last/email errors plus the role-or-group requirement.
    const errors = await screen.findAllByTestId('field-error');
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('submit_WhenEmailInvalid_ShouldShowFormatError', async () => {
    // Arrange
    renderForm(['users.invite']);
    fillProfile();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() => expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument());
    expect(createUser).not.toHaveBeenCalled();
  });

  it('form_ShouldHaveNoTenantField_TheActiveTenantIsImplied', () => {
    // Arrange & Act: tenant is not a choice on create (2026-07-21 decision) — the active tenant is
    // stated in the hint copy instead.
    renderForm(['users.invite']);

    // Assert
    expect(screen.queryByLabelText('Tenant')).toBeNull();
    expect(screen.getByText(/created in Brittany Insurance/)).toBeInTheDocument();
  });

  it('rolePickers_ShouldOfferOnlyActiveTenantAndGlobalRows_MarkedWithGlobalSuffix', async () => {
    // Arrange & Act
    renderForm(['users.invite']);

    // Assert: single-selects, defaulting to empty, no foreign-tenant rows, "(Global)" suffix
    // instead of scope headers.
    const roleSelect = screen.getByLabelText('Role');
    await waitFor(() => expect(within(roleSelect).getByRole('option', { name: 'Admin' })).toBeInTheDocument());
    expect(roleSelect).toHaveValue('');
    expect(within(roleSelect).getByRole('option', { name: 'Internal Operations (Global)' })).toBeInTheDocument();
    expect(within(roleSelect).queryByRole('option', { name: 'Foreign Admin' })).toBeNull();
    expect(within(roleSelect).queryByRole('group')).toBeNull();

    const groupSelect = screen.getByLabelText('Group');
    expect(groupSelect).toHaveValue('');
    expect(within(groupSelect).getByRole('option', { name: 'Underwriters' })).toBeInTheDocument();
    expect(within(groupSelect).queryByRole('option', { name: 'Foreign Group' })).toBeNull();
  });

  it('submit_WhenNeitherRoleNorGroupChosen_ShouldRequireOneOfThem', async () => {
    // Arrange
    renderForm(['users.invite']);
    fillProfile();

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText('Select a role or a group.')).toBeInTheDocument();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('submit_WhenRoleChosen_ShouldCreateInActiveTenantWithThatRole', async () => {
    // Arrange
    vi.mocked(createUser).mockResolvedValue({ userId: 42, email: 'e2e-user@brittany.test', isActive: true, emailSent: true });
    renderForm(['users.invite']);
    fillProfile();
    await waitFor(() => expect(within(screen.getByLabelText('Role')).getByRole('option', { name: 'Admin' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: '1' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert: the active tenant travels implicitly; no group, no direct permissions.
    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith({
        firstName: 'E2E',
        lastName: 'User',
        email: 'e2e-user@brittany.test',
        tenantIds: [1],
        directRoleIds: [1],
        directPermissions: [],
        groupIds: [],
      }),
    );
  });

  it('submit_WhenGroupAndPermissionChosen_ShouldSatisfyValidationAndSendBoth', async () => {
    // Arrange: a group alone satisfies the role-or-group rule; direct permissions come from the
    // grouped checkboxes (PermissionPicker), gated by the caller's own grants.
    vi.mocked(createUser).mockResolvedValue({ userId: 42, email: 'e2e-user@brittany.test', isActive: true, emailSent: true });
    renderForm(['users.invite', 'parties.view']);
    fillProfile();
    await waitFor(() => expect(within(screen.getByLabelText('Group')).getByRole('option', { name: 'Underwriters' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('parties.view'));

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantIds: [1],
          directRoleIds: [],
          directPermissions: ['parties.view'],
          groupIds: [5],
        }),
      ),
    );
  });
});
