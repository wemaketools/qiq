import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NewQuoteModal from '../NewQuoteModal';
import type { ReferenceItemDto } from '../../settings/settingsApi';

function referenceItem(id: number, name: string, productLineId: number | null = null): ReferenceItemDto {
  return {
    id,
    listType: 'product_line',
    name,
    displayOrder: id,
    isActive: true,
    isBrokerChannel: null,
    productLineId,
    reportingCategory: null,
    canonicalKey: null,
    isTerminal: false,
  };
}

const PRODUCT_LINES: ReferenceItemDto[] = [referenceItem(1, 'Motor'), referenceItem(2, 'Property')];
const COVER_TYPES: ReferenceItemDto[] = [referenceItem(10, 'Comprehensive', 1), referenceItem(11, 'Fire', 2)];

describe('NewQuoteModal', () => {
  it('render_WhenOpen_ShouldShowReadOnlyRefAndVersionPlaceholders', () => {
    // Arrange & Act
    render(
      <NewQuoteModal
        open
        leadDateReceived="2026-01-01"
        defaultProductLineId={1}
        defaultCoverTypeId={10}
        productLineOptions={PRODUCT_LINES}
        coverTypeOptions={COVER_TYPES}
        currencySymbol="BWP"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Assert: no ref/version placeholders — the system-assigned values only show on the saved quote.
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('New Quote');
    expect(screen.queryByTestId('new-quote-ref-placeholder')).toBeNull();
    expect(screen.queryByTestId('new-quote-version-placeholder')).toBeNull();
    expect(screen.getByLabelText('Product line')).toHaveValue('1');
    expect(screen.getByLabelText('Cover type')).toHaveValue('10');
  });

  it('click_WhenConfirmedWithoutPremium_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <NewQuoteModal
        open
        leadDateReceived="2026-01-01"
        defaultProductLineId={1}
        defaultCoverTypeId={10}
        productLineOptions={PRODUCT_LINES}
        coverTypeOptions={COVER_TYPES}
        currencySymbol="BWP"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-premium')).toHaveTextContent('Quoted premium must be greater than zero.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenPreparedDateBeforeLeadReceived_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <NewQuoteModal
        open
        leadDateReceived="2026-06-01"
        defaultProductLineId={1}
        defaultCoverTypeId={10}
        productLineOptions={PRODUCT_LINES}
        coverTypeOptions={COVER_TYPES}
        currencySymbol="BWP"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Quoted premium *'), { target: { value: '750000' } });
    fireEvent.change(screen.getByLabelText('Prepared date'), { target: { value: '2026-01-01' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-prepared-date')).toHaveTextContent("Prepared date cannot precede the lead's date received.");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenValidFieldsProvided_ShouldCallOnConfirmWithDraftPayload', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(
      <NewQuoteModal
        open
        leadDateReceived="2026-01-01"
        defaultProductLineId={1}
        defaultCoverTypeId={10}
        productLineOptions={PRODUCT_LINES}
        coverTypeOptions={COVER_TYPES}
        currencySymbol="BWP"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Quoted premium *'), { target: { value: '750000' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ productLineId: 1, coverTypeId: 10, quotedPremium: 750000, validUntil: null, notes: null }),
    );
  });

  it('change_WhenProductLineChanged_ShouldResetCoverType', () => {
    // Arrange
    render(
      <NewQuoteModal
        open
        leadDateReceived="2026-01-01"
        defaultProductLineId={1}
        defaultCoverTypeId={10}
        productLineOptions={PRODUCT_LINES}
        coverTypeOptions={COVER_TYPES}
        currencySymbol="BWP"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Act
    fireEvent.change(screen.getByLabelText('Product line'), { target: { value: '2' } });

    // Assert
    expect(screen.getByLabelText('Cover type')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Fire' })).toBeInTheDocument();
  });
});
