import { useNavigate } from 'react-router-dom';
import type { LeadDetailDto } from '../leadsApi';
import type { PartyDto } from '../../parties/partiesApi';
import { POLICY_TERM_OPTIONS } from '../form/leadFormConstants';

interface ReferenceOption {
  id: number;
  name: string;
}

function optionName(options: ReferenceOption[] | null, id: number | null): string {
  if (id == null) {
    return '—';
  }
  return options?.find((option) => option.id === id)?.name ?? '—';
}

function formatCurrency(value: number | null | undefined, currencyCode: string): string {
  if (value == null) {
    return '—';
  }
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currencyCode} ${value.toLocaleString()}`;
  }
}

interface SummaryPanelProps {
  lead: LeadDetailDto;
  party: PartyDto | null;
  currencyCode: string;
  requestChannelOptions: ReferenceOption[] | null;
  regionOptions: ReferenceOption[] | null;
  partyTypeOptions: ReferenceOption[] | null;
  segmentOptions: ReferenceOption[] | null;
  industryOptions: ReferenceOption[] | null;
}

/**
 * Lead Detail's read-only Request / Coverage / Party summary panels (spec FR-44, PRD 12.5, T-028).
 * `LeadDetailDto` carries the request channel and region only as ids (no name field, unlike broker/
 * product-line/cover-type which the backend already resolves) — the same reference-option-lookup
 * pattern `LeadFormPage`/`PartyDetailPage` already use resolves those two names here.
 */
function SummaryPanel({ lead, party, currencyCode, requestChannelOptions, regionOptions, partyTypeOptions, segmentOptions, industryOptions }: SummaryPanelProps) {
  const navigate = useNavigate();

  return (
    <section
      data-testid="summary-panel"
      className="qiq-grid"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'stretch' }}
    >
      <div data-testid="summary-request-group" className="qiq-card">
        <div className="qiq-card-head">
          <h3 className="qiq-card-title">Request</h3>
        </div>
        <dl className="qiq-dl">
          <div>
            <dt>Date received</dt>
            <dd>{lead.dateReceived}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{lead.source}</dd>
          </div>
          <div>
            <dt>Request channel</dt>
            <dd>{optionName(requestChannelOptions, lead.requestChannelId)}</dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{optionName(regionOptions, lead.regionId)}</dd>
          </div>
          <div>
            <dt>Broker</dt>
            <dd>{lead.brokerName ?? 'Direct'}</dd>
          </div>
          <div>
            <dt>Existing client</dt>
            <dd>{lead.isExistingClient ? 'Yes' : 'No'}</dd>
          </div>
          {lead.externalRef && (
            <div>
              <dt>External ref</dt>
              <dd>{lead.externalRef}</dd>
            </div>
          )}
        </dl>
      </div>

      <div data-testid="summary-coverage-group" className="qiq-card">
        <div className="qiq-card-head">
          <h3 className="qiq-card-title">Coverage</h3>
        </div>
        <dl className="qiq-dl">
          <div>
            <dt>Product line</dt>
            <dd>{lead.productLineName}</dd>
          </div>
          <div>
            <dt>Cover type</dt>
            <dd>{lead.coverTypeName}</dd>
          </div>
          <div>
            <dt>Sum insured</dt>
            <dd>{formatCurrency(lead.sumInsured, currencyCode)}</dd>
          </div>
          <div>
            <dt>Estimated premium</dt>
            <dd>{formatCurrency(lead.estimatedPremium, currencyCode)}</dd>
          </div>
          <div>
            <dt>Policy term</dt>
            <dd>
              {lead.policyTerm === 'other'
                ? (lead.policyTermOther ?? '—')
                : (POLICY_TERM_OPTIONS.find((option) => option.value === lead.policyTerm)?.label ?? lead.policyTerm)}
            </dd>
          </div>
        </dl>
      </div>

      <div data-testid="summary-party-card" className="qiq-card">
        <div className="qiq-card-head">
          <h3 className="qiq-card-title">Party</h3>
        </div>
        <dl className="qiq-dl">
          <div>
            <dt>Name</dt>
            <dd>
              <a
                href={`/parties/${lead.partyId}`}
                data-testid="party-card-link"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(`/parties/${lead.partyId}`);
                }}
              >
                {lead.partyName}
              </a>
              {party?.isStrategic && (
                <span data-testid="party-strategic-flag" title="Strategic" aria-label="Strategic">
                  {' '}★
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{optionName(partyTypeOptions, party?.partyTypeId ?? null)}</dd>
          </div>
          <div>
            <dt>Segment</dt>
            <dd>{optionName(segmentOptions, party?.segmentId ?? null)}</dd>
          </div>
          <div>
            <dt>Industry</dt>
            <dd>{optionName(industryOptions, party?.industryId ?? null)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

export default SummaryPanel;
