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
import { fetchPipelineDashboard, type PipelineDashboardDto } from './pipelineApi';
import PipelineKpiRow from './pipeline/PipelineKpiRow';
import ConversionFunnel from './pipeline/ConversionFunnel';
import ProductLineStacks from './pipeline/ProductLineStacks';
import PipelineDonut from './pipeline/PipelineDonut';
import AgingHeatmap from './pipeline/AgingHeatmap';
import AtRiskTable from './pipeline/AtRiskTable';
import ImmediateActionsPanel from './pipeline/ImmediateActionsPanel';

interface FilterOptions {
  productLineOptions: DashboardReferenceOption[] | null;
  brokerOptions: DashboardReferenceOption[] | null;
  rmOptions: DashboardReferenceOption[] | null;
  regionOptions: DashboardReferenceOption[] | null;
}

/**
 * Pipeline & Conversion dashboard (spec FR-56, AC-055/AC-059, T-033): the shared dashboard filter bar
 * over `dashboardFiltersSlice` (T-031), nine lead/quote-labeled KPI cards, the Stage Conversion funnel,
 * Pipeline-by-Product-Line stacks, the Quote-Volume-by-Source and Lead-Volume-by-Channel donuts, the
 * open-stage-only Aging heatmap, the At-Risk table, and the Immediate Actions panel — every widget
 * drillable per AC-055. Built entirely on the T-043 design-system layer (`.qiq-*` classes + `Icon`) and
 * the T-031 framework components, reusing the T-032 Executive dashboard's composition patterns.
 */
function PipelinePage() {
  const dispatch = useAppDispatch();
  const filters = useAppSelector(selectDashboardFilters);
  const { navigateToDrill } = useDrill();

  const [pipeline, setPipeline] = useState<PipelineDashboardDto | null>(null);
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
    fetchPipelineDashboard(filters)
      .then(setPipeline)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load the Pipeline dashboard.'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Filter dropdown options are best-effort (FilterBar's documented null degrade), matching OverviewPage.
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
    <div data-testid="page-pipeline" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}>
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
      {!loading && !error && !pipeline && <EmptyState message="No dashboard data available." />}

      {!loading && !error && pipeline && (
        <>
          <PipelineKpiRow kpis={pipeline.kpis} currencyCode={pipeline.currencyCode} onDrill={navigateToDrill} />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <ConversionFunnel stages={pipeline.stageConversionFunnel} onDrill={navigateToDrill} />
            <ProductLineStacks data={pipeline.pipelineByProductLine} currencyCode={pipeline.currencyCode} onDrill={navigateToDrill} />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <PipelineDonut title="Quote Volume by Source" testId="quote-volume-by-source" donut={pipeline.quoteVolumeBySource} onDrill={navigateToDrill} />
            <PipelineDonut title="Lead Volume by Channel" testId="lead-volume-by-channel" donut={pipeline.leadVolumeByChannel} onDrill={navigateToDrill} />
            <AgingHeatmap heatmap={pipeline.agingByStage} onDrill={navigateToDrill} />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
              gap: 'var(--qiq-space-4)',
            }}
          >
            <AtRiskTable rows={pipeline.atRiskPipeline} currencyCode={pipeline.currencyCode} showTenantColumn={false} />
            <ImmediateActionsPanel actions={pipeline.immediateActions} />
          </div>
        </>
      )}
    </div>
  );
}

export default PipelinePage;
