import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import QuotesCard from '../QuotesCard';
import { getQuote, listQuotesForLead, setCurrentQuote, type QuoteDetailDto, type QuoteListItemDto } from '../quotesApi';
import type { LeadDetailDto } from '../../leads/leadsApi';

vi.mock('../quotesApi', async () => {
  const actual = await vi.importActual<typeof import('../quotesApi')>('../quotesApi');
  return {
    ...actual,
    listQuotesForLead: vi.fn(),
    getQuote: vi.fn(),
    createQuote: vi.fn(),
    setCurrentQuote: vi.fn(),
  };
});

const toastShowSuccess = vi.fn();
vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: toastShowSuccess, showError: vi.fn() }),
}));

function makeLead(overrides: Partial<LeadDetailDto> = {}): LeadDetailDto {
  return {
    id: 1,
    leadRef: 'L-2026-0001',
    externalRef: null,
    partyId: 10,
    partyName: 'Acme Mining Co.',
    requestChannelId: 1,
    brokerId: null,
    brokerName: null,
    regionId: 9,
    productLineId: 1,
    productLineName: 'Motor',
    coverTypeId: 10,
    coverTypeName: 'Comprehensive',
    sumInsured: null,
    estimatedPremium: null,
    policyTerm: 'annual',
    policyTermOther: null,
    priority: 'normal',
    isExistingClient: false,
    statusId: 5,
    statusName: 'Pricing',
    statusCanonicalKey: 'pricing',
    dateReceived: '2026-01-01',
    source: 'browser',
    owner: null,
    notes: [],
    availableOperations: [],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

function makeQuoteListItem(overrides: Partial<QuoteListItemDto> = {}): QuoteListItemDto {
  return {
    id: 5,
    quoteRef: 'Q-2026-0005',
    statusName: 'Draft',
    statusCanonicalKey: 'draft',
    isCurrent: true,
    productLineName: 'Motor',
    currentQuotedPremium: 500000,
    preparedDate: '2026-06-01',
    sentDate: null,
    validUntil: null,
    ...overrides,
  };
}

function makeQuoteDetail(overrides: Partial<QuoteDetailDto> = {}): QuoteDetailDto {
  return {
    id: 5,
    quoteRef: 'Q-2026-0005',
    leadId: 1,
    statusId: 1,
    statusName: 'Draft',
    statusCanonicalKey: 'draft',
    isCurrent: true,
    productLineId: 1,
    productLineName: 'Motor',
    coverTypeId: 10,
    coverTypeName: 'Comprehensive',
    preparedDate: '2026-06-01',
    sentDate: null,
    validUntil: null,
    decisionDate: null,
    boundPremium: null,
    lostReasonId: null,
    competitor: null,
    competitorPremium: null,
    lossComments: null,
    withdrawalNote: null,
    notes: null,
    versions: [{ id: 1, versionNo: 1, quotedPremium: 500000, termsNotes: null, revisionNote: null, isCurrent: true, createdAt: '2026-06-01T00:00:00Z' }],
    history: [],
    availableOperations: ['send', 'assign', 'withdraw'],
    ...overrides,
  };
}

function renderCard(overrides: Partial<Parameters<typeof QuotesCard>[0]> = {}, permissions: string[] = ['quotes.create', 'quotes.set_current']) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'rm@brittany.test', firstName: 'Sam', lastName: 'RM' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  return render(
    <Provider store={store}>
      <QuotesCard
        lead={makeLead()}
        currencySymbol="BWP"
        quoteExpiryAlertDays={7}
        maxAttachmentMb={10}
        roles={null}
        lostReasons={[]}
        quoteStatuses={[]}
        productLineOptions={[]}
        coverTypeOptions={[]}
        isLeadClosed={false}
        onQuoteMutated={vi.fn()}
        {...overrides}
      />
    </Provider>,
  );
}

describe('QuotesCard', () => {
  beforeEach(() => {
    vi.mocked(listQuotesForLead).mockReset();
    vi.mocked(getQuote).mockReset();
    vi.mocked(setCurrentQuote).mockReset();
    toastShowSuccess.mockReset();
  });

  it('render_WhenNoQuotes_ShouldShowEmptyState', async () => {
    // Arrange
    vi.mocked(listQuotesForLead).mockResolvedValue([]);

    // Act
    renderCard();

    // Assert
    expect(await screen.findByTestId('quotes-empty-state')).toHaveTextContent('No quotes yet — create one when formal terms are ready.');
  });

  it('render_WhenLeadClosed_ShouldHideNewQuoteButton', async () => {
    // Arrange
    vi.mocked(listQuotesForLead).mockResolvedValue([]);

    // Act
    renderCard({ isLeadClosed: true });
    await screen.findByTestId('quotes-empty-state');

    // Assert
    expect(screen.queryByTestId('new-quote-button')).not.toBeInTheDocument();
  });

  it('render_WhenLeadOpen_ShouldShowNewQuoteButton', async () => {
    // Arrange
    vi.mocked(listQuotesForLead).mockResolvedValue([]);

    // Act
    renderCard({ isLeadClosed: false });

    // Assert
    expect(await screen.findByTestId('new-quote-button')).toBeInTheDocument();
  });

  it('render_WhenQuotesExist_ShouldRenderRowWithMonospaceRefAndCurrentMarker', async () => {
    // Arrange
    vi.mocked(listQuotesForLead).mockResolvedValue([makeQuoteListItem()]);

    // Act
    renderCard();

    // Assert
    const row = await screen.findByTestId('quote-row');
    expect(row).toHaveTextContent('Q-2026-0005');
    expect(screen.getByTestId('quote-current-marker')).toBeInTheDocument();
  });

  it('click_WhenRowClicked_ShouldExpandAndFetchQuoteDetail', async () => {
    // Arrange
    vi.mocked(listQuotesForLead).mockResolvedValue([makeQuoteListItem()]);
    vi.mocked(getQuote).mockResolvedValue(makeQuoteDetail());

    // Act
    renderCard();
    fireEvent.click(await screen.findByTestId('quote-row'));

    // Assert
    expect(await screen.findByTestId('quote-detail-panel')).toBeInTheDocument();
    expect(getQuote).toHaveBeenCalledWith(5);
  });

  it('click_WhenSetCurrentClickedOnNonCurrentQuote_ShouldCallSetCurrentQuoteAndReload', async () => {
    // Arrange
    const nonCurrent = makeQuoteListItem({ id: 6, quoteRef: 'Q-2026-0006', isCurrent: false });
    vi.mocked(listQuotesForLead).mockResolvedValue([nonCurrent]);
    vi.mocked(setCurrentQuote).mockResolvedValue(makeQuoteDetail({ id: 6, quoteRef: 'Q-2026-0006', isCurrent: true }));

    // Act
    renderCard();
    fireEvent.click(await screen.findByTestId('set-current-button'));

    // Assert
    await waitFor(() => expect(setCurrentQuote).toHaveBeenCalledWith(6));
    expect(toastShowSuccess).toHaveBeenCalledWith(expect.stringContaining('current quote'));
  });
});
