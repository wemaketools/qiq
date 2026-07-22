import { useEffect, useMemo, useState } from 'react';
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
import { scopeLabel } from './scopeLabel';
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
 * One assignment scope: `'global'` for tenant-less (Internal) grants, otherwise a tenant id as a
 * string. Used as the key of the per-scope selection maps below.
 */
const GLOBAL_SCOPE = 'global';

function scopeKeyOf(tenantId: number | null): string {
  return tenantId === null ? GLOBAL_SCOPE : String(tenantId);
}

/**
 * User detail/edit screen (spec FR-13/FR-14, AC-012/AC-013, verification.json V-012/V-013). Route
 * `/admin/users/{id}` with tabs Profile / Tenants / Roles / Permissions / Groups / Effective access
 * per the T-015 task brief. `GET /users/{id}` supplies the profile; `GET /users/{id}/effective-access`
 * (T-007) supplies every other tab's starting data — a single "Save" replaces the full desired state
 * via `PUT /users/{id}` (`UpdateUserCommand` is a full-replace command, not a per-field patch), so
 * edits made across tabs are submitted together.
 *
 * PER-TENANT ASSIGNMENTS (2026-07-21 decision): the Roles / Permissions / Groups tabs are scoped.
 * When more than one scope is reachable, a tenant dropdown appears on those tabs; its options
 * follow the Tenants tab live (deselect a tenant and its scope disappears, reselect and it — and
 * any picks made under it — return). Selections are kept per scope in `rolesByScope` /
 * `permissionsByScope`, and Save submits every reachable scope's picks at once as per-assignment
 * `{tenantId}` entries. Group membership is scope-less in the data model (a group belongs to a
 * tenant), so the Groups tab filters the group list per scope instead of keying selections by it.
 *
 * A caller WITHOUT `global.view_any_tenant` sees and submits only their active tenant's scope; the
 * server preserves every other scope's rows untouched (users/service.ts, F-027 extended), so a
 * partial payload cannot strip another tenant's assignments.
 */
function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const id = Number(userId);
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const canEdit = useAppSelector(selectHasPermission(PermissionCodes.UsersEdit));
  const canDeactivate = useAppSelector(selectHasPermission(PermissionCodes.UsersDeactivate));
  const canCrossTenant = useAppSelector(selectHasPermission(PermissionCodes.GlobalViewAnyTenant));
  // Self-lockout affordance: the server rejects self-deactivation (USER_CANNOT_DEACTIVATE_SELF),
  // so don't offer the action on the caller's own detail page.
  const isSelf = useAppSelector(selectSession).user?.userId === id;
  const activeTenant = useAppSelector(selectActiveTenant);
  const session = useAppSelector(selectSession);

  const [activeTab, setActiveTab] = useState<TabKey>('profile');
  const [user, setUser] = useState<UserDto | null>(null);
  const [access, setAccess] = useState<EffectiveAccessDto | null>(null);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [groups, setGroups] = useState<GroupDto[]>([]);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [tenantIds, setTenantIds] = useState<number[]>([]);
  const [rolesByScope, setRolesByScope] = useState<Record<string, number[]>>({});
  const [permissionsByScope, setPermissionsByScope] = useState<Record<string, string[]>>({});
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [assignmentScope, setAssignmentScope] = useState<string>('');

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

        const loadedRoles: Record<string, number[]> = {};
        for (const assignment of accessDto.directRoles) {
          (loadedRoles[scopeKeyOf(assignment.tenantId)] ??= []).push(assignment.roleId);
        }
        const loadedPermissions: Record<string, string[]> = {};
        for (const assignment of accessDto.directPermissions) {
          (loadedPermissions[scopeKeyOf(assignment.tenantId)] ??= []).push(
            assignment.permissionCode,
          );
        }
        setRolesByScope(loadedRoles);
        setPermissionsByScope(loadedPermissions);
        setGroupIds(accessDto.groups.map((g) => g.groupId));
      })
      .catch((err: unknown) => setLoadError((err as NormalizedError).title ?? 'Unable to load this user.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * The scopes this CALLER may edit, following the Tenants tab live. A non-cross-tenant caller's
   * sphere is the active tenant only — the server refuses any other scope and preserves it
   * untouched instead — while a cross-tenant caller edits every assigned tenant plus the Global
   * scope (tenant-less grants for Internal-style users).
   */
  const scopeOptions = useMemo(() => {
    const options: Array<{ key: string; label: string }> = [];
    if (canCrossTenant) {
      options.push({ key: GLOBAL_SCOPE, label: 'Global' });
    }
    const editableTenantIds = canCrossTenant
      ? tenantIds
      : tenantIds.filter((tenantId) => tenantId === activeTenant?.tenantId);
    for (const tenantId of editableTenantIds) {
      options.push({ key: String(tenantId), label: scopeLabel(tenantId, session.memberships) });
    }
    return options;
  }, [canCrossTenant, tenantIds, activeTenant, session.memberships]);

  // Keep the selected scope valid as the Tenants tab changes: prefer the active tenant, fall back
  // to the first option. Selections for a scope that dropped out of the list are KEPT in state —
  // reselecting the tenant brings them back — they are simply not submitted while unreachable.
  // Gated on `loading` so the pre-load option list (before `tenantIds` arrives) cannot lock in a
  // default the loaded data would not have produced.
  useEffect(() => {
    if (loading) return;
    if (scopeOptions.some((option) => option.key === assignmentScope)) return;
    const activeKey = activeTenant !== null ? String(activeTenant.tenantId) : '';
    const preferred = scopeOptions.some((option) => option.key === activeKey)
      ? activeKey
      : (scopeOptions[0]?.key ?? '');
    setAssignmentScope(preferred);
  }, [loading, scopeOptions, assignmentScope, activeTenant]);

  const scopeTenantId = assignmentScope === GLOBAL_SCOPE ? null : Number(assignmentScope);

  /** Rows offered under the current scope: the scope's own rows plus (for tenants) global ones. */
  const scopeRoles =
    assignmentScope === GLOBAL_SCOPE
      ? roles.filter((role) => role.tenantId === null)
      : roles.filter((role) => role.tenantId === null || role.tenantId === scopeTenantId);
  const scopeGroups =
    assignmentScope === GLOBAL_SCOPE
      ? groups.filter((group) => group.tenantId === null)
      : groups.filter((group) => group.tenantId === null || group.tenantId === scopeTenantId);

  /**
   * Grant-no-higher-than-self affordance per scope: the caller's own permission set in that tenant
   * (from GET /me), or their global set for the Global scope and for tenants they are not a member
   * of (a cross-tenant caller's effective set there IS their global set). The server remains the
   * authority either way.
   */
  const grantableCodes = useMemo(() => {
    if (assignmentScope === GLOBAL_SCOPE) return session.globalPermissions;
    const membership = session.memberships.find((m) => String(m.tenantId) === assignmentScope);
    return membership !== undefined ? membership.permissions : session.globalPermissions;
  }, [assignmentScope, session.memberships, session.globalPermissions]);

  function renderScopeSelect() {
    if (scopeOptions.length <= 1) return null;
    return (
      <div className="qiq-field" style={{ maxWidth: '320px', marginBottom: 'var(--qiq-space-4)' }}>
        <label htmlFor="assignment-scope">Tenant</label>
        <select
          id="assignment-scope"
          data-testid="assignment-scope-select"
          value={assignmentScope}
          onChange={(event) => setAssignmentScope(event.target.value)}
        >
          {scopeOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  async function handleSave(): Promise<void> {
    setFormError(null);
    setSaving(true);
    try {
      const scopeKeys = scopeOptions.map((option) => option.key);
      // Every reachable scope's picks are submitted together; scopes outside the caller's sphere
      // are deliberately absent — the server preserves them (F-027 extended).
      const roleAssignments = scopeKeys.flatMap((key) =>
        (rolesByScope[key] ?? []).map((roleId) => ({
          roleId,
          tenantId: key === GLOBAL_SCOPE ? null : Number(key),
        })),
      );
      const permissionAssignments = scopeKeys.flatMap((key) =>
        (permissionsByScope[key] ?? []).map((permissionCode) => ({
          permissionCode,
          tenantId: key === GLOBAL_SCOPE ? null : Number(key),
        })),
      );
      // Group membership is flat; submit only memberships in reachable groups (a deselected
      // tenant's groups drop out, a foreign tenant's are preserved server-side).
      const submittedGroupIds = groupIds.filter((groupId) => {
        const group = groups.find((candidate) => candidate.id === groupId);
        if (group === undefined) return false;
        return group.tenantId === null || scopeKeys.includes(String(group.tenantId));
      });

      await updateUser(id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        tenantIds: canCrossTenant
          ? tenantIds
          : tenantIds.filter((tenantId) => tenantId === activeTenant?.tenantId),
        roleAssignments,
        permissionAssignments,
        groupIds: submittedGroupIds,
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

  const selectedScopeRoleIds = rolesByScope[assignmentScope] ?? [];
  const selectedScopePermissions = permissionsByScope[assignmentScope] ?? [];

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
                    disabled={
                      !canEdit ||
                      (!canCrossTenant && membership.tenantId !== activeTenant?.tenantId)
                    }
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
            <section data-testid="tab-panel-roles">
              {renderScopeSelect()}
              <div className="qiq-check-list">
                {scopeRoles.map((role) => (
                  <label key={role.id} htmlFor={`user-detail-role-${role.id}`}>
                    <input
                      id={`user-detail-role-${role.id}`}
                      type="checkbox"
                      disabled={!canEdit}
                      checked={selectedScopeRoleIds.includes(role.id)}
                      onChange={(event) =>
                        setRolesByScope((current) => ({
                          ...current,
                          [assignmentScope]: event.target.checked
                            ? [...(current[assignmentScope] ?? []), role.id]
                            : (current[assignmentScope] ?? []).filter((roleId) => roleId !== role.id),
                        }))
                      }
                    />
                    {' '}
                    {role.name} — {scopeLabel(role.tenantId, session.memberships)}
                  </label>
                ))}
              </div>
            </section>
          )}

          {activeTab === 'permissions' && (
            <section data-testid="tab-panel-permissions">
              {renderScopeSelect()}
              <PermissionPicker
                selected={selectedScopePermissions}
                onChange={(codes) =>
                  setPermissionsByScope((current) => ({ ...current, [assignmentScope]: codes }))
                }
                grantableCodes={grantableCodes}
                disabled={!canEdit}
              />
            </section>
          )}

          {activeTab === 'groups' && (
            <section data-testid="tab-panel-groups">
              {renderScopeSelect()}
              <div className="qiq-check-list">
                {scopeGroups.map((group) => (
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
                    {group.name} — {scopeLabel(group.tenantId, session.memberships)}
                  </label>
                ))}
              </div>
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
