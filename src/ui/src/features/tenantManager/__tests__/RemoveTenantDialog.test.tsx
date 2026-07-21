import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RemoveTenantDialog from '../RemoveTenantDialog';

/**
 * Remove tenant danger dialog (spec FR-06/FR-07, AC-006, UI Standards §14.3): titled with the
 * tenant name, restates the soft-delete/restorable consequence, uses the danger button, and
 * wires confirm/cancel through to the caller.
 */
describe('RemoveTenantDialog', () => {
  it('render_WhenOpen_ShouldShowTitleWithTenantNameAndSoftDeleteConsequence', () => {
    // Arrange & Act
    render(
      <RemoveTenantDialog open tenantName="Acme Insurance" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    expect(screen.getByTestId('remove-tenant-dialog')).toBeInTheDocument();
    expect(screen.getByText('Remove tenant — Acme Insurance')).toBeInTheDocument();
    expect(screen.getByText(/restorable|restored/i)).toBeInTheDocument();
    expect(screen.getByTestId('dialog-danger-button')).toHaveTextContent('Remove tenant');
  });

  it('render_WhenClosed_ShouldRenderNothing', () => {
    // Arrange & Act
    render(
      <RemoveTenantDialog open={false} tenantName="Acme Insurance" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    expect(screen.queryByTestId('remove-tenant-dialog')).not.toBeInTheDocument();
  });

  it('click_WhenDangerButtonClicked_ShouldCallOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <RemoveTenantDialog open tenantName="Acme Insurance" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('click_WhenCancelClicked_ShouldCallOnCancel', () => {
    // Arrange
    const onCancel = vi.fn();
    render(
      <RemoveTenantDialog open tenantName="Acme Insurance" onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Assert
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
