import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { disableRole, getRoleUsage, listRoles, type RoleDto, type RoleUsageDto } from './rolesApi';
import StatusChip from '../../components/common/StatusChip';
import SortableTh from '../../components/common/SortableTh';
import { useClientSort, type SortAccessors } from '../../components/common/useClientSort';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { useToast } from '../../components/common/Toast';
import RoleUsageDialog from './RoleUsageDialog';
import UserManagerNav from './UserManagerNav';

type RoleSortField = 'name' | 'scope' | 'permissions' | 'status';

const ROLE_SORT_ACCESSORS: SortAccessors<RoleDto, RoleSortField> = {
  name: (role) => role.name,
  scope: (role) => (role.tenantId === null ? 'Global' : 'Tenant'),
  permissions: (role) => role.permissionCodes.length,
  status: (role) => (role.isActive ? 'Active' : 'Disabled'),
};

/**
 * Role Manager list screen (spec FR-12/FR-13, AC-012, verification.json V-012), sibling to
 * `/admin/users` and `/admin/groups` under the User Manager section (T-015 scope): name/scope/
 * status table with the usage-before-disable dialog (T-007 `GET /roles/{id}/usage`).
 */
function RoleListPage() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const canManage = useAppSelector(selectHasPermission(PermissionCodes.RolesManage));

  const [roles, setRoles] = useState<RoleDto[]>([]);
  const { sorted: sortedRoles, sort, toggle: toggleSort } = useClientSort(roles, ROLE_SORT_ACCESSORS, {
    field: 'name',
    direction: 'asc',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<RoleDto | null>(null);
  const [usage, setUsage] = useState<RoleUsageDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listRoles()
      .then((result) => setRoles(result))
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load roles.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openDisableDialog(role: RoleDto): Promise<void> {
    setDisableTarget(role);
    setUsage(null);
    try {
      const result = await getRoleUsage(role.id);
      setUsage(result);
    } catch {
      setUsage({ users: [], groups: [] });
    }
  }

  async function handleDisableConfirm(): Promise<void> {
    if (!disableTarget) {
      return;
    }
    setBusy(true);
    try {
      const inUse = (usage?.users.length ?? 0) > 0 || (usage?.groups.length ?? 0) > 0;
      await disableRole(disableTarget.id, inUse);
      showSuccess(`Role ${disableTarget.name} disabled`);
      setDisableTarget(null);
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to disable role.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="page-admin-roles">
      <UserManagerNav />
      <div className="qiq-page-head">
        <h2>Roles</h2>
        {canManage && (
          <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/roles/new')}>
            + New Role
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && loading && <SkeletonTable rows={5} columns={4} />}

      {!error && !loading && roles.length === 0 && (
        <EmptyState
          message="No roles yet."
          actions={
            canManage ? (
              <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/roles/new')}>
                + New Role
              </button>
            ) : undefined
          }
        />
      )}

      {!error && !loading && roles.length > 0 && (
        <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table data-testid="role-list">
          <thead>
            <tr>
              <SortableTh field="name" label="Name" sort={sort} onSort={toggleSort} />
              <SortableTh field="scope" label="Scope" sort={sort} onSort={toggleSort} />
              <SortableTh field="permissions" label="Permissions" sort={sort} onSort={toggleSort} />
              <SortableTh field="status" label="Status" sort={sort} onSort={toggleSort} />
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedRoles.map((role) => (
              <tr key={role.id} className="qiq-row-clickable" onClick={() => navigate(`/admin/roles/${role.id}`)}>
                <td>{role.name}</td>
                <td>{role.tenantId === null ? 'Global' : 'Tenant'}</td>
                <td>{role.permissionCodes.length}</td>
                <td>
                  <StatusChip label={role.isActive ? 'Active' : 'Disabled'} category={role.isActive ? 'won' : 'expired'} />
                </td>
                <td onClick={(event) => event.stopPropagation()}>
                  <div className="qiq-row-actions">
                    <button type="button" className="qiq-btn qiq-btn--sm" onClick={() => navigate(`/admin/roles/${role.id}`)}>
                      Edit
                    </button>
                    {canManage && role.isActive && (
                      <button type="button" className="qiq-btn qiq-btn--sm qiq-btn--danger-soft" onClick={() => void openDisableDialog(role)}>
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

      <RoleUsageDialog
        open={disableTarget !== null}
        roleName={disableTarget?.name ?? ''}
        usage={usage}
        busy={busy}
        onConfirm={() => void handleDisableConfirm()}
        onCancel={() => setDisableTarget(null)}
      />
    </div>
  );
}

export default RoleListPage;
