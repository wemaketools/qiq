import { describe, expect, it } from 'vitest';
import { formatCompactCurrency, formatFullCurrency, formatPercent } from '../formatters';

describe('formatters', () => {
  describe('formatCompactCurrency', () => {
    it('format_WhenMillions_ShouldRenderCompactMSuffix', () => {
      // Arrange & Act
      const result = formatCompactCurrency(128_600_000, 'BWP');

      // Assert
      expect(result).toBe('BWP 128.6M');
    });

    it('format_WhenThousands_ShouldRenderCompactKSuffix', () => {
      // Arrange & Act
      const result = formatCompactCurrency(45_300, 'BWP');

      // Assert
      expect(result).toBe('BWP 45.3K');
    });

    it('format_WhenBelowThousand_ShouldRenderWholeNumber', () => {
      // Arrange & Act
      const result = formatCompactCurrency(850, 'BWP');

      // Assert
      expect(result).toBe('BWP 850');
    });

    it('format_WhenNull_ShouldRenderEmDash', () => {
      // Arrange & Act
      const result = formatCompactCurrency(null, 'BWP');

      // Assert
      expect(result).toBe('—');
    });
  });

  describe('formatFullCurrency', () => {
    it('format_WhenGivenAmount_ShouldRenderFullGroupedAmount', () => {
      // Arrange & Act
      const result = formatFullCurrency(1_750_000, 'BWP');

      // Assert
      expect(result).toBe('BWP 1,750,000');
    });

    it('format_WhenNull_ShouldRenderEmDash', () => {
      // Arrange & Act
      const result = formatFullCurrency(null, 'BWP');

      // Assert
      expect(result).toBe('—');
    });
  });

  describe('formatPercent', () => {
    it('format_WhenFractionalRate_ShouldRenderOneDecimalPercent', () => {
      // Arrange & Act
      const result = formatPercent(0.339);

      // Assert
      expect(result).toBe('33.9%');
    });

    it('format_WhenNull_ShouldRenderEmDash', () => {
      // Arrange & Act
      const result = formatPercent(null);

      // Assert
      expect(result).toBe('—');
    });
  });
});
