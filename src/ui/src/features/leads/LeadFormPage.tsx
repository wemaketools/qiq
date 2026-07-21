import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission, selectSession } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import { useTenantCurrencySymbol } from '../../components/shell/useTenantCurrency';
import type { NormalizedError } from '../../api/client';
import { getParty, type PartyDto } from '../parties/partiesApi';
import { EMPTY_PARTY_FIELD_VALUES, type PartyFieldName, type PartyFieldValues } from '../parties/partyFieldValues';
import { listReferenceItems, listBrokers, type ReferenceItemDto } from '../settings/settingsApi';
import {
  createLead,
  getEligibleLeadOwners,
  getIntakeTenantRules,
  getLead,
  updateLead,
  DUPLICATE_LEAD_WARNING_CODE,
  DUPLICATE_EXTERNAL_REF_WARNING_CODE,
  DUPLICATE_PARTY_NAME_WARNING_CODE,
  type CreateLeadPayload,
  type EligibleLeadOwnerDto,
  type LeadDuplicateMatchDto,
  type UpdateLeadPayload,
} from './leadsApi';
import PartySection from './form/PartySection';
import RequestSection, { type RequestFormField } from './form/RequestSection';
import CoverageSection, { type CoverageFormField } from './form/CoverageSection';
import { POLICY_TERM_OTHER, DEFAULT_POLICY_TERM, PRIORITY_NORMAL, PRIORITY_HIGH } from './form/leadFormConstants';
import DuplicateLeadDialog from './form/DuplicateLeadDialog';
import { useToast } from '../../components/common/Toast';
import { useUnsavedChanges } from '../../components/common/useUnsavedChanges';
import ErrorBanner from '../../components/common/ErrorBanner';

interface ReferenceOption {
  id: number;
  name: string;
}

function toReferenceOptions(items: ReferenceItemDto[]): ReferenceOption[] {
  return items.map((item) => ({ id: item.id, name: item.name }));
}

function toRequestValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRequestId(value: string): number | null {
  return value === '' ? null : Number(value);
}

interface FormValues {
  partyId: number | null;
  partyMode: 'existing' | 'new';
  inlineParty: PartyFieldValues;
  isExistingClient: boolean;
  dateReceived: string;
  requestChannelId: string;
  brokerId: string;
  ownerUserId: string;
  regionId: string;
  externalRef: string;
  productLineId: string;
  coverTypeId: string;
  sumInsured: number | null;
  estimatedPremium: number | null;
  policyTerm: string;
  policyTermOther: string;
  priority: string;
  intakeNotes: string;
}

/** Party-picker-level error (no existing party selected and no "+ New party" started). */
type PartyPickerField = 'partyPicker';

type FormField = PartyPickerField | PartyFieldName | RequestFormField | CoverageFormField;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyValues(): FormValues {
  return {
    partyId: null,
    partyMode: 'existing',
    inlineParty: EMPTY_PARTY_FIELD_VALUES,
    isExistingClient: false,
    dateReceived: todayIso(),
    requestChannelId: '',
    brokerId: '',
    ownerUserId: '',
    regionId: '',
    externalRef: '',
    productLineId: '',
    coverTypeId: '',
    sumInsured: null,
    estimatedPremium: null,
    policyTerm: DEFAULT_POLICY_TERM,
    policyTermOther: '',
    priority: PRIORITY_NORMAL,
    intakeNotes: '',
  };
}

const ALL_FIELDS: FormField[] = [
  'partyPicker',
  'name',
  'partyTypeId',
  'contactEmail',
  'contactPhone',
  'dateReceived',
  'requestChannelId',
  'brokerId',
  'ownerUserId',
  'regionId',
  'productLineId',
  'coverTypeId',
  'sumInsured',
  'estimatedPremium',
  'policyTerm',
  'policyTermOther',
];

interface ValidationContext {
  isBrokerChannel: boolean;
  partyLocked: boolean;
  isEditMode: boolean;
}

function validatePartyFieldFor(field: PartyFieldName, values: PartyFieldValues): string | undefined {
  if (field === 'name') {
    return values.name.trim().length === 0 ? 'Party name is required.' : undefined;
  }
  if (field === 'partyTypeId') {
    return values.partyTypeId === '' ? 'Party type is required.' : undefined;
  }
  if (field === 'contactEmail') {
    const email = values.contactEmail.trim();
    return email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Enter a valid email address.' : undefined;
  }
  if (field === 'contactPhone') {
    const phone = values.contactPhone.trim();
    return phone.length > 0 && !/^[+]?[0-9()\-.\s]{7,20}$/.test(phone) ? 'Enter a valid phone number.' : undefined;
  }
  return undefined;
}

function validateField(field: FormField, values: FormValues, ctx: ValidationContext): string | undefined {
  if (field === 'partyPicker') {
    if (ctx.partyLocked) {
      return undefined;
    }
    return values.partyMode === 'existing' && values.partyId === null ? 'Select a party or start a new one.' : undefined;
  }
  if (field === 'name' || field === 'partyTypeId' || field === 'contactEmail' || field === 'contactPhone') {
    if (values.partyMode !== 'new') {
      return undefined;
    }
    return validatePartyFieldFor(field, values.inlineParty);
  }
  if (field === 'dateReceived') {
    return values.dateReceived === '' ? 'Date received is required.' : undefined;
  }
  if (field === 'requestChannelId') {
    return values.requestChannelId === '' ? 'Request channel is required.' : undefined;
  }
  if (field === 'brokerId') {
    return ctx.isBrokerChannel && values.brokerId === '' ? 'Broker is required for this request channel.' : undefined;
  }
  if (field === 'ownerUserId') {
    return !ctx.isEditMode && values.ownerUserId === '' ? 'Owner is required.' : undefined;
  }
  if (field === 'regionId') {
    return values.regionId === '' ? 'Region is required.' : undefined;
  }
  if (field === 'productLineId') {
    return values.productLineId === '' ? 'Product line is required.' : undefined;
  }
  if (field === 'coverTypeId') {
    return values.coverTypeId === '' ? 'Cover type is required.' : undefined;
  }
  if (field === 'sumInsured') {
    return values.sumInsured !== null && values.sumInsured <= 0 ? 'Sum insured must be greater than 0.' : undefined;
  }
  if (field === 'estimatedPremium') {
    return values.estimatedPremium !== null && values.estimatedPremium <= 0 ? 'Estimated premium must be greater than 0.' : undefined;
  }
  if (field === 'policyTermOther') {
    return values.policyTerm === POLICY_TERM_OTHER && values.policyTermOther.trim() === '' ? 'Describe the policy term.' : undefined;
  }
  return undefined;
}

function validateAll(values: FormValues, ctx: ValidationContext): Partial<Record<FormField, string>> {
  const errors: Partial<Record<FormField, string>> = {};
  ALL_FIELDS.forEach((field) => {
    const message = validateField(field, values, ctx);
    if (message) {
      errors[field] = message;
    }
  });
  return errors;
}

/**
 * New/Edit Lead intake form (spec FR-29..FR-32, PRD 9.3/12.6, AC-028..AC-031, T-018/T-025). Routes
 * `/leads/new` (supports `?partyId=` which locks the Party section — completing T-025's
 * `[data-testid='party-section-locked']` cross-task assertion, V-026) and `/leads/{id}/edit`.
 * Composes three titled sections: Party (`form/PartySection.tsx`), Request Details
 * (`form/RequestSection.tsx`), and Coverage Need (`form/CoverageSection.tsx`). Edit mode never shows
 * lifecycle/outcome fields (spec FR-30/FR-32: `UpdateLeadCommand` carries no status/owner field) —
 * the Party section is always locked in edit mode (party reassignment is out of `UpdateLeadCommand`'s
 * scope) and the Owner field is hidden (owner changes go through the Assign workflow operation).
 */
function LeadFormPage() {
  const { leadId } = useParams<{ leadId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const currencySymbol = useTenantCurrencySymbol();
  const currentUserId = useAppSelector((state) => selectSession(state).user?.userId ?? null);

  const isEditMode = leadId !== undefined;
  const queryPartyId = searchParams.get('partyId');
  const partyLocked = isEditMode || queryPartyId !== null;

  const canCreate = useAppSelector(selectHasPermission(PermissionCodes.LeadsCreate));
  const canUpdate = useAppSelector(selectHasPermission(PermissionCodes.LeadsUpdate));
  const canSave = isEditMode ? canUpdate : canCreate;

  const [partyTypeOptions, setPartyTypeOptions] = useState<ReferenceOption[] | null>(null);
  const [segmentOptions, setSegmentOptions] = useState<ReferenceOption[] | null>(null);
  const [industryOptions, setIndustryOptions] = useState<ReferenceOption[] | null>(null);
  const [regionOptions, setRegionOptions] = useState<ReferenceOption[] | null>(null);
  const [channelOptions, setChannelOptions] = useState<ReferenceItemDto[] | null>(null);
  const [productLineOptions, setProductLineOptions] = useState<ReferenceOption[] | null>(null);
  const [coverTypeItems, setCoverTypeItems] = useState<ReferenceItemDto[] | null>(null);
  const [brokerOptions, setBrokerOptions] = useState<ReferenceOption[] | null>(null);
  const [eligibleOwners, setEligibleOwners] = useState<EligibleLeadOwnerDto[] | null>(null);
  const [tenantRules, setTenantRules] = useState<{ highValueThreshold: number | null; manualExternalRefEnabled: boolean } | null>(null);

  const [lockedParty, setLockedParty] = useState<PartyDto | null>(null);
  const [selectedParty, setSelectedParty] = useState<PartyDto | null>(null);

  const [initialValues, setInitialValues] = useState<FormValues>(emptyValues);
  const [values, setValues] = useState<FormValues>(emptyValues);
  const [priorityOverridden, setPriorityOverridden] = useState(isEditMode);
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(isEditMode);
  const [saving, setSaving] = useState(false);
  const [leadRef, setLeadRef] = useState<string | null>(null);
  const [justSavedLeadId, setJustSavedLeadId] = useState<number | null>(null);

  const [pendingCreatePayload, setPendingCreatePayload] = useState<CreateLeadPayload | null>(null);
  const [duplicates, setDuplicates] = useState<LeadDuplicateMatchDto[]>([]);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);

  // Reference-option loaders (spec FR-29): each degrades independently to `null` on failure, same
  // convention as `LeadsListPage`/`PartiesFilterBar`.
  useEffect(() => {
    listReferenceItems('party_type').then((items) => setPartyTypeOptions(toReferenceOptions(items))).catch(() => setPartyTypeOptions(null));
    listReferenceItems('party_segment').then((items) => setSegmentOptions(toReferenceOptions(items))).catch(() => setSegmentOptions(null));
    listReferenceItems('industry').then((items) => setIndustryOptions(toReferenceOptions(items))).catch(() => setIndustryOptions(null));
    listReferenceItems('region').then((items) => setRegionOptions(toReferenceOptions(items))).catch(() => setRegionOptions(null));
    listReferenceItems('request_channel').then(setChannelOptions).catch(() => setChannelOptions(null));
    listReferenceItems('product_line').then((items) => setProductLineOptions(toReferenceOptions(items))).catch(() => setProductLineOptions(null));
    listReferenceItems('cover_type').then(setCoverTypeItems).catch(() => setCoverTypeItems(null));
    listBrokers()
      .then((result) => setBrokerOptions(result.items.filter((broker) => broker.status === 'active').map((broker) => ({ id: broker.id, name: broker.name }))))
      .catch(() => setBrokerOptions(null));
    getEligibleLeadOwners().then(setEligibleOwners).catch(() => setEligibleOwners(null));
    getIntakeTenantRules().then(setTenantRules).catch(() => setTenantRules(null));
  }, []);

  // Default the owner to the current user once eligible owners are known (spec FR-29: "owner default
  // ... when eligible"), but only in create mode and only while the user hasn't already picked one.
  useEffect(() => {
    if (isEditMode || eligibleOwners === null || currentUserId === null) {
      return;
    }
    setValues((current) => {
      if (current.ownerUserId !== '') {
        return current;
      }
      const eligible = eligibleOwners.some((owner) => owner.userId === currentUserId);
      return eligible ? { ...current, ownerUserId: String(currentUserId) } : current;
    });
  }, [eligibleOwners, currentUserId, isEditMode]);

  // Derived priority (spec FR-29: "derived High above tenant high-value threshold, overridable") —
  // recomputed live while the user has not explicitly overridden it. Skipped in edit mode, where
  // `UpdateLeadCommand.Priority` is always an explicit value (see this component's doc comment).
  useEffect(() => {
    if (isEditMode || priorityOverridden || tenantRules === null || tenantRules.highValueThreshold === null) {
      return;
    }
    const derived =
      values.estimatedPremium !== null && values.estimatedPremium > tenantRules.highValueThreshold ? PRIORITY_HIGH : PRIORITY_NORMAL;
    setValues((current) => (current.priority === derived ? current : { ...current, priority: derived }));
  }, [values.estimatedPremium, tenantRules, priorityOverridden, isEditMode]);

  const applyPartyDefaults = useCallback((party: PartyDto) => {
    setValues((current) => (current.regionId === '' && party.regionId !== null ? { ...current, regionId: String(party.regionId) } : current));
  }, []);

  // Locked-party load (create: `?partyId=`; edit: always locked to the lead's own party).
  useEffect(() => {
    if (isEditMode) {
      return;
    }
    if (queryPartyId === null) {
      setLockedParty(null);
      return;
    }
    let cancelled = false;
    getParty(Number(queryPartyId))
      .then((party) => {
        if (cancelled) {
          return;
        }
        setLockedParty(party);
        setValues((current) => ({ ...current, partyId: party.id, partyMode: 'existing' }));
        applyPartyDefaults(party);
      })
      .catch(() => {
        if (!cancelled) {
          setFormError('Unable to load the locked party.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isEditMode, queryPartyId, applyPartyDefaults]);

  // Edit-mode load.
  useEffect(() => {
    if (!isEditMode || leadId === undefined) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getLead(Number(leadId))
      .then((lead) => {
        if (cancelled) {
          return;
        }
        const loaded: FormValues = {
          partyId: lead.partyId,
          partyMode: 'existing',
          inlineParty: EMPTY_PARTY_FIELD_VALUES,
          isExistingClient: lead.isExistingClient,
          dateReceived: lead.dateReceived,
          requestChannelId: String(lead.requestChannelId),
          brokerId: lead.brokerId !== null ? String(lead.brokerId) : '',
          ownerUserId: lead.owner !== null ? String(lead.owner.userId) : '',
          regionId: String(lead.regionId),
          externalRef: lead.externalRef ?? '',
          productLineId: String(lead.productLineId),
          coverTypeId: String(lead.coverTypeId),
          sumInsured: lead.sumInsured,
          estimatedPremium: lead.estimatedPremium,
          policyTerm: lead.policyTerm,
          policyTermOther: lead.policyTermOther ?? '',
          priority: lead.priority,
          intakeNotes: '',
        };
        setInitialValues(loaded);
        setValues(loaded);
        setLeadRef(lead.leadRef);
        getParty(lead.partyId)
          .then((party) => {
            if (!cancelled) {
              setLockedParty(party);
            }
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) {
          setFormError('Unable to load this lead.');
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
  }, [isEditMode, leadId]);

  useEffect(() => {
    if (!isEditMode) {
      setInitialValues(emptyValues());
    }
  }, [isEditMode]);

  const isDirty = useMemo(
    () => justSavedLeadId === null && JSON.stringify(values) !== JSON.stringify(initialValues),
    [values, initialValues, justSavedLeadId],
  );
  const unsavedChanges = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (justSavedLeadId !== null) {
      navigate(`/leads/${justSavedLeadId}`);
    }
  }, [justSavedLeadId, navigate]);

  const selectedChannel = channelOptions?.find((channel) => String(channel.id) === values.requestChannelId) ?? null;
  const isBrokerChannel = selectedChannel?.isBrokerChannel ?? false;

  const errorFields = Object.keys(fieldErrors) as FormField[];
  const showSummaryBanner = errorFields.length >= 3;

  function handleChange(field: keyof FormValues, value: string | number | boolean | null): void {
    setValues((current) => ({ ...current, [field]: value }) as FormValues);
  }

  function handleBlur(field: FormField): void {
    setTouched((current) => ({ ...current, [field]: true }));
    const message = validateField(field, values, { isBrokerChannel, partyLocked, isEditMode });
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

  function handleSelectParty(party: PartyDto): void {
    setSelectedParty(party);
    setValues((current) => ({ ...current, partyId: party.id, partyMode: 'existing' }));
    setFieldErrors((current) => {
      const rest = { ...current };
      delete rest.partyPicker;
      return rest;
    });
    applyPartyDefaults(party);
  }

  function handleChangeParty(): void {
    setSelectedParty(null);
    setValues((current) => ({ ...current, partyId: null }));
  }

  function handleStartNewParty(): void {
    setValues((current) => ({ ...current, partyMode: 'new', partyId: null }));
  }

  function handleCancelNewParty(): void {
    setValues((current) => ({ ...current, partyMode: 'existing', inlineParty: EMPTY_PARTY_FIELD_VALUES }));
  }

  function handleInlinePartyChange<K extends keyof PartyFieldValues>(field: K, value: PartyFieldValues[K]): void {
    setValues((current) => ({ ...current, inlineParty: { ...current.inlineParty, [field]: value } }));
  }

  function handleInlinePartyBlur(field: PartyFieldName): void {
    handleBlur(field);
  }

  function handleProductLineChange(productLineId: string): void {
    setValues((current) => ({ ...current, productLineId, coverTypeId: '' }));
  }

  function handlePriorityOverride(priority: string): void {
    setPriorityOverridden(true);
    setValues((current) => ({ ...current, priority }));
  }

  function buildInlinePartyPayload() {
    return {
      name: values.inlineParty.name.trim(),
      partyTypeId: Number(values.inlineParty.partyTypeId),
      segmentId: toRequestId(values.inlineParty.segmentId),
      industryId: toRequestId(values.inlineParty.industryId),
      regionId: toRequestId(values.inlineParty.regionId),
      isStrategic: values.inlineParty.isStrategic,
      contactName: toRequestValue(values.inlineParty.contactName),
      contactEmail: toRequestValue(values.inlineParty.contactEmail),
      contactPhone: toRequestValue(values.inlineParty.contactPhone),
    };
  }

  function buildCreatePayload(createAnyway: boolean): CreateLeadPayload {
    return {
      partyId: values.partyMode === 'existing' ? values.partyId : null,
      inlineParty: values.partyMode === 'new' ? buildInlinePartyPayload() : null,
      isExistingClient: values.isExistingClient,
      dateReceived: values.dateReceived,
      requestChannelId: Number(values.requestChannelId),
      brokerId: values.brokerId === '' ? null : Number(values.brokerId),
      ownerUserId: Number(values.ownerUserId),
      regionId: Number(values.regionId),
      externalRef: toRequestValue(values.externalRef),
      productLineId: Number(values.productLineId),
      coverTypeId: Number(values.coverTypeId),
      sumInsured: values.sumInsured,
      estimatedPremium: values.estimatedPremium,
      policyTerm: values.policyTerm,
      policyTermOther: values.policyTerm === POLICY_TERM_OTHER ? values.policyTermOther.trim() : null,
      priority: priorityOverridden ? values.priority : null,
      intakeNotes: toRequestValue(values.intakeNotes),
      createAnyway,
    };
  }

  function buildUpdatePayload(): UpdateLeadPayload {
    return {
      isExistingClient: values.isExistingClient,
      dateReceived: values.dateReceived,
      requestChannelId: Number(values.requestChannelId),
      brokerId: values.brokerId === '' ? null : Number(values.brokerId),
      regionId: Number(values.regionId),
      externalRef: toRequestValue(values.externalRef),
      productLineId: Number(values.productLineId),
      coverTypeId: Number(values.coverTypeId),
      sumInsured: values.sumInsured,
      estimatedPremium: values.estimatedPremium,
      policyTerm: values.policyTerm,
      policyTermOther: values.policyTerm === POLICY_TERM_OTHER ? values.policyTermOther.trim() : null,
      priority: values.priority,
    };
  }

  function showNonBlockingWarnings(warnings: { code: string }[]): void {
    if (warnings.some((warning) => warning.code === DUPLICATE_PARTY_NAME_WARNING_CODE)) {
      showError('This party name is similar to an existing party — review before continuing.');
    }
    if (warnings.some((warning) => warning.code === DUPLICATE_EXTERNAL_REF_WARNING_CODE)) {
      showError('This external reference is already used on another lead.');
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const errors = validateAll(values, { isBrokerChannel, partyLocked, isEditMode });
    setFieldErrors(errors);
    setTouched(Object.fromEntries(ALL_FIELDS.map((field) => [field, true])) as Record<FormField, boolean>);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSaving(true);
    try {
      if (isEditMode && leadId !== undefined) {
        const updated = await updateLead(Number(leadId), buildUpdatePayload());
        setInitialValues(values);
        showSuccess(`Lead ${updated.leadRef} updated`);
        setJustSavedLeadId(updated.id);
        return;
      }

      const payload = buildCreatePayload(false);
      const result = await createLead(payload);
      if (result.requiresConfirmation) {
        const duplicateWarning = result.warnings.find((warning) => warning.code === DUPLICATE_LEAD_WARNING_CODE);
        const found = (duplicateWarning?.details as { duplicates?: LeadDuplicateMatchDto[] } | undefined)?.duplicates ?? [];
        setDuplicates(found);
        setPendingCreatePayload(payload);
        setDuplicateDialogOpen(true);
        return;
      }

      setInitialValues(values);
      showSuccess(`Lead ${result.lead!.leadRef} created`);
      showNonBlockingWarnings(result.warnings);
      setJustSavedLeadId(result.lead!.id);
    } catch (err) {
      setFormError((err as NormalizedError).title ?? 'Unable to save this lead.');
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateAnyway(): Promise<void> {
    if (pendingCreatePayload === null) {
      return;
    }
    setSaving(true);
    try {
      const result = await createLead({ ...pendingCreatePayload, createAnyway: true });
      setDuplicateDialogOpen(false);
      setInitialValues(values);
      showSuccess(`Lead ${result.lead!.leadRef} created`);
      showNonBlockingWarnings(result.warnings);
      setJustSavedLeadId(result.lead!.id);
    } catch (err) {
      setFormError((err as NormalizedError).title ?? 'Unable to save this lead.');
    } finally {
      setSaving(false);
    }
  }

  function handleReviewExisting(duplicateLeadId: number): void {
    setDuplicateDialogOpen(false);
    navigate(`/leads/${duplicateLeadId}`);
  }

  function handleCancel(): void {
    if (isEditMode && leadId !== undefined) {
      navigate(`/leads/${leadId}`);
    } else {
      navigate('/leads');
    }
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  const coverTypeOptions = (coverTypeItems ?? []).map((item) => ({ id: item.id, name: item.name, productLineId: item.productLineId }));

  return (
    <div data-testid="lead-form-page" className="qiq-page">
      <h2 style={{ fontSize: '20px' }}>{isEditMode ? `Edit Lead ${leadRef ?? ''}` : 'New Lead'}</h2>

      {formError && <ErrorBanner message={formError} />}

      {showSummaryBanner && (
        <div role="alert" data-testid="form-error-summary" className="qiq-banner qiq-banner--error" style={{ display: 'block' }}>
          <p>Please fix the following:</p>
          <ul>
            {errorFields.map((field) => (
              <li key={field}>{fieldErrors[field]}</li>
            ))}
          </ul>
        </div>
      )}

      <form data-testid="lead-form" onSubmit={(event) => void handleSubmit(event)} noValidate className="qiq-card" style={{ padding: 0 }}>
        <div style={{ padding: 'var(--qiq-space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-6)' }}>
        <PartySection
          locked={partyLocked}
          lockedParty={lockedParty}
          selectedParty={selectedParty}
          partyMode={values.partyMode}
          inlineParty={values.inlineParty}
          inlinePartyErrors={fieldErrors}
          inlinePartyTouched={touched}
          partyPickerError={touched.partyPicker ? fieldErrors.partyPicker : undefined}
          partyTypeOptions={partyTypeOptions}
          segmentOptions={segmentOptions}
          industryOptions={industryOptions}
          regionOptions={regionOptions}
          onSelectParty={handleSelectParty}
          onStartNewParty={handleStartNewParty}
          onCancelNewParty={handleCancelNewParty}
          onChangeParty={handleChangeParty}
          onInlinePartyChange={handleInlinePartyChange}
          onInlinePartyBlur={handleInlinePartyBlur}
        />

        <RequestSection
          values={values}
          errors={fieldErrors}
          touched={touched}
          today={todayIso()}
          channelOptions={channelOptions}
          brokerOptions={brokerOptions}
          ownerOptions={eligibleOwners?.map((owner) => ({ id: owner.userId, name: `${owner.firstName} ${owner.lastName}` })) ?? null}
          regionOptions={regionOptions}
          showOwner={!isEditMode}
          showExternalRef={tenantRules?.manualExternalRefEnabled ?? false}
          onChange={handleChange}
          onBlur={handleBlur}
        />

        <CoverageSection
          values={values}
          errors={fieldErrors}
          touched={touched}
          productLineOptions={productLineOptions}
          coverTypeOptions={coverTypeOptions}
          currencySymbol={currencySymbol}
          priorityIsDerived={!isEditMode && !priorityOverridden}
          onChange={handleChange}
          onBlur={handleBlur}
          onProductLineChange={handleProductLineChange}
          onPriorityOverride={handlePriorityOverride}
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
              {isEditMode ? 'Save changes' : 'Create lead'}
            </button>
          )}
        </div>
      </form>

      <DuplicateLeadDialog
        open={duplicateDialogOpen}
        duplicates={duplicates}
        busy={saving}
        onReviewExisting={handleReviewExisting}
        onCreateAnyway={() => void handleCreateAnyway()}
        onCancel={() => setDuplicateDialogOpen(false)}
      />

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

export default LeadFormPage;
