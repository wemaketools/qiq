import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { listReferenceItems, type ReferenceItemDto } from '../settings/settingsApi';
import {
  buildPartiesSortParam,
  DEFAULT_PARTIES_SORT,
  listParties,
  PARTIES_PAGE_SIZE,
  PARTIES_SORT_KEYS,
  type PartiesSortField,
  type PartiesSortState,
  type PartyDto,
} from './partiesApi';
import PartiesFilterBar from './PartiesFilterBar';
import { EMPTY_PARTIES_FILTERS, type PartiesFilters, type ReferenceOption } from './partiesFilters';
import SkeletonTable from '../../components/common/SkeletonTable';
import SortableTh from '../../components/common/SortableTh';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import ExportMenu from '../../components/common/ExportMenu';
import { buildPartiesExportPath, type ExportFormat } from '../exports/exportsApi';
import { useRegisterExportTarget } from '../exports/ExportTargetContext';

function toReferenceOptions(items: ReferenceItemDto[]): ReferenceOption[] {
  return items.map((item) => ({ id: item.id, name: item.name }));
}

function parseFiltersFromSearchParams(searchParams: URLSearchParams): PartiesFilters {
  return {
    partyTypeId: searchParams.has('partyType') ? Number(searchParams.get('partyType')) : null,
    segmentId: searchParams.has('segment') ? Number(searchParams.get('segment')) : null,
    industryId: searchParams.has('industry') ? Number(searchParams.get('industry')) : null,
    regionId: searchParams.has('region') ? Number(searchParams.get('region')) : null,
    strategicOnly: searchParams.get('strategic') === 'true',
    search: searchParams.get('q') ?? '',
  };
}

function parseSortFromSearchParams(searchParams: URLSearchParams): PartiesSortState {
  const field = searchParams.get('sort');
  const direction = searchParams.get('dir');
  if (field != null && Object.hasOwn(PARTIES_SORT_KEYS, field) && (direction === 'asc' || direction === 'desc')) {
    return { field: field as PartiesSortField, direction };
  }
  return DEFAULT_PARTIES_SORT;
}

function filtersToSearchParams(filters: PartiesFilters, page: number, sort: PartiesSortState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.partyTypeId != null) {
    params.set('partyType', String(filters.partyTypeId));
  }
  if (filters.segmentId != null) {
    params.set('segment', String(filters.segmentId));
  }
  if (filters.industryId != null) {
    params.set('industry', String(filters.industryId));
  }
  if (filters.regionId != null) {
    params.set('region', String(filters.regionId));
  }
  if (filters.strategicOnly) {
    params.set('strategic', 'true');
  }
  if (filters.search) {
    params.set('q', filters.search);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  if (sort.field !== DEFAULT_PARTIES_SORT.field || sort.direction !== DEFAULT_PARTIES_SORT.direction) {
    params.set('sort', sort.field);
    params.set('dir', sort.direction);
  }
  return params;
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
  return new Date(value).toLocaleDateString();
}

/**
 * Parties workspace list (spec FR-26, PRD 12.9, AC-025, verification.json V-025). Route `/parties`.
 * Filter/sort/page state is synced to the URL's `searchParams`, same convention as `LeadsListPage`.
 * `ListPartiesQuery`'s reference ids (party type/segment/industry/region) are resolved to display
 * names client-side via `settingsApi.listReferenceItems`, since `PartyDto` carries only ids.
 */
function PartiesListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const canCreate = useAppSelector(selectHasPermission(PermissionCodes.PartiesCreate));
  const canExport = useAppSelector(selectHasPermission(PermissionCodes.PartiesExport));

  const [filters, setFilters] = useState<PartiesFilters>(() => parseFiltersFromSearchParams(searchParams));
  const [page, setPage] = useState<number>(() => Number(searchParams.get('page') ?? '1'));
  const [sort, setSort] = useState<PartiesSortState>(() => parseSortFromSearchParams(searchParams));

  // TopBar page-level Export action (spec FR-52/FR-65, T-039): reflects the active Parties filters.
  const exportTarget = useMemo(
    () =>
      canExport
        ? { fileNameBase: 'parties', buildPath: (format: ExportFormat) => buildPartiesExportPath(filters, format) }
        : null,
    [canExport, filters],
  );
  useRegisterExportTarget(exportTarget);

  const [parties, setParties] = useState<PartyDto[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [partyTypeOptions, setPartyTypeOptions] = useState<ReferenceOption[] | null>(null);
  const [segmentOptions, setSegmentOptions] = useState<ReferenceOption[] | null>(null);
  const [industryOptions, setIndustryOptions] = useState<ReferenceOption[] | null>(null);
  const [regionOptions, setRegionOptions] = useState<ReferenceOption[] | null>(null);

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
    listParties({
      search: filters.search || null,
      partyTypeId: filters.partyTypeId,
      segmentId: filters.segmentId,
      industryId: filters.industryId,
      regionId: filters.regionId,
      strategic: filters.strategicOnly ? true : null,
      sort: buildPartiesSortParam(sort),
      page,
      pageSize: PARTIES_PAGE_SIZE,
    })
      .then((result) => {
        setParties(result.items);
        setTotalCount(result.totalCount);
      })
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load parties.'))
      .finally(() => setLoading(false));
  }, [filters, page, sort]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setSearchParams(filtersToSearchParams(filters, page, sort), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page, sort]);

  function handleSortChange(field: PartiesSortField): void {
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'asc' },
    );
    setPage(1);
  }

  function handleFiltersChange(next: PartiesFilters): void {
    setFilters(next);
    setPage(1);
  }

  function handleClearFilters(): void {
    setFilters(EMPTY_PARTIES_FILTERS);
    setPage(1);
  }

  const pageStart = totalCount === 0 ? 0 : (page - 1) * PARTIES_PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PARTIES_PAGE_SIZE, totalCount);
  const totalPages = Math.max(1, Math.ceil(totalCount / PARTIES_PAGE_SIZE));

  const filtersApplied = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(EMPTY_PARTIES_FILTERS),
    [filters],
  );

  return (
    <div data-testid="page-parties">
      {/* Page title lives in the shell top bar (pageTitles.ts) — this row only carries the actions. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 'var(--qiq-space-4)' }}>
        <div style={{ display: 'flex', gap: 'var(--qiq-space-3)' }}>
          {canExport && (
            <ExportMenu
              testId="parties-export-menu"
              fileNameBase="parties"
              buildPath={(format: ExportFormat) => buildPartiesExportPath(filters, format)}
            />
          )}
          {canCreate && (
            <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/parties/new')}>
              + New Party
            </button>
          )}
        </div>
      </div>

      <div className="qiq-card" style={{ marginBottom: 'var(--qiq-space-4)' }}>
      <PartiesFilterBar
        filters={filters}
        onChange={handleFiltersChange}
        onClear={handleClearFilters}
        partyTypeOptions={partyTypeOptions}
        segmentOptions={segmentOptions}
        industryOptions={industryOptions}
        regionOptions={regionOptions}
      />
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && loading && <SkeletonTable rows={8} columns={9} />}

      {!error && !loading && parties.length === 0 && (
        <EmptyState
          message="No parties match the current filters."
          actions={
            <>
              <button type="button" data-testid="empty-state-clear-filters" onClick={handleClearFilters} disabled={!filtersApplied}>
                Clear filters
              </button>
              {canCreate && (
                <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/parties/new')}>
                  + New Party
                </button>
              )}
            </>
          }
        />
      )}

      {!error && !loading && parties.length > 0 && (
        <>
          <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table data-testid="parties-table">
            <thead>
              <tr>
                <SortableTh field="name" label="Party name" sort={sort} onSort={handleSortChange} />
                <SortableTh field="type" label="Type" sort={sort} onSort={handleSortChange} />
                <SortableTh field="segment" label="Segment" sort={sort} onSort={handleSortChange} />
                <SortableTh field="industry" label="Industry" sort={sort} onSort={handleSortChange} />
                <SortableTh field="region" label="Region" sort={sort} onSort={handleSortChange} />
                <SortableTh field="strategic" label="Strategic" sort={sort} onSort={handleSortChange} />
                <SortableTh field="openLeads" label="Open leads" sort={sort} onSort={handleSortChange} align="right" />
                <SortableTh field="totalLeads" label="Total leads" sort={sort} onSort={handleSortChange} align="right" />
                <SortableTh field="lastActivity" label="Last activity" sort={sort} onSort={handleSortChange} />
              </tr>
            </thead>
            <tbody>
              {parties.map((party) => (
                <tr key={party.id} data-testid="party-row">
                  <td>
                    <Link to={`/parties/${party.id}`} data-testid="party-name-link">
                      {party.name}
                    </Link>
                  </td>
                  <td>{optionName(partyTypeOptions, party.partyTypeId)}</td>
                  <td>{optionName(segmentOptions, party.segmentId)}</td>
                  <td>{optionName(industryOptions, party.industryId)}</td>
                  <td>{optionName(regionOptions, party.regionId)}</td>
                  <td>
                    {party.isStrategic && (
                      <span data-testid="strategic-flag-icon" title="Strategic" aria-label="Strategic">
                        ★
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{party.openLeadsCount}</td>
                  <td style={{ textAlign: 'right' }}>{party.totalLeadsCount}</td>
                  <td>{formatLastActivity(party.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

          <div data-testid="pagination-summary" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--qiq-space-3)' }}>
            <span>
              {pageStart}-{pageEnd} of {totalCount}
            </span>
            <div>
              <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                Previous
              </button>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default PartiesListPage;
