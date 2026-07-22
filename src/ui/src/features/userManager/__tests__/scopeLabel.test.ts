import { describe, expect, it } from 'vitest';
import { groupByScope, scopeLabel } from '../scopeLabel';
import type { TenantMembership } from '../../../app/slices/sessionSlice';

const MEMBERSHIPS: TenantMembership[] = [
  { tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'P', permissions: [] },
  { tenantId: 2, tenantName: 'Atlantic Risk', currencyCode: 'BWP', currencySymbol: 'P', permissions: [] },
];

/**
 * Scope labelling for cross-tenant User Manager pickers: same-named roles/groups from different
 * tenants must be distinguishable (the default per-tenant role sets share names across tenants).
 */
describe('scopeLabel', () => {
  it('label_WhenTenantIdNull_ShouldSayGlobal', () => {
    expect(scopeLabel(null, MEMBERSHIPS)).toBe('Global');
  });

  it('label_WhenTenantKnownToSession_ShouldUseTenantName', () => {
    expect(scopeLabel(1, MEMBERSHIPS)).toBe('Brittany Insurance');
  });

  it('label_WhenTenantOutsideMemberships_ShouldFallBackToPlainId', () => {
    expect(scopeLabel(9, MEMBERSHIPS)).toBe('Tenant 9');
  });
});

describe('groupByScope', () => {
  it('grouping_WhenItemsSpanScopes_ShouldPutGlobalFirstThenTenantsAlphabetically', () => {
    const groups = groupByScope(
      [
        { id: 1, tenantId: 1, name: 'Admin' },
        { id: 2, tenantId: 2, name: 'Admin' },
        { id: 3, tenantId: null, name: 'Internal Operations' },
        { id: 4, tenantId: 1, name: 'Underwriter' },
      ],
      MEMBERSHIPS,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Global',
      'Atlantic Risk',
      'Brittany Insurance',
    ]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual([2]);
    expect(groups[2]?.items.map((item) => item.id)).toEqual([1, 4]);
  });

  it('grouping_WhenNoItems_ShouldReturnEmpty', () => {
    expect(groupByScope([], MEMBERSHIPS)).toEqual([]);
  });
});
