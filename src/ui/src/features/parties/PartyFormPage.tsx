import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { listReferenceItems, type ReferenceItemDto } from '../settings/settingsApi';
import {
  createParty,
  DUPLICATE_NAME_WARNING_CODE,
  getParty,
  updateParty,
  type PartyWarningMatchDto,
  type PartyWritePayload,
} from './partiesApi';
import { useToast } from '../../components/common/Toast';
import { useUnsavedChanges } from '../../components/common/useUnsavedChanges';
import ErrorBanner from '../../components/common/ErrorBanner';
import PartyFields from './PartyFields';
import { EMPTY_PARTY_FIELD_VALUES, validatePartyField, type PartyFieldName, type PartyFieldValues } from './partyFieldValues';

interface ReferenceOption {
  id: number;
  name: string;
}

function toReferenceOptions(items: ReferenceItemDto[]): ReferenceOption[] {
  return items.map((item) => ({ id: item.id, name: item.name }));
}

type FormValues = PartyFieldValues;
type FormField = PartyFieldName;

const EMPTY_VALUES: FormValues = EMPTY_PARTY_FIELD_VALUES;

const FIELD_LABELS: Record<FormField, string> = {
  name: 'Name',
  partyTypeId: 'Party type',
  contactName: 'Contact name',
  contactEmail: 'Contact email',
  contactPhone: 'Contact phone',
};

function toRequestValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRequestId(value: string): number | null {
  return value === '' ? null : Number(value);
}

function validateField(field: FormField, values: FormValues): string | undefined {
  return validatePartyField(field, values);
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
 * New/Edit Party form (spec FR-28, PRD 12.9, AC-027, verification.json V-027). Routes `/parties/new`
 * (create) and `/parties/{id}/edit` (update). Region is deliberately optional everywhere (spec Q-9 —
 * "party region is never required"), unlike the required Name/Party type. The duplicate-name warning
 * (`PartyMutationResultDto.Warnings`, code `DUPLICATE_NAME`) is non-blocking: the party is already
 * persisted by the time it is shown, so the banner is dismissible and never prevents navigating away
 * with the save already applied.
 */
function PartyFormPage() {
  const { partyId } = useParams<{ partyId: string }>();
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const isEditMode = partyId !== undefined;

  const canCreate = useAppSelector(selectHasPermission(PermissionCodes.PartiesCreate));
  const canEdit = useAppSelector(selectHasPermission(PermissionCodes.PartiesUpdate));
  const canSave = isEditMode ? canEdit : canCreate;

  const [partyTypeOptions, setPartyTypeOptions] = useState<ReferenceOption[] | null>(null);
  const [segmentOptions, setSegmentOptions] = useState<ReferenceOption[] | null>(null);
  const [industryOptions, setIndustryOptions] = useState<ReferenceOption[] | null>(null);
  const [regionOptions, setRegionOptions] = useState<ReferenceOption[] | null>(null);

  const [initialValues, setInitialValues] = useState<FormValues>(EMPTY_VALUES);
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(isEditMode);
  const [saving, setSaving] = useState(false);
  const [justSavedPartyId, setJustSavedPartyId] = useState<number | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<{ partyId: number; matches: PartyWarningMatchDto[] } | null>(
    null,
  );

  useEffect(() => {
    listReferenceItems('party_type')
      .then((items) => setPartyTypeOptions(toReferenceOptions(items)))
      .catch(() => setPartyTypeOptions(null));
    listReferenceItems('party_segment')
      .then((items) => setSegmentOptions(toReferenceOptions(items)))
      .catch(() => setSegmentOptions(null));
    listReferenceItems('industry')
      .then((items) => setIndustryOptions(toReferenceOptions(items)))
      .catch(() => setIndustryOptions(null));
    listReferenceItems('region')
      .then((items) => setRegionOptions(toReferenceOptions(items)))
      .catch(() => setRegionOptions(null));
  }, []);

  useEffect(() => {
    if (!isEditMode || partyId === undefined) {
      setInitialValues(EMPTY_VALUES);
      setValues(EMPTY_VALUES);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getParty(Number(partyId))
      .then((party) => {
        if (cancelled) {
          return;
        }
        const loaded: FormValues = {
          name: party.name,
          partyTypeId: String(party.partyTypeId),
          segmentId: party.segmentId != null ? String(party.segmentId) : '',
          industryId: party.industryId != null ? String(party.industryId) : '',
          regionId: party.regionId != null ? String(party.regionId) : '',
          isStrategic: party.isStrategic,
          contactName: party.contactName ?? '',
          contactEmail: party.contactEmail ?? '',
          contactPhone: party.contactPhone ?? '',
        };
        setInitialValues(loaded);
        setValues(loaded);
      })
      .catch(() => {
        if (!cancelled) {
          setFormError('Unable to load this party.');
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
  }, [isEditMode, partyId]);

  // `justSavedPartyId` suppresses the dirty check for the render that follows a successful save
  // (same rationale as `TenantFormPage`), so the unsaved-changes blocker doesn't fire on our own
  // post-save navigation to the detail page.
  const isDirty = useMemo(
    () => justSavedPartyId === null && JSON.stringify(values) !== JSON.stringify(initialValues),
    [values, initialValues, justSavedPartyId],
  );
  const unsavedChanges = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (justSavedPartyId !== null) {
      navigate(`/parties/${justSavedPartyId}`);
    }
  }, [justSavedPartyId, navigate]);

  const errorFields = Object.keys(fieldErrors) as FormField[];
  const showSummaryBanner = errorFields.length >= 3;

  function handleChange<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function handleBlur(field: FormField): void {
    setTouched((current) => ({ ...current, [field]: true }));
    const message = validateField(field, values);
    setFieldErrors((current) => {
      if (!message) {
        if (!(field in current)) {
          return current;
        }
        const rest = { ...current };
        delete rest[field];
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
    setDuplicateMatches(null);

    const errors = validateAll(values);
    setFieldErrors(errors);
    setTouched({ name: true, partyTypeId: true, contactName: true, contactEmail: true, contactPhone: true });
    if (Object.keys(errors).length > 0) {
      return;
    }

    const payload: PartyWritePayload = {
      name: values.name.trim(),
      partyTypeId: Number(values.partyTypeId),
      segmentId: toRequestId(values.segmentId),
      industryId: toRequestId(values.industryId),
      regionId: toRequestId(values.regionId),
      isStrategic: values.isStrategic,
      contactName: toRequestValue(values.contactName),
      contactEmail: toRequestValue(values.contactEmail),
      contactPhone: toRequestValue(values.contactPhone),
    };

    setSaving(true);
    try {
      const result =
        isEditMode && partyId !== undefined
          ? await updateParty(Number(partyId), payload)
          : await createParty(payload);

      setInitialValues(values);
      showSuccess(isEditMode ? `Party ${result.party.name} updated` : `Party ${result.party.name} created`);

      const duplicateWarning = result.warnings.find((warning) => warning.code === DUPLICATE_NAME_WARNING_CODE);
      if (duplicateWarning) {
        // Non-blocking (spec FR-28): the party is already saved (Save is not blocked by the
        // warning). The banner is shown in place of the immediate auto-navigate so the user can see
        // and follow the near-duplicate matches; "Continue to party"/"Dismiss" both proceed to the
        // detail page the same way `justSavedPartyId` would have taken them.
        setDuplicateMatches({ partyId: result.party.id, matches: duplicateWarning.matches });
      } else {
        setJustSavedPartyId(result.party.id);
      }
    } catch (err) {
      applyServerError(err as NormalizedError);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel(): void {
    if (isEditMode && partyId !== undefined) {
      navigate(`/parties/${partyId}`);
    } else {
      navigate('/parties');
    }
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div data-testid="party-form-page" className="qiq-page">
      <h2 style={{ fontSize: '20px' }}>{isEditMode ? 'Edit Party' : 'New Party'}</h2>

      {formError && <ErrorBanner message={formError} />}

      {duplicateMatches && duplicateMatches.matches.length > 0 && (
        <div role="alert" data-testid="duplicate-warning-banner" className="qiq-banner qiq-banner--warning" style={{ display: 'block', marginBottom: 'var(--qiq-space-4)' }}>
          <p>Saved. This name is similar to existing parties — review before continuing:</p>
          <ul>
            {duplicateMatches.matches.map((match) => (
              <li key={match.id}>
                <a href={`/parties/${match.id}`} data-testid="duplicate-warning-link">
                  {match.name}
                </a>
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="dismiss-duplicate-warning"
            onClick={() => {
              const partyId = duplicateMatches.partyId;
              setDuplicateMatches(null);
              setJustSavedPartyId(partyId);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {showSummaryBanner && (
        <div role="alert" data-testid="form-error-summary" className="qiq-banner qiq-banner--error" style={{ display: 'block', marginBottom: 'var(--qiq-space-4)' }}>
          <p>Please fix the following:</p>
          <ul>
            {errorFields.map((field) => (
              <li key={field}>
                <a href={`#party-${field}`}>{fieldErrors[field]}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form data-testid="party-form" onSubmit={(event) => void handleSubmit(event)} noValidate className="qiq-card" style={{ padding: 0 }}>
        <div style={{ padding: 'var(--qiq-space-5)' }}>
        <PartyFields
          idPrefix="party"
          values={values}
          errors={fieldErrors}
          touched={touched}
          partyTypeOptions={partyTypeOptions}
          segmentOptions={segmentOptions}
          industryOptions={industryOptions}
          regionOptions={regionOptions}
          onChange={handleChange}
          onBlur={handleBlur}
        />
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

export default PartyFormPage;
