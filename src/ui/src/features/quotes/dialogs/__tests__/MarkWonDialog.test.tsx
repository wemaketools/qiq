import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MarkWonDialog from '../MarkWonDialog';

describe('MarkWonDialog', () => {
  it('render_WhenOpen_ShouldDefaultBoundPremiumToQuotedPremium', () => {
    // Arrange & Act
    render(
      <MarkWonDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        quotedPremium={500000}
        currencySymbol="BWP"
        hasOtherOpenQuotes={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByLabelText('Bound premium')).toHaveValue('500,000');
  });

  it('render_WhenOtherOpenQuotesExist_ShouldWarnAboutWithdrawal', () => {
    // Arrange & Act
    render(
      <MarkWonDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        quotedPremium={500000}
        currencySymbol="BWP"
        hasOtherOpenQuotes
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('workflow-dialog-title')).toBeInTheDocument();
    expect(screen.getByText(/Other open quotes on this lead will be withdrawn/)).toBeInTheDocument();
  });

  it('click_WhenConfirmed_ShouldCallOnConfirmWithBoundPremiumAndDecisionDate', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <MarkWonDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        quotedPremium={500000}
        currencySymbol="BWP"
        hasOtherOpenQuotes={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(500000, expect.any(String));
  });
});
