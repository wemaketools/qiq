import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import PartyDetailPage from '../PartyDetailPage';
import { getParty, getPartyLeads } from '../partiesApi';
import type { PartyDto } from '../partiesApi';
import { listReferenceItems } from '../../settings/settingsApi';
import type { LeadListItemDto } from '../../leads/leadsApi';

vi.mock('../partiesApi', async () => {
  const actual = await vi.importActual<typeof import('../partiesApi')>('../partiesApi');
  return {
    ...actual,
    getParty: vi.fn(),
    getPartyLeads: vi.fn(),
  };
});

vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn(),
}));

function makeParty(overrides: Partial<PartyDto> = {}): PartyDto {
  return {
    id: 7,
    name: 'Botswana Mining Co.',
    partyTypeId: 10,
    segmentId: 20,
    industryId: 30,
    regionId: 40,
    isStrategic: true,
    contactName: 'Jane Doe',
    contactEmail: 'jane@bmc.test',
    contactPhone: '+267 123 4567',
    lastActivityAt: '2026-07-01T10:00:00Z',
    openLeadsCount: 2,
    totalLeadsCount: 3,
    ...overrides,
  };
}

function makeLead(overrides: Partial<LeadListItemDto> = {}): LeadListItemDto {
  return {
    id: 1,
    leadRef: 'LEAD-0001',
    partyId: 7,
    partyName: 'Botswana Mining Co.',
    brokerId: null,
    brokerName: null,
    productLineName: 'Motor',
    coverTypeName: 'Comprehensive',
    premium: 50000,
    statusName: 'New',
    priority: 'Normal',
    dateReceived: '2026-07-01',
    ageDays: 3,
    owner: null,
    nextFollowUpDate: null,
    flags: [],
    ...overrides,
  };
}

function renderPage(permissions: string[], partyId = '7') {
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
      <MemoryRouter initialEntries={[`/parties/${partyId}`]}>
        <Routes>
          <Route path="/parties/:partyId" element={<PartyDetailPage />} />
          <Route path="/parties/:partyId/edit" element={<div data-testid="party-edit-route" />} />
          <Route path="/leads/new" element={<div data-testid="lead-intake-route" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('PartyDetailPage', () => {
  beforeEach(() => {
    vi.mocked(getParty).mockReset();
    vi.mocked(getPartyLeads).mockReset();
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(listReferenceItems).mockResolvedValue([]);
  });

  it('render_WhenPartyLoads_ShouldShowSummaryAndLeadsCard', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(getPartyLeads).mockResolvedValue([makeLead(), makeLead({ id: 2, leadRef: 'LEAD-0002' })]);

    // Act
    renderPage(['parties.view']);

    // Assert
    expect(await screen.findByTestId('party-name-heading')).toHaveTextContent('Botswana Mining Co.');
    expect(screen.getByTestId('party-summary')).toBeInTheDocument();
    expect(screen.getByTestId('party-summary')).toHaveTextContent('Jane Doe');
    await waitFor(() => expect(screen.getByTestId('party-leads-card')).toBeInTheDocument());
    expect(await screen.findByTestId('leads-table')).toBeInTheDocument();
    expect(screen.getAllByTestId('lead-row')).toHaveLength(2);
  });

  it('render_WhenLeadsCardShown_ShouldOmitPartyColumn', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(getPartyLeads).mockResolvedValue([makeLead()]);

    // Act
    renderPage(['parties.view']);

    // Assert
    await screen.findByTestId('leads-table');
    expect(screen.queryByText('Party')).not.toBeInTheDocument();
  });

  it('click_WhenNewLeadClicked_ShouldNavigateToLeadIntakeWithPartyIdQueryParam', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(getPartyLeads).mockResolvedValue([]);
    renderPage(['parties.view', 'leads.create']);
    await screen.findByTestId('party-new-lead-button');

    // Act
    fireEvent.click(screen.getByTestId('party-new-lead-button'));

    // Assert
    expect(await screen.findByTestId('lead-intake-route')).toBeInTheDocument();
  });

  it('render_WhenUserLacksLeadsCreatePermission_ShouldHideNewLeadButton', async () => {
    // Arrange: the intake route is guarded by leads.create, so a viewer without it must not be
    // offered a button that dead-ends on the forbidden page.
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(getPartyLeads).mockResolvedValue([]);

    // Act
    renderPage(['parties.view']);

    // Assert
    await screen.findByTestId('party-name-heading');
    expect(screen.queryByTestId('party-new-lead-button')).not.toBeInTheDocument();
  });

  it('render_WhenUserLacksUpdatePermission_ShouldHideEditButton', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(getPartyLeads).mockResolvedValue([]);

    // Act
    renderPage(['parties.view']);

    // Assert
    await screen.findByTestId('party-name-heading');
    expect(screen.queryByRole('button', { name: 'Edit party' })).not.toBeInTheDocument();
  });

  it('render_WhenUserHasUpdatePermission_ShouldNavigateToEditOnClick', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(getPartyLeads).mockResolvedValue([]);
    renderPage(['parties.view', 'parties.update']);
    await screen.findByRole('button', { name: 'Edit party' });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Edit party' }));

    // Assert
    expect(await screen.findByTestId('party-edit-route')).toBeInTheDocument();
  });

  it('render_WhenPartyHasNoLeads_ShouldShowEmptyStateInLeadsCard', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(getPartyLeads).mockResolvedValue([]);

    // Act
    renderPage(['parties.view']);

    // Assert
    expect(await screen.findByText('This party has no leads yet.')).toBeInTheDocument();
  });

  it('render_WhenLoadFails_ShouldShowErrorBannerWithRetry', async () => {
    // Arrange
    vi.mocked(getParty).mockRejectedValue({ status: 500, title: 'Server error', fieldErrors: [] });
    vi.mocked(getPartyLeads).mockResolvedValue([]);

    // Act
    renderPage(['parties.view']);

    // Assert
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeInTheDocument());
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });
});
