import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import { useTenantCurrency } from '../../components/shell/useTenantCurrency';
import type { NormalizedError } from '../../api/client';
import { fetchFullBusinessRules, listReferenceItems, type ReferenceItemDto } from '../settings/settingsApi';
import { listBrokers } from '../settings/settingsApi';
import {
  bulkReassignLeads,
  buildLeadsSortParam,
  DEFAULT_LEADS_SORT,
  getEligibleLeadOwners,
  listLeads,
  LEADS_PAGE_SIZE,
  LEADS_SORT_KEYS,
  type EligibleLeadOwnerDto,
  type LeadListItemDto,
  type LeadsSortField,
  type LeadsSortState,
} from './leadsApi';
import { DEFAULT_AGING_AMBER_DAYS, DEFAULT_AGING_RED_DAYS } from './agingThresholds';
import LeadsTable from './LeadsTable';
import LeadsFilterBar from './LeadsFilterBar';
import { EMPTY_LEADS_FILTERS, type LeadsFilters, type ReferenceOption } from './leadsFilters';
import BulkReassignDialog from './BulkReassignDialog';
import ExportMenu from '../../components/common/ExportMenu';
import { buildLeadsExportPath, type ExportFormat } from '../exports/exportsApi';
import { useRegisterExportTarget } from '../exports/ExportTargetContext';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { useToast } from '../../components/common/Toast';

function toReferenceOptions(items: ReferenceItemDto[]): ReferenceOption[] {
  return items.map((item) => ({ id: item.id, name: item.name }));
}

function parseFiltersFromSearchParams(searchParams: URLSearchParams): LeadsFilters {
  const status = searchParams.get('status');
  return {
    statusIds: status ? status.split(',').map(Number).filter((n) => !Number.isNaN(n)) : [],
    ownerUserId: searchParams.has('owner') ? Number(searchParams.get('owner')) : null,
    brokerId: searchParams.has('broker') ? Number(searchParams.get('broker')) : null,
    productLineId: searchParams.has('productLine') ? Number(searchParams.get('productLine')) : null,
    regionId: searchParams.has('region') ? Number(searchParams.get('region')) : null,
    requestChannelId: searchParams.has('channel') ? Number(searchParams.get('channel')) : null,
    dateReceivedFrom: searchParams.get('from'),
    dateReceivedTo: searchParams.get('to'),
    myLeads: searchParams.get('mine') === 'true',
    search: searchParams.get('q') ?? '',
  };
}

function parseSortFromSearchParams(searchParams: URLSearchParams): LeadsSortState {
  const field = searchParams.get('sort');
  const direction = searchParams.get('dir');
  const sortable = field != null && Object.hasOwn(LEADS_SORT_KEYS, field);
  if (sortable && (direction === 'asc' || direction === 'desc')) {
    return { field: field as LeadsSortField, direction };
  }
  return DEFAULT_LEADS_SORT;
}

function filtersToSearchParams(filters: LeadsFilters, page: number, sort: LeadsSortState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.statusIds.length > 0) {
    params.set('status', filters.statusIds.join(','));
  }
  if (filters.ownerUserId != null) {
    params.set('owner', String(filters.ownerUserId));
  }
  if (filters.brokerId != null) {
    params.set('broker', String(filters.brokerId));
  }
  if (filters.productLineId != null) {
    params.set('productLine', String(filters.productLineId));
  }
  if (filters.regionId != null) {
    params.set('region', String(filters.regionId));
  }
  if (filters.requestChannelId != null) {
    params.set('channel', String(filters.requestChannelId));
  }
  if (filters.dateReceivedFrom) {
    params.set('from', filters.dateReceivedFrom);
  }
  if (filters.dateReceivedTo) {
    params.set('to', filters.dateReceivedTo);
  }
  if (filters.myLeads) {
    params.set('mine', 'true');
  }
  if (filters.search) {
    params.set('q', filters.search);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  if (sort.field !== DEFAULT_LEADS_SORT.field || sort.direction !== DEFAULT_LEADS_SORT.direction) {
    params.set('sort', sort.field);
    params.set('dir', sort.direction);
  }
  return params;
}

/**
 * Leads working queue (spec FR-43, PRD 12.4, AC-042, T-027). Route `/leads`. Filter state is
 * synced to the URL's `searchParams` so drill-throughs (Overview/Pipeline/Alerts, later tasks) can
 * deep-link straight into a pre-filtered queue.
 */
function LeadsListPage() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const currencyCode = useTenantCurrency();
  const [searchParams, setSearchParams] = useSearchParams();

  const canViewAll = useAppSelector(selectHasPermission(PermissionCodes.LeadsViewAll));
  const canReassign = useAppSelector(selectHasPermission(PermissionCodes.LeadsReassign));
  const canCreate = useAppSelector(selectHasPermission(PermissionCodes.LeadsCreate));
  const canExport = useAppSelector(selectHasPermission(PermissionCodes.LeadsExport));
  const myLeadsForced = !canViewAll;

  const [filters, setFilters] = useState<LeadsFilters>(() => parseFiltersFromSearchParams(searchParams));
  const [page, setPage] = useState<number>(() => Number(searchParams.get('page') ?? '1'));
  const [sort, setSort] = useState<LeadsSortState>(() => parseSortFromSearchParams(searchParams));

  const [leads, setLeads] = useState<LeadListItemDto[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusOptions, setStatusOptions] = useState<ReferenceOption[] | null>(null);
  const [brokerOptions, setBrokerOptions] = useState<ReferenceOption[] | null>(null);
  const [productLineOptions, setProductLineOptions] = useState<ReferenceOption[] | null>(null);
  const [regionOptions, setRegionOptions] = useState<ReferenceOption[] | null>(null);
  const [channelOptions, setChannelOptions] = useState<ReferenceOption[] | null>(null);
  const [ownerOptions, setOwnerOptions] = useState<ReferenceOption[] | null>(null);
  const [eligibleOwners, setEligibleOwners] = useState<EligibleLeadOwnerDto[] | null>(null);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignBusy, setReassignBusy] = useState(false);
  const [agingThresholds, setAgingThresholds] = useState({
    amber: DEFAULT_AGING_AMBER_DAYS,
    red: DEFAULT_AGING_RED_DAYS,
  });

  // Reference-option loaders (spec FR-43 filter row): each degrades independently to `null` rather
  // than failing the whole page. Since T-044 these lookup reads are membership-only on the backend,
  // so for any tenant member they populate; the degrade path remains as transient-failure protection.
  useEffect(() => {
    listReferenceItems('lead_status')
      .then((items) => setStatusOptions(toReferenceOptions(items)))
      .catch(() => setStatusOptions(null));
    listReferenceItems('product_line')
      .then((items) => setProductLineOptions(toReferenceOptions(items)))
      .catch(() => setProductLineOptions(null));
    listReferenceItems('region')
      .then((items) => setRegionOptions(toReferenceOptions(items)))
      .catch(() => setRegionOptions(null));
    listReferenceItems('request_channel')
      .then((items) => setChannelOptions(toReferenceOptions(items)))
      .catch(() => setChannelOptions(null));
    listBrokers()
      .then((result) => setBrokerOptions(result.items.map((broker) => ({ id: broker.id, name: broker.name }))))
      .catch(() => setBrokerOptions(null));
    getEligibleLeadOwners()
      .then((owners) => {
        setEligibleOwners(owners);
        setOwnerOptions(owners ? owners.map((owner) => ({ id: owner.userId, name: `${owner.firstName} ${owner.lastName}` })) : null);
      })
      .catch(() => {
        setEligibleOwners(null);
        setOwnerOptions(null);
      });
    // Tenant-configured aging thresholds (A-12/T-044: membership-only read); the A-12 defaults
    // above remain the fallback while loading or on failure.
    fetchFullBusinessRules()
      .then((rules) => setAgingThresholds({ amber: rules.agingAmberDays, red: rules.agingRedDays }))
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listLeads({
      statusIds: filters.statusIds,
      ownerUserId: filters.ownerUserId,
      brokerId: filters.brokerId,
      productLineId: filters.productLineId,
      regionId: filters.regionId,
      requestChannelId: filters.requestChannelId,
      dateReceivedFrom: filters.dateReceivedFrom,
      dateReceivedTo: filters.dateReceivedTo,
      myLeads: filters.myLeads || myLeadsForced,
      search: filters.search || null,
      sort: buildLeadsSortParam(sort),
      page,
      pageSize: LEADS_PAGE_SIZE,
    })
      .then((result) => {
        setLeads(result.items);
        setTotalCount(result.totalCount);
      })
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load leads.'))
      .finally(() => setLoading(false));
  }, [filters, page, sort, myLeadsForced]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setSearchParams(filtersToSearchParams(filters, page, sort), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page, sort]);

  function handleSortChange(field: LeadsSortField): void {
    setSort((current) => {
      if (current.field === field) {
        return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { field, direction: 'asc' };
    });
    setPage(1);
  }

  function handleFiltersChange(next: LeadsFilters): void {
    setFilters(next);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handleClearFilters(): void {
    setFilters(EMPTY_LEADS_FILTERS);
    setPage(1);
    setSelectedIds(new Set());
  }

  function toggleSelect(leadId: number): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(leadId)) {
        next.delete(leadId);
      } else {
        next.add(leadId);
      }
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelectedIds((current) => (current.size === leads.length ? new Set() : new Set(leads.map((lead) => lead.id))));
  }

  async function handleReassignConfirm(newOwnerUserId: number, note: string): Promise<void> {
    setReassignBusy(true);
    try {
      const result = await bulkReassignLeads({ leadIds: Array.from(selectedIds), newOwnerUserId, note });
      showSuccess(`Reassigned ${result.reassignedCount} lead(s).`);
      setReassignOpen(false);
      setSelectedIds(new Set());
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to reassign leads.');
    } finally {
      setReassignBusy(false);
    }
  }

  const pageStart = totalCount === 0 ? 0 : (page - 1) * LEADS_PAGE_SIZE + 1;
  const pageEnd = Math.min(page * LEADS_PAGE_SIZE, totalCount);
  const totalPages = Math.max(1, Math.ceil(totalCount / LEADS_PAGE_SIZE));

  const filtersApplied = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(EMPTY_LEADS_FILTERS),
    [filters],
  );

  // Export reflects the active filters (spec FR-65, T-039): the same params drive the list toolbar's
  // ExportMenu and the TopBar's page-level Export action.
  const exportParams = useMemo(
    () => ({
      statusIds: filters.statusIds,
      ownerUserId: filters.ownerUserId,
      brokerId: filters.brokerId,
      productLineId: filters.productLineId,
      regionId: filters.regionId,
      requestChannelId: filters.requestChannelId,
      dateReceivedFrom: filters.dateReceivedFrom,
      dateReceivedTo: filters.dateReceivedTo,
      myLeads: filters.myLeads || myLeadsForced,
      search: filters.search || null,
      sort: buildLeadsSortParam(sort),
    }),
    [filters, sort, myLeadsForced],
  );

  const exportTarget = useMemo(
    () =>
      canExport
        ? { fileNameBase: 'leads', buildPath: (format: ExportFormat) => buildLeadsExportPath(exportParams, format) }
        : null,
    [canExport, exportParams],
  );
  useRegisterExportTarget(exportTarget);

  return (
    <div data-testid="page-leads">
      {/* Page title lives in the shell top bar (pageTitles.ts) — this row only carries the actions. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 'var(--qiq-space-4)' }}>
        <div style={{ display: 'flex', gap: 'var(--qiq-space-3)' }}>
          {canExport && (
            <ExportMenu
              testId="leads-export-menu"
              fileNameBase="leads"
              buildPath={(format: ExportFormat) => buildLeadsExportPath(exportParams, format)}
            />
          )}
          {canCreate && (
            <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/leads/new')}>
              + New Lead
            </button>
          )}
        </div>
      </div>

      <div className="qiq-card" style={{ marginBottom: 'var(--qiq-space-4)' }}>
      <LeadsFilterBar
        filters={filters}
        onChange={handleFiltersChange}
        onClear={handleClearFilters}
        statusOptions={statusOptions}
        ownerOptions={ownerOptions}
        brokerOptions={brokerOptions}
        productLineOptions={productLineOptions}
        regionOptions={regionOptions}
        channelOptions={channelOptions}
        myLeadsForced={myLeadsForced}
      />
      </div>

      {canReassign && selectedIds.size > 0 && (
        <div style={{ margin: 'var(--qiq-space-3) 0' }}>
          <button type="button" className="qiq-btn" data-testid="bulk-reassign-button" onClick={() => setReassignOpen(true)}>
            Reassign {selectedIds.size} selected
          </button>
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && loading && <SkeletonTable rows={8} columns={9} />}

      {!error && !loading && leads.length === 0 && (
        <EmptyState
          message="No leads match the current filters."
          actions={
            <>
              <button type="button" className="qiq-btn" data-testid="empty-state-clear-filters" onClick={handleClearFilters} disabled={!filtersApplied}>
                Clear filters
              </button>
              {canCreate && (
                <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/leads/new')}>
                  + New Lead
                </button>
              )}
            </>
          }
        />
      )}

      {!error && !loading && leads.length > 0 && (
        <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
          <LeadsTable
            leads={leads}
            currencyCode={currencyCode}
            agingAmberDays={agingThresholds.amber}
            agingRedDays={agingThresholds.red}
            columns={{ showParty: true, showCheckboxes: canReassign }}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            sort={sort}
            onSortChange={handleSortChange}
          />

          <div data-testid="leads-pagination" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--qiq-space-3) var(--qiq-space-4)', borderTop: '1px solid var(--qiq-border-subtle)', fontSize: '12px', color: 'var(--qiq-text-secondary)' }}>
            <span data-testid="leads-page-summary">
              {pageStart}-{pageEnd} of {totalCount}
            </span>
            <div style={{ display: 'flex', gap: 'var(--qiq-space-2)' }}>
              <button type="button" className="qiq-btn qiq-btn--sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                Previous
              </button>
              <button type="button" className="qiq-btn qiq-btn--sm" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      <BulkReassignDialog
        open={reassignOpen}
        count={selectedIds.size}
        eligibleOwners={eligibleOwners}
        busy={reassignBusy}
        onConfirm={(newOwnerUserId, note) => void handleReassignConfirm(newOwnerUserId, note)}
        onCancel={() => setReassignOpen(false)}
      />
    </div>
  );
}

export default LeadsListPage;
