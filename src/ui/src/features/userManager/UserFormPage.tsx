import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectSession } from '../../app/slices/sessionSlice';
import type { NormalizedError } from '../../api/client';
import { createUser } from './usersApi';
import { listRoles, type RoleDto } from './rolesApi';
import { listGroups, type GroupDto } from './groupsApi';
import PermissionPicker from './PermissionPicker';
import { useToast } from '../../components/common/Toast';
import ErrorBanner from '../../components/common/ErrorBanner';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * New User form (spec FR-13/FR-16, PRD 20.1.1, AC-012, verification.json V-012/V-013). Route
 * `/admin/users/new`: first/last/email plus role/group/direct-permission assignment
 * (`POST /users`, T-007 `CreateUserCommand`).
 *
 * CREATE IS ACTIVE-TENANT-ONLY (2026-07-21 decision): the new user is silently assigned to the
 * caller's ACTIVE tenant — there is no tenant field — and the role/group dropdowns offer only that
 * tenant's rows plus global ones (suffixed "(Global)"), because the flat create contract grants
 * every pick in the created user's tenant. Exactly one role and one group can be picked here, and
 * at least ONE of the two is required — the common case is a single role; anything richer
 * (multi-tenant membership, several roles, per-tenant assignments) is managed on the user's detail
 * page, which speaks the per-assignment update contract.
 */
function UserFormPage() {
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const activeTenant = useAppSelector(selectActiveTenant);
  const session = useAppSelector(selectSession);
  // Grant-no-higher-than-self affordance for the permission checkboxes; the caller's global set
  // covers the (Internal) case of acting without a membership. Server remains authoritative.
  const grantableCodes = activeTenant?.permissions ?? session.globalPermissions;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [directPermissions, setDirectPermissions] = useState<string[]>([]);

  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [groups, setGroups] = useState<GroupDto[]>([]);

  const [fieldErrors, setFieldErrors] = useState<{ firstName?: string; lastName?: string; email?: string; access?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listRoles().then(setRoles).catch(() => setRoles([]));
    listGroups().then(setGroups).catch(() => setGroups([]));
  }, []);

  // Only the active tenant's rows (plus global ones) are assignable here — offering another
  // tenant's roles would only produce a server-side USER_ROLE_TENANT_MISMATCH.
  const activeTenantId = activeTenant?.tenantId ?? null;
  const assignableRoles = roles.filter(
    (role) => role.tenantId === null || role.tenantId === activeTenantId,
  );
  const assignableGroups = groups.filter(
    (group) => group.tenantId === null || group.tenantId === activeTenantId,
  );

  function validate(): typeof fieldErrors {
    const errors: typeof fieldErrors = {};
    if (firstName.trim().length === 0) {
      errors.firstName = 'First name is required.';
    }
    if (lastName.trim().length === 0) {
      errors.lastName = 'Last name is required.';
    }
    if (email.trim().length === 0) {
      errors.email = 'Email is required.';
    } else if (!EMAIL_PATTERN.test(email.trim())) {
      errors.email = 'Enter a valid email address.';
    }
    if (roleId === '' && groupId === '') {
      errors.access = 'Select a role or a group.';
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSaving(true);
    try {
      const result = await createUser({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        tenantIds: activeTenantId === null ? [] : [activeTenantId],
        directRoleIds: roleId === '' ? [] : [Number(roleId)],
        directPermissions,
        groupIds: groupId === '' ? [] : [Number(groupId)],
      });
      showSuccess(`User ${result.email} created`);
      navigate(`/admin/users/${result.userId}`);
    } catch (err) {
      setFormError((err as NormalizedError).title);
    } finally {
      setSaving(false);
    }
  }

  function scopedName(name: string, tenantId: number | null): string {
    return tenantId === null ? `${name} (Global)` : name;
  }

  return (
    <div data-testid="page-admin-users-new">
      <div className="qiq-page-head">
        <h2>New User</h2>
      </div>

      {formError && <ErrorBanner message={formError} />}

      <form data-testid="user-form" onSubmit={(event) => void handleSubmit(event)} noValidate className="qiq-card" style={{ padding: 0 }}>
        <div style={{ padding: 'var(--qiq-space-5)' }}>
          <div className="qiq-form-grid">
            <h3 className="qiq-form-section-title">Profile</h3>

            <div className="qiq-field">
              <label htmlFor="user-first-name">First name</label>
              <input
                id="user-first-name"
                value={firstName}
                aria-invalid={fieldErrors.firstName ? true : undefined}
                onChange={(event) => setFirstName(event.target.value)}
              />
              {fieldErrors.firstName && <p data-testid="field-error" className="qiq-field-error">{fieldErrors.firstName}</p>}
            </div>

            <div className="qiq-field">
              <label htmlFor="user-last-name">Last name</label>
              <input
                id="user-last-name"
                value={lastName}
                aria-invalid={fieldErrors.lastName ? true : undefined}
                onChange={(event) => setLastName(event.target.value)}
              />
              {fieldErrors.lastName && <p data-testid="field-error" className="qiq-field-error">{fieldErrors.lastName}</p>}
            </div>

            <div className="qiq-field">
              <label htmlFor="user-email">Email</label>
              <input
                id="user-email"
                type="email"
                value={email}
                aria-invalid={fieldErrors.email ? true : undefined}
                onChange={(event) => setEmail(event.target.value)}
              />
              {fieldErrors.email && <p data-testid="field-error" className="qiq-field-error">{fieldErrors.email}</p>}
            </div>

            <h3 className="qiq-form-section-title">Access</h3>

            {activeTenant && (
              <p className="qiq-field-hint qiq-form-full" style={{ margin: 0 }}>
                This user is created in {activeTenant.tenantName}; access below is granted there.
                Additional tenants can be assigned from the user&apos;s detail page after creation.
              </p>
            )}

            <div className="qiq-field">
              <label htmlFor="user-role">Role</label>
              <select
                id="user-role"
                value={roleId}
                aria-invalid={fieldErrors.access ? true : undefined}
                onChange={(event) => setRoleId(event.target.value)}
              >
                <option value="">Select a role…</option>
                {assignableRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {scopedName(role.name, role.tenantId)}
                  </option>
                ))}
              </select>
            </div>

            <div className="qiq-field">
              <label htmlFor="user-group">Group</label>
              <select
                id="user-group"
                value={groupId}
                aria-invalid={fieldErrors.access ? true : undefined}
                onChange={(event) => setGroupId(event.target.value)}
              >
                <option value="">Select a group…</option>
                {assignableGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {scopedName(group.name, group.tenantId)}
                  </option>
                ))}
              </select>
            </div>

            {fieldErrors.access && (
              <p data-testid="field-error" className="qiq-field-error qiq-form-full" style={{ margin: 0 }}>
                {fieldErrors.access}
              </p>
            )}

            <div className="qiq-field qiq-form-full">
              <label>Direct permissions</label>
              <PermissionPicker
                selected={directPermissions}
                onChange={setDirectPermissions}
                grantableCodes={grantableCodes}
              />
              <p className="qiq-field-hint">Permissions you do not hold yourself cannot be granted.</p>
            </div>
          </div>
        </div>

        <div
          data-testid="form-sticky-footer"
          className="qiq-sticky-footer"
        >
          <button type="button" className="qiq-btn" onClick={() => navigate('/admin/users')} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="qiq-btn qiq-btn--primary" disabled={saving}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

export default UserFormPage;
