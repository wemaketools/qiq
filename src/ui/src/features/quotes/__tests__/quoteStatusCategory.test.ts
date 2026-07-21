import { describe, expect, it } from 'vitest';
import { deriveQuoteReportingCategory, isQuoteClosed } from '../quoteStatusCategory';

describe('quoteStatusCategory', () => {
  it.each([
    ['draft', 'open'],
    ['sent', 'quoted'],
    ['revised', 'quoted'],
    ['won', 'won'],
    ['lost', 'lost'],
    ['expired', 'expired'],
    ['withdrawn', 'withdrawn'],
    [null, 'open'],
    ['unknown', 'open'],
  ] as const)('deriveQuoteReportingCategory_WhenCanonicalKeyIs%s_ShouldReturn%s', (key, expected) => {
    // Act
    const result = deriveQuoteReportingCategory(key);

    // Assert
    expect(result).toBe(expected);
  });

  it.each([
    ['draft', false],
    ['sent', false],
    ['revised', false],
    ['won', true],
    ['lost', true],
    ['expired', true],
    ['withdrawn', true],
    [null, false],
  ] as const)('isQuoteClosed_WhenCanonicalKeyIs%s_ShouldReturn%s', (key, expected) => {
    // Act
    const result = isQuoteClosed(key);

    // Assert
    expect(result).toBe(expected);
  });
});
