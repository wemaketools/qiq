import type { ReferenceItemDto } from '../../settings/settingsApi';

interface ReferenceOption {
  id: number;
  name: string;
}

export type RequestFormField = 'dateReceived' | 'requestChannelId' | 'brokerId' | 'ownerUserId' | 'regionId';

export interface RequestSectionValues {
  isExistingClient: boolean;
  dateReceived: string;
  requestChannelId: string;
  brokerId: string;
  ownerUserId: string;
  regionId: string;
  externalRef: string;
}

interface RequestSectionProps {
  values: RequestSectionValues;
  errors: Partial<Record<RequestFormField, string>>;
  touched: Partial<Record<RequestFormField, boolean>>;
  today: string;
  /** Full reference items (not just id/name) so the broker-channel flag is available for the conditional broker requirement (spec FR-29). */
  channelOptions: ReferenceItemDto[] | null;
  brokerOptions: ReferenceOption[] | null;
  ownerOptions: ReferenceOption[] | null;
  regionOptions: ReferenceOption[] | null;
  /** False in edit mode (spec FR-30/FR-32): `UpdateLeadCommand` carries no owner field — owner changes go through the Assign workflow operation (T-019), not Edit. */
  showOwner: boolean;
  /** `null` = the tenant rules lookup degraded (see `leadsApi.getIntakeTenantRules`'s doc comment) — hides the field rather than guessing. */
  showExternalRef: boolean;
  externalRefWarning?: string | null;
  onChange: (field: keyof RequestSectionValues, value: string | boolean) => void;
  onBlur: (field: RequestFormField) => void;
}

/**
 * Request Details section of the lead intake/edit form (spec FR-29, PRD 9.3, AC-028): date received
 * (default today, max today), request channel, a broker picker visible+required only for
 * broker-flagged channels, an owner picker (defaulted to the current user when eligible, by the
 * parent `LeadFormPage`), region (defaulted from the selected party by the parent), and an optional
 * external-ref input gated on the tenant's `manual_external_ref_enabled` setting.
 */
function RequestSection({
  values,
  errors,
  touched,
  today,
  channelOptions,
  brokerOptions,
  ownerOptions,
  regionOptions,
  showOwner,
  showExternalRef,
  externalRefWarning,
  onChange,
  onBlur,
}: RequestSectionProps) {
  const selectedChannel = channelOptions?.find((channel) => String(channel.id) === values.requestChannelId) ?? null;
  const isBrokerChannel = selectedChannel?.isBrokerChannel ?? false;

  return (
    <section data-testid="request-section">
      <h3 className="qiq-form-section-title" style={{ marginBottom: 'var(--qiq-space-4)' }}>
        Request Details
      </h3>
      <div className="qiq-form-grid">
        <div className="qiq-field">
          <label htmlFor="lead-date-received">Date received</label>
          <input
            id="lead-date-received"
            name="dateReceived"
            type="date"
            value={values.dateReceived}
            max={today}
            aria-invalid={touched.dateReceived && errors.dateReceived ? true : undefined}
            onChange={(event) => onChange('dateReceived', event.target.value)}
            onBlur={() => onBlur('dateReceived')}
          />
          {touched.dateReceived && errors.dateReceived && (
            <p data-testid="field-error" role="alert" className="qiq-field-error">
              {errors.dateReceived}
            </p>
          )}
        </div>

        <div className="qiq-field">
          <label htmlFor="lead-request-channel">Request channel</label>
          <select
            id="lead-request-channel"
            name="requestChannelId"
            value={values.requestChannelId}
            disabled={channelOptions === null}
            aria-invalid={touched.requestChannelId && errors.requestChannelId ? true : undefined}
            onChange={(event) => onChange('requestChannelId', event.target.value)}
            onBlur={() => onBlur('requestChannelId')}
          >
            <option value="">Select a channel</option>
            {(channelOptions ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          {touched.requestChannelId && errors.requestChannelId && (
            <p data-testid="field-error" role="alert" className="qiq-field-error">
              {errors.requestChannelId}
            </p>
          )}
        </div>

        {isBrokerChannel && (
          <div className="qiq-field">
            <label htmlFor="lead-broker">Broker</label>
            <select
              id="lead-broker"
              name="brokerId"
              data-testid="broker-select"
              value={values.brokerId}
              disabled={brokerOptions === null}
              aria-invalid={touched.brokerId && errors.brokerId ? true : undefined}
              onChange={(event) => onChange('brokerId', event.target.value)}
              onBlur={() => onBlur('brokerId')}
            >
              <option value="">Select a broker</option>
              {(brokerOptions ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            {touched.brokerId && errors.brokerId && (
              <p data-testid="field-error" role="alert" className="qiq-field-error">
                {errors.brokerId}
              </p>
            )}
          </div>
        )}

        {showOwner && (
          <div className="qiq-field">
            <label htmlFor="lead-owner">Owner</label>
            <select
              id="lead-owner"
              name="ownerUserId"
              data-testid="owner-select"
              value={values.ownerUserId}
              disabled={ownerOptions === null}
              aria-invalid={touched.ownerUserId && errors.ownerUserId ? true : undefined}
              onChange={(event) => onChange('ownerUserId', event.target.value)}
              onBlur={() => onBlur('ownerUserId')}
            >
              <option value="">Select an owner</option>
              {(ownerOptions ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            {ownerOptions === null && (
              <p role="alert" data-testid="owner-options-unavailable" className="qiq-field-error">
                Eligible owners could not be loaded.
              </p>
            )}
            {touched.ownerUserId && errors.ownerUserId && (
              <p data-testid="field-error" role="alert" className="qiq-field-error">
                {errors.ownerUserId}
              </p>
            )}
          </div>
        )}

        <div className="qiq-field">
          <label htmlFor="lead-region">Region</label>
          <select
            id="lead-region"
            name="regionId"
            value={values.regionId}
            disabled={regionOptions === null}
            aria-invalid={touched.regionId && errors.regionId ? true : undefined}
            onChange={(event) => onChange('regionId', event.target.value)}
            onBlur={() => onBlur('regionId')}
          >
            <option value="">Select a region</option>
            {(regionOptions ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          {touched.regionId && errors.regionId && (
            <p data-testid="field-error" role="alert" className="qiq-field-error">
              {errors.regionId}
            </p>
          )}
        </div>

        {showExternalRef && (
          <div className="qiq-field">
            <label htmlFor="lead-external-ref">External reference</label>
            <input
              id="lead-external-ref"
              name="externalRef"
              type="text"
              value={values.externalRef}
              onChange={(event) => onChange('externalRef', event.target.value)}
            />
            {externalRefWarning && (
              <p role="alert" data-testid="external-ref-warning" className="qiq-field-hint">
                {externalRefWarning}
              </p>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '9px' }}>
          <label
            htmlFor="lead-existing-client"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)', fontSize: '13px', fontWeight: 550, color: 'var(--qiq-text-primary)', cursor: 'pointer' }}
          >
            <input
              id="lead-existing-client"
              name="isExistingClient"
              type="checkbox"
              checked={values.isExistingClient}
              onChange={(event) => onChange('isExistingClient', event.target.checked)}
            />
            Existing client
          </label>
        </div>
      </div>
    </section>
  );
}

export default RequestSection;
