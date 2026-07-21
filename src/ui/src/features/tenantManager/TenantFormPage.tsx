import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { createTenant, getTenant, updateTenant } from './tenantsApi';
import { useToast } from '../../components/common/Toast';
import { useUnsavedChanges } from '../../components/common/useUnsavedChanges';
import ErrorBanner from '../../components/common/ErrorBanner';

interface FormValues {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

type FormField = keyof FormValues;

const EMPTY_VALUES: FormValues = { name: '', contactName: '', contactEmail: '', contactPhone: '' };

const FIELD_LABELS: Record<FormField, string> = {
  name: 'Name',
  contactName: 'Contact name',
  contactEmail: 'Contact email',
  contactPhone: 'Contact phone',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Maps a possibly-blank input to the nullable value the API expects (spec FR-06: only name is required). */
function toRequestValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateField(field: FormField, values: FormValues): string | undefined {
  if (field === 'name') {
    return values.name.trim().length === 0 ? 'Tenant name is required.' : undefined;
  }
  if (field === 'contactEmail') {
    const email = values.contactEmail.trim();
    return email.length > 0 && !EMAIL_PATTERN.test(email) ? 'Enter a valid email address.' : undefined;
  }
  return undefined;
}

function validateAll(values: FormValues): Partial<Record<FormField, string>> {
  const errors: Partial<Record<FormField, string>> = {};
  (Object.keys(FIELD_LABELS) as FormField[]).forEach((field) => {
    const message = validateField(field, values);
    if (message) {
      errors[field] = message;
    }
  });
  return errors;
}

/**
 * Add/Edit tenant form (spec FR-06, AC-006, verification.json V-006), shared between
 * `/admin/tenants/new` (create) and `/admin/tenants/{id}` (edit): required name, optional
 * contact fields with email format validation, inline errors on blur/submit per UI Standards
 * §10, sticky footer Cancel/Save, and an unsaved-changes prompt on dirty navigation away
 * (UI Standards §10.4).
 */
function TenantFormPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const isEditMode = tenantId !== undefined;

  const canCreate = useAppSelector(selectHasPermission(PermissionCodes.TenantsCreate));
  const canEdit = useAppSelector(selectHasPermission(PermissionCodes.TenantsEdit));
  const canSave = isEditMode ? canEdit : canCreate;

  const [initialValues, setInitialValues] = useState<FormValues>(EMPTY_VALUES);
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(isEditMode);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!isEditMode || tenantId === undefined) {
      setInitialValues(EMPTY_VALUES);
      setValues(EMPTY_VALUES);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getTenant(Number(tenantId))
      .then((tenant) => {
        if (cancelled) {
          return;
        }
        const loaded: FormValues = {
          name: tenant.name,
          contactName: tenant.contactName ?? '',
          contactEmail: tenant.contactEmail ?? '',
          contactPhone: tenant.contactPhone ?? '',
        };
        setInitialValues(loaded);
        setValues(loaded);
      })
      .catch(() => {
        if (!cancelled) {
          setFormError('Unable to load this tenant.');
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
  }, [isEditMode, tenantId]);

  // `justSaved` suppresses the dirty check for exactly the render that follows a successful save
  // (see the `useEffect` below), so the blocker re-registers as non-blocking *before* the
  // post-save `navigate()` to the list runs — otherwise the still-stale `isDirty` closure from the
  // pre-save render would prompt the unsaved-changes confirmation on our own successful exit.
  const isDirty = useMemo(
    () => !justSaved && JSON.stringify(values) !== JSON.stringify(initialValues),
    [values, initialValues, justSaved],
  );
  const unsavedChanges = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (justSaved) {
      navigate('/admin/tenants');
    }
  }, [justSaved, navigate]);

  const errorFields = Object.keys(fieldErrors) as FormField[];
  const showSummaryBanner = errorFields.length >= 3;

  function handleChange(field: FormField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function handleBlur(field: FormField): void {
    setTouched((current) => ({ ...current, [field]: true }));
    const message = validateField(field, values);
    setFieldErrors((current) => {
      // Only ever store *actual* error messages: an unconditional `{ ...current, [field]: message }`
      // would add `field` as an own (undefined-valued) key even when it's valid, inflating
      // `errorFields.length` (used for the 3+-error summary banner) with phantom entries.
      if (!message) {
        if (!(field in current)) {
          return current;
        }
        const { [field]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [field]: message };
    });
  }

  function applyServerError(error: NormalizedError): void {
    if (error.fieldErrors.length === 0) {
      setFormError(error.title);
      return;
    }

    const knownFields = new Set<string>(Object.keys(FIELD_LABELS).map((field) => field.toLowerCase()));
    const mapped: Partial<Record<FormField, string>> = {};
    for (const fieldError of error.fieldErrors) {
      const normalized = fieldError.field.charAt(0).toLowerCase() + fieldError.field.slice(1);
      if (knownFields.has(normalized.toLowerCase())) {
        mapped[normalized as FormField] = fieldError.message;
      }
    }

    if (Object.keys(mapped).length === 0) {
      setFormError(error.title);
    } else {
      setFieldErrors((current) => ({ ...current, ...mapped }));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const errors = validateAll(values);
    setFieldErrors(errors);
    setTouched({ name: true, contactName: true, contactEmail: true, contactPhone: true });
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        contactName: toRequestValue(values.contactName),
        contactEmail: toRequestValue(values.contactEmail),
        contactPhone: toRequestValue(values.contactPhone),
      };

      if (isEditMode && tenantId !== undefined) {
        await updateTenant(Number(tenantId), payload);
        showSuccess(`Tenant ${payload.name} updated`);
      } else {
        await createTenant(payload);
        showSuccess(`Tenant ${payload.name} created`);
      }

      setInitialValues(values);
      setJustSaved(true);
    } catch (err) {
      applyServerError(err as NormalizedError);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel(): void {
    navigate('/admin/tenants');
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div data-testid="tenant-form-page" className="qiq-page">
      <h2 style={{ fontSize: '20px' }}>{isEditMode ? 'Edit Tenant' : 'New Tenant'}</h2>

      {formError && <ErrorBanner message={formError} />}

      {showSummaryBanner && (
        <div role="alert" data-testid="form-error-summary" className="qiq-banner qiq-banner--error" style={{ display: 'block', marginBottom: 'var(--qiq-space-4)' }}>
          <p>Please fix the following:</p>
          <ul>
            {errorFields.map((field) => (
              <li key={field}>
                <a href={`#tenant-${field}`}>{fieldErrors[field]}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form data-testid="tenant-form" onSubmit={(event) => void handleSubmit(event)} noValidate className="qiq-card" style={{ padding: 0 }}>
        <div className="qiq-form-grid" style={{ padding: 'var(--qiq-space-5)' }}>
        <div className="qiq-field">
          <label htmlFor="tenant-name">Name</label>
          <input
            id="tenant-name"
            name="name"
            type="text"
            value={values.name}
            aria-invalid={touched.name && fieldErrors.name ? true : undefined}
            aria-describedby={fieldErrors.name ? 'tenant-name-error' : undefined}
            onChange={(event) => handleChange('name', event.target.value)}
            onBlur={() => handleBlur('name')}
          />
          {touched.name && fieldErrors.name && (
            <p id="tenant-name-error" data-testid="field-error" className="qiq-field-error">
              {fieldErrors.name}
            </p>
          )}
        </div>

        <div className="qiq-field">
          <label htmlFor="tenant-contact-name">Contact name</label>
          <input
            id="tenant-contact-name"
            name="contactName"
            type="text"
            value={values.contactName}
            onChange={(event) => handleChange('contactName', event.target.value)}
            onBlur={() => handleBlur('contactName')}
          />
        </div>

        <div className="qiq-field">
          <label htmlFor="tenant-contact-email">Contact email</label>
          <input
            id="tenant-contact-email"
            name="contactEmail"
            type="email"
            value={values.contactEmail}
            aria-invalid={touched.contactEmail && fieldErrors.contactEmail ? true : undefined}
            aria-describedby={fieldErrors.contactEmail ? 'tenant-contact-email-error' : undefined}
            onChange={(event) => handleChange('contactEmail', event.target.value)}
            onBlur={() => handleBlur('contactEmail')}
          />
          {touched.contactEmail && fieldErrors.contactEmail && (
            <p id="tenant-contact-email-error" data-testid="field-error" className="qiq-field-error">
              {fieldErrors.contactEmail}
            </p>
          )}
        </div>

        <div className="qiq-field">
          <label htmlFor="tenant-contact-phone">Contact phone</label>
          <input
            id="tenant-contact-phone"
            name="contactPhone"
            type="tel"
            value={values.contactPhone}
            onChange={(event) => handleChange('contactPhone', event.target.value)}
            onBlur={() => handleBlur('contactPhone')}
          />
        </div>
        </div>

        <div
          data-testid="form-sticky-footer"
          className="qiq-sticky-footer"
        >
          <button type="button" onClick={handleCancel} disabled={saving}>
            Cancel
          </button>
          {canSave && (
            <button type="submit" className="qiq-btn qiq-btn--primary" disabled={saving}>
              Save
            </button>
          )}
        </div>
      </form>

      {unsavedChanges.isBlocked && (
        <div role="alertdialog" data-testid="unsaved-changes-dialog" className="qiq-card" style={{ position: 'fixed', bottom: 'var(--qiq-space-5)', left: '50%', transform: 'translateX(-50%)', zIndex: 80, boxShadow: 'var(--qiq-shadow-raised)', display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
          <p>You have unsaved changes. Leave without saving?</p>
          <button type="button" onClick={unsavedChanges.confirm}>
            Leave
          </button>
          <button type="button" onClick={unsavedChanges.cancel}>
            Stay
          </button>
        </div>
      )}
    </div>
  );
}

export default TenantFormPage;
