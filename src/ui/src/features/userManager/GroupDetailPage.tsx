import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import {
  addGroupMember,
  createGroup,
  getGroup,
  removeGroupMember,
  setGroupPermissions,
  setGroupRoles,
  updateGroup,
  type GroupDetailDto,
} from './groupsApi';
import { listRoles, type RoleDto } from './rolesApi';
import { listUsers, type UserDto } from './usersApi';
import { useToast } from '../../components/common/Toast';
import ErrorBanner from '../../components/common/ErrorBanner';
import PermissionPicker from './PermissionPicker';
import UserManagerNav from './UserManagerNav';

/**
 * Add/Edit group screen (spec FR-12/FR-13, AC-012/AC-013, verification.json V-013). Route
 * `/admin/groups/new` (create: name only) and `/admin/groups/{id}` (edit: adds members table with
 * add/remove via user search, a roles multi-select, and a direct-permissions picker — all wired to
 * `POST /groups/{id}/members`, `/members/{userId}/remove`, `/roles`, `/permissions`, T-007).
 */
function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const isEditMode = groupId !== undefined;

  const canManage = useAppSelector(selectHasPermission(PermissionCodes.GroupsManage));
  const activeTenant = useAppSelector(selectActiveTenant);
  const grantableCodes = activeTenant?.permissions ?? [];

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [group, setGroup] = useState<GroupDetailDto | null>(null);
  const [allUsers, setAllUsers] = useState<UserDto[]>([]);
  const [allRoles, setAllRoles] = useState<RoleDto[]>([]);
  const [selectedRoleIds, setSelectedRoleIds] = useState<number[]>([]);
  const [selectedPermissionCodes, setSelectedPermissionCodes] = useState<string[]>([]);
  const [newMemberUserId, setNewMemberUserId] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(isEditMode);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function loadDetail(id: number): void {
    setLoading(true);
    Promise.all([getGroup(id), listUsers(), listRoles()])
      .then(([groupDetail, users, roles]) => {
        setGroup(groupDetail);
        setName(groupDetail.name);
        setSelectedRoleIds(groupDetail.roleIds);
        setSelectedPermissionCodes(groupDetail.permissionCodes);
        setAllUsers(users);
        setAllRoles(roles);
      })
      .catch(() => setFormError('Unable to load this group.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (isEditMode && groupId !== undefined) {
      loadDetail(Number(groupId));
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, groupId]);

  const memberUsers = useMemo(
    () => allUsers.filter((user) => group?.memberUserIds.includes(user.id)),
    [allUsers, group],
  );
  const nonMemberUsers = useMemo(
    () => allUsers.filter((user) => !group?.memberUserIds.includes(user.id)),
    [allUsers, group],
  );

  function validateName(value: string): string | undefined {
    return value.trim().length === 0 ? 'Group name is required.' : undefined;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const error = validateName(name);
    setNameError(error ?? null);
    if (error) {
      return;
    }

    setSaving(true);
    try {
      if (isEditMode && groupId !== undefined) {
        await updateGroup(Number(groupId), name.trim());
        showSuccess(`Group ${name.trim()} updated`);
      } else {
        const created = await createGroup(name.trim());
        showSuccess(`Group ${name.trim()} created`);
        navigate(`/admin/groups/${created.id}`);
        return;
      }
    } catch (err) {
      setFormError((err as NormalizedError).title);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddMember(): Promise<void> {
    if (!groupId || newMemberUserId === '') {
      return;
    }
    try {
      await addGroupMember(Number(groupId), Number(newMemberUserId));
      setNewMemberUserId('');
      loadDetail(Number(groupId));
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to add member.');
    }
  }

  async function handleRemoveMember(userId: number): Promise<void> {
    if (!groupId) {
      return;
    }
    try {
      await removeGroupMember(Number(groupId), userId);
      loadDetail(Number(groupId));
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to remove member.');
    }
  }

  async function handleSaveRoles(): Promise<void> {
    if (!groupId) {
      return;
    }
    try {
      await setGroupRoles(Number(groupId), selectedRoleIds);
      showSuccess('Group roles updated');
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to update group roles.');
    }
  }

  async function handleSavePermissions(): Promise<void> {
    if (!groupId) {
      return;
    }
    try {
      await setGroupPermissions(Number(groupId), selectedPermissionCodes);
      showSuccess('Group permissions updated');
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to update group permissions.');
    }
  }

  function toggleRole(roleId: number, checked: boolean): void {
    setSelectedRoleIds((current) => (checked ? [...current, roleId] : current.filter((id) => id !== roleId)));
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div data-testid="group-detail-page">
      <UserManagerNav />
      <div className="qiq-page-head">
        <h2>{isEditMode ? `Edit Group — ${group?.name ?? ''}` : 'New Group'}</h2>
      </div>

      {formError && <ErrorBanner message={formError} />}

      <form data-testid="group-form" onSubmit={(event) => void handleSubmit(event)} noValidate className="qiq-card" style={{ padding: 0, marginBottom: 'var(--qiq-space-4)' }}>
        <div style={{ padding: 'var(--qiq-space-5)' }}>
          <div className="qiq-field" style={{ maxWidth: '420px' }}>
            <label htmlFor="group-name">Name</label>
            <input
              id="group-name"
              name="name"
              type="text"
              value={name}
              aria-invalid={nameError ? true : undefined}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setNameError(validateName(name) ?? null)}
            />
            {nameError && <p data-testid="field-error" className="qiq-field-error">{nameError}</p>}
          </div>
        </div>
        <div className="qiq-sticky-footer">
          <button type="button" className="qiq-btn" onClick={() => navigate('/admin/groups')} disabled={saving}>
            Cancel
          </button>
          {canManage && (
            <button type="submit" className="qiq-btn qiq-btn--primary" disabled={saving}>
              Save
            </button>
          )}
        </div>
      </form>

      {isEditMode && group && (
        <div className="qiq-page">
          <section data-testid="group-members-section" className="qiq-card">
            <div className="qiq-card-head">
              <h3 className="qiq-card-title">Members</h3>
            </div>
            <div className="qiq-table-wrap" style={{ margin: '0 calc(-1 * var(--qiq-space-4))' }}>
              <table data-testid="group-members-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {memberUsers.map((user) => (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>
                        {canManage && (
                          <button type="button" className="qiq-btn qiq-btn--sm qiq-btn--danger-soft" onClick={() => void handleRemoveMember(user.id)}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canManage && (
              <div style={{ display: 'flex', gap: 'var(--qiq-space-3)', alignItems: 'flex-end', marginTop: 'var(--qiq-space-4)' }}>
                <div className="qiq-field" style={{ minWidth: '260px' }}>
                  <label htmlFor="group-add-member">Add member</label>
                  <select
                    id="group-add-member"
                    value={newMemberUserId}
                    onChange={(event) => setNewMemberUserId(event.target.value)}
                  >
                    <option value="">Select a user…</option>
                    {nonMemberUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.email}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="button" className="qiq-btn" onClick={() => void handleAddMember()} disabled={newMemberUserId === ''}>
                  Add member
                </button>
              </div>
            )}
          </section>

          <section data-testid="group-roles-section" className="qiq-card">
            <div className="qiq-card-head">
              <h3 className="qiq-card-title">Roles</h3>
              {canManage && (
                <button type="button" className="qiq-btn qiq-btn--primary qiq-btn--sm" onClick={() => void handleSaveRoles()}>
                  Save roles
                </button>
              )}
            </div>
            <div className="qiq-check-list">
              {allRoles.map((role) => (
                <label key={role.id} htmlFor={`group-role-${role.id}`}>
                  <input
                    id={`group-role-${role.id}`}
                    type="checkbox"
                    checked={selectedRoleIds.includes(role.id)}
                    disabled={!canManage}
                    onChange={(event) => toggleRole(role.id, event.target.checked)}
                  />
                  {' '}
                  {role.name}
                </label>
              ))}
            </div>
          </section>

          <section data-testid="group-permissions-section" className="qiq-card">
            <div className="qiq-card-head">
              <h3 className="qiq-card-title">Direct permissions</h3>
              {canManage && (
                <button type="button" className="qiq-btn qiq-btn--primary qiq-btn--sm" onClick={() => void handleSavePermissions()}>
                  Save permissions
                </button>
              )}
            </div>
            <PermissionPicker
              selected={selectedPermissionCodes}
              onChange={setSelectedPermissionCodes}
              grantableCodes={grantableCodes}
              disabled={!canManage}
            />
          </section>
        </div>
      )}
    </div>
  );
}

export default GroupDetailPage;
