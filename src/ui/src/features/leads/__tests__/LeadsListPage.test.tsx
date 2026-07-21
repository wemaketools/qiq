import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import LeadsListPage from '../LeadsListPage';
import { bulkReassignLeads, buildLeadsSortParam, DEFAULT_LEADS_SORT, getEligibleLeadOwners, listLeads } from '../leadsApi';
import type { LeadListDto, LeadListItemDto } from '../leadsApi';
import { listBrokers, listReferenceItems } from '../../settings/settingsApi';

vi.mock('../leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../leadsApi')>('../leadsApi');
  return {
    ...actual,
    listLeads: vi.fn(),
    bulkReassignLeads: vi.fn(),
    getEligibleLeadOwners: vi.fn(),
    LEADS_PAGE_SIZE: 25,
  };
});

vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn(),
  listBrokers: vi.fn(),
  fetchBusinessAssignments: vi.fn(),
  // Resolves the same values as the A-12 defaults so threshold-coloring tests stay deterministic.
  fetchFullBusinessRules: vi.fn().mockResolvedValue({ agingAmberDays: 8, agingRedDays: 15 }),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
  useOptionalToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function makeLead(overrides: Partial<LeadListItemDto> = {}): LeadListItemDto {
  return {
    id: 1,
    leadRef: 'LEAD-0001',
    partyId: 10,
    partyName: 'Acme Co',
    brokerId: null,
    brokerName: null,
    productLineName: 'Motor',
    coverTypeName: 'Comprehensive',
    premium: 50000,
    statusName: 'New',
    priority: 'Normal',
    dateReceived: '2026-07-01',
    ageDays: 3,
    owner: { userId: 100, firstName: 'Sam', lastName: 'RM' },
    nextFollowUpDate: null,
    flags: [],
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderPage(permissions: string[], initialPath = '/leads') {
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
          <Route
            path="*"
            element={
              <>
                <LeadsListPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('LeadsListPage', () => {
  beforeEach(() => {
    vi.mocked(listLeads).mockReset();
    vi.mocked(bulkReassignLeads).mockReset();
    vi.mocked(getEligibleLeadOwners).mockReset();
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(listBrokers).mockReset();

    vi.mocked(listReferenceItems).mockResolvedValue([]);
    vi.mocked(listBrokers).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 200 });
    vi.mocked(getEligibleLeadOwners).mockResolvedValue([{ userId: 100, firstName: 'Sam', lastName: 'RM', email: 's@x.test' }]);
  });

  it('render_WhenLeadsLoad_ShouldShowTableWithFlagsAndAgeColumns', async () => {
    // Arrange
    const dto: LeadListDto = { items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 };
    vi.mocked(listLeads).mockResolvedValue(dto);

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert
    await waitFor(() => expect(screen.getByTestId('leads-table')).toBeInTheDocument());
    expect(screen.getByTestId('lead-ref-link')).toHaveTextContent('LEAD-0001');
    expect(screen.getByTestId('flag-chips')).toBeInTheDocument();
    expect(screen.getByTestId('lead-age')).toHaveTextContent('3d');
  });

  it('render_WhenAgeAtOrAboveRedThreshold_ShouldColorAgeRed', async () => {
    // Arrange
    const dto: LeadListDto = { items: [makeLead({ ageDays: 20 })], totalCount: 1, page: 1, pageSize: 25 };
    vi.mocked(listLeads).mockResolvedValue(dto);

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert
    const ageCell = await screen.findByTestId('lead-age');
    expect(ageCell).toHaveStyle({ color: 'var(--qiq-danger)' });
  });

  it('render_WhenAgeAtOrAboveAmberThreshold_ShouldColorAgeAmber', async () => {
    // Arrange
    const dto: LeadListDto = { items: [makeLead({ ageDays: 10 })], totalCount: 1, page: 1, pageSize: 25 };
    vi.mocked(listLeads).mockResolvedValue(dto);

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert
    const ageCell = await screen.findByTestId('lead-age');
    expect(ageCell).toHaveStyle({ color: 'var(--qiq-warning)' });
  });

  it('render_WhenNextFollowUpInPast_ShouldShowOverdueChip', async () => {
    // Arrange
    const dto: LeadListDto = { items: [makeLead({ nextFollowUpDate: '2000-01-01' })], totalCount: 1, page: 1, pageSize: 25 };
    vi.mocked(listLeads).mockResolvedValue(dto);

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert
    expect(await screen.findByTestId('overdue-chip')).toBeInTheDocument();
  });

  it('render_WhenUserLacksViewAll_ShouldForceMyLeadsToggleOnAndDisabled', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view']);

    // Assert
    const toggle = await screen.findByTestId('my-leads-toggle');
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    await waitFor(() =>
      expect(listLeads).toHaveBeenCalledWith(expect.objectContaining({ myLeads: true })),
    );
  });

  it('render_WhenUserLacksReassignPermission_ShouldHideCheckboxColumn', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert
    await screen.findByTestId('leads-table');
    expect(screen.queryByLabelText(/Select all leads/i)).not.toBeInTheDocument();
  });

  it('render_WhenUserHasReassignPermission_ShouldShowCheckboxesAndBulkReassignButtonOnSelection', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view', 'leads.view_all', 'leads.reassign']);
    await screen.findByTestId('leads-table');
    fireEvent.click(screen.getByLabelText('Select lead LEAD-0001'));

    // Assert
    expect(screen.getByTestId('bulk-reassign-button')).toBeInTheDocument();
  });

  it('click_WhenBulkReassignSubmittedWithoutNote_ShouldShowInlineError', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });
    renderPage(['leads.view', 'leads.view_all', 'leads.reassign']);
    await screen.findByTestId('leads-table');
    fireEvent.click(screen.getByLabelText('Select lead LEAD-0001'));
    fireEvent.click(screen.getByTestId('bulk-reassign-button'));
    const dialog = screen.getByTestId('bulk-reassign-dialog');

    // Act
    fireEvent.click(within(dialog).getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('reassign-note-error')).toBeInTheDocument();
    expect(bulkReassignLeads).not.toHaveBeenCalled();
  });

  it('click_WhenBulkReassignSubmittedWithNoteAndOwner_ShouldCallApiAndClearSelection', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });
    vi.mocked(bulkReassignLeads).mockResolvedValue({ reassignedCount: 1 });
    renderPage(['leads.view', 'leads.view_all', 'leads.reassign']);
    await screen.findByTestId('leads-table');
    fireEvent.click(screen.getByLabelText('Select lead LEAD-0001'));
    fireEvent.click(screen.getByTestId('bulk-reassign-button'));
    const dialog = screen.getByTestId('bulk-reassign-dialog');
    fireEvent.change(within(dialog).getByTestId('reassign-owner-select'), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByTestId('reassign-note-textarea'), { target: { value: 'Reassigning for coverage' } });

    // Act
    fireEvent.click(within(dialog).getByTestId('dialog-primary-button'));

    // Assert
    await waitFor(() =>
      expect(bulkReassignLeads).toHaveBeenCalledWith({ leadIds: [1], newOwnerUserId: 100, note: 'Reassigning for coverage' }),
    );
  });

  it('render_WhenNoLeads_ShouldShowEmptyStateWithClearFiltersAndNewLeadActions', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view', 'leads.view_all', 'leads.create']);

    // Assert
    await screen.findByTestId('empty-state');
    expect(screen.getByTestId('empty-state-clear-filters')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '+ New Lead' }).length).toBeGreaterThan(0);
  });

  it('render_WhenPaged_ShouldShowRangeSummary', async () => {
    // Arrange
    const items = Array.from({ length: 25 }, (_, i) => makeLead({ id: i + 1, leadRef: `LEAD-${1000 + i}` }));
    vi.mocked(listLeads).mockResolvedValue({ items, totalCount: 42, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert
    expect(await screen.findByTestId('leads-page-summary')).toHaveTextContent('1-25 of 42');
  });

  it('render_WhenLoadFails_ShouldShowErrorBannerWithRetry', async () => {
    // Arrange
    vi.mocked(listLeads).mockRejectedValue({ status: 500, title: 'Server error', fieldErrors: [] });

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });

  it('render_Always_ShouldDefaultSortStateToLowestAgeFirst', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view', 'leads.view_all']);

    // Assert: lowest age first is newest-received first (PRD 12.4) — the backend's own default order.
    await waitFor(() =>
      expect(listLeads).toHaveBeenCalledWith(expect.objectContaining({ sort: '-date_received' })),
    );
    expect(buildLeadsSortParam(DEFAULT_LEADS_SORT)).toBe('-date_received');
    // The default sort is implied, so it stays out of the URL.
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('sort=');
  });

  it('click_WhenLeadIdHeaderClicked_ShouldSortAscendingByLeadRefAndSyncUrl', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });
    renderPage(['leads.view', 'leads.view_all']);
    await screen.findByTestId('leads-table');

    // Act
    fireEvent.click(screen.getByTestId('sort-header-leadRef'));

    // Assert
    await waitFor(() => expect(listLeads).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'lead_ref' })));
    expect(screen.getByTestId('sort-indicator-leadRef')).toHaveAttribute('data-direction', 'asc');
    expect(screen.getByTestId('location-search')).toHaveTextContent('sort=leadRef');
    expect(screen.getByTestId('location-search')).toHaveTextContent('dir=asc');
  });

  it('click_WhenLeadIdHeaderClickedTwice_ShouldToggleToDescending', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });
    renderPage(['leads.view', 'leads.view_all']);
    await screen.findByTestId('leads-table');
    fireEvent.click(screen.getByTestId('sort-header-leadRef'));
    await waitFor(() => expect(listLeads).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'lead_ref' })));

    // Act
    fireEvent.click(screen.getByTestId('sort-header-leadRef'));

    // Assert
    await waitFor(() => expect(listLeads).toHaveBeenLastCalledWith(expect.objectContaining({ sort: '-lead_ref' })));
    expect(screen.getByTestId('sort-indicator-leadRef')).toHaveAttribute('data-direction', 'desc');
    expect(screen.getByTestId('location-search')).toHaveTextContent('dir=desc');
  });

  it('render_WhenSortParamsInUrl_ShouldInitializeSortStateFromUrl', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [makeLead()], totalCount: 1, page: 1, pageSize: 25 });

    // Act: descending Age (oldest lead first) is ascending date_received on the wire.
    renderPage(['leads.view', 'leads.view_all'], '/leads?sort=age&dir=desc');

    // Assert
    await waitFor(() => expect(listLeads).toHaveBeenCalledWith(expect.objectContaining({ sort: 'date_received' })));
    expect(await screen.findByTestId('sort-indicator-age')).toHaveAttribute('data-direction', 'desc');
  });

  it('render_WhenUserLacksExportPermission_ShouldHideExportMenu', async () => {
    // Arrange (spec FR-65, T-039: the export affordance is gated on leads.export)
    vi.mocked(listLeads).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view']);

    // Assert
    await screen.findByTestId('page-leads');
    expect(screen.queryByTestId('leads-export-menu')).not.toBeInTheDocument();
  });

  it('render_WhenUserHasExportPermission_ShouldShowExportMenu', async () => {
    // Arrange
    vi.mocked(listLeads).mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 25 });

    // Act
    renderPage(['leads.view', 'leads.export']);

    // Assert
    expect(await screen.findByTestId('leads-export-menu')).toBeInTheDocument();
  });
});
