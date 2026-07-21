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
import { listReferenceItems } from '../settings/settingsApi';
import { getEligibleLeadOwners } from '../leads/leadsApi';
import useDrill from './useDrill';
import { fetchRmPerformance, type RmPerformanceDto } from './rmApi';
import RmKpiRow from './rm/RmKpiRow';
import WonPremiumRanking from './rm/WonPremiumRanking';
import TurnaroundByRm from './rm/TurnaroundByRm';
import WatchlistTable from './rm/WatchlistTable';
import InsightsPanel from './rm/InsightsPanel';

interface FilterOptions {
  productLineOptions: DashboardReferenceOption[] | null;
  rmOptions: DashboardReferenceOption[] | null;
  brokerTypeOptions: DashboardReferenceOption[] | null;
  regionOptions: DashboardReferenceOption[] | null;
}

/**
 * RM Performance dashboard (spec FR-58, AC-057, AC-059, PRD 15.2/15.4, T-035): the shared dashboard
 * filter bar in its RM variant (RM/Team + Broker Type replacing RM + Broker), six lead/quote-labeled KPI
 * cards, the Top RMs won-premium ranking, the Turnaround-by-RM bars with the dashed SLA target marker,
 * the Performance Watchlist with color-coded suggested-action chips, and the Leadership Insights panel.
 * RM rows/bars drill to that RM's leads (via teamOrRmId). Built entirely on the T-031 framework
 * components + the T-043 design-system layer (`.qiq-*`).
 *
 * Deviation from PRD 15.2/T-035 (user decision, 2026-07-16): the Top Brokers ranking and the shared
 * quadrant Broker Performance Matrix were removed from this screen — they are broker-centric and the
 * Brokers dashboard (T-034) already carries both. The API payload still returns `topBrokers` +
 * `brokerMatrix` untouched.
 */
function RmPerformancePage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const filters = useAppSelector(selectDashboardFilters);
  const { navigateToDrill } = useDrill();

  const [data, setData] = useState<RmPerformanceDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<FilterOptions>({
    productLineOptions: null,
    rmOptions: null,
    brokerTypeOptions: null,
    regionOptions: null,
  });

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchRmPerformance(filters)
      .then(setData)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load the RM Performance dashboard.'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Filter dropdown options are best-effort (FilterBar's documented null degrade), matching BrokerPage.
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
    listReferenceItems('broker_type')
      .then((rows) => active && setOptions((prev) => ({ ...prev, brokerTypeOptions: toOptions(rows) })))
      .catch(() => active && setOptions((prev) => ({ ...prev, brokerTypeOptions: null })));
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

  /** RM drill: narrows the active filter to that RM (teamOrRmId) so the shared DrillListPage lists only that RM's leads, then navigates. A 0 id drills without narrowing. */
  function drillRm(rmUserId: number, widgetKey: string): void {
    if (rmUserId > 0) {
      const next: DashboardFiltersState = { ...filters, teamOrRmId: rmUserId };
      dispatch(setDashboardFilters(next));
      persistFilters(next);
    }
    navigate(`/dashboards/drill/${encodeURIComponent(widgetKey)}`);
  }

  return (
    <div data-testid="page-rm-performance" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}>
      <FilterBar
        filters={filters}
        onChange={applyFilters}
        onClear={clearFilters}
        productLineOptions={options.productLineOptions}
        brokerOptions={null}
        brokerTypeOptions={options.brokerTypeOptions}
        rmOptions={options.rmOptions}
        regionOptions={options.regionOptions}
        variant="rmPerformance"
      />

      {loading && <SkeletonTable />}
      {!loading && error && <ErrorBanner message={error} onRetry={load} />}
      {!loading && !error && !data && <EmptyState message="No dashboard data available." />}

      {!loading && !error && data && (
        <>
          <RmKpiRow kpis={data.kpis} currencyCode={data.currencyCode} onDrill={navigateToDrill} />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <WonPremiumRanking
              title="Top RMs"
              testId="top-rms-ranking"
              rowTestId="top-rm-row"
              items={data.topRms.map((rm) => ({
                id: rm.rmUserId,
                name: rm.rmName,
                wonPremium: rm.wonPremium,
                conversionRate: rm.conversionRate,
                drillWidgetKey: rm.drillWidgetKey,
              }))}
              currencyCode={data.currencyCode}
              emptyLabel="No RM activity in this period."
              viewAllLabel="View all RMs"
              onDrill={drillRm}
            />
            <TurnaroundByRm turnaround={data.turnaroundByRm} onDrillRm={drillRm} />
          </div>

          <WatchlistTable rows={data.watchlist} currencyCode={data.currencyCode} onDrillRm={drillRm} />

          <InsightsPanel insights={data.insights} />
        </>
      )}
    </div>
  );
}

export default RmPerformancePage;
