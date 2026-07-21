import { describe, expect, it } from 'vitest';
import { labelForQuoteOperation } from '../quoteOperations';
import { QUOTE_OPERATION_CODES } from '../quotesApi';

describe('quoteOperations', () => {
  it('labelForQuoteOperation_WhenKnownCode_ShouldReturnDisplayLabel', () => {
    // Act & Assert
    expect(labelForQuoteOperation(QUOTE_OPERATION_CODES.MarkWon)).toBe('Mark won');
    expect(labelForQuoteOperation(QUOTE_OPERATION_CODES.Send)).toBe('Send');
    expect(labelForQuoteOperation(QUOTE_OPERATION_CODES.SetCurrent)).toBe('Set current');
  });

  it('labelForQuoteOperation_WhenUnknownCode_ShouldReturnCodeVerbatim', () => {
    // Act
    const result = labelForQuoteOperation('some-unmapped-op');

    // Assert
    expect(result).toBe('some-unmapped-op');
  });
});
