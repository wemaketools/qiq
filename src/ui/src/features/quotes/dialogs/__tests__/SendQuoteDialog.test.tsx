import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SendQuoteDialog from '../SendQuoteDialog';

describe('SendQuoteDialog', () => {
  it('render_WhenOpen_ShouldShowTitleAndReadOnlyPremium', () => {
    // Arrange & Act
    render(
      <SendQuoteDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Botswana Mining Co."
        quotedPremium={500000}
        currencySymbol="BWP"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('Send — Q-2026-0001 · Botswana Mining Co.');
    expect(screen.getByLabelText('Quoted premium')).toBeDisabled();
  });

  it('click_WhenConfirmedWithoutValidUntilOrNextFollowUp_ShouldShowInlineErrorsAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <SendQuoteDialog open quoteRef="Q-2026-0001" partyName="Acme" quotedPremium={500000} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-valid-until')).toHaveTextContent('Valid-until is required to send a quote.');
    expect(screen.getByTestId('field-error-next-follow-up')).toHaveTextContent('A next follow-up date is required to send a quote.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('render_WhenQuoteAlreadyHasValidUntil_ShouldPrefillTheField', () => {
    // Arrange & Act: a valid-until entered at Draft must carry into the Send dialog rather than
    // forcing the user to retype it (regression, 2026-07-22).
    const onConfirm = vi.fn();
    render(
      <SendQuoteDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        quotedPremium={500000}
        defaultValidUntil="2026-11-15"
        currencySymbol="BWP"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Assert: pre-filled, and confirm goes through with it untouched (only follow-up added).
    expect(screen.getByLabelText('Valid until *')).toHaveValue('2026-11-15');
    fireEvent.change(screen.getByLabelText('Next follow-up date *'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByTestId('dialog-primary-button'));
    expect(onConfirm).toHaveBeenCalledWith(expect.any(String), '2026-11-15', '2026-08-01');
  });

  it('click_WhenValidUntilAndNextFollowUpProvided_ShouldCallOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <SendQuoteDialog open quoteRef="Q-2026-0001" partyName="Acme" quotedPremium={500000} currencySymbol="BWP" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Valid until *'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Next follow-up date *'), { target: { value: '2026-08-01' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(expect.any(String), '2026-12-01', '2026-08-01');
  });
});
