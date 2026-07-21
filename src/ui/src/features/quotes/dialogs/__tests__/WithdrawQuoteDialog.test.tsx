import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WithdrawQuoteDialog from '../WithdrawQuoteDialog';

describe('WithdrawQuoteDialog', () => {
  it('click_WhenConfirmedWithoutNote_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<WithdrawQuoteDialog open quoteRef="Q-2026-0001" partyName="Acme" onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error')).toHaveTextContent('A note is required to withdraw this quote.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenNoteProvided_ShouldCallOnConfirmWithTrimmedNote', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<WithdrawQuoteDialog open quoteRef="Q-2026-0001" partyName="Acme" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('withdraw-quote-note-textarea'), { target: { value: '  Client withdrew.  ' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith('Client withdrew.');
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('Withdraw — Q-2026-0001 · Acme');
  });
});
