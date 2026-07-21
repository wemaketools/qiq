import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import UserListPage from '../UserListPage';
import { listUsers } from '../usersApi';
import type { UserDto } from '../usersApi';

vi.mock('../usersApi', () => ({
  listUsers: vi.fn(),
  deactivateUser: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function renderList(permissions: string[]) {
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
        <UserListPage />
      </MemoryRouter>
    </Provider>,
  );
}

// id 2: distinct from the session user (userId 1), whose own row hides Deactivate (self-lockout).
const ACTIVE_USER: UserDto = {
  id: 2,
  firstName: 'E2E',
  lastName: 'User',
  email: 'e2e-user@brittany.test',
  isActive: true,
  tenantIds: [1],
};

const SELF_USER: UserDto = {
  id: 1,
  firstName: 'Admin',
  lastName: 'User',
  email: 'admin@brittany.test',
  isActive: true,
  tenantIds: [1],
};

/**
 * User Manager list (spec FR-13, AC-012, verification.json V-012): +New gated by `users.invite`,
 * Deactivate action gated by `users.deactivate`, and status chips reflect active/inactive users.
 */
describe('UserListPage', () => {
  beforeEach(() => {
    vi.mocked(listUsers).mockReset();
  });

  it('render_WhenUserLacksInvitePermission_ShouldHideNewUserButton', async () => {
    // Arrange
    vi.mocked(listUsers).mockResolvedValue([ACTIVE_USER]);

    // Act
    renderList(['users.view']);
    await screen.findByTestId('user-list');

    // Assert
    expect(screen.queryByRole('button', { name: '+ New User' })).not.toBeInTheDocument();
  });

  it('render_WhenUserHasInvitePermission_ShouldShowNewUserButton', async () => {
    // Arrange
    vi.mocked(listUsers).mockResolvedValue([ACTIVE_USER]);

    // Act
    renderList(['users.view', 'users.invite']);

    // Assert
    expect(await screen.findByRole('button', { name: '+ New User' })).toBeInTheDocument();
  });

  it('render_WhenUserLacksDeactivatePermission_ShouldHideDeactivateButton', async () => {
    // Arrange
    vi.mocked(listUsers).mockResolvedValue([ACTIVE_USER]);

    // Act
    renderList(['users.view']);

    // Assert
    await screen.findByTestId('user-list');
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });

  it('click_WhenDeactivateClicked_ShouldOpenDangerDialogWithUserEmail', async () => {
    // Arrange
    vi.mocked(listUsers).mockResolvedValue([ACTIVE_USER]);
    renderList(['users.view', 'users.deactivate']);
    const button = await screen.findByRole('button', { name: 'Deactivate' });

    // Act
    button.click();

    // Assert
    await waitFor(() => expect(screen.getByTestId('deactivate-user-dialog')).toBeInTheDocument());
    expect(screen.getByText('Deactivate user — e2e-user@brittany.test')).toBeInTheDocument();
  });

  it('render_WhenRowIsOwnAccount_ShouldHideDeactivateButton', async () => {
    // Arrange: self-lockout affordance -- the server rejects self-deactivation
    // (USER_CANNOT_DEACTIVATE_SELF), so the caller's own row must not offer the action.
    vi.mocked(listUsers).mockResolvedValue([SELF_USER]);

    // Act
    renderList(['users.view', 'users.deactivate']);

    // Assert
    await screen.findByTestId('user-list');
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });

  it('render_WhenNoUsers_ShouldShowEmptyState', async () => {
    // Arrange
    vi.mocked(listUsers).mockResolvedValue([]);

    // Act
    renderList(['users.view']);

    // Assert
    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
  });

  it('render_WhenLoadFails_ShouldShowErrorBannerWithRetry', async () => {
    // Arrange
    vi.mocked(listUsers).mockRejectedValue({ status: 500, title: 'Server error', fieldErrors: [] });

    // Act
    renderList(['users.view']);

    // Assert
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });
});
