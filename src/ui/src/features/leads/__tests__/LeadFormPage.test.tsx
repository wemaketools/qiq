import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import LeadFormPage from '../LeadFormPage';
import {
  createLead,
  getEligibleLeadOwners,
  getIntakeTenantRules,
  getLead,
  updateLead,
  type CreateLeadOutcomeDto,
  type LeadDetailDto,
} from '../leadsApi';
import { getParty, listParties } from '../../parties/partiesApi';
import type { PartyDto, PartyListDto } from '../../parties/partiesApi';
import { listBrokers, listReferenceItems } from '../../settings/settingsApi';
import type { ReferenceItemDto } from '../../settings/settingsApi';

vi.mock('../leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../leadsApi')>('../leadsApi');
  return {
    ...actual,
    createLead: vi.fn(),
    updateLead: vi.fn(),
    getLead: vi.fn(),
    getEligibleLeadOwners: vi.fn(),
    getIntakeTenantRules: vi.fn(),
  };
});

vi.mock('../../parties/partiesApi', async () => {
  const actual = await vi.importActual<typeof import('../../parties/partiesApi')>('../../parties/partiesApi');
  return { ...actual, listParties: vi.fn(), getParty: vi.fn() };
});

vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn(),
  listBrokers: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function referenceItem(overrides: Partial<ReferenceItemDto> = {}): ReferenceItemDto {
  return {
    id: 1,
    listType: 'request_channel',
    name: 'Email',
    displayOrder: 1,
    isActive: true,
    isBrokerChannel: null,
    productLineId: null,
    reportingCategory: null,
    canonicalKey: null,
    isTerminal: false,
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

function makeLeadDetail(overrides: Partial<LeadDetailDto> = {}): LeadDetailDto {
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
    owner: { userId: 1, firstName: 'Sam', lastName: 'RM' },
    notes: [],
    availableOperations: [],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

function mockReferenceData(): void {
  vi.mocked(listReferenceItems).mockImplementation((listType) => {
    if (listType === 'request_channel') {
      return Promise.resolve([
        referenceItem({ id: 1, name: 'Email', isBrokerChannel: false }),
        referenceItem({ id: 2, name: 'Broker portal', isBrokerChannel: true }),
      ]);
    }
    if (listType === 'product_line') {
      return Promise.resolve([referenceItem({ id: 5, name: 'Motor' }), referenceItem({ id: 6, name: 'Property' })]);
    }
    if (listType === 'cover_type') {
      return Promise.resolve([
        referenceItem({ id: 50, name: 'Comprehensive', productLineId: 5 }),
        referenceItem({ id: 60, name: 'Fire', productLineId: 6 }),
      ]);
    }
    if (listType === 'region') {
      return Promise.resolve([referenceItem({ id: 9, name: 'Gaborone' })]);
    }
    if (listType === 'party_type') {
      return Promise.resolve([referenceItem({ id: 100, name: 'Corporate' })]);
    }
    return Promise.resolve([]);
  });
  vi.mocked(listBrokers).mockResolvedValue({
    items: [{ id: 200, name: 'Best Brokers', brokerTypeId: null, branch: null, status: 'active' }],
    totalCount: 1,
    page: 1,
    pageSize: 200,
  });
}

function renderForm(initialPath: string, permissions: string[] = ['leads.create', 'leads.update']) {
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
      { path: '/leads/new', element: <LeadFormPage /> },
      { path: '/leads/:leadId/edit', element: <LeadFormPage /> },
      { path: '/leads/:leadId', element: <div data-testid="lead-detail-route" /> },
      { path: '/leads', element: <div data-testid="lead-list-route" /> },
    ],
    { initialEntries: [initialPath] },
  );

  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
}

describe('LeadFormPage', () => {
  beforeEach(() => {
    vi.mocked(createLead).mockReset();
    vi.mocked(updateLead).mockReset();
    vi.mocked(getLead).mockReset();
    vi.mocked(getEligibleLeadOwners).mockReset();
    vi.mocked(getIntakeTenantRules).mockReset();
    vi.mocked(listParties).mockReset();
    vi.mocked(getParty).mockReset();
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(listBrokers).mockReset();

    mockReferenceData();
    vi.mocked(getEligibleLeadOwners).mockResolvedValue([{ userId: 1, firstName: 'Sam', lastName: 'RM', email: 'rm@brittany.test' }]);
    vi.mocked(getIntakeTenantRules).mockResolvedValue({ highValueThreshold: 100000, manualExternalRefEnabled: false });
  });

  it('render_WhenPartyIdQueryParamPresent_ShouldRenderLockedPartySection', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());

    // Act
    renderForm('/leads/new?partyId=10');

    // Assert
    expect(await screen.findByTestId('party-section-locked')).toBeInTheDocument();
    expect(screen.getByTestId('party-summary-collapsed')).toHaveTextContent('Acme Mining Co.');
  });

  it('selectParty_WhenSearchResultClicked_ShouldCollapseToReadOnlySummary', async () => {
    // Arrange
    const listResult: PartyListDto = { items: [makeParty()], totalCount: 1, page: 1, pageSize: 10 };
    vi.mocked(listParties).mockResolvedValue(listResult);
    renderForm('/leads/new');
    const searchInput = await screen.findByTestId('party-select');

    // Act
    fireEvent.change(searchInput, { target: { value: 'Acme' } });
    const resultButton = await screen.findByTestId('party-search-result');
    fireEvent.click(resultButton);

    // Assert
    expect(await screen.findByTestId('party-summary-collapsed')).toHaveTextContent('Acme Mining Co.');
    expect(screen.queryByTestId('party-select')).not.toBeInTheDocument();
  });

  it('changeChannel_WhenBrokerChannelSelected_ShouldShowBrokerSelectAsRequired', async () => {
    // Arrange
    renderForm('/leads/new');
    const channelSelect = await screen.findByLabelText('Request channel');

    // Act
    fireEvent.change(channelSelect, { target: { value: '2' } });

    // Assert
    expect(await screen.findByTestId('broker-select')).toBeInTheDocument();
  });

  it('changeProductLine_WhenChanged_ShouldResetCoverType', async () => {
    // Arrange
    renderForm('/leads/new');
    const productLineSelect = await screen.findByLabelText('Product line');
    const coverTypeSelect = screen.getByLabelText('Cover type') as HTMLSelectElement;

    // Act
    fireEvent.change(productLineSelect, { target: { value: '5' } });
    fireEvent.change(coverTypeSelect, { target: { value: '50' } });
    fireEvent.change(productLineSelect, { target: { value: '6' } });

    // Assert
    expect(coverTypeSelect).toHaveValue('');
  });

  it('selectPolicyTermOther_ShouldRevealRequiredCompanionInput', async () => {
    // Arrange
    renderForm('/leads/new');
    const policyTermSelect = await screen.findByLabelText('Policy term');

    // Act
    fireEvent.change(policyTermSelect, { target: { value: 'other' } });

    // Assert
    expect(await screen.findByLabelText('Describe policy term')).toBeInTheDocument();
  });

  it('submit_WhenRequiredFieldsMissing_ShouldShowThreeOrMoreErrorsSummaryBanner', async () => {
    // Arrange
    renderForm('/leads/new');
    await screen.findByLabelText('Request channel');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Create lead' }));

    // Assert
    expect(await screen.findByTestId('form-error-summary')).toBeInTheDocument();
    expect(createLead).not.toHaveBeenCalled();
  });

  it('submit_WhenFormValid_ShouldCallCreateLeadAndNavigateToLeadDetail', async () => {
    // Arrange
    const outcome: CreateLeadOutcomeDto = { lead: makeLeadDetail(), warnings: [], requiresConfirmation: false };
    vi.mocked(createLead).mockResolvedValue(outcome);
    const listResult: PartyListDto = { items: [makeParty()], totalCount: 1, page: 1, pageSize: 10 };
    vi.mocked(listParties).mockResolvedValue(listResult);
    renderForm('/leads/new');

    // Act
    fireEvent.change(await screen.findByTestId('party-select'), { target: { value: 'Acme' } });
    fireEvent.click(await screen.findByTestId('party-search-result'));
    fireEvent.change(screen.getByLabelText('Request channel'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Product line'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Cover type'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create lead' }));

    // Assert
    await waitFor(() => expect(createLead).toHaveBeenCalledWith(expect.objectContaining({ partyId: 10, productLineId: 5, coverTypeId: 50 })));
    expect(await screen.findByTestId('lead-detail-route')).toBeInTheDocument();
  });

  it('submit_WhenServerReturnsDuplicateConfirmation_ShouldShowDialogAndCreateAnywayResubmits', async () => {
    // Arrange
    const duplicateOutcome: CreateLeadOutcomeDto = {
      lead: null,
      warnings: [{ code: 'DUPLICATE_LEAD', details: { duplicates: [{ leadId: 9, leadRef: 'L-2026-0009', status: 'New', dateReceived: '2026-06-01' }] } }],
      requiresConfirmation: true,
    };
    const successOutcome: CreateLeadOutcomeDto = { lead: makeLeadDetail(), warnings: [], requiresConfirmation: false };
    vi.mocked(createLead).mockResolvedValueOnce(duplicateOutcome).mockResolvedValueOnce(successOutcome);
    const listResult: PartyListDto = { items: [makeParty()], totalCount: 1, page: 1, pageSize: 10 };
    vi.mocked(listParties).mockResolvedValue(listResult);
    renderForm('/leads/new');

    fireEvent.change(await screen.findByTestId('party-select'), { target: { value: 'Acme' } });
    fireEvent.click(await screen.findByTestId('party-search-result'));
    fireEvent.change(screen.getByLabelText('Request channel'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Product line'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Cover type'), { target: { value: '50' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Create lead' }));
    expect(await screen.findByTestId('duplicate-lead-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }));

    // Assert
    await waitFor(() => expect(createLead).toHaveBeenCalledTimes(2));
    expect(createLead).toHaveBeenLastCalledWith(expect.objectContaining({ createAnyway: true }));
    expect(await screen.findByTestId('lead-detail-route')).toBeInTheDocument();
  });

  it('render_WhenEditingExistingLead_ShouldPrefillFieldsHideOwnerAndLabelSaveChanges', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(makeLeadDetail());
    vi.mocked(getParty).mockResolvedValue(makeParty());

    // Act
    renderForm('/leads/55/edit', ['leads.update']);

    // Assert
    expect(await screen.findByTestId('party-section-locked')).toBeInTheDocument();
    expect(screen.queryByTestId('owner-select')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('submit_WhenEditingExistingLead_ShouldCallUpdateLeadNotCreateLead', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue(makeLeadDetail());
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(updateLead).mockResolvedValue(makeLeadDetail({ estimatedPremium: 75000 }));
    renderForm('/leads/55/edit', ['leads.update']);
    await screen.findByTestId('party-section-locked');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // Assert
    await waitFor(() => expect(updateLead).toHaveBeenCalledWith(55, expect.objectContaining({ productLineId: 5, coverTypeId: 50 })));
    expect(createLead).not.toHaveBeenCalled();
  });
});
