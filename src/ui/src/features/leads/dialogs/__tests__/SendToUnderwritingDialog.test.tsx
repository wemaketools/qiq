import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SendToUnderwritingDialog from '../SendToUnderwritingDialog';
import type { LeadDetailDto } from '../../leadsApi';
import type { BusinessAssignmentEntryDto } from '../../../settings/settingsApi';

vi.mock('../../leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../../leadsApi')>('../../leadsApi');
  return {
    ...actual,
    getEligibleAssignees: vi.fn(() => Promise.resolve([{ userId: 3, firstName: 'Uma', lastName: 'UW', email: 'uma@x.test' }])),
  };
});

const UNDERWRITING_ROLE: BusinessAssignmentEntryDto = { assignmentId: 2, roleId: 2, roleName: 'Underwriter' };

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
    statusName: 'Assigned',
    statusCanonicalKey: 'assigned',
    dateReceived: '2026-01-01',
    source: 'api',
    owner: { userId: 9, firstName: 'Sam', lastName: 'RM' },
    notes: [],
    availableOperations: ['send-to-underwriting'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

describe('SendToUnderwritingDialog', () => {
  it('click_WhenConfirmedWithoutOwner_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<SendToUnderwritingDialog open lead={makeLead({})} underwritingRole={UNDERWRITING_ROLE} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error')).toHaveTextContent('An underwriting owner is required.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenOwnerSelectedAndConfirmed_ShouldCallOnConfirmWithUserIdAndTrimmedNote', async () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<SendToUnderwritingDialog open lead={makeLead({})} underwritingRole={UNDERWRITING_ROLE} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('underwriting-owner-select-select')).toBeEnabled());
    fireEvent.change(screen.getByTestId('underwriting-owner-select-select'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('send-to-underwriting-note-textarea'), { target: { value: '  handoff notes  ' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(3, 'handoff notes');
  });

  it('render_WhenNoUnderwritingRoleConfigured_ShouldDisablePickerAndShowNotice', () => {
    // Arrange & Act
    render(
      <SendToUnderwritingDialog
        open
        lead={makeLead({})}
        underwritingRole={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('underwriting-role-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('underwriting-owner-select-select')).toBeDisabled();
  });
});
