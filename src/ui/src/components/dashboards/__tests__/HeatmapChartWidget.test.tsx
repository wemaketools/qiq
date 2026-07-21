import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import HeatmapChartWidget from '../charts/HeatmapChartWidget';

describe('HeatmapChartWidget', () => {
  it('render_GivenCells_ShouldGradeBackgroundBySeverity', () => {
    // Arrange & Act: pipeline aging heatmap (spec FR-56, open-stage-only).
    render(
      <HeatmapChartWidget
        rowLabels={['Motor', 'Property']}
        columnLabels={['Assigned', 'Underwriting']}
        cells={[
          { row: 'Motor', column: 'Assigned', value: 2, severity: 'normal' },
          { row: 'Motor', column: 'Underwriting', value: 12, severity: 'red' },
          { row: 'Property', column: 'Assigned', value: 5, severity: 'amber' },
          { row: 'Property', column: 'Underwriting', value: 1, severity: 'normal' },
        ]}
      />,
    );

    // Assert
    const cells = screen.getAllByTestId('heatmap-cell');
    expect(cells).toHaveLength(4);
    const redCell = cells.find((cell) => cell.textContent === '12')!;
    expect(redCell).toHaveStyle({ background: 'var(--qiq-danger-soft)' });
    const normalCell = cells.find((cell) => cell.textContent === '2')!;
    expect(normalCell).toHaveStyle({ background: 'var(--qiq-surface-card)' });
  });
});
