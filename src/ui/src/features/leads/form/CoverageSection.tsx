import CurrencyInput from '../../../components/common/CurrencyInput';
import { POLICY_TERM_OPTIONS, POLICY_TERM_OTHER, PRIORITY_NORMAL, PRIORITY_HIGH } from './leadFormConstants';

interface ReferenceOption {
  id: number;
  name: string;
}

interface CoverTypeOption extends ReferenceOption {
  productLineId: number | null;
}

export type CoverageFormField = 'productLineId' | 'coverTypeId' | 'sumInsured' | 'estimatedPremium' | 'policyTerm' | 'policyTermOther';

export interface CoverageSectionValues {
  productLineId: string;
  coverTypeId: string;
  sumInsured: number | null;
  estimatedPremium: number | null;
  policyTerm: string;
  policyTermOther: string;
  priority: string;
  intakeNotes: string;
}

interface CoverageSectionProps {
  values: CoverageSectionValues;
  errors: Partial<Record<CoverageFormField, string>>;
  touched: Partial<Record<CoverageFormField, boolean>>;
  productLineOptions: ReferenceOption[] | null;
  coverTypeOptions: CoverTypeOption[] | null;
  currencySymbol: string;
  /** True while `priority` tracks the server-derived value rather than an explicit user pick (spec FR-29: "derived High ... overridable"). */
  priorityIsDerived: boolean;
  onChange: (field: keyof CoverageSectionValues, value: string | number | null) => void;
  onBlur: (field: CoverageFormField) => void;
  onProductLineChange: (productLineId: string) => void;
  onPriorityOverride: (priority: string) => void;
}

/**
 * Coverage Need section of the lead intake/edit form (spec FR-29, PRD 9.3, Q-11, AC-028):
 * product line -> cover type dependency (cover type disabled until a product line is chosen, and
 * resets whenever the product line changes), tenant-currency `sumInsured`/`estimatedPremium` inputs,
 * a policy-term select with a required companion free-text field only for "Other", a Normal/High
 * priority select initialized from the server-derived value and freely overridable, and an
 * intake-notes textarea spanning both grid columns.
 */
function CoverageSection({
  values,
  errors,
  touched,
  productLineOptions,
  coverTypeOptions,
  currencySymbol,
  priorityIsDerived,
  onChange,
  onBlur,
  onProductLineChange,
  onPriorityOverride,
}: CoverageSectionProps) {
  const availableCoverTypes = (coverTypeOptions ?? []).filter(
    (coverType) => values.productLineId !== '' && String(coverType.productLineId) === values.productLineId,
  );

  return (
    <section data-testid="coverage-section">
      <h3 className="qiq-form-section-title" style={{ marginBottom: 'var(--qiq-space-4)' }}>
        Coverage Need
      </h3>
      <div className="qiq-form-grid">
        <div className="qiq-field">
          <label htmlFor="lead-product-line">Product line</label>
          <select
            id="lead-product-line"
            name="productLineId"
            value={values.productLineId}
            disabled={productLineOptions === null}
            aria-invalid={touched.productLineId && errors.productLineId ? true : undefined}
            onChange={(event) => onProductLineChange(event.target.value)}
            onBlur={() => onBlur('productLineId')}
          >
            <option value="">Select a product line</option>
            {(productLineOptions ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          {touched.productLineId && errors.productLineId && (
            <p data-testid="field-error" role="alert" className="qiq-field-error">
              {errors.productLineId}
            </p>
          )}
        </div>

        <div className="qiq-field">
          <label htmlFor="lead-cover-type">Cover type</label>
          <select
            id="lead-cover-type"
            name="coverTypeId"
            value={values.coverTypeId}
            disabled={values.productLineId === '' || coverTypeOptions === null}
            aria-invalid={touched.coverTypeId && errors.coverTypeId ? true : undefined}
            onChange={(event) => onChange('coverTypeId', event.target.value)}
            onBlur={() => onBlur('coverTypeId')}
          >
            <option value="">Select a cover type</option>
            {availableCoverTypes.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          {touched.coverTypeId && errors.coverTypeId && (
            <p data-testid="field-error" role="alert" className="qiq-field-error">
              {errors.coverTypeId}
            </p>
          )}
        </div>

        <div className="qiq-field">
          <label htmlFor="lead-sum-insured">Sum insured</label>
          <CurrencyInput
            id="lead-sum-insured"
            name="sumInsured"
            value={values.sumInsured}
            currencySymbol={currencySymbol}
            ariaInvalid={touched.sumInsured && !!errors.sumInsured}
            onChange={(value) => onChange('sumInsured', value)}
            onBlur={() => onBlur('sumInsured')}
          />
          {touched.sumInsured && errors.sumInsured && (
            <p data-testid="field-error" role="alert" className="qiq-field-error">
              {errors.sumInsured}
            </p>
          )}
        </div>

        <div className="qiq-field">
          <label htmlFor="lead-estimated-premium">Estimated premium</label>
          <CurrencyInput
            id="lead-estimated-premium"
            name="estimatedPremium"
            value={values.estimatedPremium}
            currencySymbol={currencySymbol}
            ariaInvalid={touched.estimatedPremium && !!errors.estimatedPremium}
            onChange={(value) => onChange('estimatedPremium', value)}
            onBlur={() => onBlur('estimatedPremium')}
          />
          {touched.estimatedPremium && errors.estimatedPremium && (
            <p data-testid="field-error" role="alert" className="qiq-field-error">
              {errors.estimatedPremium}
            </p>
          )}
        </div>

        <div className="qiq-field">
          <label htmlFor="lead-policy-term">Policy term</label>
          <select
            id="lead-policy-term"
            name="policyTerm"
            value={values.policyTerm}
            onChange={(event) => onChange('policyTerm', event.target.value)}
            onBlur={() => onBlur('policyTerm')}
          >
            {POLICY_TERM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {values.policyTerm === POLICY_TERM_OTHER && (
          <div className="qiq-field">
            <label htmlFor="lead-policy-term-other">Describe policy term</label>
            <input
              id="lead-policy-term-other"
              name="policyTermOther"
              type="text"
              value={values.policyTermOther}
              aria-invalid={touched.policyTermOther && errors.policyTermOther ? true : undefined}
              onChange={(event) => onChange('policyTermOther', event.target.value)}
              onBlur={() => onBlur('policyTermOther')}
            />
            {touched.policyTermOther && errors.policyTermOther && (
              <p data-testid="field-error" role="alert" className="qiq-field-error">
                {errors.policyTermOther}
              </p>
            )}
          </div>
        )}

        <div className="qiq-field">
          <label htmlFor="lead-priority">Priority</label>
          <select
            id="lead-priority"
            name="priority"
            value={values.priority}
            onChange={(event) => onPriorityOverride(event.target.value)}
          >
            <option value={PRIORITY_NORMAL}>Normal</option>
            <option value={PRIORITY_HIGH}>High</option>
          </select>
          {priorityIsDerived && (
            <span data-testid="priority-derived-hint" className="qiq-field-hint">
              Derived from the estimated premium — change to override.
            </span>
          )}
        </div>

        <div className="qiq-field qiq-form-full">
          <label htmlFor="lead-intake-notes">Intake notes</label>
          <textarea
            id="lead-intake-notes"
            name="intakeNotes"
            value={values.intakeNotes}
            onChange={(event) => onChange('intakeNotes', event.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

export default CoverageSection;
