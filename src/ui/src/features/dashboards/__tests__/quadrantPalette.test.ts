import { describe, expect, it } from 'vitest';
import { QUADRANTS, quadrantColor } from '../quadrantPalette';

/**
 * Locks the single-source PRD 15.3 quadrant palette (T-034) that both the Broker matrix shading and its
 * legend consume, and that the RM Performance matrix (T-035) imports unchanged: the four generic
 * volume/conversion categories, keyed to the server payload, colored only via `--qiq-*` tokens (V-070).
 */
describe('quadrantPalette', () => {
  it('QUADRANTS_ShouldExposeTheFourPrd153CategoriesInOrder', () => {
    expect(QUADRANTS.map((q) => q.key)).toEqual(['high-high', 'high-low', 'low-high', 'low-low']);
    expect(QUADRANTS.map((q) => q.label)).toEqual([
      'High Volume / High Conversion',
      'High Volume / Low Conversion',
      'Low Volume / High Conversion',
      'Low Volume / Low Conversion',
    ]);
  });

  it('QUADRANTS_ShouldSourceEveryColorFromAQiqToken', () => {
    for (const quadrant of QUADRANTS) {
      expect(quadrant.color).toMatch(/^var\(--qiq-quadrant-/);
    }
  });

  it('quadrantColor_ShouldResolveKnownKeysAndFallBackForUnknown', () => {
    expect(quadrantColor('high-high')).toBe('var(--qiq-quadrant-high-high)');
    expect(quadrantColor('low-low')).toBe('var(--qiq-quadrant-low-low)');
    expect(quadrantColor('nonsense')).toBe('var(--qiq-quadrant-low-low)');
  });
});
