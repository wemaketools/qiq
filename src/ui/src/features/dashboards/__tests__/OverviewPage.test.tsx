import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import { sessionReducer } from '../../../app/slices/sessionSlice';
import OverviewPage from '../OverviewPage';
import { fetchExecutiveOverview, type ExecutiveOverviewDto } from '../executiveApi';

vi.mock('../executiveApi', () => ({ fetchExecutiveOverview: vi.fn() }));
vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn().mockResolvedValue([]),
  listBrokers: vi.fn().mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 }),
}));
vi.mock('../../leads/leadsApi', () => ({ getEligibleLeadOwners: vi.fn().mockResolvedValue([]) }));

const OVERVIEW: ExecutiveOverviewDto = {
  currencyCode: 'BWP',
  kpis: [
    { key: 'total_quotes', label: 'Total Quotes', leadOrQuote: 'quote', kind: 'count', value: 1248, delta: 156, goodDirection: 'higherIsBetter', isFavorableDelta: true, drillWidgetKey: 'exec.quotes' },
    { key: 'open_pipeline_premium', label: 'Open Pipeline Premium', leadOrQuote: 'quote', kind: 'currency', value: 128_600_000, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'exec.open_pipeline' },
    { key: 'won_premium', label: 'Won Premium', leadOrQuote: 'quote', kind: 'currency', value: 42_300_000, delta: 7_000_000, goodDirection: 'higherIsBetter', isFavorableDelta: true, drillWidgetKey: 'exec.won' },
    { key: 'conversion_rate', label: 'Conversion Rate', leadOrQuote: 'quote', kind: 'percent', value: 0.339, delta: 0.036, goodDirection: 'higherIsBetter', isFavorableDelta: true, drillWidgetKey: 'exec.won' },
    { key: 'average_turnaround', label: 'Avg Turnaround', leadOrQuote: 'quote', kind: 'days', value: 2.6, delta: -0.6, goodDirection: 'lowerIsBetter', isFavorableDelta: true, drillWidgetKey: 'exec.quotes' },
    { key: 'quotes_at_risk', label: 'Quotes at Risk', leadOrQuote: 'quote', kind: 'count', value: 87, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'exec.at_risk' },
    { key: 'total_leads', label: 'Total Leads', leadOrQuote: 'lead', kind: 'count', value: 1580, delta: 40, goodDirection: 'higherIsBetter', isFavorableDelta: true, drillWidgetKey: 'exec.leads' },
    { key: 'lead_to_quote_rate', label: 'Lead-to-Quote Rate', leadOrQuote: 'lead', kind: 'percent', value: 0.79, delta: 0.02, goodDirection: 'higherIsBetter', isFavorableDelta: true, drillWidgetKey: 'exec.leads' },
    { key: 'leads_at_risk', label: 'Leads at Risk', leadOrQuote: 'lead', kind: 'count', value: 34, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'exec.at_risk' },
  ],
  pipelineByStage: [
    { stageName: 'New', stageCanonicalKey: 'new', openCount: 1248, shareOfOpen: 1, drillWidgetKey: 'exec.open_pipeline' },
    { stageName: 'Pricing', stageCanonicalKey: 'pricing', openCount: 326, shareOfOpen: 0.26, drillWidgetKey: 'exec.open_pipeline' },
  ],
  openQuotesAging: {
    buckets: [
      { bucket: '0-3 days', count: 168, share: 0.33 },
      { bucket: '4-7 days', count: 142, share: 0.28 },
      { bucket: '8-14 days', count: 118, share: 0.23 },
      { bucket: '15+ days', count: 84, share: 0.16 },
    ],
    totalOpenQuotes: 512,
    drillWidgetKey: 'exec.open_pipeline',
  },
  wonVsLostTrend: {
    weekly: [{ label: 'May 26', wonPremium: 50_000_000, lostPremium: 10_000_000 }],
    monthly: [{ label: 'May 2025', wonPremium: 200_000_000, lostPremium: 40_000_000 }],
    drillWidgetKey: 'exec.won',
  },
  highValueOpportunities: [
    {
      leadId: 42, leadRef: 'L-2025-0042', clientName: 'Botswana Mining Co.', partyType: 'Corporate', brokerName: 'Alpha Brokers',
      productLineName: 'Commercial Combined', premium: 8_750_000, stageName: 'Pricing', stageReportingCategory: 'open',
      nextFollowUpDate: '2025-06-02', ownerName: 'Michael Ndlovu', riskFlag: true,
    },
  ],
  requiresAttention: [
    { category: 'stalled', name: 'Stalled Quotes', definition: 'No activity 7+ days', tab: null, count: 34 },
    { category: 'overdue', name: 'Overdue', definition: 'Follow-up overdue', tab: 'overdue', count: 28 },
  ],
};

function renderPage(initialPath = '/overview') {
  const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer, session: sessionReducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/dashboards/drill/:widgetKey" element={<div data-testid="drill-landing" />} />
          <Route path="/alerts" element={<div data-testid="alerts-landing" />} />
          <Route path="/leads/:leadId" element={<div data-testid="lead-detail-landing" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('OverviewPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.mocked(fetchExecutiveOverview).mockResolvedValue(OVERVIEW);
  });

  it('render_WhenLoaded_ShouldRenderNineLeadOrQuoteLabeledKpisAndAllWidgets', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('kpi-row')).toBeInTheDocument());
    expect(within(screen.getByTestId('kpi-row')).getAllByTestId('kpi-card')).toHaveLength(9);
    // Lead-vs-quote labeling explicit (FR-54).
    expect(screen.getByText('Total Leads')).toBeInTheDocument();
    expect(screen.getByText('Total Quotes')).toBeInTheDocument();
    expect(screen.getByTestId('pipeline-by-stage')).toBeInTheDocument();
    expect(screen.getByTestId('aging-donut')).toBeInTheDocument();
    expect(screen.getByTestId('aging-center-total')).toHaveTextContent('512');
    expect(screen.getByTestId('won-lost-trend')).toBeInTheDocument();
    expect(screen.getByTestId('high-value-table')).toBeInTheDocument();
    expect(screen.getByTestId('requires-attention')).toBeInTheDocument();
  });

  it('render_WhenTurnaroundFalling_ShouldColorDeltaGreen', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('kpi-row')).toBeInTheDocument());
    const turnaroundCard = screen.getByText('Avg Turnaround (Quote)').closest('[data-testid="kpi-card"]')!;
    expect(within(turnaroundCard as HTMLElement).getByTestId('kpi-delta')).toHaveStyle({ color: 'var(--qiq-success)' });
  });

  it('click_WhenKpiClicked_ShouldNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('kpi-row')).toBeInTheDocument());
    const totalLeadsCard = screen.getByText('Total Leads').closest('[data-testid="kpi-card"]')!;
    fireEvent.click(totalLeadsCard as HTMLElement);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('click_WhenPipelineStageClicked_ShouldDrillToOpenPipeline', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('pipeline-by-stage')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('pipeline-stage-row')[0]!);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('click_WhenHighValueRowClicked_ShouldNavigateToLeadDetail', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('high-value-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('high-value-row'));

    expect(await screen.findByTestId('lead-detail-landing')).toBeInTheDocument();
  });

  it('click_WhenAttentionRowChevronClicked_ShouldNavigateToPreFilteredAlerts', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('requires-attention')).toBeInTheDocument());
    const overdueRow = screen.getByText('Overdue').closest('[data-testid="attention-row"]')!;
    fireEvent.click(overdueRow as HTMLElement);

    expect(await screen.findByTestId('alerts-landing')).toBeInTheDocument();
  });

  it('select_WhenTrendGranularityToMonthly_ShouldSwitchSeriesWithoutRefetch', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('won-lost-trend')).toBeInTheDocument());
    const callsBeforeToggle = vi.mocked(fetchExecutiveOverview).mock.calls.length;
    fireEvent.change(screen.getByTestId('trend-granularity'), { target: { value: 'monthly' } });

    // The Weekly/Monthly selector toggles the pre-fetched series client-side, without a refetch.
    expect(screen.getByTestId('trend-granularity')).toHaveValue('monthly');
    expect(vi.mocked(fetchExecutiveOverview).mock.calls.length).toBe(callsBeforeToggle);
  });

  it('render_WhenFetchFails_ShouldRenderErrorBanner', async () => {
    vi.mocked(fetchExecutiveOverview).mockRejectedValue({ title: 'Unable to load the Overview dashboard.' });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
  });
});
