import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { createRole, getRole, updateRole } from './rolesApi';
import { useToast } from '../../components/common/Toast';
import { useUnsavedChanges } from '../../components/common/useUnsavedChanges';
import ErrorBanner from '../../components/common/ErrorBanner';
import PermissionPicker from './PermissionPicker';

interface FormValues {
  name: string;
  permissionCodes: string[];
}

const EMPTY_VALUES: FormValues = { name: '', permissionCodes: [] };

/**
 * Add/Edit role form (spec FR-12/FR-13, AC-012, verification.json V-012/V-013): name plus a
 * grouped checkbox permission picker sourced from the (static, see `permissionCatalog.ts`)
 * catalog. Route `/admin/roles/new` (create) and `/admin/roles/{id}` (edit). Adding a permission
 * the caller does not themselves hold surfaces the server's `ROLE_PERMISSION_EXCEEDS_CALLER_GRANT`
 * (403) as an inline form error (grant-no-higher-than-self, F-034) — the picker's disabled
 * checkboxes are a UX affordance only, never a substitute for that server check.
 */
function RoleFormPage() {
  const { roleId } = useParams<{ roleId: string }>();
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const isEditMode = roleId !== undefined;

  const canManage = useAppSelector(selectHasPermission(PermissionCodes.RolesManage));
  const activeTenant = useAppSelector(selectActiveTenant);
  const grantableCodes = activeTenant?.permissions ?? [];

  const [initialValues, setInitialValues] = useState<FormValues>(EMPTY_VALUES);
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [nameError, setNameError] = useState<string | null>(null);
  const [touchedName, setTouchedName] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(isEditMode);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!isEditMode || roleId === undefined) {
      setInitialValues(EMPTY_VALUES);
      setValues(EMPTY_VALUES);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getRole(Number(roleId))
      .then((role) => {
        if (cancelled) {
          return;
        }
        const loaded: FormValues = { name: role.name, permissionCodes: role.permissionCodes };
        setInitialValues(loaded);
        setValues(loaded);
      })
      .catch(() => {
        if (!cancelled) {
          setFormError('Unable to load this role.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isEditMode, roleId]);

  const isDirty = useMemo(
    () => !justSaved && JSON.stringify(values) !== JSON.stringify(initialValues),
    [values, initialValues, justSaved],
  );
  const unsavedChanges = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (justSaved) {
      navigate('/admin/roles');
    }
  }, [justSaved, navigate]);

  function validateName(name: string): string | undefined {
    return name.trim().length === 0 ? 'Role name is required.' : undefined;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setTouchedName(true);

    const error = validateName(values.name);
    setNameError(error ?? null);
    if (error) {
      return;
    }

    setSaving(true);
    try {
      const payload = { name: values.name.trim(), permissionCodes: values.permissionCodes };
      if (isEditMode && roleId !== undefined) {
        await updateRole(Number(roleId), payload);
        showSuccess(`Role ${payload.name} updated`);
      } else {
        await createRole(payload);
        showSuccess(`Role ${payload.name} created`);
      }
      setInitialValues(values);
      setJustSaved(true);
    } catch (err) {
      setFormError((err as NormalizedError).title);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel(): void {
    navigate('/admin/roles');
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div data-testid="role-form-page">
      <div className="qiq-page-head">
        <h2>{isEditMode ? 'Edit Role' : 'New Role'}</h2>
      </div>

      {formError && <ErrorBanner message={formError} />}

      <form data-testid="role-form" onSubmit={(event) => void handleSubmit(event)} noValidate className="qiq-card" style={{ padding: 0 }}>
        <div style={{ padding: 'var(--qiq-space-5)' }}>
          <div className="qiq-field" style={{ maxWidth: '420px', marginBottom: 'var(--qiq-space-5)' }}>
            <label htmlFor="role-name">Name</label>
            <input
              id="role-name"
              name="name"
              type="text"
              value={values.name}
              aria-invalid={touchedName && nameError ? true : undefined}
              aria-describedby={nameError ? 'role-name-error' : undefined}
              onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
              onBlur={() => {
                setTouchedName(true);
                setNameError(validateName(values.name) ?? null);
              }}
            />
            {touchedName && nameError && (
              <p id="role-name-error" data-testid="field-error" className="qiq-field-error">
                {nameError}
              </p>
            )}
          </div>

          <PermissionPicker
            selected={values.permissionCodes}
            onChange={(codes) => setValues((current) => ({ ...current, permissionCodes: codes }))}
            grantableCodes={grantableCodes}
          />
        </div>

        <div
          data-testid="form-sticky-footer"
          className="qiq-sticky-footer"
        >
          <button type="button" className="qiq-btn" onClick={handleCancel} disabled={saving}>
            Cancel
          </button>
          {canManage && (
            <button type="submit" className="qiq-btn qiq-btn--primary" disabled={saving}>
              Save
            </button>
          )}
        </div>
      </form>

      {unsavedChanges.isBlocked && (
        <div role="alertdialog" data-testid="unsaved-changes-dialog" className="qiq-card" style={{ position: 'fixed', bottom: 'var(--qiq-space-5)', left: '50%', transform: 'translateX(-50%)', zIndex: 80, boxShadow: 'var(--qiq-shadow-raised)', display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
          <p style={{ margin: 0 }}>You have unsaved changes. Leave without saving?</p>
          <button type="button" className="qiq-btn qiq-btn--sm qiq-btn--danger-soft" onClick={unsavedChanges.confirm}>
            Leave
          </button>
          <button type="button" className="qiq-btn qiq-btn--sm" onClick={unsavedChanges.cancel}>
            Stay
          </button>
        </div>
      )}
    </div>
  );
}

export default RoleFormPage;
