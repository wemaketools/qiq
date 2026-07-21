import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import { sessionReducer } from '../../../app/slices/sessionSlice';
import RmPerformancePage from '../RmPerformancePage';
import { fetchRmPerformance, type RmPerformanceDto } from '../rmApi';

vi.mock('../rmApi', () => ({ fetchRmPerformance: vi.fn() }));
vi.mock('../../settings/settingsApi', () => ({ listReferenceItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../../leads/leadsApi', () => ({ getEligibleLeadOwners: vi.fn().mockResolvedValue([]) }));

const RM: RmPerformanceDto = {
  currencyCode: 'BWP',
  kpis: [
    { key: 'active_rms', label: 'Active RMs', leadOrQuote: 'lead', kind: 'count', value: 3, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'rm.leads' },
    { key: 'active_brokers', label: 'Active Brokers', leadOrQuote: 'lead', kind: 'count', value: 3, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'rm.leads' },
    { key: 'won_premium_ytd', label: 'Won Premium YTD', leadOrQuote: 'quote', kind: 'currency', value: 370_000, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'rm.won' },
    { key: 'rm_conversion_rate', label: 'RM Conversion Rate', leadOrQuote: 'quote', kind: 'percent', value: 0.55, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'rm.won' },
    { key: 'broker_conversion_rate', label: 'Broker Conversion Rate', leadOrQuote: 'quote', kind: 'percent', value: 0.55, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'rm.won' },
    { key: 'follow_up_compliance', label: 'Follow-up Compliance', leadOrQuote: 'lead', kind: 'percent', value: 0.6667, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'rm.overdue' },
  ],
  topRms: [
    { rmUserId: 1, rmName: 'Alice RM', quoteVolume: 4, wonPremium: 300_000, conversionRate: 0.75, drillWidgetKey: 'rm.leads' },
    { rmUserId: 2, rmName: 'Bob RM', quoteVolume: 4, wonPremium: 50_000, conversionRate: 0.25, drillWidgetKey: 'rm.leads' },
    { rmUserId: 3, rmName: 'Carol RM', quoteVolume: 1, wonPremium: 20_000, conversionRate: 1.0, drillWidgetKey: 'rm.leads' },
  ],
  topBrokers: [
    { brokerId: 10, brokerName: 'Alpha Brokers', quoteVolume: 4, wonPremium: 300_000, conversionRate: 0.75, drillWidgetKey: 'rm.quotes' },
    { brokerId: 11, brokerName: 'Beta Brokers', quoteVolume: 4, wonPremium: 50_000, conversionRate: 0.25, drillWidgetKey: 'rm.quotes' },
  ],
  brokerMatrix: {
    points: [
      { brokerId: 10, brokerName: 'Alpha Brokers', quoteVolume: 4, conversionRate: 0.75, wonPremium: 300_000, quadrant: 'high-high', drillWidgetKey: 'rm.quotes' },
      { brokerId: 11, brokerName: 'Beta Brokers', quoteVolume: 4, conversionRate: 0.25, wonPremium: 50_000, quadrant: 'high-low', drillWidgetKey: 'rm.quotes' },
      { brokerId: 12, brokerName: 'Gamma Brokers', quoteVolume: 1, conversionRate: 1.0, wonPremium: 20_000, quadrant: 'low-high', drillWidgetKey: 'rm.quotes' },
    ],
    volumeSplit: 4,
    conversionSplit: 0.75,
    drillWidgetKey: 'rm.quotes',
  },
  turnaroundByRm: {
    rows: [
      { rmUserId: 3, rmName: 'Carol RM', avgTurnaroundDays: 8.0, beyondTarget: true, drillWidgetKey: 'rm.quotes' },
      { rmUserId: 2, rmName: 'Bob RM', avgTurnaroundDays: 3.0, beyondTarget: false, drillWidgetKey: 'rm.quotes' },
      { rmUserId: 1, rmName: 'Alice RM', avgTurnaroundDays: 2.0, beyondTarget: false, drillWidgetKey: 'rm.quotes' },
    ],
    slaTargetDays: 5,
    drillWidgetKey: 'rm.quotes',
  },
  watchlist: [
    { rmUserId: 2, name: 'Bob RM', quoteVolume: 4, wonPremium: 50_000, conversionRate: 0.25, avgTurnaroundDays: 3.0, overdueFollowUps: 2, suggestedAction: { label: 'Coach and support', tone: 'warning' }, drillWidgetKey: 'rm.leads' },
    { rmUserId: 1, name: 'Alice RM', quoteVolume: 4, wonPremium: 300_000, conversionRate: 0.75, avgTurnaroundDays: 2.0, overdueFollowUps: 0, suggestedAction: { label: 'Recognize and retain', tone: 'success' }, drillWidgetKey: 'rm.leads' },
    { rmUserId: 3, name: 'Carol RM', quoteVolume: 1, wonPremium: 20_000, conversionRate: 1.0, avgTurnaroundDays: 8.0, overdueFollowUps: 0, suggestedAction: { label: 'Deepen engagement', tone: 'accent' }, drillWidgetKey: 'rm.leads' },
  ],
  insights: [
    { type: 'TopPerformingBroker', icon: '★', headline: 'Top performing broker: Alpha Brokers', narrative: 'Alpha leads with BWP 300,000.' },
    { type: 'UnderperformingRm', icon: '!', headline: 'Underperforming RM: Bob RM', narrative: 'Bob has the lowest conversion.' },
    { type: 'TurnaroundAtRisk', icon: '⏱', headline: 'Turnaround at risk: Carol RM', narrative: 'Carol averages 8.0 days, over the 5.0-day SLA target.' },
    { type: 'FollowUpCompliance', icon: '☑', headline: 'Follow-up compliance', narrative: 'Team follow-up compliance is 66.7%.' },
    { type: 'LargestPremiumOpportunity', icon: '$', headline: 'Largest premium opportunity: Alice RM', narrative: 'Alice is working BWP 900,000 of open pipeline.' },
  ],
};

function renderPage(initialPath = '/rm-performance') {
  const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer, session: sessionReducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/rm-performance" element={<RmPerformancePage />} />
          <Route path="/dashboards/drill/:widgetKey" element={<div data-testid="drill-landing" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('RmPerformancePage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.mocked(fetchRmPerformance).mockResolvedValue(RM);
  });

  it('render_WhenLoaded_ShouldRenderSixKpisAndEveryWidget', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('rm-kpi-row')).toBeInTheDocument());
    expect(within(screen.getByTestId('rm-kpi-row')).getAllByTestId('kpi-card')).toHaveLength(6);
    expect(screen.getByText('Active RMs (Lead)')).toBeInTheDocument();
    expect(screen.getByText('Follow-up Compliance (Lead)')).toBeInTheDocument();
    expect(screen.getByTestId('top-rms-ranking')).toBeInTheDocument();
    expect(screen.getByTestId('turnaround-bars')).toBeInTheDocument();
    expect(screen.getByTestId('performance-watchlist')).toBeInTheDocument();
    expect(screen.getByTestId('leadership-insights')).toBeInTheDocument();
  });

  it('render_WhenLoaded_ShouldNotRenderBrokerWidgetsMovedToBrokersDashboard', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('rm-kpi-row')).toBeInTheDocument());
    // Removed per user decision (2026-07-16): Top Brokers + Broker Performance Matrix are
    // broker-centric and live on the Brokers dashboard only.
    expect(screen.queryByTestId('top-brokers-ranking')).not.toBeInTheDocument();
    expect(screen.queryByTestId('broker-matrix')).not.toBeInTheDocument();
  });

  it('render_ShouldShowRmVariantFilterBarWithRmTeamAndBrokerTypeLabels', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('filter-bar-rm-variant')).toBeInTheDocument());
    expect(screen.getByLabelText('RM/Team')).toBeInTheDocument();
    expect(screen.getByLabelText('Broker Type')).toBeInTheDocument();
  });

  it('render_TurnaroundBars_ShouldShowSlaMarkerAndFlagBeyondTargetRow', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('turnaround-bars')).toBeInTheDocument());
    expect(screen.getByTestId('sla-target-marker')).toBeInTheDocument();

    const rows = screen.getAllByTestId('turnaround-row');
    expect(rows).toHaveLength(3);
    // Carol (first, slowest) is flagged beyond the SLA target.
    expect(rows[0]!).toHaveAttribute('data-beyond-target', 'true');
    expect(within(rows[0]!).getByTestId('turnaround-days')).toHaveTextContent('8.0d');
    expect(rows[2]!).toHaveAttribute('data-beyond-target', 'false');
  });

  it('render_TurnaroundBars_ShouldSizeBarFillsProportionallyAcrossStretchedRows', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('turnaround-bars')).toBeInTheDocument());
    const rows = screen.getAllByTestId('turnaround-row');
    // Rows must pin align-items: stretch inline — components.css's bare-button rule
    // (`button:not([class])` → align-items: center) otherwise collapses the track to zero width.
    expect(rows[0]!).toHaveStyle({ alignItems: 'stretch' });
    // Carol: 8.0d on the 10-day scale (max(8, SLA 5) × 1.25) → an 80%-wide bar fill.
    expect(within(rows[0]!).getByTestId('turnaround-bar-fill')).toHaveStyle({ width: '80%' });
  });

  it('render_Watchlist_ShouldShowColorCodedSuggestedActionChips', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('performance-watchlist')).toBeInTheDocument());
    const rows = screen.getAllByTestId('watchlist-row');
    expect(rows).toHaveLength(3);

    const chip = within(rows[0]!).getByTestId('suggested-action-chip');
    expect(chip).toHaveTextContent('Coach and support');
    expect(chip).toHaveClass('qiq-chip--warning');
    expect(within(rows[1]!).getByTestId('suggested-action-chip')).toHaveClass('qiq-chip--success');
  });

  it('render_Insights_ShouldListFiveLeadershipInsightEntries', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('leadership-insights')).toBeInTheDocument());
    expect(screen.getAllByTestId('insight-item')).toHaveLength(5);
    expect(screen.getByText('Top performing broker: Alpha Brokers')).toBeInTheDocument();
    expect(screen.getByText('Follow-up compliance')).toBeInTheDocument();
  });

  it('click_WhenWatchlistRowClicked_ShouldNarrowFilterAndNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('performance-watchlist')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('watchlist-row')[0]!);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('click_WhenKpiClicked_ShouldNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('rm-kpi-row')).toBeInTheDocument());
    const card = screen.getByText('Won Premium YTD (Quote)').closest('[data-testid="kpi-card"]')!;
    fireEvent.click(card as HTMLElement);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('render_WhenFetchFails_ShouldRenderErrorBanner', async () => {
    vi.mocked(fetchRmPerformance).mockRejectedValue({ title: 'Unable to load the RM Performance dashboard.' });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
  });
});
