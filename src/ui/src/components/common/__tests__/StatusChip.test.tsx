import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusChip from '../StatusChip';
import type { ReportingCategory } from '../StatusChip';

describe('StatusChip', () => {
  // T-043: the reporting-category palette moved from inline styles into the shared
  // `.qiq-chip--{category}` classes (theme/components.css, UI Standards §4.1), so the contract
  // asserted here is the class binding (jsdom does not compute stylesheet-applied CSS values).
  const categories: ReportingCategory[] = ['open', 'quoted', 'won', 'lost', 'expired', 'withdrawn'];

  for (const category of categories) {
    it(`render_WhenCategoryIs${category}_ShouldUseReportingCategoryPalette`, () => {
      // Arrange & Act
      render(<StatusChip label="Some Status" category={category} />);

      // Assert
      const chip = screen.getByTestId('status-chip');
      expect(chip).toHaveAttribute('data-reporting-category', category);
      expect(chip).toHaveClass('qiq-chip', `qiq-chip--${category}`);
    });
  }

  it('render_ShouldAlwaysCarryTextLabel_NotColorAlone', () => {
    // Arrange & Act: AC-069 -- color is never the only signal.
    render(<StatusChip label="Closed Won" category="won" />);

    // Assert
    expect(screen.getByTestId('status-chip')).toHaveTextContent('Closed Won');
  });
});
