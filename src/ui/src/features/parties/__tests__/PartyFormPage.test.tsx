import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import PartyFormPage from '../PartyFormPage';
import { createParty, getParty, updateParty } from '../partiesApi';
import type { PartyDto, PartyMutationResultDto } from '../partiesApi';
import { listReferenceItems } from '../../settings/settingsApi';

vi.mock('../partiesApi', async () => {
  const actual = await vi.importActual<typeof import('../partiesApi')>('../partiesApi');
  return {
    ...actual,
    createParty: vi.fn(),
    updateParty: vi.fn(),
    getParty: vi.fn(),
  };
});

vi.mock('../../settings/settingsApi', () => ({
  listReferenceItems: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function makeParty(overrides: Partial<PartyDto> = {}): PartyDto {
  return {
    id: 7,
    name: 'Botswana Mining Co.',
    partyTypeId: 10,
    segmentId: null,
    industryId: null,
    regionId: null,
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

function renderForm(initialPath: string, permissions: string[] = ['parties.create', 'parties.update']) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'user@brittany.test', firstName: 'Test', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  // useUnsavedChanges' useBlocker requires a data router (createMemoryRouter), not the plain
  // <MemoryRouter>/<Routes> component API (same convention as TenantFormPage.test.tsx).
  const router = createMemoryRouter(
    [
      { path: '/parties/new', element: <PartyFormPage /> },
      { path: '/parties/:partyId/edit', element: <PartyFormPage /> },
      { path: '/parties/:partyId', element: <div data-testid="party-detail-route" /> },
      { path: '/parties', element: <div data-testid="party-list-route" /> },
    ],
    { initialEntries: [initialPath] },
  );

  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
}

describe('PartyFormPage', () => {
  beforeEach(() => {
    vi.mocked(createParty).mockReset();
    vi.mocked(updateParty).mockReset();
    vi.mocked(getParty).mockReset();
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(listReferenceItems).mockImplementation((listType) => {
      if (listType === 'party_type') {
        return Promise.resolve([{ id: 10, listType: 'party_type', name: 'Corporate', displayOrder: 1, isActive: true, isBrokerChannel: null, productLineId: null, reportingCategory: null, canonicalKey: null, isTerminal: false }]);
      }
      return Promise.resolve([]);
    });
  });

  it('submit_WhenNameLeftBlank_ShouldShowInlineRequiredError', async () => {
    // Arrange
    renderForm('/parties/new');
    await screen.findByLabelText('Party type');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText('Party name is required.')).toBeInTheDocument();
    expect(createParty).not.toHaveBeenCalled();
  });

  it('submit_WhenPartyTypeNotSelected_ShouldShowInlineRequiredError', async () => {
    // Arrange
    renderForm('/parties/new');
    await screen.findByLabelText('Party type');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText('Party type is required.')).toBeInTheDocument();
    expect(createParty).not.toHaveBeenCalled();
  });

  it('blur_WhenContactEmailIsInvalidFormat_ShouldShowInlineFormatError', async () => {
    // Arrange
    renderForm('/parties/new');
    await screen.findByLabelText('Party type');
    const emailInput = screen.getByLabelText('Contact email');

    // Act
    fireEvent.change(emailInput, { target: { value: 'not-an-email' } });
    fireEvent.blur(emailInput);

    // Assert
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('submit_WhenRegionLeftEmpty_ShouldSucceed', async () => {
    // Arrange
    const result: PartyMutationResultDto = { party: makeParty({ id: 99, name: 'Acme' }), warnings: [] };
    vi.mocked(createParty).mockResolvedValue(result);
    renderForm('/parties/new');
    await screen.findByLabelText('Party type');

    // Act
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Party type'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(createParty).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Acme', partyTypeId: 10, regionId: null }),
      ),
    );
    expect(await screen.findByTestId('party-detail-route')).toBeInTheDocument();
  });

  it('submit_WhenDuplicateNameWarningReturned_ShouldShowNonBlockingBannerAndStillNavigate', async () => {
    // Arrange
    const result: PartyMutationResultDto = {
      party: makeParty({ id: 99, name: 'Botswana Mining Co' }),
      warnings: [{ code: 'DUPLICATE_NAME', matches: [{ id: 1, name: 'Botswana Mining Co.' }] }],
    };
    vi.mocked(createParty).mockResolvedValue(result);
    renderForm('/parties/new');
    await screen.findByLabelText('Party type');

    // Act
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Botswana Mining Co' } });
    fireEvent.change(screen.getByLabelText('Party type'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert: banner shown non-blocking (party already saved); navigation only follows the
    // explicit Dismiss/Continue action, not automatically.
    expect(await screen.findByTestId('duplicate-warning-banner')).toBeInTheDocument();
    expect(screen.getByTestId('duplicate-warning-link')).toHaveTextContent('Botswana Mining Co.');
    expect(screen.queryByTestId('party-detail-route')).not.toBeInTheDocument();

    // Act
    fireEvent.click(screen.getByTestId('dismiss-duplicate-warning'));

    // Assert
    expect(await screen.findByTestId('party-detail-route')).toBeInTheDocument();
  });

  it('submit_WhenEditingExistingParty_ShouldLoadValuesAndCallUpdateParty', async () => {
    // Arrange
    vi.mocked(getParty).mockResolvedValue(makeParty());
    vi.mocked(updateParty).mockResolvedValue({ party: makeParty({ name: 'Botswana Mining Co. Ltd' }), warnings: [] });
    renderForm('/parties/7/edit');

    // Assert values loaded
    expect(await screen.findByDisplayValue('Botswana Mining Co.')).toBeInTheDocument();

    // Act
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Botswana Mining Co. Ltd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(updateParty).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ name: 'Botswana Mining Co. Ltd', partyTypeId: 10 }),
      ),
    );
  });

  it('render_WhenUserLacksCreatePermission_ShouldHideSaveButton', async () => {
    // Arrange & Act
    renderForm('/parties/new', []);

    // Assert
    await screen.findByLabelText('Party type');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
