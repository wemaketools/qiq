import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import ReferenceDataTab from '../ReferenceDataTab';
import { listReferenceItems, reorderReferenceItems, type ReferenceItemDto } from '../settingsApi';

vi.mock('../settingsApi', async () => {
  const actual = await vi.importActual<typeof import('../settingsApi')>('../settingsApi');
  return { ...actual, listReferenceItems: vi.fn(), reorderReferenceItems: vi.fn(), disableReferenceItem: vi.fn() };
});

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

const LEAD_STATUS_ITEMS: ReferenceItemDto[] = [
  {
    id: 1,
    listType: 'lead_status',
    name: 'New',
    displayOrder: 0,
    isActive: true,
    isBrokerChannel: null,
    productLineId: null,
    reportingCategory: 'open',
    canonicalKey: 'new',
    isTerminal: false,
  },
  {
    id: 2,
    listType: 'lead_status',
    name: 'Closed Won',
    displayOrder: 1,
    isActive: true,
    isBrokerChannel: null,
    productLineId: null,
    reportingCategory: 'won',
    canonicalKey: 'closed_won',
    isTerminal: true,
  },
];

function renderTab(permissions: string[], listType = 'lead_status') {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'admin@brittany.test', firstName: 'Admin', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  const router = createMemoryRouter(
    [{ path: '/settings/reference-data/:listType', element: <ReferenceDataTab /> }],
    { initialEntries: [`/settings/reference-data/${listType}`] },
  );

  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
}

/**
 * Reference data tab guarded-status affordances (spec §11.2, FR-19/FR-20, AC-018, V-018, T-016):
 * mirrors (UX only) the T-008 backend rules — reporting category read-only for canonical rows, no
 * Disable action on terminal rows, and reorder persisted via the reorder endpoint.
 */
describe('ReferenceDataTab', () => {
  beforeEach(() => {
    vi.mocked(listReferenceItems).mockReset();
    vi.mocked(reorderReferenceItems).mockReset();
    vi.mocked(listReferenceItems).mockResolvedValue(LEAD_STATUS_ITEMS);
  });

  it('render_WhenListTypeIsLeadStatus_ShouldShowReportingCategoryColumn', async () => {
    // Arrange & Act
    renderTab(['reference_data.manage']);

    // Assert
    const cells = await screen.findAllByTestId('reporting-category-cell');
    expect(cells.map((c) => c.textContent)).toEqual(['open', 'won']);
  });

  it('render_WhenRowIsTerminal_ShouldHideDisableButton', async () => {
    // Arrange & Act
    renderTab(['reference_data.manage']);
    await screen.findAllByTestId('reporting-category-cell');

    // Assert
    const terminalRow = screen.getByText('Closed Won').closest('tr');
    expect(terminalRow).not.toBeNull();
    expect(terminalRow && Array.from(terminalRow.querySelectorAll('button')).some((b) => b.textContent === 'Disable')).toBe(
      false,
    );

    const nonTerminalRow = screen.getByText('New').closest('tr');
    expect(nonTerminalRow).not.toBeNull();
    expect(
      nonTerminalRow && Array.from(nonTerminalRow.querySelectorAll('button')).some((b) => b.textContent === 'Disable'),
    ).toBe(true);
  });

  it('editCanonicalRow_ShouldRenderReportingCategoryAsReadOnly', async () => {
    // Arrange
    renderTab(['reference_data.manage']);
    await screen.findAllByTestId('reporting-category-cell');

    // Act
    const newRow = screen.getByText('New').closest('tr');
    expect(newRow).not.toBeNull();
    fireEvent.click(within(newRow as HTMLElement).getByRole('button', { name: 'Edit' }));

    // Assert
    const select = await screen.findByTestId('reporting-category-select');
    expect(select).toBeDisabled();
  });

  it('reorder_WhenMoveDownClicked_ShouldCallReorderWithNewOrder', async () => {
    // Arrange
    vi.mocked(reorderReferenceItems).mockResolvedValue(undefined);
    renderTab(['reference_data.manage']);
    await screen.findAllByTestId('reporting-category-cell');

    // Act
    fireEvent.click(screen.getAllByTestId('reorder-down')[0]!);

    // Assert
    await waitFor(() => expect(reorderReferenceItems).toHaveBeenCalledWith('lead_status', [2, 1]));
  });
});
