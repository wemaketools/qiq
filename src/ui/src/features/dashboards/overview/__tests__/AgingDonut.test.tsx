import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgingDonut from '../AgingDonut';
import type { ExecutiveAgingDto } from '../../executiveApi';

/** The four buckets `GetExecutiveOverviewQueryHandler.BuildAging` always emits, in its order. */
const AGING: ExecutiveAgingDto = {
  buckets: [
    { bucket: '0-3 days', count: 33, share: 0.11 },
    { bucket: '4-7 days', count: 24, share: 0.08 },
    { bucket: '8-14 days', count: 12, share: 0.04 },
    { bucket: '15+ days', count: 239, share: 0.78 },
  ],
  totalOpenQuotes: 308,
  drillWidgetKey: 'open_pipeline',
};

function renderDonut() {
  return render(<AgingDonut aging={AGING} onDrill={vi.fn()} onViewAgingReport={vi.fn()} />);
}

/** Fill of each donut slice, in bucket order. */
function sliceFills(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.recharts-pie-sector path')).map((path) => path.getAttribute('fill'));
}

/** Colour of each legend swatch, in bucket order. */
function swatchColors(): string[] {
  return Array.from(screen.getByTestId('aging-legend').querySelectorAll<HTMLElement>('span[aria-hidden="true"]')).map(
    (swatch) => swatch.style.background,
  );
}

describe('AgingDonut', () => {
  it('render_Always_ShouldPaintEveryLegendSwatchTheSameColourAsItsSlice', () => {
    // Arrange & Act
    const { container } = renderDonut();

    // Assert: the regression guard. The slices and the legend used to pick colours from two
    // independent arrays, so the 15+ bucket drew red against a teal legend dot.
    const fills = sliceFills(container);
    expect(fills).toHaveLength(AGING.buckets.length);
    expect(fills).toEqual(swatchColors());
  });

  it('render_Always_ShouldRampFromSuccessToDangerAsBucketsAge', () => {
    // Arrange & Act
    const { container } = renderDonut();

    // Assert: age buckets are an ordered severity ramp — the oldest, most at-risk bucket is the
    // danger one, matching LeadsTable's fresh/amber/red lead-age convention.
    expect(sliceFills(container)).toEqual([
      'var(--qiq-success)',
      'var(--qiq-info)',
      'var(--qiq-warning)',
      'var(--qiq-danger)',
    ]);
  });
});
