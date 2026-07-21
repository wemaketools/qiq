import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import { sessionReducer } from '../../../app/slices/sessionSlice';
import BrokerPerformancePage from '../BrokerPerformancePage';
import { fetchBrokerPerformance, type BrokerPerformanceDto } from '../brokersApi';

vi.mock('../brokersApi', () => ({ fetchBrokerPerformance: vi.fn() }));
vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn().mockResolvedValue([]),
  listBrokers: vi.fn().mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 }),
}));
vi.mock('../../leads/leadsApi', () => ({ getEligibleLeadOwners: vi.fn().mockResolvedValue([]) }));

const BROKERS: BrokerPerformanceDto = {
  currencyCode: 'BWP',
  kpis: [
    { key: 'active_brokers', label: 'Active Brokers', leadOrQuote: 'lead', kind: 'count', value: 3, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'broker.leads' },
    { key: 'broker_quotes', label: 'Broker Quotes', leadOrQuote: 'quote', kind: 'count', value: 9, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'broker.quotes' },
    { key: 'broker_conversion', label: 'Broker Conversion', leadOrQuote: 'quote', kind: 'percent', value: 0.55, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'broker.won' },
    { key: 'won_via_brokers', label: 'Won via Brokers', leadOrQuote: 'quote', kind: 'currency', value: 370_000, delta: null, goodDirection: 'higherIsBetter', isFavorableDelta: null, drillWidgetKey: 'broker.won' },
    { key: 'avg_turnaround', label: 'Avg Turnaround', leadOrQuote: 'quote', kind: 'days', value: 2.1, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'broker.quotes' },
    { key: 'overdue_follow_ups', label: 'Overdue Follow-ups', leadOrQuote: 'lead', kind: 'count', value: 1, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'broker.overdue' },
  ],
  topBrokers: [
    { brokerId: 1, brokerName: 'Alpha Brokers', quoteVolume: 4, conversionRate: 0.75, drillWidgetKey: 'broker.quotes' },
    { brokerId: 2, brokerName: 'Beta Brokers', quoteVolume: 4, conversionRate: 0.25, drillWidgetKey: 'broker.quotes' },
    { brokerId: 3, brokerName: 'Gamma Brokers', quoteVolume: 1, conversionRate: 1.0, drillWidgetKey: 'broker.quotes' },
  ],
  matrix: {
    points: [
      { brokerId: 1, brokerName: 'Alpha Brokers', quoteVolume: 4, conversionRate: 0.75, wonPremium: 300_000, quadrant: 'high-high', drillWidgetKey: 'broker.quotes' },
      { brokerId: 2, brokerName: 'Beta Brokers', quoteVolume: 4, conversionRate: 0.25, wonPremium: 50_000, quadrant: 'high-low', drillWidgetKey: 'broker.quotes' },
      { brokerId: 3, brokerName: 'Gamma Brokers', quoteVolume: 1, conversionRate: 1.0, wonPremium: 20_000, quadrant: 'low-high', drillWidgetKey: 'broker.quotes' },
    ],
    volumeSplit: 4,
    conversionSplit: 0.75,
    drillWidgetKey: 'broker.quotes',
  },
  table: [
    { brokerId: 1, brokerName: 'Alpha Brokers', primaryContactName: 'Anna Alpha', tierName: 'Tier 1', branch: 'Gaborone', quoteVolume: 4, conversionRate: 0.75, wonPremium: 300_000, avgTurnaroundDays: 2.0, overdueFollowUps: 0, topLossReason: 'Coverage gap', drillWidgetKey: 'broker.leads' },
    { brokerId: 2, brokerName: 'Beta Brokers', primaryContactName: 'Ben Beta', tierName: 'Tier 2', branch: 'Francistown', quoteVolume: 4, conversionRate: 0.25, wonPremium: 50_000, avgTurnaroundDays: 2.5, overdueFollowUps: 1, topLossReason: 'Pricing too high', drillWidgetKey: 'broker.leads' },
    { brokerId: 4, brokerName: 'Delta Brokers', primaryContactName: 'Dan Delta', tierName: 'Tier 3', branch: 'Kasane', quoteVolume: 0, conversionRate: null, wonPremium: 0, avgTurnaroundDays: null, overdueFollowUps: 0, topLossReason: null, drillWidgetKey: 'broker.leads' },
  ],
};

function renderPage(initialPath = '/brokers') {
  const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer, session: sessionReducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/brokers" element={<BrokerPerformancePage />} />
          <Route path="/dashboards/drill/:widgetKey" element={<div data-testid="drill-landing" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('BrokerPerformancePage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.mocked(fetchBrokerPerformance).mockResolvedValue(BROKERS);
  });

  it('render_WhenLoaded_ShouldRenderSixKpisAndEveryWidget', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('broker-kpi-row')).toBeInTheDocument());
    expect(within(screen.getByTestId('broker-kpi-row')).getAllByTestId('kpi-card')).toHaveLength(6);
    expect(screen.getByText('Active Brokers (Lead)')).toBeInTheDocument();
    expect(screen.getByText('Broker Conversion (Quote)')).toBeInTheDocument();
    expect(screen.getByTestId('top-brokers-ranking')).toBeInTheDocument();
    expect(screen.getByTestId('broker-matrix')).toBeInTheDocument();
    expect(screen.getByTestId('broker-performance-table')).toBeInTheDocument();
  });

  it('render_WhenTopBrokers_ShouldShowVolumeAndConversionColumns', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('top-brokers-ranking')).toBeInTheDocument());
    const rows = screen.getAllByTestId('top-broker-row');
    expect(rows).toHaveLength(3);
    // First bar is Alpha with 4 quotes and 75% conversion.
    expect(within(rows[0]!).getByTestId('top-broker-volume')).toHaveTextContent('4');
    expect(within(rows[0]!).getByTestId('top-broker-conversion')).toHaveTextContent('75.0%');
  });

  it('render_WhenMatrix_ShouldRenderQuadrantLegendFromSharedPalette', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('broker-matrix')).toBeInTheDocument());
    const legendItems = screen.getAllByTestId('quadrant-legend-item');
    expect(legendItems).toHaveLength(4);
    expect(screen.getByText('High Volume / High Conversion')).toBeInTheDocument();
    expect(screen.getByText('Low Volume / Low Conversion')).toBeInTheDocument();
  });

  it('render_WhenTable_ShouldShowTierChipsConversionColoringAndTopLossReason', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('broker-performance-table')).toBeInTheDocument());
    const rows = screen.getAllByTestId('broker-table-row');
    expect(rows).toHaveLength(3);

    // Tier chip + primary contact.
    expect(within(rows[0]!).getByText('Tier 1')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Anna Alpha')).toBeInTheDocument();

    // Strong conversion (>= median split 0.75) renders green; weak renders red.
    const strong = within(rows[0]!).getByTestId('broker-conversion');
    const weak = within(rows[1]!).getByTestId('broker-conversion');
    expect(strong).toHaveStyle({ color: 'var(--qiq-success)' });
    expect(weak).toHaveStyle({ color: 'var(--qiq-danger)' });

    // Top loss reason column.
    expect(within(rows[1]!).getByTestId('broker-top-loss-reason')).toHaveTextContent('Pricing too high');
    // No-activity broker renders an em dash for top loss reason.
    expect(within(rows[2]!).getByTestId('broker-top-loss-reason')).toHaveTextContent('—');
  });

  it('click_WhenBrokerRowClicked_ShouldNarrowFilterAndNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('broker-performance-table')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('broker-table-row')[0]!);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('click_WhenKpiClicked_ShouldNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('broker-kpi-row')).toBeInTheDocument());
    const card = screen.getByText('Won via Brokers (Quote)').closest('[data-testid="kpi-card"]')!;
    fireEvent.click(card as HTMLElement);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('render_WhenFetchFails_ShouldRenderErrorBanner', async () => {
    vi.mocked(fetchBrokerPerformance).mockRejectedValue({ title: 'Unable to load the Broker Performance dashboard.' });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
  });
});
