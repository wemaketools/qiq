import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChartCard from '../ChartCard';

describe('ChartCard', () => {
  it('render_WhenGivenTitleAndLink_ShouldRenderBoth', () => {
    // Arrange & Act
    render(
      <ChartCard title="Open Items per Stage" viewAllLabel="View pipeline" onViewAll={vi.fn()}>
        <div>chart body</div>
      </ChartCard>,
    );

    // Assert
    expect(screen.getByText('Open Items per Stage')).toBeInTheDocument();
    expect(screen.getByTestId('chart-card-view-all')).toHaveTextContent('View pipeline →');
  });

  it('click_WhenMenuButtonClicked_ShouldRevealExportAndViewDetails', () => {
    // Arrange
    render(
      <ChartCard
        title="Won/Lost Trend"
        exportConfig={{ widgetKey: 'leads.filtered', filter: {}, fileNameBase: 'won-lost' }}
        onViewDetails={vi.fn()}
      >
        <div>chart body</div>
      </ChartCard>,
    );

    // Act
    fireEvent.click(screen.getByTestId('chart-card-menu-button'));

    // Assert: CSV + Excel export items and View details are all present (spec FR-65, T-039).
    expect(screen.getByTestId('chart-card-menu-export-csv')).toBeInTheDocument();
    expect(screen.getByTestId('chart-card-menu-export-xlsx')).toBeInTheDocument();
    expect(screen.getByTestId('chart-card-menu-view-details')).toBeInTheDocument();
  });

  it('render_WhenNoExportConfigAndNoViewDetails_ShouldRenderNoMenu', () => {
    // Arrange & Act
    render(
      <ChartCard title="Won/Lost Trend">
        <div>chart body</div>
      </ChartCard>,
    );

    // Assert
    expect(screen.queryByTestId('chart-card-menu-button')).not.toBeInTheDocument();
  });
});
