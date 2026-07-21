import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission, selectSession } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { deactivateUser, listUsers, type UserDto } from './usersApi';
import StatusChip from '../../components/common/StatusChip';
import SortableTh from '../../components/common/SortableTh';
import { useClientSort, type SortAccessors } from '../../components/common/useClientSort';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { useToast } from '../../components/common/Toast';
import DeactivateUserDialog from './DeactivateUserDialog';
import UserManagerNav from './UserManagerNav';

type UserSortField = 'name' | 'email' | 'tenants' | 'status';

const USER_SORT_ACCESSORS: SortAccessors<UserDto, UserSortField> = {
  name: (user) => `${user.firstName} ${user.lastName}`,
  email: (user) => user.email,
  tenants: (user) => user.tenantIds.length,
  status: (user) => (user.isActive ? 'Active' : 'Inactive'),
};

/**
 * User Manager list screen (spec FR-13, PRD 20.1.1, AC-012, verification.json V-012). Route
 * `/admin/users`. `GET /users` (T-007 `ListUsersQueryHandler`) already returns the tenant-filtered
 * set for ordinary tenant-scoped callers and every user for cross-tenant (Internal) callers — this
 * screen renders whichever set the server returns rather than filtering client-side.
 */
function UserListPage() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const canInvite = useAppSelector(selectHasPermission(PermissionCodes.UsersInvite));
  const canDeactivate = useAppSelector(selectHasPermission(PermissionCodes.UsersDeactivate));
  // Self-lockout affordance: the server rejects self-deactivation (USER_CANNOT_DEACTIVATE_SELF),
  // so don't offer the action on the caller's own row.
  const ownUserId = useAppSelector(selectSession).user?.userId;

  const [users, setUsers] = useState<UserDto[]>([]);
  const { sorted: sortedUsers, sort, toggle: toggleSort } = useClientSort(users, USER_SORT_ACCESSORS, {
    field: 'name',
    direction: 'asc',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<UserDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listUsers()
      .then((result) => setUsers(result))
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load users.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDeactivateConfirm(): Promise<void> {
    if (!deactivateTarget) {
      return;
    }
    setBusy(true);
    try {
      await deactivateUser(deactivateTarget.id);
      showSuccess(`User ${deactivateTarget.email} deactivated`);
      setDeactivateTarget(null);
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to deactivate user.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="page-admin-users">
      <UserManagerNav />
      {/* Page title lives in the shell top bar (pageTitles.ts) — this row only carries the actions. */}
      <div className="qiq-page-head" style={{ justifyContent: 'flex-end' }}>
        {canInvite && (
          <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/users/new')}>
            + New User
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && loading && <SkeletonTable rows={5} columns={5} />}

      {!error && !loading && users.length === 0 && (
        <EmptyState
          message="No users match the current filters."
          actions={
            canInvite ? (
              <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/users/new')}>
                + New User
              </button>
            ) : undefined
          }
        />
      )}

      {!error && !loading && users.length > 0 && (
        <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table data-testid="user-list">
          <thead>
            <tr>
              <SortableTh field="name" label="Name" sort={sort} onSort={toggleSort} />
              <SortableTh field="email" label="Email" sort={sort} onSort={toggleSort} />
              <SortableTh field="tenants" label="Tenants" sort={sort} onSort={toggleSort} />
              <SortableTh field="status" label="Status" sort={sort} onSort={toggleSort} />
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((user) => (
              <tr key={user.id} className="qiq-row-clickable" onClick={() => navigate(`/admin/users/${user.id}`)}>
                <td>
                  {user.firstName} {user.lastName}
                </td>
                <td>{user.email}</td>
                <td>{user.tenantIds.length}</td>
                <td>
                  <StatusChip label={user.isActive ? 'Active' : 'Inactive'} category={user.isActive ? 'won' : 'expired'} />
                </td>
                <td onClick={(event) => event.stopPropagation()}>
                  <div className="qiq-row-actions">
                    <button type="button" className="qiq-btn qiq-btn--sm" onClick={() => navigate(`/admin/users/${user.id}`)}>
                      View
                    </button>
                    {canDeactivate && user.isActive && user.id !== ownUserId && (
                      <button type="button" className="qiq-btn qiq-btn--sm qiq-btn--danger-soft" onClick={() => setDeactivateTarget(user)}>
                        Deactivate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <DeactivateUserDialog
        open={deactivateTarget !== null}
        userEmail={deactivateTarget?.email ?? ''}
        busy={busy}
        onConfirm={() => void handleDeactivateConfirm()}
        onCancel={() => setDeactivateTarget(null)}
      />
    </div>
  );
}

export default UserListPage;
