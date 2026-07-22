import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import BusinessAssignmentsTab from '../BusinessAssignmentsTab';
import { fetchBusinessAssignments, updateBusinessAssignments } from '../settingsApi';
import { listRoles } from '../../userManager/rolesApi';

vi.mock('../settingsApi', async () => {
  const actual = await vi.importActual<typeof import('../settingsApi')>('../settingsApi');
  return { ...actual, fetchBusinessAssignments: vi.fn(), updateBusinessAssignments: vi.fn() };
});

vi.mock('../../userManager/rolesApi', () => ({ listRoles: vi.fn() }));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

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

  return render(
    <Provider store={store}>
      <BusinessAssignmentsTab />
    </Provider>,
  );
}

/**
 * Business assignments tab (spec FR-23 as amended 2026-07-15, PRD 8, AC-022): one role dropdown per
 * fixed slot (RM / Underwriting), and the `{ rmRoleId, underwritingRoleId }` payload sent to
 * `PUT /settings/business-assignments`.
 */
describe('BusinessAssignmentsTab', () => {
  beforeEach(() => {
    vi.mocked(listRoles).mockReset();
    vi.mocked(fetchBusinessAssignments).mockReset();
    vi.mocked(updateBusinessAssignments).mockReset();

    vi.mocked(listRoles).mockResolvedValue([
      { id: 1, tenantId: 1, name: 'RM', isActive: true, permissionCodes: [] },
      { id: 2, tenantId: 1, name: 'Underwriter', isActive: true, permissionCodes: [] },
    ]);
    vi.mocked(fetchBusinessAssignments).mockResolvedValue({
      rmRole: { assignmentId: 10, roleId: 1, roleName: 'RM' },
      underwritingRole: null,
    });
  });

  it('render_WhenLoaded_ShouldPreselectConfiguredSlotRoles', async () => {
    // Arrange & Act
    renderTab(['business_assignments.manage']);

    // Assert
    const rmSelect = await screen.findByTestId('rm-role-select');
    expect(rmSelect).toHaveValue('1');
    expect(screen.getByTestId('underwriting-role-select')).toHaveValue('');
  });

  it('render_WhenRoleListSpansTenants_ShouldOfferOnlyActiveTenantAndGlobalRoles', async () => {
    // Arrange: cross-tenant callers receive EVERY tenant's roles from /roles, but the two slots
    // configure the ACTIVE tenant and the server refuses a foreign tenant's role — the dropdown
    // must not offer options that can never be saved.
    vi.mocked(listRoles).mockResolvedValue([
      { id: 1, tenantId: 1, name: 'RM', isActive: true, permissionCodes: [] },
      { id: 9, tenantId: 2, name: 'Foreign RM', isActive: true, permissionCodes: [] },
      { id: 3, tenantId: null, name: 'Global RM', isActive: true, permissionCodes: [] },
    ]);

    // Act
    renderTab(['business_assignments.manage']);

    // Assert
    const rmSelect = await screen.findByTestId('rm-role-select');
    const optionLabels = within(rmSelect).getAllByRole('option').map((option) => option.textContent);
    expect(optionLabels).toEqual(['Not configured', 'RM', 'Global RM']);
  });

  it('save_WhenBothSlotsChosen_ShouldSendSlotRoleIdsInPayload', async () => {
    // Arrange
    vi.mocked(updateBusinessAssignments).mockResolvedValue({
      rmRole: { assignmentId: 10, roleId: 1, roleName: 'RM' },
      underwritingRole: { assignmentId: 11, roleId: 2, roleName: 'Underwriter' },
    });
    renderTab(['business_assignments.manage']);
    await screen.findByTestId('rm-role-select');
    fireEvent.change(screen.getByTestId('underwriting-role-select'), { target: { value: '2' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    await waitFor(() =>
      expect(updateBusinessAssignments).toHaveBeenCalledWith({ rmRoleId: 1, underwritingRoleId: 2 }),
    );
  });

  it('save_WhenSameRoleChosenForBothSlots_ShouldShowInlineErrorAndNotSave', async () => {
    // Arrange
    renderTab(['business_assignments.manage']);
    await screen.findByTestId('rm-role-select');
    fireEvent.change(screen.getByTestId('underwriting-role-select'), { target: { value: '1' } });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Assert
    expect(await screen.findByText('The RM role and the Underwriting role must be different roles.')).toBeInTheDocument();
    expect(updateBusinessAssignments).not.toHaveBeenCalled();
  });

  it('render_WhenCallerLacksManagePermission_ShouldDisableSelectsAndHideSave', async () => {
    // Arrange & Act
    renderTab([]);

    // Assert
    const rmSelect = await screen.findByTestId('rm-role-select');
    expect(rmSelect).toBeDisabled();
    expect(screen.getByTestId('underwriting-role-select')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
