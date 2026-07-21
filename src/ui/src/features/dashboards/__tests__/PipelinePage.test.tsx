import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import { sessionReducer } from '../../../app/slices/sessionSlice';
import PipelinePage from '../PipelinePage';
import { fetchPipelineDashboard, type PipelineDashboardDto } from '../pipelineApi';

vi.mock('../pipelineApi', () => ({ fetchPipelineDashboard: vi.fn() }));
vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn().mockResolvedValue([]),
  listBrokers: vi.fn().mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 }),
}));
vi.mock('../../leads/leadsApi', () => ({ getEligibleLeadOwners: vi.fn().mockResolvedValue([]) }));

const PIPELINE: PipelineDashboardDto = {
  currencyCode: 'BWP',
  kpis: [
    { key: 'new_leads_this_month', label: 'New Leads This Month', leadOrQuote: 'lead', kind: 'count', value: 42, delta: 6, goodDirection: 'higherIsBetter', isFavorableDelta: true, drillWidgetKey: 'pipeline.new_leads' },
    { key: 'open_pipeline_value', label: 'Open Pipeline Value', leadOrQuote: 'quote', kind: 'currency', value: 72_000_000, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'pipeline.open_pipeline' },
    { key: 'quote_to_proposal_rate', label: 'Quote-to-Proposal Rate', leadOrQuote: 'quote', kind: 'percent', value: 0.4, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'pipeline.quoted' },
    { key: 'proposal_to_win_rate', label: 'Proposal-to-Win Rate', leadOrQuote: 'quote', kind: 'percent', value: 0.5, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'pipeline.won' },
    { key: 'average_quote_age', label: 'Average Quote Age', leadOrQuote: 'quote', kind: 'days', value: 6, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'pipeline.open_pipeline' },
    { key: 'sla_breaches', label: 'SLA Breaches', leadOrQuote: 'quote', kind: 'count', value: 1, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'pipeline.at_risk' },
    { key: 'quotes_issued_this_month', label: 'Quotes Issued This Month', leadOrQuote: 'quote', kind: 'count', value: 5, delta: 1, goodDirection: 'higherIsBetter', isFavorableDelta: true, drillWidgetKey: 'pipeline.quoted' },
    { key: 'lead_to_quote_rate', label: 'Lead-to-Quote Rate', leadOrQuote: 'lead', kind: 'percent', value: 0.71, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'pipeline.leads' },
    { key: 'average_lead_age', label: 'Average Lead Age', leadOrQuote: 'lead', kind: 'days', value: 4.6, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'pipeline.open_pipeline' },
  ],
  stageConversionFunnel: [
    { stageName: 'New', stageCanonicalKey: 'new', reachedCount: 6, conversionFromTop: 1, isLost: false, drillWidgetKey: 'pipeline.open_pipeline' },
    { stageName: 'Assigned', stageCanonicalKey: 'assigned', reachedCount: 4, conversionFromTop: 0.667, isLost: false, drillWidgetKey: 'pipeline.open_pipeline' },
    { stageName: 'Closed Won', stageCanonicalKey: 'closed_won', reachedCount: 1, conversionFromTop: 0.167, isLost: false, drillWidgetKey: 'pipeline.open_pipeline' },
    { stageName: 'Closed Lost', stageCanonicalKey: 'closed_lost', reachedCount: 1, conversionFromTop: 0.167, isLost: true, drillWidgetKey: 'pipeline.lost' },
  ],
  pipelineByProductLine: {
    productLines: ['Motor', 'Property'],
    columns: [
      { monthLabel: 'Jul 2026', segments: [{ productLineName: 'Motor', value: 420_000 }, { productLineName: 'Property', value: 300_000 }], monthlyTotal: 720_000 },
    ],
    drillWidgetKey: 'pipeline.open_pipeline',
  },
  quoteVolumeBySource: {
    slices: [{ label: 'Alpha Brokers', count: 3, share: 0.6 }, { label: 'Direct', count: 2, share: 0.4 }],
    drillWidgetKey: 'pipeline.quoted',
  },
  leadVolumeByChannel: {
    slices: [{ label: 'Direct', count: 5, share: 0.71 }, { label: 'Broker Email', count: 2, share: 0.29 }],
    drillWidgetKey: 'pipeline.leads',
  },
  agingByStage: {
    stages: [
      { stageName: 'New', stageCanonicalKey: 'new' },
      { stageName: 'Pricing', stageCanonicalKey: 'pricing' },
    ],
    buckets: ['0-3', '4-7', '8-14', '15-30', '31-60', '60+', 'Total'],
    cells: [
      { stageName: 'New', bucket: '0-3', count: 2, grade: 'normal', drillWidgetKey: 'pipeline.open_pipeline' },
      { stageName: 'New', bucket: 'Total', count: 2, grade: 'normal', drillWidgetKey: 'pipeline.open_pipeline' },
      { stageName: 'Pricing', bucket: '8-14', count: 1, grade: 'amber', drillWidgetKey: 'pipeline.open_pipeline' },
      { stageName: 'Pricing', bucket: 'Total', count: 1, grade: 'normal', drillWidgetKey: 'pipeline.open_pipeline' },
    ],
    drillWidgetKey: 'pipeline.open_pipeline',
  },
  atRiskPipeline: [
    {
      leadId: 3, leadRef: 'L-2026-0003', clientName: 'Botswana Mining Co.', brokerName: 'Alpha Brokers', premium: 210_000,
      stageName: 'Pricing', stageReportingCategory: 'open', ageDays: 10, ownerName: 'Michael Ndlovu',
      riskReason: 'SLA breach', suggestedAction: 'Escalate to underwriting', tenantName: null, drillWidgetKey: 'pipeline.at_risk',
    },
  ],
  immediateActions: [
    { category: 'overdue_quotes', name: 'Overdue Quotes', count: 1, tab: 'sla', drillWidgetKey: 'pipeline.overdue_quotes' },
    { category: 'unassigned_leads', name: 'Unassigned Leads', count: 0, tab: 'all', drillWidgetKey: 'pipeline.leads' },
    { category: 'follow_ups_due_today', name: 'Follow-ups Due Today', count: 1, tab: 'overdue', drillWidgetKey: 'pipeline.open_pipeline' },
  ],
};

function renderPage(initialPath = '/pipeline') {
  const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer, session: sessionReducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/pipeline" element={<PipelinePage />} />
          <Route path="/dashboards/drill/:widgetKey" element={<div data-testid="drill-landing" />} />
          <Route path="/alerts" element={<div data-testid="alerts-landing" />} />
          <Route path="/leads/:leadId" element={<div data-testid="lead-detail-landing" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('PipelinePage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.mocked(fetchPipelineDashboard).mockResolvedValue(PIPELINE);
  });

  it('render_WhenLoaded_ShouldRenderNineKpisAndEveryWidget', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('pipeline-kpi-row')).toBeInTheDocument());
    expect(within(screen.getByTestId('pipeline-kpi-row')).getAllByTestId('kpi-card')).toHaveLength(9);
    expect(screen.getByText('New Leads This Month')).toBeInTheDocument();
    expect(screen.getByText('Open Pipeline Value (Quote)')).toBeInTheDocument();
    expect(screen.getByTestId('conversion-funnel')).toBeInTheDocument();
    expect(screen.getByTestId('product-line-stacks')).toBeInTheDocument();
    expect(screen.getByTestId('quote-volume-by-source')).toBeInTheDocument();
    expect(screen.getByTestId('lead-volume-by-channel')).toBeInTheDocument();
    expect(screen.getByTestId('aging-heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('at-risk-table')).toBeInTheDocument();
    expect(screen.getByTestId('immediate-actions')).toBeInTheDocument();
  });

  it('render_WhenFunnelHasLostBar_ShouldFlagItLastAndRed', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('conversion-funnel')).toBeInTheDocument());
    const rows = screen.getAllByTestId('funnel-stage-row');
    const last = rows[rows.length - 1]!;
    expect(last).toHaveAttribute('data-is-lost', 'true');
    expect(within(last).getByText('Closed Lost')).toBeInTheDocument();
  });

  it('render_WhenHeatmap_ShouldShowOnlyOpenStagesWithGradedCells', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('aging-heatmap')).toBeInTheDocument());
    const heatmap = screen.getByTestId('aging-heatmap');
    // Won/Lost rows are omitted from the heatmap (spec FR-56 prototype deviation).
    expect(within(heatmap).queryByText('Closed Won')).not.toBeInTheDocument();
    expect(within(heatmap).getByText('New')).toBeInTheDocument();
    expect(within(heatmap).getByText('Pricing')).toBeInTheDocument();
  });

  it('render_WhenProductLineStacks_ShouldRenderSegmentsForEachProductLine', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('product-line-stacks')).toBeInTheDocument());
    const segments = screen.getAllByTestId('stack-segment');
    expect(segments.some((s) => s.getAttribute('data-product-line') === 'Motor')).toBe(true);
    expect(segments.some((s) => s.getAttribute('data-product-line') === 'Property')).toBe(true);
  });

  it('click_WhenKpiClicked_ShouldNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('pipeline-kpi-row')).toBeInTheDocument());
    const card = screen.getByText('New Leads This Month').closest('[data-testid="kpi-card"]')!;
    fireEvent.click(card as HTMLElement);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('click_WhenFunnelStageClicked_ShouldNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('conversion-funnel')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('funnel-stage-row')[0]!);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('click_WhenAtRiskRowClicked_ShouldNavigateToLeadDetail', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('at-risk-table')).toBeInTheDocument());
    // The row carries its risk reason and suggested action before any navigation.
    expect(screen.getByTestId('at-risk-reason')).toHaveTextContent('SLA breach');
    expect(screen.getByTestId('at-risk-action')).toHaveTextContent('Escalate to underwriting');

    fireEvent.click(screen.getByTestId('at-risk-row'));

    expect(await screen.findByTestId('lead-detail-landing')).toBeInTheDocument();
  });

  it('click_WhenImmediateActionClicked_ShouldNavigateToPreFilteredAlerts', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('immediate-actions')).toBeInTheDocument());
    const overdueRow = screen.getByText('Overdue Quotes').closest('[data-testid="immediate-action-row"]')!;
    fireEvent.click(overdueRow as HTMLElement);

    expect(await screen.findByTestId('alerts-landing')).toBeInTheDocument();
  });

  it('render_WhenFetchFails_ShouldRenderErrorBanner', async () => {
    vi.mocked(fetchPipelineDashboard).mockRejectedValue({ title: 'Unable to load the Pipeline dashboard.' });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
  });
});
