import type { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import { sessionReducer } from '../../../app/slices/sessionSlice';
import LossAnalysisPage from '../LossAnalysisPage';
import { fetchLossAnalysis, type LossAnalysisDto } from '../lossApi';

vi.mock('../lossApi', () => ({ fetchLossAnalysis: vi.fn() }));
vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn().mockResolvedValue([]),
  listBrokers: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock('../../leads/leadsApi', () => ({ getEligibleLeadOwners: vi.fn().mockResolvedValue([]) }));

// Recharts needs a non-zero layout size in jsdom; render its children deterministically instead.
vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AreaChart: Passthrough,
    Area: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

const LOSS: LossAnalysisDto = {
  currencyCode: 'BWP',
  kpis: [
    { key: 'lost_premium', label: 'Lost Premium', leadOrQuote: 'lead', kind: 'currency', value: 750_000, textValue: null, delta: -0.07, goodDirection: 'lowerIsBetter', isFavorableDelta: true, drillWidgetKey: 'loss.count_by_reason' },
    { key: 'quotes_lost', label: 'Quotes Lost', leadOrQuote: 'lead', kind: 'count', value: 4, textValue: null, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'loss.count_by_reason' },
    { key: 'top_loss_reason', label: 'Top Loss Reason', leadOrQuote: 'lead', kind: 'text', value: null, textValue: 'Pricing', delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'loss.count_by_reason' },
    { key: 'avg_price_gap', label: 'Avg Price Gap', leadOrQuote: 'quote', kind: 'percent', value: 0.1667, textValue: null, delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'loss.price_gap' },
    { key: 'top_competitor', label: 'Top Competitor', leadOrQuote: 'lead', kind: 'text', value: null, textValue: 'Old Mutual', delta: null, goodDirection: 'lowerIsBetter', isFavorableDelta: null, drillWidgetKey: 'loss.count_by_reason' },
  ],
  lostPremiumByReason: {
    rows: [
      { reasonName: 'Pricing', amount: 700_000, drillWidgetKey: 'loss.count_by_reason' },
      { reasonName: 'Brand trust', amount: 50_000, drillWidgetKey: 'loss.count_by_reason' },
    ],
    drillWidgetKey: 'loss.count_by_reason',
  },
  lostPremiumTrend: {
    points: [
      { monthLabel: 'Dec 24', amount: 0 },
      { monthLabel: 'Jan 25', amount: 0 },
      { monthLabel: 'Feb 25', amount: 0 },
      { monthLabel: 'Mar 25', amount: 0 },
      { monthLabel: 'Apr 25', amount: 0 },
      { monthLabel: 'May 25', amount: 750_000 },
    ],
    drillWidgetKey: 'loss.trend_by_reason',
  },
  lostPremiumByProductLine: {
    rows: [
      { productLineName: 'Property', amount: 410_000, drillWidgetKey: 'loss.by_cover_type' },
      { productLineName: 'Motor', amount: 340_000, drillWidgetKey: 'loss.by_cover_type' },
    ],
    drillWidgetKey: 'loss.by_cover_type',
  },
  competitorAnalysis: {
    rows: [
      { competitor: 'Old Mutual', dealsLost: 3, premiumLost: 700_000, avgPriceGapPct: 0.1667, drillWidgetKey: 'loss.count_by_reason' },
      { competitor: 'Regent', dealsLost: 1, premiumLost: 50_000, avgPriceGapPct: null, drillWidgetKey: 'loss.count_by_reason' },
    ],
    drillWidgetKey: 'loss.count_by_reason',
  },
  lossCommentary: {
    items: [
      { leadId: 1, client: 'Tati Transport', productLineName: 'Motor', comment: 'Undercut on price.', lossReasonName: 'Pricing', lossReasonTone: 'danger', premium: 120_000, drillWidgetKey: 'loss.count_by_reason' },
      { leadId: 2, client: 'Mahalapye Hospitality', productLineName: 'Property', comment: 'Went with a trusted brand.', lossReasonName: 'Brand trust', lossReasonTone: 'danger', premium: 50_000, drillWidgetKey: 'loss.count_by_reason' },
    ],
  },
};

function renderPage(initialPath = '/loss-analysis') {
  const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer, session: sessionReducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/loss-analysis" element={<LossAnalysisPage />} />
          <Route path="/dashboards/drill/:widgetKey" element={<div data-testid="drill-landing" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('LossAnalysisPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.mocked(fetchLossAnalysis).mockResolvedValue(LOSS);
  });

  it('render_WhenLoaded_ShouldRenderFiveKpisAndNoWinBackCard', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('loss-kpi-row')).toBeInTheDocument());
    const cards = within(screen.getByTestId('loss-kpi-row')).getAllByTestId('kpi-card');
    expect(cards).toHaveLength(5);
    expect(screen.getByText('Lost Premium (Lead)')).toBeInTheDocument();
    expect(screen.getByText('Quotes Lost')).toBeInTheDocument();
    expect(screen.getByText('Top Loss Reason (Lead)')).toBeInTheDocument();
    expect(screen.getByText('Avg Price Gap (Quote)')).toBeInTheDocument();
    expect(screen.getByText('Top Competitor (Lead)')).toBeInTheDocument();
    // The explicitly-excluded prototype KPI must never appear.
    expect(screen.queryByText(/win-?back/i)).not.toBeInTheDocument();
  });

  it('render_TextKpis_ShouldShowCategoricalNameValues', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('loss-kpi-row')).toBeInTheDocument());
    const kpiRow = screen.getByTestId('loss-kpi-row');
    expect(within(kpiRow).getByText('Pricing')).toBeInTheDocument();
    expect(within(kpiRow).getByText('Old Mutual')).toBeInTheDocument();
  });

  it('render_LostPremiumKpi_ShouldRenderFallingDeltaGreen', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('loss-kpi-row')).toBeInTheDocument());
    const card = screen.getByText('Lost Premium (Lead)').closest('[data-testid="kpi-card"]')!;
    expect(card).toHaveAttribute('data-good-direction', 'lowerIsBetter');
    const delta = within(card as HTMLElement).getByTestId('kpi-delta');
    // A falling lost-premium delta is favorable (losing less is good) -> green success token.
    expect(delta).toHaveStyle({ color: 'var(--qiq-success)' });
    expect(delta.textContent).toContain('↓');
  });

  it('render_Bars_ShouldRenderReasonRedAndProductLineAmberWithAmounts', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('lost-by-reason')).toBeInTheDocument());
    const reasonRows = within(screen.getByTestId('lost-by-reason')).getAllByTestId('lost-by-reason-row');
    expect(reasonRows).toHaveLength(2);
    expect(within(reasonRows[0]!).getByTestId('loss-bar-fill')).toHaveStyle({ background: 'var(--qiq-danger)' });
    expect(within(reasonRows[0]!).getByTestId('loss-bar-amount')).toHaveTextContent('BWP 700.0K');

    const productRows = within(screen.getByTestId('lost-by-product-line')).getAllByTestId('lost-by-product-line-row');
    expect(within(productRows[0]!).getByTestId('loss-bar-fill')).toHaveStyle({ background: 'var(--qiq-warning)' });
  });

  it('render_Trend_ShouldRenderSixMonthPoints', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('loss-trend')).toBeInTheDocument());
    expect(screen.getByTestId('loss-trend')).toHaveAttribute('data-point-count', '6');
  });

  it('render_CompetitorTable_ShouldListCompetitorsWithGaps', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('competitor-table')).toBeInTheDocument());
    const rows = screen.getAllByTestId('competitor-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Old Mutual')).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId('competitor-price-gap')).toHaveTextContent('16.7%');
    // Regent has no known competitor premium -> em dash, not a fabricated 0%.
    expect(within(rows[1]!).getByTestId('competitor-price-gap')).toHaveTextContent('—');
  });

  it('render_Commentary_ShouldRenderFullWidthFeedWithReasonChips', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('loss-commentary')).toBeInTheDocument());
    const items = screen.getAllByTestId('commentary-item');
    expect(items).toHaveLength(2);
    const chip = within(items[0]!).getByTestId('commentary-reason-chip');
    expect(chip).toHaveTextContent('Pricing');
    expect(chip).toHaveClass('qiq-chip--danger');
  });

  it('click_WhenReasonBarClicked_ShouldNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('lost-by-reason')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('lost-by-reason')).getAllByTestId('lost-by-reason-row')[0]!);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('click_WhenKpiClicked_ShouldNavigateToDrill', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('loss-kpi-row')).toBeInTheDocument());
    const card = screen.getByText('Avg Price Gap (Quote)').closest('[data-testid="kpi-card"]')!;
    fireEvent.click(card as HTMLElement);

    expect(await screen.findByTestId('drill-landing')).toBeInTheDocument();
  });

  it('render_WhenFetchFails_ShouldRenderErrorBanner', async () => {
    vi.mocked(fetchLossAnalysis).mockRejectedValue({ title: 'Unable to load the Loss Analysis dashboard.' });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
  });
});
