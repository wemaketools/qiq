import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RoleUsageDialog from '../RoleUsageDialog';
import type { RoleUsageDto } from '../rolesApi';

/**
 * Role-usage-before-disable dialog (spec FR-13, AC-012, T-007 `GET /roles/{id}/usage`): lists
 * every referencing user/group so the administrator understands the impact before disabling.
 */
describe('RoleUsageDialog', () => {
  const USAGE: RoleUsageDto = {
    users: [{ userId: 1, email: 'rm1@brittany.test', tenantId: 1 }],
    groups: [{ groupId: 5, name: 'RM Team', tenantId: 1 }],
  };

  it('render_WhenRoleInUse_ShouldListReferencingUsersAndGroups', () => {
    // Arrange & Act
    render(
      <RoleUsageDialog open roleName="Relationship Manager" usage={USAGE} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    const list = screen.getByTestId('role-usage-list');
    expect(list).toHaveTextContent('rm1@brittany.test');
    expect(list).toHaveTextContent('RM Team');
  });

  it('render_WhenRoleNotInUse_ShouldShowNoUsageMessageAndNoList', () => {
    // Arrange & Act
    render(
      <RoleUsageDialog
        open
        roleName="Unused Role"
        usage={{ users: [], groups: [] }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByText(/not currently assigned/i)).toBeInTheDocument();
    expect(screen.queryByTestId('role-usage-list')).not.toBeInTheDocument();
  });

  it('click_WhenDisableClicked_ShouldCallOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <RoleUsageDialog open roleName="Relationship Manager" usage={USAGE} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('render_WhenClosed_ShouldRenderNothing', () => {
    // Arrange & Act
    render(
      <RoleUsageDialog open={false} roleName="Relationship Manager" usage={USAGE} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    expect(screen.queryByTestId('role-usage-dialog')).not.toBeInTheDocument();
  });
});
