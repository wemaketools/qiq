import { describe, expect, it } from 'vitest';
import { buildLeadsSortParam, DEFAULT_LEADS_SORT, LEADS_SORT_KEYS, type LeadsSortField } from '../leadsApi';

describe('buildLeadsSortParam', () => {
  it('build_WhenAscending_ShouldSendTheBareBackendKey', () => {
    // Arrange + Act + Assert
    expect(buildLeadsSortParam({ field: 'party', direction: 'asc' })).toBe('party');
    expect(buildLeadsSortParam({ field: 'nextFollowUp', direction: 'asc' })).toBe('next_follow_up');
  });

  it('build_WhenDescending_ShouldPrefixTheBackendKeyWithMinus', () => {
    // Arrange + Act + Assert
    expect(buildLeadsSortParam({ field: 'premium', direction: 'desc' })).toBe('-premium');
  });

  it('build_WhenSortingByAge_ShouldInvertDirectionBecauseAgeCountsUpAsDateReceivedRecedes', () => {
    // Arrange + Act + Assert: youngest-first reads as ascending Age but is descending date_received.
    expect(buildLeadsSortParam({ field: 'age', direction: 'asc' })).toBe('-date_received');
    expect(buildLeadsSortParam({ field: 'age', direction: 'desc' })).toBe('date_received');
  });

  it('build_WhenSortIsTheDefault_ShouldRequestTheBackendsOwnNewestFirstOrder', () => {
    // Arrange + Act + Assert (PRD 12.4)
    expect(buildLeadsSortParam(DEFAULT_LEADS_SORT)).toBe('-date_received');
  });

  it('build_WhenNoSortState_ShouldOmitTheParam', () => {
    // Arrange + Act + Assert
    expect(buildLeadsSortParam(null)).toBeUndefined();
    expect(buildLeadsSortParam(undefined)).toBeUndefined();
  });

  it('build_ForEverySortableColumn_ShouldProduceAKeyTheBackendSwitchNames', () => {
    // Arrange: the exact arm labels in LeadStore.ListAsync's sort switch.
    const backendKeys = ['lead_ref', 'party', 'broker', 'product', 'premium', 'status', 'date_received', 'owner', 'next_follow_up'];

    // Act
    const fields = Object.keys(LEADS_SORT_KEYS) as LeadsSortField[];

    // Assert
    expect(fields.map((field) => buildLeadsSortParam({ field, direction: 'asc' })?.replace(/^-/, '')).sort()).toEqual(
      [...backendKeys].sort(),
    );
  });
});
