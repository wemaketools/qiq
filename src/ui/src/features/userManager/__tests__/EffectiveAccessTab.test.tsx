import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import EffectiveAccessTab from '../EffectiveAccessTab';
import type { EffectiveAccessDto } from '../usersApi';

/**
 * Effective access view (spec FR-14, AC-013, verification.json V-013): renders direct roles,
 * direct permissions, group memberships, tenant assignments, and the resolved permission set per
 * tenant exactly as returned by `GET /users/{id}/effective-access`.
 */
describe('EffectiveAccessTab', () => {
  const ACCESS: EffectiveAccessDto = {
    userId: 7,
    directRoles: [{ roleId: 1, roleName: 'R1', tenantId: null }],
    directPermissions: [{ permissionCode: 'parties.view', tenantId: 1 }],
    groups: [{ groupId: 5, groupName: 'G1', tenantId: 1 }],
    tenantAssignments: [{ tenantId: 1, tenantName: 'Brittany Insurance' }],
    effectivePermissionsByTenant: {
      global: [],
      '1': ['parties.view', 'leads.view'],
    },
  };

  it('render_WhenAccessLoaded_ShouldListDirectGrantsAndTenantAssignment', () => {
    // Arrange & Act
    render(<EffectiveAccessTab access={ACCESS} />);

    // Assert
    expect(screen.getByTestId('direct-permissions-list')).toHaveTextContent('parties.view');
    expect(screen.getByTestId('groups-list')).toHaveTextContent('G1');
    expect(screen.getByTestId('tenant-assignments-list')).toHaveTextContent('Brittany Insurance');
    expect(screen.getByTestId('direct-roles-list')).toHaveTextContent('R1');
  });

  it('render_WhenAccessLoaded_ShouldShowResolvedPermissionUnionPerTenant', () => {
    // Arrange & Act
    render(<EffectiveAccessTab access={ACCESS} />);

    // Assert
    const resolved = screen.getByTestId('resolved-permissions');
    expect(resolved).toHaveTextContent('parties.view');
    expect(resolved).toHaveTextContent('leads.view');
  });

  it('render_WhenNoGrants_ShouldShowEmptyMessages', () => {
    // Arrange
    const empty: EffectiveAccessDto = {
      userId: 8,
      directRoles: [],
      directPermissions: [],
      groups: [],
      tenantAssignments: [],
      effectivePermissionsByTenant: { global: [] },
    };

    // Act
    render(<EffectiveAccessTab access={empty} />);

    // Assert
    expect(screen.getByText('No direct roles.')).toBeInTheDocument();
    expect(screen.getByText('No direct permissions.')).toBeInTheDocument();
    expect(screen.getByText('No group memberships.')).toBeInTheDocument();
    expect(screen.getByText('No tenant assignments.')).toBeInTheDocument();
  });
});
