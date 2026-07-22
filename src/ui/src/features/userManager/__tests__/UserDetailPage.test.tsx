import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import UserDetailPage from '../UserDetailPage';
import {
  getEffectiveAccess,
  getUser,
  updateUser,
  type EffectiveAccessDto,
  type UserDto,
} from '../usersApi';
import { listRoles } from '../rolesApi';
import { listGroups } from '../groupsApi';

vi.mock('../usersApi', () => ({
  getUser: vi.fn(),
  getEffectiveAccess: vi.fn(),
  updateUser: vi.fn(),
  deactivateUser: vi.fn(),
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

const USER: UserDto = {
  id: 42,
  firstName: 'E2E',
  lastName: 'User',
  email: 'e2e-user@brittany.test',
  isActive: true,
  tenantIds: [1],
};

const ACCESS: EffectiveAccessDto = {
  userId: 42,
  directRoles: [{ roleId: 2, roleName: 'Underwriter', tenantId: 1 }],
  directPermissions: [{ permissionCode: 'leads.view', tenantId: 1 }],
  groups: [{ groupId: 5, groupName: 'Underwriters', tenantId: 1 }],
  tenantAssignments: [{ tenantId: 1, tenantName: 'Brittany Insurance' }],
  effectivePermissionsByTenant: { global: [], '1': ['leads.view'] },
};

function renderPage(
  permissions: string[],
  options: { extraMemberships?: Array<{ tenantId: number; tenantName: string }>; globalPermissions?: string[] } = {},
) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'admin@brittany.test', firstName: 'Admin', lastName: 'User' },
      memberships: [
        { tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions },
        ...(options.extraMemberships ?? []).map((membership) => ({
          ...membership,
          currencyCode: 'BWP',
          currencySymbol: 'BWP',
          permissions,
        })),
      ],
      globalPermissions: options.globalPermissions ?? [],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/admin/users/42']}>
        <Routes>
          <Route path="/admin/users/:userId" element={<UserDetailPage />} />
          <Route path="/admin/users" element={<div data-testid="user-list-route" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

/**
 * User edit save path (spec FR-13/FR-14, AC-012/AC-013, verification.json V-012/V-013, T-015
 * F-048): `handleSave` had zero automated coverage; these tests exercise
 * `UserDetailPage.tsx:101-121` directly, asserting the full-replace `PUT /users/{id}` payload the
 * page assembles from the tabs' loaded starting state (direct roles/permissions/groups/tenant
 * assignments), and that a rejected save surfaces inline without crashing.
 */
describe('UserDetailPage', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockReset().mockResolvedValue(USER);
    vi.mocked(getEffectiveAccess).mockReset().mockResolvedValue(ACCESS);
    vi.mocked(listRoles).mockReset().mockResolvedValue([{ id: 2, tenantId: 1, name: 'Underwriter', isActive: true, permissionCodes: [] }]);
    vi.mocked(listGroups).mockReset().mockResolvedValue([{ id: 5, tenantId: 1, name: 'Underwriters', isActive: true }]);
    vi.mocked(updateUser).mockReset();
  });

  it('save_WhenClicked_ShouldCallUpdateUserWithFullReplacePayloadFromLoadedAccess', async () => {
    // Arrange
    vi.mocked(updateUser).mockResolvedValue(USER);
    renderPage(['users.view', 'users.edit']);
    await screen.findByTestId('user-detail-page');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert: full-replace payload assembled from the profile fields plus the direct
    // roles/permissions/groups/tenant assignments loaded from GET /users/{id}/effective-access,
    // each role/permission tagged with the active tenant id (UserDetailPage.tsx:105-113).
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith(42, {
        firstName: 'E2E',
        lastName: 'User',
        tenantIds: [1],
        roleAssignments: [{ roleId: 2, tenantId: 1 }],
        permissionAssignments: [{ permissionCode: 'leads.view', tenantId: 1 }],
        groupIds: [5],
      }),
    );
  });

  it('save_WhenAssignmentInForeignScope_ShouldOmitItAndRelyOnServerPreservation', async () => {
    // Arrange: a tenant-1 caller (no cross-tenant capability) edits a user who also holds a
    // tenant-2 role. That scope is outside the caller's sphere: it must NOT be submitted — the
    // server preserves foreign-scope rows untouched (users/service.ts, F-027 extended) — and the
    // scope dropdown must not appear for the single editable scope.
    vi.mocked(listRoles).mockReset().mockResolvedValue([
      { id: 2, tenantId: 1, name: 'Underwriter', isActive: true, permissionCodes: [] },
      { id: 7, tenantId: 2, name: 'Admin', isActive: true, permissionCodes: [] },
    ]);
    vi.mocked(getEffectiveAccess).mockReset().mockResolvedValue({
      ...ACCESS,
      directRoles: [
        { roleId: 2, roleName: 'Underwriter', tenantId: 1 },
        { roleId: 7, roleName: 'Admin', tenantId: 2 },
      ],
    });
    vi.mocked(updateUser).mockResolvedValue(USER);
    renderPage(['users.view', 'users.edit']);
    await screen.findByTestId('user-detail-page');

    // Act
    expect(screen.queryByTestId('assignment-scope-select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert: only the tenant-1 slice travels; tenant 2's role is preserved server-side.
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ roleAssignments: [{ roleId: 2, tenantId: 1 }], tenantIds: [1] }),
      ),
    );
  });

  it('scopeDropdown_WhenCrossTenantCallerEditsMultiTenantUser_ShouldFollowTenantsTabAndSaveAllScopes', async () => {
    // Arrange: an Internal caller (global.view_any_tenant) edits a user assigned to tenants 1 and
    // 2 with a role in each. The Roles tab gets a scope dropdown (Global + both tenants); picks
    // are remembered per scope; deselecting a tenant on the Tenants tab removes its scope option
    // (and its picks from the payload), reselecting restores both.
    vi.mocked(getUser).mockReset().mockResolvedValue({ ...USER, tenantIds: [1, 2] });
    vi.mocked(listRoles).mockReset().mockResolvedValue([
      { id: 2, tenantId: 1, name: 'Underwriter', isActive: true, permissionCodes: [] },
      { id: 7, tenantId: 2, name: 'Admin', isActive: true, permissionCodes: [] },
    ]);
    vi.mocked(getEffectiveAccess).mockReset().mockResolvedValue({
      ...ACCESS,
      directRoles: [
        { roleId: 2, roleName: 'Underwriter', tenantId: 1 },
        { roleId: 7, roleName: 'Admin', tenantId: 2 },
      ],
      directPermissions: [],
      groups: [],
    });
    vi.mocked(updateUser).mockResolvedValue(USER);
    renderPage(['users.view', 'users.edit', 'global.view_any_tenant'], {
      extraMemberships: [{ tenantId: 2, tenantName: 'Atlantic Risk' }],
      globalPermissions: ['global.view_any_tenant'],
    });
    await screen.findByTestId('user-detail-page');

    // Act: the Roles tab shows the scope dropdown, defaulting to the active tenant (1).
    fireEvent.click(screen.getByTestId('tab-roles'));
    const scopeSelect = screen.getByTestId('assignment-scope-select');
    expect(within(scopeSelect).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Global',
      'Brittany Insurance',
      'Atlantic Risk',
    ]);
    expect(screen.getByLabelText(/Underwriter/)).toBeChecked();

    // Switch to tenant 2's scope: its role list and remembered pick replace tenant 1's.
    fireEvent.change(scopeSelect, { target: { value: '2' } });
    expect(screen.queryByLabelText(/Underwriter/)).toBeNull();
    expect(screen.getByLabelText(/Admin/)).toBeChecked();

    // Switch back: tenant 1's pick was remembered.
    fireEvent.change(scopeSelect, { target: { value: '1' } });
    expect(screen.getByLabelText(/Underwriter/)).toBeChecked();

    // Deselect tenant 2 on the Tenants tab -> its scope option disappears...
    fireEvent.click(screen.getByTestId('tab-tenants'));
    fireEvent.click(screen.getByLabelText('Atlantic Risk'));
    fireEvent.click(screen.getByTestId('tab-roles'));
    expect(
      within(screen.getByTestId('assignment-scope-select'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Global', 'Brittany Insurance']);

    // ...and reselecting brings the scope AND its remembered pick back.
    fireEvent.click(screen.getByTestId('tab-tenants'));
    fireEvent.click(screen.getByLabelText('Atlantic Risk'));
    fireEvent.click(screen.getByTestId('tab-roles'));
    fireEvent.change(screen.getByTestId('assignment-scope-select'), { target: { value: '2' } });
    expect(screen.getByLabelText(/Admin/)).toBeChecked();

    // Save: every reachable scope's picks travel together, each tagged with its own tenant.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          tenantIds: [1, 2],
          roleAssignments: [
            { roleId: 2, tenantId: 1 },
            { roleId: 7, tenantId: 2 },
          ],
        }),
      ),
    );
  });

  it('save_WhenFirstNameEdited_ShouldCallUpdateUserWithEditedValue', async () => {
    // Arrange
    vi.mocked(updateUser).mockResolvedValue(USER);
    renderPage(['users.view', 'users.edit']);
    await screen.findByTestId('user-detail-page');

    // Act
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith(42, expect.objectContaining({ firstName: 'Edited' })),
    );
  });

  it('save_WhenServerRejectsWith403_ShouldShowInlineErrorBannerNotCrash', async () => {
    // Arrange: server 403 (e.g. exceeds-caller-grant) must surface inline via ErrorBanner without
    // throwing (UserDetailPage.tsx:116-118 catch -> setFormError -> ErrorBanner).
    vi.mocked(updateUser).mockRejectedValue({
      status: 403,
      title: 'USER_PERMISSION_EXCEEDS_CALLER_GRANT: Caller cannot grant this permission to the user.',
      fieldErrors: [],
    });
    renderPage(['users.view', 'users.edit']);
    await screen.findByTestId('user-detail-page');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByTestId('error-banner')).toBeInTheDocument();
    expect(screen.getByText(/USER_PERMISSION_EXCEEDS_CALLER_GRANT/)).toBeInTheDocument();
    expect(screen.getByTestId('user-detail-page')).toBeInTheDocument();
  });

  it('save_WhenValidationErrorReturned_ShouldShowInlineErrorAndNotCrash', async () => {
    // Arrange: a 422 validation failure follows the same inline-surfacing path as a 403.
    vi.mocked(updateUser).mockRejectedValue({
      status: 422,
      title: 'USER_VALIDATION_FAILED: At least one tenant is required.',
      fieldErrors: [{ field: 'tenantIds', message: 'At least one tenant is required.' }],
    });
    renderPage(['users.view', 'users.edit']);
    await screen.findByTestId('user-detail-page');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByTestId('error-banner')).toBeInTheDocument();
    expect(screen.getByText(/USER_VALIDATION_FAILED/)).toBeInTheDocument();
  });
});
