import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MoreActionsMenu from '../MoreActionsMenu';
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
    statusName: 'New',
    statusCanonicalKey: 'new',
    dateReceived: '2026-01-01',
    source: 'api',
    owner: null,
    notes: [],
    availableOperations: [],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

describe('MoreActionsMenu', () => {
  it('render_WhenNoOperationsRemain_ShouldRenderNothing', () => {
    // Arrange & Act
    render(<MoreActionsMenu operations={[]} lead={makeLead({})} onSelect={vi.fn()} />);

    // Assert
    expect(screen.queryByTestId('more-actions-menu')).not.toBeInTheDocument();
  });

  it('render_WhenOperationsProvided_ShouldOnlyListThoseOperations', () => {
    // Arrange & Act (AC-016: server-computed availableOperations drives the entire menu — no
    // "Reopen" or "Approve pricing" entry can appear unless it was passed in.)
    render(<MoreActionsMenu operations={['mark-lost', 'withdraw']} lead={makeLead({})} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('more-actions-trigger'));

    // Assert
    expect(screen.getByTestId('more-action-mark-lost')).toBeInTheDocument();
    expect(screen.getByTestId('more-action-withdraw')).toBeInTheDocument();
    expect(screen.queryByTestId('more-action-reopen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('more-action-approve-pricing')).not.toBeInTheDocument();
  });

  it('click_WhenMenuItemClicked_ShouldCallOnSelectWithOpCodeAndCloseMenu', () => {
    // Arrange
    const onSelect = vi.fn();
    render(<MoreActionsMenu operations={['withdraw']} lead={makeLead({})} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('more-actions-trigger'));

    // Act
    fireEvent.click(screen.getByTestId('more-action-withdraw'));

    // Assert
    expect(onSelect).toHaveBeenCalledWith('withdraw');
    expect(screen.queryByTestId('more-action-withdraw')).not.toBeInTheDocument();
  });

  it('render_WhenAssignAndOwnerAlreadySet_ShouldLabelEntryReassign', () => {
    // Arrange & Act
    render(
      <MoreActionsMenu
        operations={['assign']}
        lead={makeLead({ owner: { userId: 1, firstName: 'Sam', lastName: 'RM' } })}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('more-actions-trigger'));

    // Assert
    expect(screen.getByTestId('more-action-assign')).toHaveTextContent('Reassign');
  });
});
