import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RequestPricingApprovalDialog from '../RequestPricingApprovalDialog';
import type { LeadDetailDto } from '../../leadsApi';

vi.mock('../../leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../../leadsApi')>('../../leadsApi');
  return {
    ...actual,
    getEligibleApprovers: vi.fn(() => Promise.resolve([{ userId: 5, firstName: 'Pat', lastName: 'Approver', email: 'pat@x.test' }])),
  };
});

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
    availableOperations: ['request-pricing-approval'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

describe('RequestPricingApprovalDialog', () => {
  it('click_WhenConfirmedWithoutApprover_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<RequestPricingApprovalDialog open lead={makeLead({})} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error')).toHaveTextContent('An approver is required.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenApproverAndPremiumProvided_ShouldCallOnConfirmWithApproverIdPremiumAndNote', async () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<RequestPricingApprovalDialog open lead={makeLead({})} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('pricing-approver-select-select')).toBeEnabled());
    fireEvent.change(screen.getByTestId('pricing-approver-select-select'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Proposed premium'), { target: { value: '50000' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(5, 50000, null);
  });
});
