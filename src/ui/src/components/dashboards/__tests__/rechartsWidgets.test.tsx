import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BarChartWidget from '../charts/BarChartWidget';
import DonutChartWidget from '../charts/DonutChartWidget';
import LineChartWidget from '../charts/LineChartWidget';

describe('Recharts wrapper smoke tests', () => {
  it('render_BarChartWidget_ShouldRenderPointCountFromData', () => {
    // Arrange & Act
    render(<BarChartWidget data={[{ label: 'Assigned', value: 10 }, { label: 'Pricing', value: 5 }]} onBarClick={vi.fn()} />);

    // Assert
    expect(screen.getByTestId('bar-chart')).toHaveAttribute('data-point-count', '2');
  });

  it('render_DonutChartWidget_ShouldRenderPointCountFromData', () => {
    // Arrange & Act
    render(<DonutChartWidget data={[{ label: '0-3d', value: 10 }, { label: '4-7d', value: 5 }]} />);

    // Assert
    expect(screen.getByTestId('donut-chart')).toHaveAttribute('data-point-count', '2');
  });

  it('render_LineChartWidget_ShouldRenderPointCountFromData', () => {
    // Arrange & Act
    render(
      <LineChartWidget
        data={[
          { label: 'Jan', won: 10, lost: 4 },
          { label: 'Feb', won: 12, lost: 3 },
        ]}
        series={[
          { key: 'won', name: 'Won', color: 'var(--qiq-success)' },
          { key: 'lost', name: 'Lost', color: 'var(--qiq-danger)' },
        ]}
      />,
    );

    // Assert
    expect(screen.getByTestId('line-chart')).toHaveAttribute('data-point-count', '2');
  });

  it('render_LineChartWidget_WhenYTickFormatterGiven_ShouldFormatAxisTicks', () => {
    // Arrange & Act
    render(
      <LineChartWidget
        data={[
          { label: 'Jan', won: 10_000_000 },
          { label: 'Feb', won: 20_000_000 },
        ]}
        series={[{ key: 'won', name: 'Won', color: 'var(--qiq-success)' }]}
        yTickFormatter={(value) => `F${value}`}
      />,
    );

    // Assert: y-axis tick labels render through the formatter (raw "26000000"-style ticks clipped).
    const tickTexts = Array.from(
      screen.getByTestId('line-chart').querySelectorAll('.recharts-yAxis-tick-labels text'),
    ).map((node) => node.textContent);
    expect(tickTexts.length).toBeGreaterThan(0);
    expect(tickTexts.every((text) => text?.startsWith('F'))).toBe(true);
  });

  it('render_LineChartWidget_WhenContainerUnmeasured_ShouldRenderAtFallbackWidth', () => {
    // Arrange & Act: jsdom performs no layout, so the container-width measurement never fires and
    // the chart must deterministically render at the 560px fallback (the pre-fix fixed width).
    render(
      <LineChartWidget
        data={[{ label: 'Jan', won: 10, lost: 4 }]}
        series={[{ key: 'won', name: 'Won', color: 'var(--qiq-success)' }]}
      />,
    );

    // Assert
    const svg = screen.getByTestId('line-chart').querySelector('svg');
    expect(svg).toHaveAttribute('width', '560');
  });
});
