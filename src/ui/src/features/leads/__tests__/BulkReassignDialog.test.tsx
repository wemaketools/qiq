import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BulkReassignDialog from '../BulkReassignDialog';
import type { EligibleLeadOwnerDto } from '../leadsApi';

const OWNERS: EligibleLeadOwnerDto[] = [{ userId: 1, firstName: 'Sam', lastName: 'RM', email: 'sam@x.test' }];

describe('BulkReassignDialog', () => {
  it('click_WhenConfirmedWithoutNote_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<BulkReassignDialog open count={2} eligibleOwners={OWNERS} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('reassign-owner-select'), { target: { value: '1' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('reassign-note-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenConfirmedWithNoteAndOwner_ShouldCallOnConfirmWithTrimmedNote', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<BulkReassignDialog open count={2} eligibleOwners={OWNERS} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('reassign-owner-select'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('reassign-note-textarea'), { target: { value: '  moving coverage  ' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(1, 'moving coverage');
  });

  it('render_WhenEligibleOwnersUnavailable_ShouldDisableSelectAndShowNotice', () => {
    // Arrange & Act
    render(<BulkReassignDialog open count={1} eligibleOwners={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Assert
    expect(screen.getByTestId('reassign-owner-select')).toBeDisabled();
    expect(screen.getByTestId('reassign-owner-unavailable')).toBeInTheDocument();
  });

  it('render_WhenClosed_ShouldRenderNothing', () => {
    // Arrange & Act
    render(<BulkReassignDialog open={false} count={1} eligibleOwners={OWNERS} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Assert
    expect(screen.queryByTestId('bulk-reassign-dialog')).not.toBeInTheDocument();
  });
});
