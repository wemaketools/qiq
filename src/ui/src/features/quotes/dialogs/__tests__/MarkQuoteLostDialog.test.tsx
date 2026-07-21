import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MarkQuoteLostDialog from '../MarkQuoteLostDialog';
import type { ReferenceItemDto } from '../../../settings/settingsApi';

function referenceItem(id: number, name: string, canonicalKey: string | null): ReferenceItemDto {
  return {
    id,
    listType: 'lost_reason',
    name,
    displayOrder: id,
    isActive: true,
    isBrokerChannel: null,
    productLineId: null,
    reportingCategory: null,
    canonicalKey,
    isTerminal: false,
  };
}

const LOST_REASONS: ReferenceItemDto[] = [referenceItem(1, 'Competitor won', 'competitor_won'), referenceItem(2, 'Other', 'other')];

describe('MarkQuoteLostDialog', () => {
  it('render_WhenNoOtherOpenQuotes_ShouldDefaultAlsoCloseLeadChecked', () => {
    // Arrange & Act
    render(
      <MarkQuoteLostDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        lostReasons={LOST_REASONS}
        currencySymbol="BWP"
        hasOtherOpenQuotes={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('also-close-lead-checkbox')).toBeChecked();
  });

  it('render_WhenOtherOpenQuotesExist_ShouldDefaultAlsoCloseLeadUnchecked', () => {
    // Arrange & Act
    render(
      <MarkQuoteLostDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        lostReasons={LOST_REASONS}
        currencySymbol="BWP"
        hasOtherOpenQuotes
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('also-close-lead-checkbox')).not.toBeChecked();
  });

  it('click_WhenConfirmedWithoutReason_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <MarkQuoteLostDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        lostReasons={LOST_REASONS}
        currencySymbol="BWP"
        hasOtherOpenQuotes={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error-lost-reason')).toHaveTextContent('Select a lost reason.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenReasonOtherSelectedWithoutComments_ShouldShowInlineError', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <MarkQuoteLostDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        lostReasons={LOST_REASONS}
        currencySymbol="BWP"
        hasOtherOpenQuotes={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('quote-lost-reason-select'), { target: { value: '2' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(screen.getByTestId('field-error-loss-comments')).toHaveTextContent("required when the lost reason is 'Other'");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenReasonAndCheckboxProvided_ShouldCallOnConfirmWithAlsoCloseLead', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <MarkQuoteLostDialog
        open
        quoteRef="Q-2026-0001"
        partyName="Acme"
        lostReasons={LOST_REASONS}
        currencySymbol="BWP"
        hasOtherOpenQuotes={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('quote-lost-reason-select'), { target: { value: '1' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-danger-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(1, null, null, null, true);
  });
});
