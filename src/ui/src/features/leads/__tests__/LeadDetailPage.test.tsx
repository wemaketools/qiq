import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import LeadDetailPage from '../LeadDetailPage';
import {
  assignLead,
  getEligibleAssignees,
  getLead,
  getLeadTimeline,
  markLeadLost,
  type LeadDetailDto,
  type LeadTimelineDto,
} from '../leadsApi';
import { getParty } from '../../parties/partiesApi';
import type { PartyDto } from '../../parties/partiesApi';
import { fetchBusinessAssignments, listReferenceItems } from '../../settings/settingsApi';
import type { BusinessAssignmentsDto, ReferenceItemDto } from '../../settings/settingsApi';
import { listQuotesForLead } from '../../quotes/quotesApi';
import type { QuoteListItemDto } from '../../quotes/quotesApi';

vi.mock('../../quotes/quotesApi', async () => {
  const actual = await vi.importActual<typeof import('../../quotes/quotesApi')>('../../quotes/quotesApi');
  return { ...actual, listQuotesForLead: vi.fn(() => Promise.resolve([])) };
});

vi.mock('../leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../leadsApi')>('../leadsApi');
  return {
    ...actual,
    getLead: vi.fn(),
    getLeadTimeline: vi.fn(),
    assignLead: vi.fn(),
    markLeadLost: vi.fn(),
    getEligibleAssignees: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../../parties/partiesApi', async () => {
  const actual = await vi.importActual<typeof import('../../parties/partiesApi')>('../../parties/partiesApi');
  return { ...actual, getParty: vi.fn() };
});

vi.mock('../../settings/settingsApi', async () => {
  const actual = await vi.importActual<typeof import('../../settings/settingsApi')>('../../settings/settingsApi');
  return { ...actual, listReferenceItems: vi.fn(() => Promise.resolve([])), fetchBusinessAssignments: vi.fn() };
});

const toastShowSuccess = vi.fn();
vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: toastShowSuccess, showError: vi.fn() }),
}));

function makeLead(overrides: Partial<LeadDetailDto> = {}): LeadDetailDto {
  return {
    id: 55,
    leadRef: 'L-2026-0055',
    externalRef: null,
    partyId: 10,
    partyName: 'Acme Mining Co.',
    requestChannelId: 1,
    brokerId: null,
    brokerName: null,
    regionId: 9,
    productLineId: 5,
    productLineName: 'Motor',
    coverTypeId: 50,
    coverTypeName: 'Comprehensive',
    sumInsured: null,
    estimatedPremium: 50000,
    policyTerm: 'm12',
    policyTermOther: null,
    priority: 'normal',
    isExistingClient: false,
    statusId: 900,
    statusName: 'New',
    statusCanonicalKey: 'new',
    dateReceived: '2026-07-01',
    source: 'browser',
    owner: null,
    notes: [],
    availableOperations: ['assign'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

function makeParty(overrides: Partial<PartyDto> = {}): PartyDto {
  return {
    id: 10,
    name: 'Acme Mining Co.',
    partyTypeId: 100,
    segmentId: null,
    industryId: null,
    regionId: 9,
    isStrategic: false,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    lastActivityAt: null,
    openLeadsCount: 0,
    totalLeadsCount: 0,
    ...overrides,
  };
}

const EMPTY_TIMELINE: LeadTimelineDto = { items: [], totalCount: 0, page: 1, pageSize: 50 };

const LEAD_ROLES: BusinessAssignmentsDto = {
  rmRole: { assignmentId: 1, roleId: 1, roleName: 'Relationship Manager' },
  underwritingRole: null,
};

function renderPage(leadId = '55', permissions: string[] = ['leads.view', 'leads.update']) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'rm@brittany.test', firstName: 'Sam', lastName: 'RM' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  const router = createMemoryRouter(
    [
      { path: '/leads/:leadId', element: <LeadDetailPage /> },
      { path: '/leads/:leadId/edit', element: <div data-testid="lead-edit-route" /> },
      { path: '/parties/:partyId', element: <div data-testid="party-detail-route" /> },
    ],
    { initialEntries: [`/leads/${leadId}`] },
  );

  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
}

describe('LeadDetailPage', () => {
  beforeEach(() => {
    vi.mocked(getLead).mockReset();
    vi.mocked(getLeadTimeline).mockReset();
    vi.mocked(assignLead).mockReset();
    vi.mocked(markLeadLost).mockReset();
    vi.mocked(getEligibleAssignees).mockReset();
    vi.mocked(getEligibleAssignees).mockResolvedValue([]);
    vi.mocked(getParty).mockReset();
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(fetchBusinessAssignments).mockReset();
    vi.mocked(listQuotesForLead).mockReset();
    toastShowSuccess.mockReset();

    vi.mocked(getLeadTimeline).mockResolvedValue(EMPTY_TIMELINE);
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(listReferenceItems).mockResolvedValue([] as ReferenceItemDto[]);
    vi.mocked(fetchBusinessAssignments).mockResolvedValue(LEAD_ROLES);
    vi.mocked(listQuotesForLead).mockResolvedValue([]);
  });

  it('render_WhenNewLead_ShouldShowAssignAsPrimaryAction', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(makeLead({ statusCanonicalKey: 'new', availableOperations: ['assign'] }));

    // Act
    renderPage();

    // Assert
    expect(await screen.findByTestId('primary-workflow-action')).toHaveTextContent('Assign');
  });

  it('render_WhenIllegalOperationsNotInAvailableOperations_ShouldNotAppearInMenu', async () => {
    // Arrange (AC-016: only server-computed availableOperations render — Reopen/Approve pricing absent)
    vi.mocked(getLead).mockResolvedValue(makeLead({ statusCanonicalKey: 'new', availableOperations: ['assign'] }));
    renderPage();
    await screen.findByTestId('lead-header');

    // Act & Assert
    expect(screen.queryByTestId('more-actions-menu')).not.toBeInTheDocument();
  });

  it('click_WhenAssignConfirmed_ShouldUpdateStatusChipInPlaceAndShowToast', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(makeLead({ statusCanonicalKey: 'new', availableOperations: ['assign'] }));
    vi.mocked(assignLead).mockResolvedValue(
      makeLead({
        statusName: 'Assigned',
        statusCanonicalKey: 'assigned',
        owner: { userId: 1, firstName: 'Sam', lastName: 'RM' },
        availableOperations: ['send-to-underwriting', 'mark-lost', 'withdraw'],
      }),
    );
    vi.mocked(getEligibleAssignees).mockResolvedValue([{ userId: 1, firstName: 'Sam', lastName: 'RM', email: 'rm@brittany.test' }]);
    renderPage();
    fireEvent.click(await screen.findByTestId('primary-workflow-action'));
    const dialog = await screen.findByTestId('assign-dialog');
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('role-select-accountable-select')).toBeEnabled());
    fireEvent.change(screen.getByTestId('role-select-accountable-select'), { target: { value: '1' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    await waitFor(() => expect(screen.queryByTestId('assign-dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('status-chip')).toHaveTextContent('Assigned');
    expect(toastShowSuccess).toHaveBeenCalledWith(expect.stringContaining('assigned'));
  });

  it('render_WhenLeadHasMultipleAvailableOperations_ShouldListNonPrimaryOnesInMoreActionsMenu', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(
      makeLead({ statusName: 'Assigned', statusCanonicalKey: 'assigned', owner: { userId: 1, firstName: 'Sam', lastName: 'RM' }, availableOperations: ['send-to-underwriting', 'mark-lost', 'withdraw'] }),
    );
    renderPage();
    await screen.findByTestId('lead-header');

    // Act
    fireEvent.click(screen.getByTestId('more-actions-trigger'));

    // Assert
    expect(screen.getByTestId('more-action-mark-lost')).toBeInTheDocument();
    expect(screen.getByTestId('more-action-withdraw')).toBeInTheDocument();
  });

  it('render_WhenLeadClosed_ShouldShowOutcomePanelAndNoPrimaryAction', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(
      makeLead({ statusName: 'Closed Won', statusCanonicalKey: 'closed_won', availableOperations: [] }),
    );

    // Act
    renderPage();

    // Assert
    expect(await screen.findByTestId('outcome-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('primary-workflow-action')).not.toBeInTheDocument();
    expect(screen.queryByTestId('more-actions-menu')).not.toBeInTheDocument();
  });

  it('render_WhenLeadOpen_ShouldNotShowOutcomePanel', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(makeLead({}));

    // Act
    renderPage();
    await screen.findByTestId('lead-header');

    // Assert
    expect(screen.queryByTestId('outcome-panel')).not.toBeInTheDocument();
  });

  it('click_WhenMarkLostConfirmedWithoutReason_ShouldKeepDialogOpenWithInlineError', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(
      makeLead({ statusName: 'Quote Sent', statusCanonicalKey: 'quote_sent', availableOperations: ['mark-lost', 'log-follow-up'] }),
    );
    vi.mocked(listReferenceItems).mockImplementation((listType) =>
      listType === 'lost_reason'
        ? Promise.resolve([
            { id: 1, listType: 'lost_reason', name: 'Competitor won', displayOrder: 1, isActive: true, isBrokerChannel: null, productLineId: null, reportingCategory: null, canonicalKey: 'competitor_won', isTerminal: false },
          ])
        : Promise.resolve([]),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('more-actions-trigger'));
    fireEvent.click(screen.getByTestId('more-action-mark-lost'));

    // Act
    fireEvent.click(await screen.findByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('mark-lost-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('field-error-lost-reason')).toBeInTheDocument();
  });

  it('render_WhenDraftQuoteExists_ShouldShowSendQuoteAsPrimaryActionAndMoveLeadOpToMoreActions', async () => {
    // Arrange (T-029: completes T-028's PrimaryActionResolver -- "draft-quote-exists -> Send quote")
    vi.mocked(getLead).mockResolvedValue(
      makeLead({ statusName: 'Pricing', statusCanonicalKey: 'pricing', availableOperations: ['send-to-underwriting', 'mark-lost'] }),
    );
    const draftQuote: QuoteListItemDto = {
      id: 5,
      quoteRef: 'Q-2026-0005',
      statusName: 'Draft',
      statusCanonicalKey: 'draft',
      isCurrent: true,
      productLineName: 'Motor',
      currentQuotedPremium: 500000,
      preparedDate: '2026-07-01',
      sentDate: null,
      validUntil: null,
    };
    vi.mocked(listQuotesForLead).mockResolvedValue([draftQuote]);

    // Act
    renderPage();

    // Assert: header primary action is "Send quote", not a lead-level op.
    expect(await screen.findByTestId('primary-workflow-action')).toHaveTextContent('Send quote');

    // The lead-level op that would otherwise have been primary now appears in More actions instead.
    fireEvent.click(screen.getByTestId('more-actions-trigger'));
    expect(screen.getByTestId('more-action-send-to-underwriting')).toBeInTheDocument();
  });

  it('render_WhenNoDraftQuoteExists_ShouldShowLeadLevelPrimaryAction', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(
      makeLead({ statusName: 'Assigned', statusCanonicalKey: 'assigned', owner: { userId: 1, firstName: 'Sam', lastName: 'RM' }, availableOperations: ['send-to-underwriting'] }),
    );
    vi.mocked(listQuotesForLead).mockResolvedValue([]);

    // Act
    renderPage();

    // Assert
    expect(await screen.findByTestId('primary-workflow-action')).toHaveTextContent('Send to underwriting');
  });
});
