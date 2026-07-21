import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import KpiCard from '../KpiCard';

describe('KpiCard', () => {
  it('render_WhenHigherIsBetterAndDeltaPositive_ShouldColorDeltaGreen', () => {
    // Arrange & Act
    render(
      <KpiCard
        label="Conversion Rate"
        value="33.9%"
        delta="+3.6pp"
        goodDirection="higherIsBetter"
        isFavorableDelta
      />,
    );

    // Assert
    expect(screen.getByTestId('kpi-delta')).toHaveStyle({ color: 'var(--qiq-success)' });
    expect(screen.getByTestId('kpi-delta')).toHaveTextContent('+3.6pp');
  });

  it('render_WhenLowerIsBetterAndValueFalling_ShouldColorDeltaGreen', () => {
    // Arrange & Act: Average Turnaround falling (spec example: "2.6 days ↓0.6", delta green when falling).
    render(
      <KpiCard
        label="Average Turnaround"
        value="2.6 days"
        delta="-0.6"
        goodDirection="lowerIsBetter"
        isFavorableDelta
      />,
    );

    // Assert
    expect(screen.getByTestId('kpi-delta')).toHaveStyle({ color: 'var(--qiq-success)' });
  });

  it('render_WhenUnfavorableDelta_ShouldColorDeltaRed', () => {
    // Arrange & Act: Lost Premium rising is bad news (lowerIsBetter, delta positive -> unfavorable).
    render(
      <KpiCard
        label="Lost Premium"
        value="BWP 3.1M"
        delta="+0.4M"
        goodDirection="lowerIsBetter"
        isFavorableDelta={false}
      />,
    );

    // Assert
    expect(screen.getByTestId('kpi-delta')).toHaveStyle({ color: 'var(--qiq-danger)' });
  });

  it('render_WhenNoDelta_ShouldOmitDeltaElement', () => {
    // Arrange & Act
    render(<KpiCard label="Open Pipeline Premium" value="BWP 128.6M" delta={null} goodDirection="higherIsBetter" isFavorableDelta={null} />);

    // Assert
    expect(screen.queryByTestId('kpi-delta')).not.toBeInTheDocument();
  });

  it('render_WhenClickable_ShouldInvokeOnClickForDrillThrough', () => {
    // Arrange
    let clicked = false;
    render(
      <KpiCard
        label="Conversion Rate"
        value="33.9%"
        delta={null}
        goodDirection="higherIsBetter"
        isFavorableDelta={null}
        onClick={() => {
          clicked = true;
        }}
      />,
    );

    // Act
    screen.getByTestId('kpi-card').click();

    // Assert
    expect(clicked).toBe(true);
  });
});
