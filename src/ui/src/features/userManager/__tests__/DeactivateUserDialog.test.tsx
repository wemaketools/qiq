import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DeactivateUserDialog from '../DeactivateUserDialog';

/**
 * Deactivate-user danger dialog (spec FR-13, AC-012, UI Standards §14.3): titled with the user's
 * email, restates the login-block + history-retention consequence (AC-012, V-012), uses the danger
 * button, and wires confirm/cancel through to the caller.
 */
describe('DeactivateUserDialog', () => {
  it('render_WhenOpen_ShouldShowTitleWithEmailAndLoginBlockConsequence', () => {
    // Arrange & Act
    render(
      <DeactivateUserDialog open userEmail="e2e-user@brittany.test" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    expect(screen.getByTestId('deactivate-user-dialog')).toBeInTheDocument();
    expect(screen.getByText('Deactivate user — e2e-user@brittany.test')).toBeInTheDocument();
    expect(screen.getByText(/blocks the user from signing in/i)).toBeInTheDocument();
    expect(screen.getByText(/preserving their history/i)).toBeInTheDocument();
    expect(screen.getByTestId('dialog-danger-button')).toHaveTextContent('Deactivate user');
  });

  it('render_WhenClosed_ShouldRenderNothing', () => {
    // Arrange & Act
    render(
      <DeactivateUserDialog open={false} userEmail="e2e-user@brittany.test" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    // Assert
    expect(screen.queryByTestId('deactivate-user-dialog')).not.toBeInTheDocument();
  });

  it('click_WhenDangerButtonClicked_ShouldCallOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <DeactivateUserDialog open userEmail="e2e-user@brittany.test" onConfirm={onConfirm} onCancel={vi.fn()} />,
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
      <DeactivateUserDialog open userEmail="e2e-user@brittany.test" onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Assert
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
