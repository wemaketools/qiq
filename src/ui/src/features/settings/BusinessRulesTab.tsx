import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectHasPermission, updateActiveTenantCurrency } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { fetchFullBusinessRules, updateBusinessRules, type FullBusinessRulesDto } from './settingsApi';
import ErrorBanner from '../../components/common/ErrorBanner';
import SkeletonTable from '../../components/common/SkeletonTable';
import { useToast } from '../../components/common/Toast';
import { useUnsavedChanges } from '../../components/common/useUnsavedChanges';

type FieldErrors = Partial<Record<keyof FullBusinessRulesDto, string>>;

const SEQUENCE_TOKEN_PATTERN = /\{SEQ:[1-9][0-9]*\}/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * Validates the form client-side mirroring `UpdateBusinessRulesValidator` (spec FR-11, T-010) —
 * a UX convenience only; the server remains the sole authority (CLAUDE.md security stance).
 */
function validate(values: FullBusinessRulesDto): FieldErrors {
  const errors: FieldErrors = {};

  if (!CURRENCY_CODE_PATTERN.test(values.currencyCode)) {
    errors.currencyCode = "Currency code must be a 3-letter ISO-4217-shaped code (e.g. 'BWP').";
  }
  if (values.currencySymbol.trim().length === 0) {
    errors.currencySymbol = 'Currency symbol is required.';
  }
  if (values.maxAttachmentMb <= 0) {
    errors.maxAttachmentMb = 'Attachment cap must be greater than 0.';
  }
  if (values.highValueThreshold !== null && values.highValueThreshold <= 0) {
    errors.highValueThreshold = 'High-value threshold must be greater than 0.';
  }
  if (values.agingAmberDays <= 0) {
    errors.agingAmberDays = 'Aging amber days must be greater than 0.';
  }
  if (values.agingRedDays <= 0) {
    errors.agingRedDays = 'Aging red days must be greater than 0.';
  } else if (values.agingRedDays <= values.agingAmberDays) {
    errors.agingRedDays = 'Aging red threshold must be greater than the aging amber threshold.';
  }
  if (values.followUpOverdueGraceDays < 0) {
    errors.followUpOverdueGraceDays = 'Follow-up grace days cannot be negative.';
  }
  if (values.quoteExpiryAlertDays <= 0) {
    errors.quoteExpiryAlertDays = 'Quote expiry alert days must be greater than 0.';
  }
  if (values.unassignedLeadHours <= 0) {
    errors.unassignedLeadHours = 'Unassigned lead hours must be greater than 0.';
  }
  if (values.stalledLeadDays <= 0) {
    errors.stalledLeadDays = 'Stalled lead days must be greater than 0.';
  }
  if (values.stalledQuoteDays <= 0) {
    errors.stalledQuoteDays = 'Stalled quote days must be greater than 0.';
  }
  if (values.duplicateCheckDays <= 0) {
    errors.duplicateCheckDays = 'Duplicate check days must be greater than 0.';
  }
  if (values.leadInactivityExpiryDays <= 0) {
    errors.leadInactivityExpiryDays = 'Lead inactivity expiry days must be greater than 0.';
  }
  if (values.pricingApprovalTargetDays <= 0) {
    errors.pricingApprovalTargetDays = 'Pricing approval target days must be greater than 0.';
  }
  if (values.slaAssignmentDays <= 0) {
    errors.slaAssignmentDays = 'SLA assignment days must be greater than 0.';
  }
  if (values.slaUnderwritingDays <= 0) {
    errors.slaUnderwritingDays = 'SLA underwriting days must be greater than 0.';
  }
  if (values.slaReceivedToSentDays <= 0) {
    errors.slaReceivedToSentDays = 'SLA received-to-sent days must be greater than 0.';
  }
  if (values.leadRefFormat.trim().length === 0 || !SEQUENCE_TOKEN_PATTERN.test(values.leadRefFormat)) {
    errors.leadRefFormat = 'Lead reference format must include a {SEQ:n} token.';
  }
  if (values.quoteRefFormat.trim().length === 0 || !SEQUENCE_TOKEN_PATTERN.test(values.quoteRefFormat)) {
    errors.quoteRefFormat = 'Quote reference format must include a {SEQ:n} token.';
  }

  return errors;
}

/**
 * Business rules tab (spec FR-11, §11.2, AC-010, AC-074, T-010/T-016): sectioned form (Currency &
 * formats / Thresholds & SLA / Workflow rules), `GET`/`PUT /api/v1/settings/business-rules`. On a
 * successful save, if the currency changed, immediately syncs the session's active-tenant currency
 * (`updateActiveTenantCurrency`) so the footer and every other currency-sourced surface (all read
 * from the session, see `useTenantCurrency.ts`) reflect the change without waiting on a `GET /me`
 * refetch/round trip.
 */
function BusinessRulesTab() {
  const dispatch = useAppDispatch();
  const { showSuccess, showError } = useToast();
  const canManage = useAppSelector(selectHasPermission(PermissionCodes.BusinessRulesManage));
  const activeTenant = useAppSelector(selectActiveTenant);

  const [initialValues, setInitialValues] = useState<FullBusinessRulesDto | null>(null);
  const [values, setValues] = useState<FullBusinessRulesDto | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load(): void {
    setLoading(true);
    setLoadError(null);
    fetchFullBusinessRules()
      .then((dto) => {
        setInitialValues(dto);
        setValues(dto);
      })
      .catch((err: unknown) => setLoadError((err as NormalizedError).title ?? 'Unable to load business rules.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTenant?.tenantId]);

  const isDirty = useMemo(
    () => values !== null && initialValues !== null && JSON.stringify(values) !== JSON.stringify(initialValues),
    [values, initialValues],
  );
  const unsavedChanges = useUnsavedChanges(isDirty);

  function setField<K extends keyof FullBusinessRulesDto>(field: K, value: FullBusinessRulesDto[K]): void {
    setValues((current) => (current ? { ...current, [field]: value } : current));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!values) {
      return;
    }

    const validationErrors = validate(values);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setSaving(true);
    try {
      const saved = await updateBusinessRules(values);
      setInitialValues(saved);
      setValues(saved);
      showSuccess('Business rules saved');

      const currencyChanged =
        initialValues !== null &&
        (initialValues.currencyCode !== saved.currencyCode || initialValues.currencySymbol !== saved.currencySymbol);
      if (currencyChanged) {
        dispatch(updateActiveTenantCurrency({ currencyCode: saved.currencyCode, currencySymbol: saved.currencySymbol }));
      }
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to save business rules.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <SkeletonTable rows={6} columns={2} />;
  }

  if (loadError || !values) {
    return <ErrorBanner message={loadError ?? 'Unable to load business rules.'} onRetry={load} />;
  }

  return (
    <div data-testid="business-rules-tab">
      <div className="qiq-page-head">
        <h2>Business rules</h2>
      </div>

      <form data-testid="business-rules-form" onSubmit={(event) => void handleSubmit(event)} noValidate className="qiq-card" style={{ padding: 0 }}>
        <div style={{ padding: 'var(--qiq-space-5)' }}>
        <fieldset className="qiq-fieldset" disabled={!canManage}>
          <legend>Currency & formats</legend>
          <div className="qiq-form-grid">

          <div className="qiq-field">
            <label htmlFor="br-currency-code">Currency code</label>
            <input
              id="br-currency-code"
              name="currencyCode"
              value={values.currencyCode}
              onChange={(e) => setField('currencyCode', e.target.value.toUpperCase())}
            />
            {errors.currencyCode && <p data-testid="field-error" className="qiq-field-error">{errors.currencyCode}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-currency-symbol">Currency symbol</label>
            <input
              id="br-currency-symbol"
              name="currencySymbol"
              value={values.currencySymbol}
              onChange={(e) => setField('currencySymbol', e.target.value)}
            />
            {errors.currencySymbol && <p data-testid="field-error" className="qiq-field-error">{errors.currencySymbol}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-lead-ref-format">Lead reference format</label>
            <input
              id="br-lead-ref-format"
              name="leadRefFormat"
              value={values.leadRefFormat}
              onChange={(e) => setField('leadRefFormat', e.target.value)}
            />
            {errors.leadRefFormat && <p data-testid="field-error" className="qiq-field-error">{errors.leadRefFormat}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-quote-ref-format">Quote reference format</label>
            <input
              id="br-quote-ref-format"
              name="quoteRefFormat"
              value={values.quoteRefFormat}
              onChange={(e) => setField('quoteRefFormat', e.target.value)}
            />
            {errors.quoteRefFormat && <p data-testid="field-error" className="qiq-field-error">{errors.quoteRefFormat}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-max-attachment-mb">Attachment cap (MB)</label>
            <input
              id="br-max-attachment-mb"
              name="maxAttachmentMb"
              type="number"
              value={values.maxAttachmentMb}
              onChange={(e) => setField('maxAttachmentMb', Number(e.target.value))}
            />
            {errors.maxAttachmentMb && <p data-testid="field-error" className="qiq-field-error">{errors.maxAttachmentMb}</p>}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '9px' }}>
            <label
              htmlFor="br-manual-external-ref"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)', fontSize: '13px', fontWeight: 550, color: 'var(--qiq-text-primary)', cursor: 'pointer' }}
            >
              <input
                id="br-manual-external-ref"
                name="manualExternalRefEnabled"
                type="checkbox"
                checked={values.manualExternalRefEnabled}
                onChange={(e) => setField('manualExternalRefEnabled', e.target.checked)}
              />
              {' '}Allow manual external reference entry
            </label>
          </div>
          </div>
        </fieldset>

        <fieldset className="qiq-fieldset" disabled={!canManage}>
          <legend>Thresholds & SLA</legend>
          <div className="qiq-form-grid">

          <div className="qiq-field">
            <label htmlFor="br-high-value-threshold">High-value threshold</label>
            <input
              id="br-high-value-threshold"
              name="highValueThreshold"
              type="number"
              value={values.highValueThreshold ?? ''}
              onChange={(e) => setField('highValueThreshold', e.target.value === '' ? null : Number(e.target.value))}
            />
            {errors.highValueThreshold && <p data-testid="field-error" className="qiq-field-error">{errors.highValueThreshold}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-aging-amber-days">Aging amber days</label>
            <input
              id="br-aging-amber-days"
              name="agingAmberDays"
              type="number"
              value={values.agingAmberDays}
              onChange={(e) => setField('agingAmberDays', Number(e.target.value))}
            />
            {errors.agingAmberDays && <p data-testid="field-error" className="qiq-field-error">{errors.agingAmberDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-aging-red-days">Aging red days</label>
            <input
              id="br-aging-red-days"
              name="agingRedDays"
              type="number"
              value={values.agingRedDays}
              onChange={(e) => setField('agingRedDays', Number(e.target.value))}
            />
            {errors.agingRedDays && <p data-testid="field-error" className="qiq-field-error">{errors.agingRedDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-quote-expiry-alert-days">Quote expiry alert days</label>
            <input
              id="br-quote-expiry-alert-days"
              name="quoteExpiryAlertDays"
              type="number"
              value={values.quoteExpiryAlertDays}
              onChange={(e) => setField('quoteExpiryAlertDays', Number(e.target.value))}
            />
            {errors.quoteExpiryAlertDays && <p data-testid="field-error" className="qiq-field-error">{errors.quoteExpiryAlertDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-follow-up-grace-days">Follow-up overdue grace days</label>
            <input
              id="br-follow-up-grace-days"
              name="followUpOverdueGraceDays"
              type="number"
              value={values.followUpOverdueGraceDays}
              onChange={(e) => setField('followUpOverdueGraceDays', Number(e.target.value))}
            />
            {errors.followUpOverdueGraceDays && <p data-testid="field-error" className="qiq-field-error">{errors.followUpOverdueGraceDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-unassigned-lead-hours">Unassigned lead hours</label>
            <input
              id="br-unassigned-lead-hours"
              name="unassignedLeadHours"
              type="number"
              value={values.unassignedLeadHours}
              onChange={(e) => setField('unassignedLeadHours', Number(e.target.value))}
            />
            {errors.unassignedLeadHours && <p data-testid="field-error" className="qiq-field-error">{errors.unassignedLeadHours}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-stalled-lead-days">Stalled lead days</label>
            <input
              id="br-stalled-lead-days"
              name="stalledLeadDays"
              type="number"
              value={values.stalledLeadDays}
              onChange={(e) => setField('stalledLeadDays', Number(e.target.value))}
            />
            {errors.stalledLeadDays && <p data-testid="field-error" className="qiq-field-error">{errors.stalledLeadDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-stalled-quote-days">Stalled quote days</label>
            <input
              id="br-stalled-quote-days"
              name="stalledQuoteDays"
              type="number"
              value={values.stalledQuoteDays}
              onChange={(e) => setField('stalledQuoteDays', Number(e.target.value))}
            />
            {errors.stalledQuoteDays && <p data-testid="field-error" className="qiq-field-error">{errors.stalledQuoteDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-duplicate-check-days">Duplicate check window (days)</label>
            <input
              id="br-duplicate-check-days"
              name="duplicateCheckDays"
              type="number"
              value={values.duplicateCheckDays}
              onChange={(e) => setField('duplicateCheckDays', Number(e.target.value))}
            />
            {errors.duplicateCheckDays && <p data-testid="field-error" className="qiq-field-error">{errors.duplicateCheckDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-lead-inactivity-expiry-days">Lead inactivity expiry days</label>
            <input
              id="br-lead-inactivity-expiry-days"
              name="leadInactivityExpiryDays"
              type="number"
              value={values.leadInactivityExpiryDays}
              onChange={(e) => setField('leadInactivityExpiryDays', Number(e.target.value))}
            />
            {errors.leadInactivityExpiryDays && <p data-testid="field-error" className="qiq-field-error">{errors.leadInactivityExpiryDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-pricing-approval-target-days">Pricing approval target days</label>
            <input
              id="br-pricing-approval-target-days"
              name="pricingApprovalTargetDays"
              type="number"
              value={values.pricingApprovalTargetDays}
              onChange={(e) => setField('pricingApprovalTargetDays', Number(e.target.value))}
            />
            {errors.pricingApprovalTargetDays && <p data-testid="field-error" className="qiq-field-error">{errors.pricingApprovalTargetDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-sla-assignment-days">SLA: assignment days</label>
            <input
              id="br-sla-assignment-days"
              name="slaAssignmentDays"
              type="number"
              value={values.slaAssignmentDays}
              onChange={(e) => setField('slaAssignmentDays', Number(e.target.value))}
            />
            {errors.slaAssignmentDays && <p data-testid="field-error" className="qiq-field-error">{errors.slaAssignmentDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-sla-underwriting-days">SLA: underwriting days</label>
            <input
              id="br-sla-underwriting-days"
              name="slaUnderwritingDays"
              type="number"
              value={values.slaUnderwritingDays}
              onChange={(e) => setField('slaUnderwritingDays', Number(e.target.value))}
            />
            {errors.slaUnderwritingDays && <p data-testid="field-error" className="qiq-field-error">{errors.slaUnderwritingDays}</p>}
          </div>

          <div className="qiq-field">
            <label htmlFor="br-sla-received-to-sent-days">SLA: received-to-sent days</label>
            <input
              id="br-sla-received-to-sent-days"
              name="slaReceivedToSentDays"
              type="number"
              value={values.slaReceivedToSentDays}
              onChange={(e) => setField('slaReceivedToSentDays', Number(e.target.value))}
            />
            {errors.slaReceivedToSentDays && <p data-testid="field-error" className="qiq-field-error">{errors.slaReceivedToSentDays}</p>}
          </div>
          </div>
        </fieldset>

        <fieldset className="qiq-fieldset" disabled={!canManage}>
          <legend>Workflow rules</legend>
          <div className="qiq-form-grid">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <label
              htmlFor="br-require-pricing-approval"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)', fontSize: '13px', fontWeight: 550, color: 'var(--qiq-text-primary)', cursor: 'pointer' }}
            >
              <input
                id="br-require-pricing-approval"
                name="requirePricingApprovalForHighValue"
                type="checkbox"
                checked={values.requirePricingApprovalForHighValue}
                onChange={(e) => setField('requirePricingApprovalForHighValue', e.target.checked)}
              />
              {' '}Require pricing approval for high-value leads
            </label>
          </div>
          </div>
        </fieldset>
        </div>

        {canManage && (
          <div
            data-testid="form-sticky-footer"
            className="qiq-sticky-footer"
          >
            <button type="submit" className="qiq-btn qiq-btn--primary" disabled={saving}>
              Save
            </button>
          </div>
        )}
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

export default BusinessRulesTab;
