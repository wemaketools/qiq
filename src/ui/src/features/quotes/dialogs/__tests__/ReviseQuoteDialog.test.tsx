import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReviseQuoteDialog from '../ReviseQuoteDialog';

describe('ReviseQuoteDialog', () => {
  it('click_WhenConfirmedWithoutChangeOrRevisionNote_ShouldShowInlineErrors', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <ReviseQuoteDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        currentQuotedPremium={500000}
        currencySymbol="BWP"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-change')).toHaveTextContent('At least one of a new quoted premium or terms notes must be supplied.');
    expect(screen.getByTestId('field-error-revision-note')).toHaveTextContent('A revision note is required.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenNewPremiumAndRevisionNoteProvided_ShouldCallOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <ReviseQuoteDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        currentQuotedPremium={500000}
        currencySymbol="BWP"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('New quoted premium'), { target: { value: '450000' } });
    fireEvent.change(screen.getByTestId('revise-revision-note-textarea'), { target: { value: 'Client requested a lower premium.' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(450000, null, 'Client requested a lower premium.');
  });

  it('click_WhenOnlyTermsNotesProvided_ShouldCallOnConfirmWithNullPremium', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <ReviseQuoteDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        currentQuotedPremium={500000}
        currencySymbol="BWP"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('revise-terms-notes-textarea'), { target: { value: 'Extended payment terms.' } });
    fireEvent.change(screen.getByTestId('revise-revision-note-textarea'), { target: { value: 'Terms updated.' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(null, 'Extended payment terms.', 'Terms updated.');
  });
});
