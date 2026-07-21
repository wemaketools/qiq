import { describe, expect, it } from 'vitest';
import { labelForOperation, moreActionsOperations, resolvePrimaryOperation } from '../leadOperations';
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

describe('resolvePrimaryOperation', () => {
  it('resolve_WhenNewWithAssignAvailable_ShouldReturnAssign', () => {
    // Arrange
    const lead = makeLead({ statusCanonicalKey: 'new', availableOperations: ['assign'] });

    // Act
    const primary = resolvePrimaryOperation(lead);

    // Assert
    expect(primary).toBe('assign');
  });

  it('resolve_WhenQuoteSentWithLogFollowUpAvailable_ShouldReturnLogFollowUp', () => {
    // Arrange
    const lead = makeLead({
      statusCanonicalKey: 'quote_sent',
      availableOperations: ['assign', 'mark-lost', 'log-follow-up', 'withdraw'],
    });

    // Act
    const primary = resolvePrimaryOperation(lead);

    // Assert
    expect(primary).toBe('log-follow-up');
  });

  it('resolve_WhenNoSpecialCaseApplies_ShouldReturnFirstAvailableOperation', () => {
    // Arrange
    const lead = makeLead({ statusCanonicalKey: 'assigned', availableOperations: ['send-to-underwriting', 'mark-lost'] });

    // Act
    const primary = resolvePrimaryOperation(lead);

    // Assert
    expect(primary).toBe('send-to-underwriting');
  });

  it('resolve_WhenNoOperationsAvailable_ShouldReturnNull', () => {
    // Arrange
    const lead = makeLead({ statusCanonicalKey: 'closed_won', availableOperations: [] });

    // Act
    const primary = resolvePrimaryOperation(lead);

    // Assert
    expect(primary).toBeNull();
  });
});

describe('moreActionsOperations', () => {
  it('filter_WhenPrimaryOpPresent_ShouldExcludeIt', () => {
    // Arrange
    const lead = makeLead({ availableOperations: ['assign', 'mark-lost', 'withdraw'] });

    // Act
    const remaining = moreActionsOperations(lead, 'assign');

    // Assert
    expect(remaining).toEqual(['mark-lost', 'withdraw']);
  });

  it('filter_WhenApproveAndRejectBothLegal_ShouldMergeIntoOneEntry', () => {
    // Arrange
    const lead = makeLead({ availableOperations: ['approve-pricing', 'reject-pricing', 'mark-lost'] });

    // Act
    const remaining = moreActionsOperations(lead, null);

    // Assert
    expect(remaining).toEqual(['approve-pricing', 'mark-lost']);
  });
});

describe('labelForOperation', () => {
  it('label_WhenAssignAndNoOwnerYet_ShouldReturnAssign', () => {
    // Arrange
    const lead = makeLead({ owner: null });

    // Act & Assert
    expect(labelForOperation('assign', lead)).toBe('Assign');
  });

  it('label_WhenAssignAndOwnerAlreadySet_ShouldReturnReassign', () => {
    // Arrange
    const lead = makeLead({ owner: { userId: 1, firstName: 'Sam', lastName: 'RM' } });

    // Act & Assert
    expect(labelForOperation('assign', lead)).toBe('Reassign');
  });

  it('label_WhenMarkLost_ShouldReturnMarkLost', () => {
    // Arrange
    const lead = makeLead({});

    // Act & Assert
    expect(labelForOperation('mark-lost', lead)).toBe('Mark lost');
  });
});
