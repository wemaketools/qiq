import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AssignDialog from '../AssignDialog';
import type { LeadDetailDto } from '../../leadsApi';
import type { BusinessAssignmentsDto } from '../../../settings/settingsApi';

vi.mock('../../leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../../leadsApi')>('../../leadsApi');
  return {
    ...actual,
    getEligibleAssignees: vi.fn(() => Promise.resolve([{ userId: 2, firstName: 'Uma', lastName: 'UW', email: 'uma@x.test' }])),
  };
});

const ROLES: BusinessAssignmentsDto = {
  rmRole: { assignmentId: 1, roleId: 1, roleName: 'Relationship Manager' },
  underwritingRole: { assignmentId: 2, roleId: 2, roleName: 'Underwriter' },
};

function makeLead(overrides: Partial<LeadDetailDto>): LeadDetailDto {
  return {
    id: 1,
    leadRef: 'L-2026-0001',
    externalRef: null,
    partyId: 1,
    partyName: 'Botswana Mining Co.',
    requestChannelId: 1,
    brokerId: null,
    brokerName: null,
    regionId: 1,
    productLineId: 1,
    productLineName: 'Motor',
    coverTypeId: 1,
    coverTypeName: 'Comprehensive',
    sumInsured: null,
    estimatedPremium: null,
    policyTerm: 'annual',
    policyTermOther: null,
    priority: 'normal',
    isExistingClient: false,
    statusId: 1,
    statusName: 'New',
    statusCanonicalKey: 'new',
    dateReceived: '2026-01-01',
    source: 'api',
    owner: null,
    notes: [],
    availableOperations: ['assign'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

describe('AssignDialog', () => {
  it('render_WhenOpenOnNewLead_ShouldShowOneSelectPerRoleWithAccountableRequired', () => {
    // Arrange & Act
    render(<AssignDialog open lead={makeLead({})} roles={ROLES} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Assert
    expect(screen.getByTestId('assign-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('Assign — L-2026-0001 · Botswana Mining Co.');
    expect(screen.getByTestId('role-select-accountable')).toHaveTextContent('Relationship Manager *');
    expect(screen.getByTestId('role-select-underwriter')).toBeInTheDocument();
  });

  it('click_WhenConfirmedWithoutAccountableOwner_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<AssignDialog open lead={makeLead({})} roles={ROLES} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error')).toHaveTextContent('An accountable owner is required.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenAccountableOwnerSelectedAndConfirmed_ShouldCallOnConfirmWithAllRoles', async () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<AssignDialog open lead={makeLead({})} roles={ROLES} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('role-select-accountable-select')).toBeEnabled());
    fireEvent.change(screen.getByTestId('role-select-accountable-select'), { target: { value: '2' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(
      [
        { businessAssignmentId: 1, userId: 2 },
        { businessAssignmentId: 2, userId: null },
      ],
      null,
    );
  });

  it('render_WhenReassigningExistingOwner_ShouldPrefillAccountableRoleFromLeadOwner', () => {
    // Arrange & Act
    render(
      <AssignDialog
        open
        lead={makeLead({ owner: { userId: 9, firstName: 'Sam', lastName: 'RM' }, statusCanonicalKey: 'assigned' })}
        roles={ROLES}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('Reassign');
    expect(screen.getByTestId('role-select-accountable-select')).toHaveValue('9');
    expect(screen.getByRole('option', { name: 'Sam RM' })).toBeInTheDocument();
  });

  it('change_WhenReassigningExistingOwnerToAnotherUser_ShouldConfirmWithNewOwnerUserId', async () => {
    // Arrange
    const onConfirm = vi.fn();
    const leadWithOwner = makeLead({ owner: { userId: 9, firstName: 'Sam', lastName: 'RM' }, statusCanonicalKey: 'assigned' });
    render(<AssignDialog open lead={leadWithOwner} roles={ROLES} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('role-select-accountable-select')).toBeEnabled());
    fireEvent.change(screen.getByTestId('role-select-accountable-select'), { target: { value: '2' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(
      [
        { businessAssignmentId: 1, userId: 2 },
        { businessAssignmentId: 2, userId: null },
      ],
      null,
    );
  });

  it('click_WhenNonOwnerRoleCleared_ShouldSetThatRoleUserIdToNullOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    const leadWithOwner = makeLead({ owner: { userId: 9, firstName: 'Sam', lastName: 'RM' }, statusCanonicalKey: 'assigned' });
    render(<AssignDialog open lead={leadWithOwner} roles={ROLES} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert (underwriter role had no pre-filled value, so it stays null)
    expect(onConfirm).toHaveBeenCalledWith(
      [
        { businessAssignmentId: 1, userId: 9 },
        { businessAssignmentId: 2, userId: null },
      ],
      null,
    );
  });
});
