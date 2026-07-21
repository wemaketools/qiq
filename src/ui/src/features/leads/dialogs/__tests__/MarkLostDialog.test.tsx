import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MarkLostDialog from '../MarkLostDialog';
import type { LeadDetailDto } from '../../leadsApi';
import type { ReferenceItemDto } from '../../../settings/settingsApi';

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
    statusName: 'Quote Sent',
    statusCanonicalKey: 'quote_sent',
    dateReceived: '2026-01-01',
    source: 'api',
    owner: { userId: 9, firstName: 'Sam', lastName: 'RM' },
    notes: [],
    availableOperations: ['mark-lost'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

function referenceItem(id: number, name: string, canonicalKey: string | null): ReferenceItemDto {
  return {
    id,
    listType: 'lost_reason',
    name,
    displayOrder: id,
    isActive: true,
    isBrokerChannel: null,
    productLineId: null,
    reportingCategory: null,
    canonicalKey,
    isTerminal: false,
  };
}

const LOST_REASONS: ReferenceItemDto[] = [
  referenceItem(1, 'Competitor won', 'competitor_won'),
  referenceItem(2, 'Other', 'other'),
];

describe('MarkLostDialog', () => {
  it('render_WhenOpen_ShouldShowDangerTitleAndConsequence', () => {
    // Arrange & Act
    render(<MarkLostDialog open lead={makeLead({})} lostReasons={LOST_REASONS} currencySymbol="BWP" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Assert
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('Mark lost — L-2026-0001 · Botswana Mining Co.');
    expect(screen.getByTestId('dialog-danger-button')).toBeInTheDocument();
    expect(screen.getByText(/Any open quotes on this lead will also be marked Lost/)).toBeInTheDocument();
  });

  it('click_WhenConfirmedWithoutReason_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<MarkLostDialog open lead={makeLead({})} lostReasons={LOST_REASONS} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error-lost-reason')).toHaveTextContent('Select a lost reason.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenReasonOtherSelectedWithoutComments_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<MarkLostDialog open lead={makeLead({})} lostReasons={LOST_REASONS} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('lost-reason-select'), { target: { value: '2' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error-loss-comments')).toHaveTextContent("required when the lost reason is 'Other'");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenReasonNotOtherAndAllFieldsProvided_ShouldCallOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<MarkLostDialog open lead={makeLead({})} lostReasons={LOST_REASONS} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('lost-reason-select'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Competitor'), { target: { value: 'Rival Co.' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(1, 'Rival Co.', null, null);
  });

  it('click_WhenReasonOtherWithComments_ShouldCallOnConfirmWithComments', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<MarkLostDialog open lead={makeLead({})} lostReasons={LOST_REASONS} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('lost-reason-select'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('lost-comments-textarea'), { target: { value: 'Budget cut entirely' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(2, null, null, 'Budget cut entirely');
  });
});
