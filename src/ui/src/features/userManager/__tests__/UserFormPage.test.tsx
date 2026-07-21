import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

/**
 * New User form (spec FR-13/FR-16, AC-012, verification.json V-012): validates required
 * first/last name, email format, and requires >=1 tenant for a non-Internal caller (UX mirror of
 * the backend's FR-16 rule — server remains authoritative).
 */
describe('UserFormPage', () => {
  beforeEach(() => {
    vi.mocked(createUser).mockReset();
    vi.mocked(listRoles).mockResolvedValue([]);
    vi.mocked(listGroups).mockResolvedValue([]);
  });

  it('submit_WhenRequiredFieldsEmpty_ShouldShowInlineErrors', async () => {
    // Arrange
    renderForm(['users.invite']);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    const errors = await screen.findAllByTestId('field-error');
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('submit_WhenEmailInvalid_ShouldShowFormatError', async () => {
    // Arrange
    renderForm(['users.invite']);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'E2E' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'User' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() => expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument());
    expect(createUser).not.toHaveBeenCalled();
  });

  it('submit_WhenNonInternalCallerSelectsNoTenant_ShouldRequireAtLeastOneTenant', async () => {
    // Arrange: caller lacks global.view_any_tenant, so >=1 tenant is required (FR-16 UX mirror)
    renderForm(['users.invite']);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'E2E' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'User' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'e2e-user@brittany.test' } });
    // Deselect the pre-selected active tenant
    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: [] } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText('Select at least one tenant.')).toBeInTheDocument();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('submit_WhenValid_ShouldCallCreateUserWithTenantAssignment', async () => {
    // Arrange
    vi.mocked(createUser).mockResolvedValue({ userId: 42, email: 'e2e-user@brittany.test', isActive: true, emailSent: true });
    renderForm(['users.invite']);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'E2E' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'User' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'e2e-user@brittany.test' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: 'E2E',
          lastName: 'User',
          email: 'e2e-user@brittany.test',
          tenantIds: [1],
        }),
      ),
    );
  });
});
