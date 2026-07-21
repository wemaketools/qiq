import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WithdrawDialog from '../WithdrawDialog';
import ReopenDialog from '../ReopenDialog';
import SimpleNoteDialog from '../SimpleNoteDialog';
import type { LeadDetailDto } from '../../leadsApi';

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
    availableOperations: ['withdraw'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

describe('WithdrawDialog', () => {
  it('click_WhenConfirmedWithoutNote_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<WithdrawDialog open lead={makeLead({})} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenConfirmedWithNote_ShouldCallOnConfirmWithTrimmedNote', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<WithdrawDialog open lead={makeLead({})} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('withdraw-note-textarea'), { target: { value: '  client cancelled  ' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith('client cancelled');
  });
});

describe('ReopenDialog', () => {
  it('click_WhenConfirmedWithoutReason_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<ReopenDialog open lead={makeLead({ statusName: 'Closed Lost', statusCanonicalKey: 'closed_lost' })} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenConfirmedWithReason_ShouldCallOnConfirmWithTrimmedReason', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<ReopenDialog open lead={makeLead({ statusName: 'Closed Lost', statusCanonicalKey: 'closed_lost' })} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('reopen-reason-textarea'), { target: { value: '  client re-engaged  ' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith('client re-engaged');
  });
});

describe('SimpleNoteDialog', () => {
  it('click_WhenConfirmed_ShouldCallOnConfirmWithNoteOrNull', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <SimpleNoteDialog
        open
        lead={makeLead({})}
        action="Start pricing"
        consequence="This lead moves to Pricing."
        confirmLabel="Start pricing"
        testId="start-pricing-dialog"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(null);
  });
});
