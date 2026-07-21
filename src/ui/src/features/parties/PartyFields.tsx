import type { PartyFieldName, PartyFieldValues } from './partyFieldValues';

interface ReferenceOption {
  id: number;
  name: string;
}

export interface PartyFieldsProps {
  /**
   * Namespaces every field's `id`/`htmlFor` pair (e.g. `"party"` -> `party-name`,
   * `"lead-new-party"` -> `lead-new-party-name`) so two independent instances of this component
   * never collide on the same page. Field *labels* are unaffected, so existing
   * `screen.getByLabelText(...)` test lookups keep working regardless of prefix.
   */
  idPrefix: string;
  values: PartyFieldValues;
  errors: Partial<Record<PartyFieldName, string>>;
  touched: Partial<Record<PartyFieldName, boolean>>;
  partyTypeOptions: ReferenceOption[] | null;
  segmentOptions: ReferenceOption[] | null;
  industryOptions: ReferenceOption[] | null;
  regionOptions: ReferenceOption[] | null;
  onChange: <K extends keyof PartyFieldValues>(field: K, value: PartyFieldValues[K]) => void;
  onBlur: (field: PartyFieldName) => void;
}

/**
 * Name/type/segment/industry/region/strategic/contact fields for a party (spec FR-28, PRD 12.9,
 * AC-027), extracted from `PartyFormPage` (T-025) so the lead-intake "+ New party" inline
 * expansion (T-026, spec FR-29) reuses the exact same fields/markup/validation copy rather than
 * duplicating them. Region is deliberately optional everywhere (spec Q-9).
 */
function PartyFields({
  idPrefix,
  values,
  errors,
  touched,
  partyTypeOptions,
  segmentOptions,
  industryOptions,
  regionOptions,
  onChange,
  onBlur,
}: PartyFieldsProps) {
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <div className="qiq-form-grid">
      <div className="qiq-field">
        <label htmlFor={id('name')}>Name</label>
        <input
          id={id('name')}
          name="name"
          type="text"
          value={values.name}
          aria-invalid={touched.name && errors.name ? true : undefined}
          aria-describedby={errors.name ? `${id('name')}-error` : undefined}
          onChange={(event) => onChange('name', event.target.value)}
          onBlur={() => onBlur('name')}
        />
        {touched.name && errors.name && (
          <p id={`${id('name')}-error`} data-testid="field-error" className="qiq-field-error">
            {errors.name}
          </p>
        )}
      </div>

      <div className="qiq-field">
        <label htmlFor={id('type')}>Party type</label>
        <select
          id={id('type')}
          name="partyTypeId"
          value={values.partyTypeId}
          disabled={partyTypeOptions === null}
          aria-invalid={touched.partyTypeId && errors.partyTypeId ? true : undefined}
          aria-describedby={errors.partyTypeId ? `${id('type')}-error` : undefined}
          onChange={(event) => onChange('partyTypeId', event.target.value)}
          onBlur={() => onBlur('partyTypeId')}
        >
          <option value="">Select a party type</option>
          {(partyTypeOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        {touched.partyTypeId && errors.partyTypeId && (
          <p id={`${id('type')}-error`} data-testid="field-error" className="qiq-field-error">
            {errors.partyTypeId}
          </p>
        )}
      </div>

      <div className="qiq-field">
        <label htmlFor={id('segment')}>Segment</label>
        <select
          id={id('segment')}
          name="segmentId"
          value={values.segmentId}
          disabled={segmentOptions === null}
          onChange={(event) => onChange('segmentId', event.target.value)}
        >
          <option value="">None</option>
          {(segmentOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor={id('industry')}>Industry</label>
        <select
          id={id('industry')}
          name="industryId"
          value={values.industryId}
          disabled={industryOptions === null}
          onChange={(event) => onChange('industryId', event.target.value)}
        >
          <option value="">None</option>
          {(industryOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        {/* Region is deliberately optional everywhere (spec Q-9) — no required marker, no validation. */}
        <label htmlFor={id('region')}>Region (optional)</label>
        <select
          id={id('region')}
          name="regionId"
          value={values.regionId}
          disabled={regionOptions === null}
          onChange={(event) => onChange('regionId', event.target.value)}
        >
          <option value="">None</option>
          {(regionOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '9px' }}>
        <label
          htmlFor={id('strategic')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)', fontSize: '13px', fontWeight: 550, color: 'var(--qiq-text-primary)', cursor: 'pointer' }}
        >
          <input
            id={id('strategic')}
            name="isStrategic"
            type="checkbox"
            checked={values.isStrategic}
            onChange={(event) => onChange('isStrategic', event.target.checked)}
          />
          Strategic party
        </label>
      </div>

      <div className="qiq-field">
        <label htmlFor={id('contact-name')}>Contact name</label>
        <input
          id={id('contact-name')}
          name="contactName"
          type="text"
          value={values.contactName}
          onChange={(event) => onChange('contactName', event.target.value)}
          onBlur={() => onBlur('contactName')}
        />
      </div>

      <div className="qiq-field">
        <label htmlFor={id('contact-email')}>Contact email</label>
        <input
          id={id('contact-email')}
          name="contactEmail"
          type="email"
          value={values.contactEmail}
          aria-invalid={touched.contactEmail && errors.contactEmail ? true : undefined}
          aria-describedby={errors.contactEmail ? `${id('contact-email')}-error` : undefined}
          onChange={(event) => onChange('contactEmail', event.target.value)}
          onBlur={() => onBlur('contactEmail')}
        />
        {touched.contactEmail && errors.contactEmail && (
          <p id={`${id('contact-email')}-error`} data-testid="field-error" className="qiq-field-error">
            {errors.contactEmail}
          </p>
        )}
      </div>

      <div className="qiq-field">
        <label htmlFor={id('contact-phone')}>Contact phone</label>
        <input
          id={id('contact-phone')}
          name="contactPhone"
          type="tel"
          value={values.contactPhone}
          aria-invalid={touched.contactPhone && errors.contactPhone ? true : undefined}
          aria-describedby={errors.contactPhone ? `${id('contact-phone')}-error` : undefined}
          onChange={(event) => onChange('contactPhone', event.target.value)}
          onBlur={() => onBlur('contactPhone')}
        />
        {touched.contactPhone && errors.contactPhone && (
          <p id={`${id('contact-phone')}-error`} data-testid="field-error" className="qiq-field-error">
            {errors.contactPhone}
          </p>
        )}
      </div>
    </div>
  );
}

export default PartyFields;
