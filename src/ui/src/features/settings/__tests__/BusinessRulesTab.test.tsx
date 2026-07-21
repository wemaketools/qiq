import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import BusinessRulesTab from '../BusinessRulesTab';
import { fetchFullBusinessRules, updateBusinessRules, type FullBusinessRulesDto } from '../settingsApi';

vi.mock('../settingsApi', async () => {
  const actual = await vi.importActual<typeof import('../settingsApi')>('../settingsApi');
  return { ...actual, fetchFullBusinessRules: vi.fn(), updateBusinessRules: vi.fn() };
});

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

const BASE_RULES: FullBusinessRulesDto = {
  currencyCode: 'BWP',
  currencySymbol: 'BWP',
  maxAttachmentMb: 10,
  highValueThreshold: 500000,
  quoteExpiryAlertDays: 5,
  followUpOverdueGraceDays: 1,
  agingAmberDays: 8,
  agingRedDays: 15,
  unassignedLeadHours: 24,
  stalledLeadDays: 10,
  stalledQuoteDays: 10,
  duplicateCheckDays: 30,
  leadRefFormat: 'L-{YYYY}-{SEQ:4}',
  quoteRefFormat: 'Q-{YYYY}-{SEQ:4}',
  leadInactivityExpiryDays: 60,
  pricingApprovalTargetDays: 3,
  slaAssignmentDays: 1,
  slaUnderwritingDays: 2,
  slaReceivedToSentDays: 3,
  requirePricingApprovalForHighValue: true,
  manualExternalRefEnabled: false,
};

function renderTab(permissions: string[]) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'admin@brittany.test', firstName: 'Admin', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  // useUnsavedChanges' useBlocker requires a data router (createMemoryRouter), same pattern as
  // RoleFormPage.test.tsx.
  const router = createMemoryRouter([{ path: '/settings/business-rules', element: <BusinessRulesTab /> }], {
    initialEntries: ['/settings/business-rules'],
  });

  render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );

  return store;
}

/**
 * Business rules form (spec FR-11, AC-010, AC-074, V-010/V-074, T-016): client-side validation
 * mirrors `UpdateBusinessRulesValidator`, saves the full DTO via `PUT /settings/business-rules`,
 * and — on a currency change — syncs the session's active-tenant currency in place so the footer
 * (sourced from the session, see `useTenantCurrency.ts`) reflects the change without a `GET /me`
 * refetch.
 */
describe('BusinessRulesTab', () => {
  beforeEach(() => {
    vi.mocked(fetchFullBusinessRules).mockReset();
    vi.mocked(updateBusinessRules).mockReset();
    vi.mocked(fetchFullBusinessRules).mockResolvedValue(BASE_RULES);
  });

  it('submit_WhenAgingRedNotGreaterThanAmber_ShouldShowInlineErrorAndNotSave', async () => {
    // Arrange
    renderTab(['business_rules.manage']);
    await screen.findByTestId('business-rules-form');

    // Act
    fireEvent.change(screen.getByLabelText('Aging amber days'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Aging red days'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText('Aging red threshold must be greater than the aging amber threshold.')).toBeInTheDocument();
    expect(updateBusinessRules).not.toHaveBeenCalled();
  });

  it('submit_WhenValid_ShouldSaveFullPayloadIncludingCurrency', async () => {
    // Arrange
    vi.mocked(updateBusinessRules).mockResolvedValue({ ...BASE_RULES, currencyCode: 'ZAR', currencySymbol: 'R' });
    renderTab(['business_rules.manage']);
    await screen.findByTestId('business-rules-form');

    // Act
    fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'ZAR' } });
    fireEvent.change(screen.getByLabelText('Currency symbol'), { target: { value: 'R' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(updateBusinessRules).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'ZAR', currencySymbol: 'R' })),
    );
  });

  it('submit_WhenCurrencyChanges_ShouldSyncSessionActiveTenantCurrency', async () => {
    // Arrange
    vi.mocked(updateBusinessRules).mockResolvedValue({ ...BASE_RULES, currencyCode: 'ZAR', currencySymbol: 'R' });
    const store = renderTab(['business_rules.manage']);
    await screen.findByTestId('business-rules-form');

    // Act
    fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'ZAR' } });
    fireEvent.change(screen.getByLabelText('Currency symbol'), { target: { value: 'R' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() => expect(store.getState().session.memberships[0]?.currencyCode).toBe('ZAR'));
  });
});
