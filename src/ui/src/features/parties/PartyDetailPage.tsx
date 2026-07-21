import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import { useTenantCurrency } from '../../components/shell/useTenantCurrency';
import type { NormalizedError } from '../../api/client';
import { listReferenceItems, type ReferenceItemDto } from '../settings/settingsApi';
import { getParty, getPartyLeads, type PartyDto } from './partiesApi';
import type { LeadListItemDto } from '../leads/leadsApi';
import { DEFAULT_AGING_AMBER_DAYS, DEFAULT_AGING_RED_DAYS } from '../leads/agingThresholds';
import LeadsTable from '../leads/LeadsTable';
import ErrorBanner from '../../components/common/ErrorBanner';
import EmptyState from '../../components/common/EmptyState';
import SkeletonTable from '../../components/common/SkeletonTable';

interface ReferenceOption {
  id: number;
  name: string;
}

function toReferenceOptions(items: ReferenceItemDto[]): ReferenceOption[] {
  return items.map((item) => ({ id: item.id, name: item.name }));
}

function optionName(options: ReferenceOption[] | null, id: number | null): string {
  if (id == null) {
    return '—';
  }
  return options?.find((option) => option.id === id)?.name ?? '—';
}

function formatLastActivity(value: string | null): string {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Party detail (spec FR-27, PRD 12.9, AC-026, verification.json V-026). Route `/parties/{id}`:
 * header (name, type chip, strategic flag, permission-gated Edit), a read-only summary panel, and a
 * Leads card reusing the shared `LeadsTable` (T-027) with the Party column omitted (`columns.showParty:
 * false`) and no sort props (plain, non-interactive headers, per `LeadsTable`'s documented seam for
 * this exact consumer). `+ New Lead` (shown only with leads.create, matching the intake route's
 * RouteGuard) navigates to `/leads/new?partyId={id}`, which T-026's intake
 * form consumes to pre-fill and lock the Party section.
 */
function PartyDetailPage() {
  const { partyId } = useParams<{ partyId: string }>();
  const id = Number(partyId);
  const navigate = useNavigate();
  const currencyCode = useTenantCurrency();

  const canEdit = useAppSelector(selectHasPermission(PermissionCodes.PartiesUpdate));
  // The intake route is guarded by leads.create (router.tsx RouteGuard) — without it the button
  // would dead-end on the forbidden page, so it is hidden instead (same gate as TopBar/LeadsListPage).
  const canCreateLead = useAppSelector(selectHasPermission(PermissionCodes.LeadsCreate));

  const [party, setParty] = useState<PartyDto | null>(null);
  const [leads, setLeads] = useState<LeadListItemDto[]>([]);
  const [partyTypeOptions, setPartyTypeOptions] = useState<ReferenceOption[] | null>(null);
  const [segmentOptions, setSegmentOptions] = useState<ReferenceOption[] | null>(null);
  const [industryOptions, setIndustryOptions] = useState<ReferenceOption[] | null>(null);
  const [regionOptions, setRegionOptions] = useState<ReferenceOption[] | null>(null);

  const [loading, setLoading] = useState(true);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getParty(id)
      .then(setParty)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load this party.'))
      .finally(() => setLoading(false));

    setLeadsLoading(true);
    getPartyLeads(id)
      .then(setLeads)
      .catch(() => setLeads([]))
      .finally(() => setLeadsLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error || !party) {
    return <ErrorBanner message={error ?? 'Party not found.'} onRetry={load} />;
  }

  return (
    <div data-testid="party-detail-page" className="qiq-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--qiq-space-4)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 'var(--qiq-space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 data-testid="party-name-heading" style={{ fontSize: '20px' }}>{party.name}</h2>
          <span data-testid="party-type-chip" className="qiq-chip qiq-chip--neutral">
            {optionName(partyTypeOptions, party.partyTypeId)}
          </span>
          {party.isStrategic && (
            <span data-testid="strategic-flag-icon" title="Strategic" aria-label="Strategic" style={{ color: 'var(--qiq-warning)' }}>
              ★
            </span>
          )}
        </div>
        {canEdit && (
          <button type="button" onClick={() => navigate(`/parties/${id}/edit`)}>
            Edit party
          </button>
        )}
      </div>

      <section data-testid="party-summary" className="qiq-card">
        {/* 5 explicit columns: 9 fields land on exactly two rows, with enough width that the
            contact email doesn't wrap (the .qiq-dl auto-fill default packs them too tightly here). */}
        <dl className="qiq-dl" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          <div>
            <dt>Segment</dt>
            <dd>{optionName(segmentOptions, party.segmentId)}</dd>
          </div>
          <div>
            <dt>Industry</dt>
            <dd>{optionName(industryOptions, party.industryId)}</dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{optionName(regionOptions, party.regionId)}</dd>
          </div>
          <div>
            <dt>Contact name</dt>
            <dd>{party.contactName ?? '—'}</dd>
          </div>
          <div>
            <dt>Contact email</dt>
            <dd>{party.contactEmail ?? '—'}</dd>
          </div>
          <div>
            <dt>Contact phone</dt>
            <dd>{party.contactPhone ?? '—'}</dd>
          </div>
          <div>
            <dt>Open leads</dt>
            <dd>{party.openLeadsCount}</dd>
          </div>
          <div>
            <dt>Total leads</dt>
            <dd>{party.totalLeadsCount}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{formatLastActivity(party.lastActivityAt)}</dd>
          </div>
        </dl>
      </section>

      <section data-testid="party-leads-card" className="qiq-card">
        <div className="qiq-card-head">
          <h3 className="qiq-card-title">Leads</h3>
          {canCreateLead && (
            <button type="button" className="qiq-btn qiq-btn--primary" data-testid="party-new-lead-button" onClick={() => navigate(`/leads/new?partyId=${id}`)}>
              + New Lead
            </button>
          )}
        </div>

        {leadsLoading && <SkeletonTable rows={3} columns={8} />}

        {!leadsLoading && leads.length === 0 && <EmptyState message="This party has no leads yet." />}

        {!leadsLoading && leads.length > 0 && (
          <LeadsTable
            leads={leads}
            currencyCode={currencyCode}
            agingAmberDays={DEFAULT_AGING_AMBER_DAYS}
            agingRedDays={DEFAULT_AGING_RED_DAYS}
            columns={{ showParty: false, showCheckboxes: false }}
          />
        )}
      </section>
    </div>
  );
}

export default PartyDetailPage;
