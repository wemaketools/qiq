import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectHasPermission, selectSession } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import {
  deactivateUser,
  getEffectiveAccess,
  getUser,
  updateUser,
  type EffectiveAccessDto,
  type UserDto,
} from './usersApi';
import { listRoles, type RoleDto } from './rolesApi';
import { listGroups, type GroupDto } from './groupsApi';
import { useToast } from '../../components/common/Toast';
import ErrorBanner from '../../components/common/ErrorBanner';
import DeactivateUserDialog from './DeactivateUserDialog';
import EffectiveAccessTab from './EffectiveAccessTab';
import UserManagerNav from './UserManagerNav';
import PermissionPicker from './PermissionPicker';

type TabKey = 'profile' | 'tenants' | 'roles' | 'permissions' | 'groups' | 'effective-access';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'profile', label: 'Profile' },
  { key: 'tenants', label: 'Tenants' },
  { key: 'roles', label: 'Roles' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'groups', label: 'Groups' },
  { key: 'effective-access', label: 'Effective access' },
];

/**
 * User detail/edit screen (spec FR-13/FR-14, AC-012/AC-013, verification.json V-012/V-013). Route
 * `/admin/users/{id}` with tabs Profile / Tenants / Roles / Permissions / Groups / Effective access
 * per the T-015 task brief. `GET /users/{id}` supplies the profile; `GET /users/{id}/effective-access`
 * (T-007) supplies every other tab's starting data (direct roles/permissions/groups/tenant
 * assignments plus the resolved-per-tenant view) — a single "Save" replaces the full desired state
 * via `PUT /users/{id}` (`UpdateUserCommand` is a full-replace command, not a per-field patch), so
 * edits made across tabs are submitted together.
 */
function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const id = Number(userId);
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const canEdit = useAppSelector(selectHasPermission(PermissionCodes.UsersEdit));
  const canDeactivate = useAppSelector(selectHasPermission(PermissionCodes.UsersDeactivate));
  // Self-lockout affordance: the server rejects self-deactivation (USER_CANNOT_DEACTIVATE_SELF),
  // so don't offer the action on the caller's own detail page.
  const isSelf = useAppSelector(selectSession).user?.userId === id;
  const activeTenant = useAppSelector(selectActiveTenant);
  const session = useAppSelector(selectSession);
  const grantableCodes = activeTenant?.permissions ?? [];

  const [activeTab, setActiveTab] = useState<TabKey>('profile');
  const [user, setUser] = useState<UserDto | null>(null);
  const [access, setAccess] = useState<EffectiveAccessDto | null>(null);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [groups, setGroups] = useState<GroupDto[]>([]);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [tenantIds, setTenantIds] = useState<number[]>([]);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [permissionCodes, setPermissionCodes] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function load(): void {
    setLoading(true);
    setLoadError(null);
    Promise.all([getUser(id), getEffectiveAccess(id), listRoles(), listGroups()])
      .then(([userDto, accessDto, roleList, groupList]) => {
        setUser(userDto);
        setAccess(accessDto);
        setRoles(roleList);
        setGroups(groupList);
        setFirstName(userDto.firstName);
        setLastName(userDto.lastName);
        setTenantIds(userDto.tenantIds);
        setRoleIds(accessDto.directRoles.map((r) => r.roleId));
        setPermissionCodes(accessDto.directPermissions.map((p) => p.permissionCode));
        setGroupIds(accessDto.groups.map((g) => g.groupId));
      })
      .catch((err: unknown) => setLoadError((err as NormalizedError).title ?? 'Unable to load this user.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleSave(): Promise<void> {
    setFormError(null);
    setSaving(true);
    try {
      const assignmentTenantId = activeTenant?.tenantId ?? null;
      await updateUser(id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        tenantIds,
        roleAssignments: roleIds.map((roleId) => ({ roleId, tenantId: assignmentTenantId })),
        permissionAssignments: permissionCodes.map((permissionCode) => ({ permissionCode, tenantId: assignmentTenantId })),
        groupIds,
      });
      showSuccess('User updated');
      load();
    } catch (err) {
      setFormError((err as NormalizedError).title);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivateConfirm(): Promise<void> {
    setBusy(true);
    try {
      await deactivateUser(id);
      showSuccess('User deactivated');
      setDeactivateOpen(false);
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to deactivate user.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (loadError || !user || !access) {
    return <ErrorBanner message={loadError ?? 'User not found.'} onRetry={load} />;
  }

  return (
    <div data-testid="user-detail-page">
      <UserManagerNav />
      <div className="qiq-page-head">
        <h2>
          {user.firstName} {user.lastName} — {user.email}
        </h2>
        {canDeactivate && user.isActive && !isSelf && (
          <button type="button" className="qiq-btn qiq-btn--danger-soft" onClick={() => setDeactivateOpen(true)}>
            Deactivate
          </button>
        )}
      </div>

      {formError && <ErrorBanner message={formError} />}

      <div role="tablist" data-testid="user-detail-tabs" className="qiq-tabs" style={{ marginBottom: 'var(--qiq-space-4)' }}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            data-testid={`tab-${tab.key}`}
            className={activeTab === tab.key ? 'qiq-tab qiq-tab--active' : 'qiq-tab'}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="qiq-card" style={{ padding: 0 }}>
        <div style={{ padding: 'var(--qiq-space-5)' }}>
          {activeTab === 'profile' && (
            <section data-testid="tab-panel-profile" className="qiq-form-grid">
              <div className="qiq-field">
                <label htmlFor="user-detail-first-name">First name</label>
                <input
                  id="user-detail-first-name"
                  value={firstName}
                  disabled={!canEdit}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              </div>
              <div className="qiq-field">
                <label htmlFor="user-detail-last-name">Last name</label>
                <input
                  id="user-detail-last-name"
                  value={lastName}
                  disabled={!canEdit}
                  onChange={(event) => setLastName(event.target.value)}
                />
              </div>
              <div className="qiq-field">
                <label htmlFor="user-detail-email">Email</label>
                <input id="user-detail-email" value={user.email} disabled readOnly />
              </div>
            </section>
          )}

          {activeTab === 'tenants' && (
            <section data-testid="tab-panel-tenants" className="qiq-check-list">
              {session.memberships.map((membership) => (
                <label key={membership.tenantId} htmlFor={`user-detail-tenant-${membership.tenantId}`}>
                  <input
                    id={`user-detail-tenant-${membership.tenantId}`}
                    type="checkbox"
                    disabled={!canEdit}
                    checked={tenantIds.includes(membership.tenantId)}
                    onChange={(event) =>
                      setTenantIds((current) =>
                        event.target.checked
                          ? [...current, membership.tenantId]
                          : current.filter((tenantId) => tenantId !== membership.tenantId),
                      )
                    }
                  />
                  {' '}
                  {membership.tenantName}
                </label>
              ))}
            </section>
          )}

          {activeTab === 'roles' && (
            <section data-testid="tab-panel-roles" className="qiq-check-list">
              {roles.map((role) => (
                <label key={role.id} htmlFor={`user-detail-role-${role.id}`}>
                  <input
                    id={`user-detail-role-${role.id}`}
                    type="checkbox"
                    disabled={!canEdit}
                    checked={roleIds.includes(role.id)}
                    onChange={(event) =>
                      setRoleIds((current) =>
                        event.target.checked ? [...current, role.id] : current.filter((roleId) => roleId !== role.id),
                      )
                    }
                  />
                  {' '}
                  {role.name}
                </label>
              ))}
            </section>
          )}

          {activeTab === 'permissions' && (
            <section data-testid="tab-panel-permissions">
              <PermissionPicker
                selected={permissionCodes}
                onChange={setPermissionCodes}
                grantableCodes={grantableCodes}
                disabled={!canEdit}
              />
            </section>
          )}

          {activeTab === 'groups' && (
            <section data-testid="tab-panel-groups" className="qiq-check-list">
              {groups.map((group) => (
                <label key={group.id} htmlFor={`user-detail-group-${group.id}`}>
                  <input
                    id={`user-detail-group-${group.id}`}
                    type="checkbox"
                    disabled={!canEdit}
                    checked={groupIds.includes(group.id)}
                    onChange={(event) =>
                      setGroupIds((current) =>
                        event.target.checked ? [...current, group.id] : current.filter((groupId) => groupId !== group.id),
                      )
                    }
                  />
                  {' '}
                  {group.name}
                </label>
              ))}
            </section>
          )}

          {activeTab === 'effective-access' && <EffectiveAccessTab access={access} />}
        </div>

        <div
          data-testid="form-sticky-footer"
          className="qiq-sticky-footer"
        >
          <button type="button" className="qiq-btn" onClick={() => navigate('/admin/users')} disabled={saving}>
            Back
          </button>
          {canEdit && (
            <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => void handleSave()} disabled={saving}>
              Save
            </button>
          )}
        </div>
      </div>

      <DeactivateUserDialog
        open={deactivateOpen}
        userEmail={user.email}
        busy={busy}
        onConfirm={() => void handleDeactivateConfirm()}
        onCancel={() => setDeactivateOpen(false)}
      />
    </div>
  );
}

export default UserDetailPage;
