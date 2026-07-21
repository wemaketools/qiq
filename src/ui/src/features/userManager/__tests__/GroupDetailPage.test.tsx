import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import GroupDetailPage from '../GroupDetailPage';
import {
  addGroupMember,
  getGroup,
  removeGroupMember,
  setGroupPermissions,
  type GroupDetailDto,
} from '../groupsApi';
import { listRoles } from '../rolesApi';
import { listUsers } from '../usersApi';

vi.mock('../groupsApi', () => ({
  getGroup: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  addGroupMember: vi.fn(),
  removeGroupMember: vi.fn(),
  setGroupRoles: vi.fn(),
  setGroupPermissions: vi.fn(),
}));

vi.mock('../rolesApi', () => ({
  listRoles: vi.fn(),
}));

vi.mock('../usersApi', () => ({
  listUsers: vi.fn(),
}));

const showSuccess = vi.fn();
const showError = vi.fn();

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess, showError }),
}));

const GROUP: GroupDetailDto = {
  id: 5,
  tenantId: 1,
  name: 'Underwriters',
  isActive: true,
  memberUserIds: [10],
  roleIds: [2],
  permissionCodes: ['leads.view'],
};

const GROUP_WITH_NEW_MEMBER: GroupDetailDto = { ...GROUP, memberUserIds: [10, 11] };
const GROUP_WITHOUT_MEMBER: GroupDetailDto = { ...GROUP, memberUserIds: [] };

const USERS = [
  { id: 10, firstName: 'Member', lastName: 'One', email: 'member@brittany.test', isActive: true, tenantIds: [1] },
  { id: 11, firstName: 'Candidate', lastName: 'Two', email: 'candidate@brittany.test', isActive: true, tenantIds: [1] },
];

const ROLES = [{ id: 2, tenantId: 1, name: 'Underwriter', isActive: true, permissionCodes: [] }];

function renderPage(permissions: string[]) {
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
      <MemoryRouter initialEntries={['/admin/groups/5']}>
        <Routes>
          <Route path="/admin/groups/:groupId" element={<GroupDetailPage />} />
          <Route path="/admin/groups" element={<div data-testid="group-list-route" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

/**
 * Group members/roles/permissions management (spec FR-13, AC-012/AC-013, verification.json V-013,
 * T-015 F-048): the add/remove-member and save-permissions handlers previously had zero automated
 * coverage; these tests exercise `GroupDetailPage.tsx:118-165` directly.
 */
describe('GroupDetailPage', () => {
  beforeEach(() => {
    vi.mocked(getGroup).mockReset();
    vi.mocked(addGroupMember).mockReset();
    vi.mocked(removeGroupMember).mockReset();
    vi.mocked(setGroupPermissions).mockReset();
    vi.mocked(listUsers).mockReset().mockResolvedValue(USERS);
    vi.mocked(listRoles).mockReset().mockResolvedValue(ROLES);
    showSuccess.mockReset();
    showError.mockReset();
  });

  it('addMember_WhenUserSelected_ShouldCallAddGroupMemberAndRefreshTable', async () => {
    // Arrange: GroupDetailPage.tsx:118-129 handleAddMember -> POST /groups/{id}/members
    vi.mocked(getGroup).mockResolvedValueOnce(GROUP).mockResolvedValueOnce(GROUP_WITH_NEW_MEMBER);
    vi.mocked(addGroupMember).mockResolvedValue(undefined);
    renderPage(['groups.manage']);
    await screen.findByTestId('group-members-table');

    // Act
    fireEvent.change(screen.getByLabelText('Add member'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    // Assert: correct endpoint args
    await waitFor(() => expect(addGroupMember).toHaveBeenCalledWith(5, 11));
    // Assert: table updates to reflect the new member once the group is reloaded
    await waitFor(() => expect(screen.getByTestId('group-members-table')).toHaveTextContent('candidate@brittany.test'));
    expect(screen.getByTestId('group-members-table')).toHaveTextContent('member@brittany.test');
  });

  it('addMember_WhenServerRejectsExceedsCallerGrant_ShouldSurfaceErrorGracefullyWithoutCrashing', async () => {
    // Arrange: a 403 (exceeds-caller-grant / not-found) must not throw an unhandled rejection or
    // crash the page -- GroupDetailPage surfaces it via the shared toast error channel, consistent
    // with every other action handler in this component (handleRemoveMember/handleSaveRoles/
    // handleSavePermissions all follow the same catch -> showError pattern).
    vi.mocked(getGroup).mockResolvedValue(GROUP);
    vi.mocked(addGroupMember).mockRejectedValue({
      status: 403,
      title: 'GROUP_MEMBER_EXCEEDS_CALLER_GRANT: Caller cannot add this member to the group.',
      fieldErrors: [],
    });
    renderPage(['groups.manage']);
    await screen.findByTestId('group-members-table');

    // Act
    fireEvent.change(screen.getByLabelText('Add member'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    // Assert: page stays mounted (no crash) and the error is surfaced
    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith('GROUP_MEMBER_EXCEEDS_CALLER_GRANT: Caller cannot add this member to the group.'),
    );
    expect(screen.getByTestId('group-detail-page')).toBeInTheDocument();
  });

  it('removeMember_WhenClicked_ShouldCallRemoveGroupMemberAndRefreshTable', async () => {
    // Arrange: GroupDetailPage.tsx:131-141 handleRemoveMember -> POST /groups/{id}/members/{userId}/remove
    vi.mocked(getGroup).mockResolvedValueOnce(GROUP).mockResolvedValueOnce(GROUP_WITHOUT_MEMBER);
    vi.mocked(removeGroupMember).mockResolvedValue(undefined);
    renderPage(['groups.manage']);
    await screen.findByText('member@brittany.test');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    // Assert: correct endpoint args
    await waitFor(() => expect(removeGroupMember).toHaveBeenCalledWith(5, 10));
    // Assert: the members table (not the "add member" candidate dropdown, which now legitimately
    // lists the removed user again) no longer shows the removed member.
    await waitFor(() =>
      expect(within(screen.getByTestId('group-members-table')).queryByText('member@brittany.test')).not.toBeInTheDocument(),
    );
  });

  it('savePermissions_WhenPermissionsSelected_ShouldCallSetGroupPermissionsWithSelectedCodes', async () => {
    // Arrange: GroupDetailPage.tsx:155-165 handleSavePermissions -> POST /groups/{id}/permissions
    vi.mocked(getGroup).mockResolvedValue(GROUP);
    vi.mocked(setGroupPermissions).mockResolvedValue(undefined);
    renderPage(['groups.manage', 'leads.view', 'parties.view']);
    await screen.findByTestId('group-permissions-section');

    // Act: leads.view already selected (from GROUP.permissionCodes); additionally select parties.view
    fireEvent.click(screen.getByLabelText('parties.view'));
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));

    // Assert: called with exactly the selected codes
    await waitFor(() =>
      expect(setGroupPermissions).toHaveBeenCalledWith(5, expect.arrayContaining(['leads.view', 'parties.view'])),
    );
    const [, calledCodes] = vi.mocked(setGroupPermissions).mock.calls[0]!;
    expect(calledCodes).toHaveLength(2);
  });

  it('savePermissions_WhenServerRejects403_ShouldSurfaceErrorGracefullyWithoutCrashing', async () => {
    // Arrange
    vi.mocked(getGroup).mockResolvedValue(GROUP);
    vi.mocked(setGroupPermissions).mockRejectedValue({
      status: 403,
      title: 'GROUP_PERMISSION_EXCEEDS_CALLER_GRANT: Caller cannot grant this permission.',
      fieldErrors: [],
    });
    renderPage(['groups.manage', 'leads.view']);
    await screen.findByTestId('group-permissions-section');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));

    // Assert
    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith('GROUP_PERMISSION_EXCEEDS_CALLER_GRANT: Caller cannot grant this permission.'),
    );
    expect(screen.getByTestId('group-detail-page')).toBeInTheDocument();
  });
});
