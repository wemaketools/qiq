import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { disableGroup, listGroups, type GroupDto } from './groupsApi';
import StatusChip from '../../components/common/StatusChip';
import SortableTh from '../../components/common/SortableTh';
import { useClientSort, type SortAccessors } from '../../components/common/useClientSort';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { useToast } from '../../components/common/Toast';
import UserManagerNav from './UserManagerNav';

type GroupSortField = 'name' | 'status';

const GROUP_SORT_ACCESSORS: SortAccessors<GroupDto, GroupSortField> = {
  name: (group) => group.name,
  status: (group) => (group.isActive ? 'Active' : 'Disabled'),
};

/**
 * Group Manager list screen (spec FR-12/FR-13, AC-012, verification.json V-013), sibling to
 * `/admin/users` and `/admin/roles` under the User Manager section (T-015 scope).
 */
function GroupListPage() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const canManage = useAppSelector(selectHasPermission(PermissionCodes.GroupsManage));

  const [groups, setGroups] = useState<GroupDto[]>([]);
  const { sorted: sortedGroups, sort, toggle: toggleSort } = useClientSort(groups, GROUP_SORT_ACCESSORS, {
    field: 'name',
    direction: 'asc',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listGroups()
      .then((result) => setGroups(result))
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load groups.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDisable(group: GroupDto): Promise<void> {
    try {
      await disableGroup(group.id);
      showSuccess(`Group ${group.name} disabled`);
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to disable group.');
    }
  }

  return (
    <div data-testid="page-admin-groups">
      <UserManagerNav />
      <div className="qiq-page-head">
        <h2>Groups</h2>
        {canManage && (
          <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/groups/new')}>
            + New Group
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && loading && <SkeletonTable rows={5} columns={3} />}

      {!error && !loading && groups.length === 0 && (
        <EmptyState
          message="No groups yet."
          actions={
            canManage ? (
              <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/groups/new')}>
                + New Group
              </button>
            ) : undefined
          }
        />
      )}

      {!error && !loading && groups.length > 0 && (
        <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table data-testid="group-list">
          <thead>
            <tr>
              <SortableTh field="name" label="Name" sort={sort} onSort={toggleSort} />
              <SortableTh field="status" label="Status" sort={sort} onSort={toggleSort} />
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedGroups.map((group) => (
              <tr key={group.id} className="qiq-row-clickable" onClick={() => navigate(`/admin/groups/${group.id}`)}>
                <td>
                  <Link to={`/admin/groups/${group.id}`} onClick={(event) => event.stopPropagation()}>
                    {group.name}
                  </Link>
                </td>
                <td>
                  <StatusChip label={group.isActive ? 'Active' : 'Disabled'} category={group.isActive ? 'won' : 'expired'} />
                </td>
                <td onClick={(event) => event.stopPropagation()}>
                  <div className="qiq-row-actions">
                    <button type="button" className="qiq-btn qiq-btn--sm" onClick={() => navigate(`/admin/groups/${group.id}`)}>
                      Edit
                    </button>
                    {canManage && group.isActive && (
                      <button type="button" className="qiq-btn qiq-btn--sm qiq-btn--danger-soft" onClick={() => void handleDisable(group)}>
                        Disable
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
    </div>
  );
}

export default GroupListPage;
