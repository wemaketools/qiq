import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import FunnelChartWidget from '../charts/FunnelChartWidget';

describe('FunnelChartWidget', () => {
  it('render_GivenDescendingStages_ShouldTaperBarWidthByValue', () => {
    // Arrange & Act: cumulative conversion funnel, Lost last (spec FR-56).
    render(
      <FunnelChartWidget
        stages={[
          { label: 'Leads', value: 100 },
          { label: 'Quoted', value: 60 },
          { label: 'Won', value: 20 },
          { label: 'Lost', value: 40 },
        ]}
      />,
    );

    // Assert
    const bars = screen.getAllByTestId('funnel-stage-bar');
    expect(bars).toHaveLength(4);
    const leadsWidth = Number(bars[0]!.style.width.replace('%', ''));
    const wonWidth = Number(bars[2]!.style.width.replace('%', ''));
    expect(leadsWidth).toBeGreaterThan(wonWidth);
    expect(screen.getByText('Lost')).toBeInTheDocument();
  });
});
