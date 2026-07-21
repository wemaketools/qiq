import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import BrokerMatrixScatter, { MatrixTooltipContent } from '../brokers/BrokerMatrixScatter';
import type { BrokerMatrixDto } from '../brokersApi';

const MATRIX: BrokerMatrixDto = {
  points: [
    { brokerId: 1, brokerName: 'Alpha Brokers', quoteVolume: 4, conversionRate: 0.75, wonPremium: 300_000, quadrant: 'high-high', drillWidgetKey: 'broker.quotes' },
    { brokerId: 2, brokerName: 'Beta Brokers', quoteVolume: 4, conversionRate: 0.25, wonPremium: 50_000, quadrant: 'high-low', drillWidgetKey: 'broker.quotes' },
    { brokerId: 3, brokerName: 'Gamma Brokers', quoteVolume: 1, conversionRate: 1.0, wonPremium: 20_000, quadrant: 'low-high', drillWidgetKey: 'broker.quotes' },
  ],
  volumeSplit: 4,
  conversionSplit: 0.75,
  drillWidgetKey: 'broker.quotes',
};

describe('BrokerMatrixScatter', () => {
  it('render_WhenPointsProvided_ShouldDirectLabelEveryBrokerName', () => {
    render(<BrokerMatrixScatter matrix={MATRIX} currencyCode="BWP" onDrillBroker={vi.fn()} />);

    const matrix = within(screen.getByTestId('broker-matrix'));
    expect(matrix.getByText('Alpha Brokers')).toBeInTheDocument();
    expect(matrix.getByText('Beta Brokers')).toBeInTheDocument();
    expect(matrix.getByText('Gamma Brokers')).toBeInTheDocument();
  });

  it('render_WhenTooltipActive_ShouldNameBrokerWithQuadrantAndMetrics', () => {
    render(<MatrixTooltipContent active payload={[{ payload: MATRIX.points[0]! }]} currencyCode="BWP" />);

    const tooltip = within(screen.getByTestId('broker-matrix-tooltip'));
    expect(tooltip.getByText('Alpha Brokers')).toBeInTheDocument();
    expect(tooltip.getByText('High Volume / High Conversion')).toBeInTheDocument();
    expect(tooltip.getByText('Quote volume: 4')).toBeInTheDocument();
    expect(tooltip.getByText('Conversion: 75.0%')).toBeInTheDocument();
    expect(tooltip.getByText('Won premium: BWP 300,000')).toBeInTheDocument();
  });

  it('render_WhenTooltipActive_ShouldColorSwatchFromSharedQuadrantPalette', () => {
    render(<MatrixTooltipContent active payload={[{ payload: MATRIX.points[1]! }]} currencyCode="BWP" />);

    const swatch = screen.getByTestId('broker-matrix-tooltip-swatch');
    expect(swatch).toHaveStyle({ background: 'var(--qiq-quadrant-high-low)' });
  });

  it('render_WhenTooltipInactive_ShouldRenderNothing', () => {
    const { container } = render(
      <MatrixTooltipContent active={false} payload={[{ payload: MATRIX.points[0]! }]} currencyCode="BWP" />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
