import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { dashboardFiltersReducer } from '../../../app/slices/dashboardFiltersSlice';
import { sessionReducer } from '../../../app/slices/sessionSlice';
import DrillListPage from '../DrillListPage';
import { fetchDrill } from '../dashboardsApi';

vi.mock('../dashboardsApi', () => ({
  fetchDrill: vi.fn(),
}));

function renderWithProviders(widgetKey: string) {
  const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer, session: sessionReducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/dashboards/drill/${widgetKey}`]}>
        <Routes>
          <Route path="/dashboards/drill/:widgetKey" element={<DrillListPage />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('DrillListPage', () => {
  it('render_WhenDrillLoads_ShouldRenderMatchingRowsInSharedLeadsTable', async () => {
    // Arrange
    vi.mocked(fetchDrill).mockResolvedValue({
      widgetKey: 'leads.filtered',
      items: [
        {
          id: 1,
          leadRef: 'L-2026-0001',
          partyId: 1,
          partyName: 'Acme Corp',
          brokerId: null,
          brokerName: null,
          productLineName: 'Motor',
          coverTypeName: 'Comprehensive',
          premium: 5000,
          statusName: 'New',
          priority: 'Standard',
          dateReceived: '2026-07-01',
          ageDays: 5,
          owner: null,
          nextFollowUpDate: null,
          flags: [],
        },
      ],
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    // Act
    renderWithProviders('leads.filtered');

    // Assert
    await waitFor(() => expect(screen.getByTestId('drill-list')).toBeInTheDocument());
    expect(screen.getByText('L-2026-0001')).toBeInTheDocument();
  });

  it('render_WhenNoRowsReturned_ShouldRenderEmptyState', async () => {
    // Arrange
    vi.mocked(fetchDrill).mockResolvedValue({ widgetKey: 'leads.filtered', items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderWithProviders('leads.filtered');

    // Assert
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeInTheDocument());
  });

  it('render_WhenFetchFails_ShouldRenderErrorBanner', async () => {
    // Arrange
    vi.mocked(fetchDrill).mockRejectedValue({ title: 'Unable to load drill results.' });

    // Act
    renderWithProviders('leads.filtered');

    // Assert
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
  });
});
