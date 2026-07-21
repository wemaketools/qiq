import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectHasPermission, selectSession } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { createUser } from './usersApi';
import { listRoles, type RoleDto } from './rolesApi';
import { listGroups, type GroupDto } from './groupsApi';
import { groupPermissionsByCategory, formatPermissionCategory, PERMISSION_CATALOG } from './permissionCatalog';
import { useToast } from '../../components/common/Toast';
import ErrorBanner from '../../components/common/ErrorBanner';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function selectedOptionValues(event: { target: HTMLSelectElement }): string[] {
  return Array.from(event.target.selectedOptions).map((option) => option.value);
}

/**
 * New User form (spec FR-13/FR-16, PRD 20.1.1, AC-012, verification.json V-012/V-013). Route
 * `/admin/users/new`: first/last/email plus tenant/role/group/direct-permission assignment
 * (`POST /users`, T-007 `CreateUserCommand`). Mirrors the backend's FR-16 rule as a UX affordance
 * only (>=1 tenant required unless the caller holds `global.view_any_tenant`, in which case a
 * zero-tenant Internal-style user is permitted) — the server (`UserErrors.RequiresTenant`) is the
 * sole authority.
 */
function UserFormPage() {
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const canCreateGlobalUser = useAppSelector(selectHasPermission(PermissionCodes.GlobalViewAnyTenant));
  const activeTenant = useAppSelector(selectActiveTenant);
  const session = useAppSelector(selectSession);
  const grantableCodes = activeTenant?.permissions ?? [];

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [tenantIds, setTenantIds] = useState<number[]>(activeTenant ? [activeTenant.tenantId] : []);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [directPermissions, setDirectPermissions] = useState<string[]>([]);

  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [groups, setGroups] = useState<GroupDto[]>([]);

  const [fieldErrors, setFieldErrors] = useState<{ firstName?: string; lastName?: string; email?: string; tenantIds?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listRoles().then(setRoles).catch(() => setRoles([]));
    listGroups().then(setGroups).catch(() => setGroups([]));
  }, []);

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
    if (tenantIds.length === 0 && !canCreateGlobalUser) {
      errors.tenantIds = 'Select at least one tenant.';
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
        tenantIds,
        directRoleIds: roleIds,
        directPermissions,
        groupIds,
      });
      showSuccess(`User ${result.email} created`);
      navigate(`/admin/users/${result.userId}`);
    } catch (err) {
      setFormError((err as NormalizedError).title);
    } finally {
      setSaving(false);
    }
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

            <div className="qiq-field">
              <label htmlFor="user-tenant">Tenant</label>
              <select
                id="user-tenant"
                multiple
                value={tenantIds.map(String)}
                aria-invalid={fieldErrors.tenantIds ? true : undefined}
                onChange={(event) => setTenantIds(selectedOptionValues(event).map(Number))}
              >
                {session.memberships.map((membership) => (
                  <option key={membership.tenantId} value={membership.tenantId}>
                    {membership.tenantName}
                  </option>
                ))}
              </select>
              {fieldErrors.tenantIds && <p data-testid="field-error" className="qiq-field-error">{fieldErrors.tenantIds}</p>}
              <p className="qiq-field-hint">Hold Ctrl (Cmd on Mac) to select more than one.</p>
            </div>

            <div className="qiq-field">
              <label htmlFor="user-role">Role</label>
              <select
                id="user-role"
                multiple
                value={roleIds.map(String)}
                onChange={(event) => setRoleIds(selectedOptionValues(event).map(Number))}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="qiq-field">
              <label htmlFor="user-group">Group</label>
              <select
                id="user-group"
                multiple
                value={groupIds.map(String)}
                onChange={(event) => setGroupIds(selectedOptionValues(event).map(Number))}
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="qiq-field">
              <label htmlFor="user-direct-permission">Direct permission</label>
              <select
                id="user-direct-permission"
                multiple
                value={directPermissions}
                onChange={(event) => setDirectPermissions(selectedOptionValues(event))}
              >
                {groupPermissionsByCategory(PERMISSION_CATALOG).map(({ category, entries }) => (
                  <optgroup key={category} label={formatPermissionCategory(category)}>
                    {entries.map((entry) => (
                      <option key={entry.code} value={entry.code} disabled={!grantableCodes.includes(entry.code)}>
                        {entry.description}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
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
