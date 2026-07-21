import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';
import { resolveSeriesColor } from '../palettes';

export interface BarChartDatum {
  label: string;
  value: number;
  /** Product-line name driving the bar's series color (`resolveSeriesColor`); omitted -> the chart's single fixed `color` prop is used for every bar. */
  seriesName?: string;
}

interface BarChartWidgetProps {
  data: BarChartDatum[];
  /** Fallback fill when a datum has no `seriesName` (e.g. a single-series bar chart like "open items per stage"). */
  color?: string;
  width?: number;
  height?: number;
  onBarClick?: (datum: BarChartDatum) => void;
}

/**
 * Thin Recharts bar-chart wrapper (spec §10.1, T-031): token-based series coloring via
 * `resolveSeriesColor`, click-to-drill (AC-053: every chart/row drills through). A fixed
 * `width`/`height` is used rather than `ResponsiveContainer` so the chart renders deterministically
 * in both jsdom component tests and real layouts (the parent `ChartCard` controls visual sizing via CSS).
 */
function BarChartWidget({ data, color = 'var(--qiq-accent)', width = 560, height = 280, onBarClick }: BarChartWidgetProps) {
  return (
    <div data-testid="bar-chart" data-point-count={data.length}>
      <BarChart data={data} width={width} height={height}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--qiq-border-subtle)" />
        <XAxis dataKey="label" stroke="var(--qiq-text-secondary)" />
        <YAxis stroke="var(--qiq-text-secondary)" />
        <Tooltip />
        <Bar
          dataKey="value"
          onClick={(payload: unknown) => onBarClick?.(payload as BarChartDatum)}
          fill={color}
          isAnimationActive={false}
        >
          {data.map((datum) => (
            <Cell key={datum.label} fill={datum.seriesName ? resolveSeriesColor(datum.seriesName) : color} />
          ))}
        </Bar>
      </BarChart>
    </div>
  );
}

export default BarChartWidget;
