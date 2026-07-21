import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import {
  clearDashboardFilters,
  EMPTY_DASHBOARD_FILTERS,
  persistFilters,
  selectDashboardFilters,
  setDashboardFilters,
  type DashboardFiltersState,
} from '../../app/slices/dashboardFiltersSlice';
import FilterBar, { type DashboardReferenceOption } from '../../components/dashboards/FilterBar';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import type { NormalizedError } from '../../api/client';
import { listBrokers, listReferenceItems } from '../settings/settingsApi';
import { getEligibleLeadOwners } from '../leads/leadsApi';
import useDrill from './useDrill';
import { dashboardFiltersToExportFilter } from '../exports/exportsApi';
import { fetchExecutiveOverview, type ExecutiveOverviewDto } from './executiveApi';
import KpiRow from './overview/KpiRow';
import PipelineByStage from './overview/PipelineByStage';
import AgingDonut from './overview/AgingDonut';
import WonLostTrend from './overview/WonLostTrend';
import HighValueTable from './overview/HighValueTable';
import RequiresAttentionPanel from './overview/RequiresAttentionPanel';

interface FilterOptions {
  productLineOptions: DashboardReferenceOption[] | null;
  brokerOptions: DashboardReferenceOption[] | null;
  rmOptions: DashboardReferenceOption[] | null;
  regionOptions: DashboardReferenceOption[] | null;
}

/**
 * Executive Overview dashboard (spec FR-55, AC-054, T-032): the shared dashboard filter bar over
 * `dashboardFiltersSlice` (T-031), nine lead/quote-labeled KPI cards, the three charts (Pipeline by
 * Stage, Open Quotes Aging, Won vs Lost Trend), the High-Value Opportunities table, and the Requires
 * Attention panel — every widget drillable per AC-054. Built entirely on the T-043 design-system layer
 * (`.qiq-*` classes + `Icon`) and the T-031 framework components.
 */
function OverviewPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const filters = useAppSelector(selectDashboardFilters);
  const { navigateToDrill } = useDrill();

  const [overview, setOverview] = useState<ExecutiveOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<FilterOptions>({
    productLineOptions: null,
    brokerOptions: null,
    rmOptions: null,
    regionOptions: null,
  });

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchExecutiveOverview(filters)
      .then(setOverview)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load the Overview dashboard.'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Filter dropdown options are best-effort: a viewer without settings/broker read permission simply
  // gets a disabled dropdown (FilterBar's documented null degrade), never a broken page.
  useEffect(() => {
    let active = true;
    const toOptions = <T extends { id: number; name: string }>(rows: T[]): DashboardReferenceOption[] =>
      rows.map((row) => ({ id: row.id, name: row.name }));

    listReferenceItems('product_line')
      .then((rows) => active && setOptions((prev) => ({ ...prev, productLineOptions: toOptions(rows) })))
      .catch(() => active && setOptions((prev) => ({ ...prev, productLineOptions: null })));
    listReferenceItems('region')
      .then((rows) => active && setOptions((prev) => ({ ...prev, regionOptions: toOptions(rows) })))
      .catch(() => active && setOptions((prev) => ({ ...prev, regionOptions: null })));
    listBrokers()
      .then((result) => active && setOptions((prev) => ({ ...prev, brokerOptions: toOptions(result.items) })))
      .catch(() => active && setOptions((prev) => ({ ...prev, brokerOptions: null })));
    getEligibleLeadOwners()
      .then((rows) =>
        active &&
        setOptions((prev) => ({
          ...prev,
          rmOptions: rows === null ? null : rows.map((row) => ({ id: row.userId, name: `${row.firstName} ${row.lastName}` })),
        })),
      )
      .catch(() => active && setOptions((prev) => ({ ...prev, rmOptions: null })));

    return () => {
      active = false;
    };
  }, []);

  function applyFilters(next: DashboardFiltersState): void {
    dispatch(setDashboardFilters(next));
    persistFilters(next);
  }

  function clearFilters(): void {
    dispatch(clearDashboardFilters());
    persistFilters(EMPTY_DASHBOARD_FILTERS);
  }

  return (
    <div data-testid="page-overview" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}>
      <FilterBar
        filters={filters}
        onChange={applyFilters}
        onClear={clearFilters}
        productLineOptions={options.productLineOptions}
        brokerOptions={options.brokerOptions}
        rmOptions={options.rmOptions}
        regionOptions={options.regionOptions}
      />

      {loading && <SkeletonTable />}
      {!loading && error && <ErrorBanner message={error} onRetry={load} />}
      {!loading && !error && !overview && <EmptyState message="No dashboard data available." />}

      {!loading && !error && overview && (
        <>
          <KpiRow kpis={overview.kpis} currencyCode={overview.currencyCode} onDrill={navigateToDrill} />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <PipelineByStage
              stages={overview.pipelineByStage}
              onDrill={navigateToDrill}
              onViewFullPipeline={() => navigate('/pipeline')}
              exportFilter={dashboardFiltersToExportFilter(filters)}
            />
            <AgingDonut
              aging={overview.openQuotesAging}
              onDrill={navigateToDrill}
              onViewAgingReport={() => navigate('/reports')}
            />
            <WonLostTrend
              trend={overview.wonVsLostTrend}
              currencyCode={overview.currencyCode}
              onViewTrendAnalysis={() => navigate('/pipeline')}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <HighValueTable
              rows={overview.highValueOpportunities}
              currencyCode={overview.currencyCode}
              onViewAll={() => navigateToDrill('exec.high_value')}
              exportFilter={dashboardFiltersToExportFilter(filters)}
            />
            <RequiresAttentionPanel rows={overview.requiresAttention} />
          </div>
        </>
      )}
    </div>
  );
}

export default OverviewPage;
