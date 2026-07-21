import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ApproveRejectPricingDialog from '../ApproveRejectPricingDialog';
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
    statusName: 'Pricing',
    statusCanonicalKey: 'pricing',
    dateReceived: '2026-01-01',
    source: 'api',
    owner: { userId: 9, firstName: 'Sam', lastName: 'RM' },
    notes: [],
    availableOperations: ['approve-pricing', 'reject-pricing'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

describe('ApproveRejectPricingDialog', () => {
  it('render_WhenBothLegal_ShouldShowApproveAndRejectButtons', () => {
    // Arrange & Act
    render(
      <ApproveRejectPricingDialog open lead={makeLead({})} currencySymbol="BWP" canApprove canReject onApprove={vi.fn()} onReject={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('Approve/Reject pricing — L-2026-0001 · Botswana Mining Co.');
    expect(screen.getByTestId('dialog-primary-button')).toHaveTextContent('Approve');
    expect(screen.getByTestId('dialog-danger-button')).toHaveTextContent('Reject');
  });

  it('render_WhenOnlyApproveLegal_ShouldHideRejectButton', () => {
    // Arrange & Act (AC-016: hidden, not disabled)
    render(
      <ApproveRejectPricingDialog open lead={makeLead({})} currencySymbol="BWP" canApprove canReject={false} onApprove={vi.fn()} onReject={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    expect(screen.queryByTestId('dialog-danger-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('dialog-primary-button')).toBeInTheDocument();
  });

  it('click_WhenRejectedWithoutReason_ShouldShowInlineErrorAndNotReject', () => {
    // Arrange
    const onReject = vi.fn();
    render(
      <ApproveRejectPricingDialog open lead={makeLead({})} currencySymbol="BWP" canApprove canReject onApprove={vi.fn()} onReject={onReject} onCancel={vi.fn()} />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error')).toHaveTextContent('A rejection reason is required.');
    expect(onReject).not.toHaveBeenCalled();
  });

  it('click_WhenRejectedWithReason_ShouldCallOnRejectWithTrimmedReason', () => {
    // Arrange
    const onReject = vi.fn();
    render(
      <ApproveRejectPricingDialog open lead={makeLead({})} currencySymbol="BWP" canApprove canReject onApprove={vi.fn()} onReject={onReject} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('reject-pricing-reason-textarea'), { target: { value: '  too high  ' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onReject).toHaveBeenCalledWith('too high');
  });

  it('click_WhenApproved_ShouldCallOnApproveWithNoteOrNull', () => {
    // Arrange
    const onApprove = vi.fn();
    render(
      <ApproveRejectPricingDialog open lead={makeLead({})} currencySymbol="BWP" canApprove canReject onApprove={onApprove} onReject={vi.fn()} onCancel={vi.fn()} />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onApprove).toHaveBeenCalledWith(null);
  });
});
