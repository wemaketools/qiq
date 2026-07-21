import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import { alertsBadgeReducer } from '../../../app/slices/alertsBadgeSlice';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import GlobalSearch from '../GlobalSearch';
import type { GlobalSearchDto } from '../../../features/search/searchApi';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const globalSearchMock = vi.fn<(q: string, limitPerType?: number) => Promise<GlobalSearchDto>>();
vi.mock('../../../features/search/searchApi', async () => {
  const actual = await vi.importActual<typeof import('../../../features/search/searchApi')>(
    '../../../features/search/searchApi',
  );
  return { ...actual, globalSearch: (...args: [string, number?]) => globalSearchMock(...args) };
});

function sampleResults(): GlobalSearchDto {
  return {
    parties: [{ id: 7, name: 'Okavango Holdings', type: 'Corporate' }],
    leads: [{ id: 40, ref: 'L-2026-0040', partyName: 'Okavango Holdings', status: 'Pricing' }],
    quotes: [{ id: 88, ref: 'Q-2026-1503', leadId: 40, leadRef: 'L-2026-0040', partyName: 'Okavango Holdings', status: 'Draft' }],
    brokers: [{ id: 12, name: 'Okavango Brokers', tier: 'Tier 1' }],
  };
}

// Default caller holds broker admin so the broker group renders and routes to the admin subsection
// (the pre-F-T038-04 baseline the first 7 tests assert against).
const BROKER_ADMIN_PERMISSIONS = ['leads.view', 'brokers.view'];

function renderSearch(permissions: string[] = BROKER_ADMIN_PERMISSIONS) {
  const store = configureStore({
    reducer: { session: sessionReducer, alertsBadge: alertsBadgeReducer, dashboardFilters: dashboardFiltersReducer },
  });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: [
        { tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions },
      ],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  return render(
    <Provider store={store}>
      <MemoryRouter>
        <GlobalSearch />
      </MemoryRouter>
    </Provider>,
  );
}

describe('GlobalSearch', () => {
  beforeEach(() => {
    navigate.mockClear();
    globalSearchMock.mockReset();
    globalSearchMock.mockResolvedValue(sampleResults());
  });

  it('type_WhenBelowMinLength_ShouldNotSearch', async () => {
    // Arrange
    vi.useFakeTimers();
    renderSearch();

    // Act
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'o' } });
    await vi.advanceTimersByTimeAsync(300);

    // Assert
    expect(globalSearchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('type_WhenTwoOrMoreChars_ShouldDebounceThenShowGroupedResults', async () => {
    // Arrange
    renderSearch();

    // Act
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'okavango' } });

    // Assert — grouped dropdown with per-entity headers renders after the debounced fetch.
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledWith('okavango'));
    const headers = await screen.findAllByTestId('search-group-header');
    expect(headers.map((h) => h.textContent)).toEqual(['Clients', 'Leads', 'Quotes', 'Brokers']);
    expect(screen.getAllByTestId('search-result-item')).toHaveLength(4);
  });

  it('select_WhenPartyClicked_ShouldNavigateToPartyDetail', async () => {
    // Arrange
    renderSearch();
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'okavango' } });
    await screen.findByTestId('search-results');

    // Act
    const partyRow = screen.getByRole('option', { name: /Okavango Holdings\s*Corporate/ });
    fireEvent.click(partyRow);

    // Assert
    expect(navigate).toHaveBeenCalledWith('/parties/7');
  });

  it('select_WhenQuoteClicked_ShouldNavigateToLeadWithHighlightQuote', async () => {
    // Arrange
    renderSearch();
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'okavango' } });
    await screen.findByTestId('search-results');

    // Act
    const quoteRow = screen.getByRole('option', { name: /Q-2026-1503/ });
    fireEvent.click(quoteRow);

    // Assert — opens the quote's lead with the T-037 highlightQuote param.
    expect(navigate).toHaveBeenCalledWith('/leads/40?highlightQuote=88');
  });

  it('keyboard_WhenArrowDownThenEnter_ShouldSelectFirstResult', async () => {
    // Arrange
    renderSearch();
    const input = screen.getByTestId('global-search-input');
    fireEvent.change(input, { target: { value: 'okavango' } });
    await screen.findByTestId('search-results');

    // Act — first ArrowDown highlights the first flat result (the Clients party), Enter selects it.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Assert
    expect(navigate).toHaveBeenCalledWith('/parties/7');
  });

  it('keyboard_WhenEscapePressed_ShouldCloseDropdown', async () => {
    // Arrange
    renderSearch();
    const input = screen.getByTestId('global-search-input');
    fireEvent.change(input, { target: { value: 'okavango' } });
    await screen.findByTestId('search-results');

    // Act
    fireEvent.keyDown(input, { key: 'Escape' });

    // Assert
    await waitFor(() => expect(screen.queryByTestId('search-results')).not.toBeInTheDocument());
  });

  it('type_WhenNoMatches_ShouldShowEmptyState', async () => {
    // Arrange
    globalSearchMock.mockResolvedValue({ parties: [], leads: [], quotes: [], brokers: [] });
    renderSearch();

    // Act
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'zzzz' } });

    // Assert
    const empty = await screen.findByTestId('search-empty');
    expect(within(empty).getByText(/No matches/)).toBeInTheDocument();
  });

  // F-T038-04: broker-hit routing is permission-aware so no seeded role is funneled into Forbidden.
  it('select_WhenBrokerClickedWithBrokerAdminPermission_ShouldNavigateToSettingsBrokers', async () => {
    // Arrange — caller holds brokers.view (broker admin).
    renderSearch(['leads.view', 'brokers.view']);
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'okavango' } });
    await screen.findByTestId('search-results');

    // Act
    const brokerRow = screen.getByRole('option', { name: /Okavango Brokers/ });
    fireEvent.click(brokerRow);

    // Assert — admins still reach the broker admin subsection.
    expect(navigate).toHaveBeenCalledWith('/settings/brokers?focus=12');
  });

  it('render_WhenCallerHasNoBrokerPermission_ShouldOmitBrokerGroup', async () => {
    // Arrange — a leads.view-only caller (Relationship Manager / Underwriter / Sales Ops / Exec
    // Viewer profile) can open no broker destination, so the broker group must not render at all.
    renderSearch(['leads.view']);

    // Act
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'okavango' } });
    await screen.findByTestId('search-results');

    // Assert — Brokers header is absent and no broker result row is shown (3 groups, 3 items).
    const headers = screen.getAllByTestId('search-group-header');
    expect(headers.map((h) => h.textContent)).toEqual(['Clients', 'Leads', 'Quotes']);
    expect(screen.queryByRole('option', { name: /Okavango Brokers/ })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('search-result-item')).toHaveLength(3);
  });

  it('select_WhenBrokerViewPerformanceOnly_ShouldNavigateToBrokerPerformance', async () => {
    // Arrange — caller lacks broker admin but holds dashboards.view_broker_performance.
    renderSearch(['leads.view', 'dashboards.view_broker_performance']);
    fireEvent.change(screen.getByTestId('global-search-input'), { target: { value: 'okavango' } });
    await screen.findByTestId('search-results');

    // Act
    const brokerRow = screen.getByRole('option', { name: /Okavango Brokers/ });
    fireEvent.click(brokerRow);

    // Assert — routed to the Broker Performance dashboard (no fabricated focus param; page ignores it).
    expect(navigate).toHaveBeenCalledWith('/brokers');
  });
});
