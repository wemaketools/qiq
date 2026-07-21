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
import { fetchBrokerPerformance, type BrokerPerformanceDto } from './brokersApi';
import BrokerKpiRow from './brokers/BrokerKpiRow';
import TopBrokersRanking from './brokers/TopBrokersRanking';
import BrokerMatrixScatter from './brokers/BrokerMatrixScatter';
import BrokerPerformanceTable from './brokers/BrokerPerformanceTable';

interface FilterOptions {
  productLineOptions: DashboardReferenceOption[] | null;
  brokerOptions: DashboardReferenceOption[] | null;
  rmOptions: DashboardReferenceOption[] | null;
  regionOptions: DashboardReferenceOption[] | null;
}

/**
 * Broker Performance dashboard (spec FR-57, AC-056, PRD 15.1/15.3, T-034): the shared dashboard filter
 * bar over `dashboardFiltersSlice` (T-031), six lead/quote-labeled KPI cards, the Top Brokers ranking,
 * the quadrant Performance Matrix (bubble = won premium, background shading + legend from the shared
 * `quadrantPalette` single source), and the full-width ranked broker table with green-strong/red-weak
 * conversion and top loss reason. Broker rows/points/bars drill to that broker's filtered lead lists
 * (AC-056). Built entirely on the T-031 framework components + the T-043 design-system layer (`.qiq-*`).
 */
function BrokerPerformancePage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const filters = useAppSelector(selectDashboardFilters);
  const { navigateToDrill } = useDrill();

  const [data, setData] = useState<BrokerPerformanceDto | null>(null);
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
    fetchBrokerPerformance(filters)
      .then(setData)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load the Broker Performance dashboard.'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Filter dropdown options are best-effort (FilterBar's documented null degrade), matching PipelinePage.
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

  /**
   * Broker-specific drill: narrows the active dashboard filter to that broker (so the shared
   * `DrillListPage`, which reads the persisted filter, lists only that broker's leads — the backend
   * scope stays broker-agnostic and the `BrokerId` dimension does the narrowing) then navigates. A
   * `brokerId` of 0 (a "View all" affordance) drills to every broker's leads without narrowing.
   */
  function drillBroker(brokerId: number, widgetKey: string): void {
    if (brokerId > 0) {
      const next: DashboardFiltersState = { ...filters, brokerId };
      dispatch(setDashboardFilters(next));
      persistFilters(next);
    }
    navigate(`/dashboards/drill/${encodeURIComponent(widgetKey)}`);
  }

  return (
    <div data-testid="page-brokers" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}>
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
      {!loading && !error && !data && <EmptyState message="No dashboard data available." />}

      {!loading && !error && data && (
        <>
          <BrokerKpiRow kpis={data.kpis} currencyCode={data.currencyCode} onDrill={navigateToDrill} />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <TopBrokersRanking brokers={data.topBrokers} onDrillBroker={drillBroker} />
            <BrokerMatrixScatter matrix={data.matrix} currencyCode={data.currencyCode} onDrillBroker={drillBroker} />
          </div>

          <BrokerPerformanceTable
            rows={data.table}
            currencyCode={data.currencyCode}
            conversionSplit={data.matrix.conversionSplit}
            onDrillBroker={drillBroker}
          />
        </>
      )}
    </div>
  );
}

export default BrokerPerformancePage;
