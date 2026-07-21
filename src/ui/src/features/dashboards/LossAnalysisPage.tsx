import { useCallback, useEffect, useState } from 'react';
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
import { fetchLossAnalysis, type LossAnalysisDto } from './lossApi';
import LossKpiRow from './loss/LossKpiRow';
import LostPremiumBars from './loss/LostPremiumBars';
import LossTrendChart from './loss/LossTrendChart';
import CompetitorTable from './loss/CompetitorTable';
import CommentaryFeed from './loss/CommentaryFeed';

interface FilterOptions {
  productLineOptions: DashboardReferenceOption[] | null;
  brokerOptions: DashboardReferenceOption[] | null;
  rmOptions: DashboardReferenceOption[] | null;
  regionOptions: DashboardReferenceOption[] | null;
}

/**
 * Loss Analysis dashboard (spec FR-59, AC-058, PRD 16, T-036): the shared dashboard filter bar over
 * `dashboardFiltersSlice` (T-031), FIVE lead/quote-labeled KPI cards (no Win-back Potential — PRD 16.0
 * exclusion), the Lost Premium by Reason (red) and by Product Line (amber) horizontal bars, the
 * six-month Lost Premium Trend with an area fill, the Competitor Analysis table, and the full-width Loss
 * Commentary feed. Every KPI/chart/row drills to its filtered loss list (AC-058), the reason drill
 * distinguishing pre-quote vs post-quote losses via the row flag chips. Built entirely on the T-031
 * framework components + the T-043 design-system layer (`.qiq-*`).
 */
function LossAnalysisPage() {
  const dispatch = useAppDispatch();
  const filters = useAppSelector(selectDashboardFilters);
  const { navigateToDrill } = useDrill();

  const [data, setData] = useState<LossAnalysisDto | null>(null);
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
    fetchLossAnalysis(filters)
      .then(setData)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load the Loss Analysis dashboard.'))
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
    <div data-testid="page-loss-analysis" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}>
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
          <LossKpiRow kpis={data.kpis} currencyCode={data.currencyCode} onDrill={navigateToDrill} />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <LostPremiumBars
              title="Lost Premium by Reason"
              testId="lost-by-reason"
              rowTestId="lost-by-reason-row"
              items={data.lostPremiumByReason.rows.map((row) => ({ name: row.reasonName, amount: row.amount, drillWidgetKey: row.drillWidgetKey }))}
              barColor="var(--qiq-danger)"
              currencyCode={data.currencyCode}
              emptyLabel="No losses in this period."
              onDrill={navigateToDrill}
            />
            <LossTrendChart trend={data.lostPremiumTrend} onDrill={navigateToDrill} />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <LostPremiumBars
              title="Lost Premium by Product Line"
              testId="lost-by-product-line"
              rowTestId="lost-by-product-line-row"
              items={data.lostPremiumByProductLine.rows.map((row) => ({ name: row.productLineName, amount: row.amount, drillWidgetKey: row.drillWidgetKey }))}
              barColor="var(--qiq-warning)"
              currencyCode={data.currencyCode}
              emptyLabel="No losses in this period."
              onDrill={navigateToDrill}
            />
            <CompetitorTable competitorAnalysis={data.competitorAnalysis} currencyCode={data.currencyCode} onDrill={navigateToDrill} />
          </div>

          <CommentaryFeed commentary={data.lossCommentary} currencyCode={data.currencyCode} />
        </>
      )}
    </div>
  );
}

export default LossAnalysisPage;
