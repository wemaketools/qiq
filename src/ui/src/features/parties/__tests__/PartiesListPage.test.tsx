import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import PartiesListPage from '../PartiesListPage';
import { listParties } from '../partiesApi';
import type { PartyDto, PartyListDto } from '../partiesApi';
import { listReferenceItems } from '../../settings/settingsApi';

vi.mock('../partiesApi', async () => {
  const actual = await vi.importActual<typeof import('../partiesApi')>('../partiesApi');
  return {
    ...actual,
    listParties: vi.fn(),
  };
});

vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn(),
}));

function makeParty(overrides: Partial<PartyDto> = {}): PartyDto {
  return {
    id: 1,
    name: 'Acme Mining Co.',
    partyTypeId: 10,
    segmentId: 20,
    industryId: 30,
    regionId: 40,
    isStrategic: true,
    contactName: 'Jane Doe',
    contactEmail: 'jane@acme.test',
    contactPhone: '+267 123 4567',
    lastActivityAt: '2026-07-01T10:00:00Z',
    openLeadsCount: 3,
    totalLeadsCount: 7,
    ...overrides,
  };
}

function renderPage(permissions: string[], initialPath = '/parties') {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'sales-head@brittany.test', firstName: 'Sales', lastName: 'Head' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/parties" element={<PartiesListPage />} />
          <Route path="/parties/:partyId" element={<div data-testid="party-detail-route" />} />
          <Route path="/parties/new" element={<div data-testid="party-new-route" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('PartiesListPage', () => {
  beforeEach(() => {
    vi.mocked(listParties).mockReset();
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(listReferenceItems).mockImplementation((listType) => {
      if (listType === 'party_type') {
        return Promise.resolve([{ id: 10, listType: 'party_type', name: 'Corporate', displayOrder: 1, isActive: true, isBrokerChannel: null, productLineId: null, reportingCategory: null, canonicalKey: null, isTerminal: false }]);
      }
      return Promise.resolve([]);
    });
  });

  it('render_WhenPartiesLoad_ShouldShowColumnsIncludingLeadCountsAndLastActivity', async () => {
    // Arrange
    const dto: PartyListDto = { items: [makeParty()], totalCount: 1, page: 1, pageSize: 25 };
    vi.mocked(listParties).mockResolvedValue(dto);

    // Act
    renderPage(['parties.view']);

    // Assert
    await waitFor(() => expect(screen.getByTestId('parties-table')).toBeInTheDocument());
    expect(screen.getByTestId('party-name-link')).toHaveTextContent('Acme Mining Co.');
    expect(screen.getByTestId('strategic-flag-icon')).toBeInTheDocument();
    const row = screen.getByTestId('party-row');
    expect(row).toHaveTextContent('3');
    expect(row).toHaveTextContent('7');
  });

  it('change_WhenPartyTypeFilterChanged_ShouldNarrowList', async () => {
    // Arrange
    vi.mocked(listParties).mockResolvedValue({ items: [makeParty()], totalCount: 1, page: 1, pageSize: 25 });
    renderPage(['parties.view']);
    await screen.findByTestId('parties-table');

    // Act
    fireEvent.change(screen.getByTestId('party-type-filter'), { target: { value: '10' } });

    // Assert
    await waitFor(() =>
      expect(listParties).toHaveBeenLastCalledWith(expect.objectContaining({ partyTypeId: 10 })),
    );
  });

  it('render_WhenPaged_ShouldShowPaginationSummary', async () => {
    // Arrange
    const items = Array.from({ length: 25 }, (_, i) => makeParty({ id: i + 1, name: `Party ${i + 1}` }));
    vi.mocked(listParties).mockResolvedValue({ items, totalCount: 42, page: 1, pageSize: 25 });

    // Act
    renderPage(['parties.view']);

    // Assert
    expect(await screen.findByTestId('pagination-summary')).toHaveTextContent('1-25 of 42');
  });

  it('render_WhenNoParties_ShouldShowEmptyState', async () => {
    // Arrange
    vi.mocked(listParties).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderPage(['parties.view', 'parties.create']);

    // Assert
    await screen.findByTestId('empty-state');
    expect(screen.getByTestId('empty-state-clear-filters')).toBeInTheDocument();
  });

  it('render_WhenUserLacksExportPermission_ShouldHideExportMenu', async () => {
    // Arrange (spec FR-65, T-039: the export affordance is gated on parties.export)
    vi.mocked(listParties).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderPage(['parties.view']);

    // Assert
    await screen.findByTestId('empty-state');
    expect(screen.queryByTestId('parties-export-menu')).not.toBeInTheDocument();
  });

  it('render_WhenUserHasExportPermission_ShouldShowExportMenu', async () => {
    // Arrange
    vi.mocked(listParties).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderPage(['parties.view', 'parties.export']);

    // Assert
    expect(await screen.findByTestId('parties-export-menu')).toBeInTheDocument();
  });

  it('render_WhenUserLacksCreatePermission_ShouldHideNewPartyButton', async () => {
    // Arrange
    vi.mocked(listParties).mockResolvedValue({ items: [makeParty()], totalCount: 1, page: 1, pageSize: 25 });

    // Act
    renderPage(['parties.view']);

    // Assert
    await screen.findByTestId('parties-table');
    expect(screen.queryByRole('button', { name: '+ New Party' })).not.toBeInTheDocument();
  });

  it('render_WhenLoadFails_ShouldShowErrorBannerWithRetry', async () => {
    // Arrange
    vi.mocked(listParties).mockRejectedValue({ status: 500, title: 'Server error', fieldErrors: [] });

    // Act
    renderPage(['parties.view']);

    // Assert
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });
});
