import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis, type TooltipValueType } from 'recharts';
import { useMeasuredWidth } from './useMeasuredWidth';

export interface LineChartSeries {
  key: string;
  name: string;
  color: string;
  /** Optional Recharts `strokeDasharray` (e.g. "6 4") for a dashed series — the Won-vs-Lost trend renders Lost premium dashed vs Won solid (spec FR-55). Omitted -> solid. */
  dash?: string;
}

/** Pre-measurement / jsdom width; also the deterministic width the widget tests assert against. */
const FALLBACK_WIDTH = 560;

/**
 * Y-axis gutter. Recharts' 60px default clipped the leading digits of wide tick values; 80px fits
 * both compact-currency ("BWP 26.0M") and raw 8-digit ticks. Fixed rather than `width="auto"`
 * because auto-sizing measures rendered text, which jsdom cannot do (see FALLBACK_WIDTH's note).
 */
const Y_AXIS_WIDTH = 80;

interface LineChartWidgetProps {
  /** Each row is one x-axis point (e.g. a month), carrying one numeric value per `series[].key` plus a `label`. */
  data: Array<Record<string, number | string>>;
  series: LineChartSeries[];
  /** Explicit width override; omitted -> the chart fills its container's measured width. */
  width?: number;
  height?: number;
  /** Formats y-axis ticks and tooltip values (e.g. compact currency per NFR-08/AC-074 "compact notation on axes"). Omitted -> raw numbers. */
  yTickFormatter?: (value: number) => string;
}

/**
 * Thin Recharts line-chart wrapper (spec §10.1, PRD 12.6 "won/lost trend with period selector",
 * T-031): one `<Line>` per series, token-based colors supplied by the caller. Sizes itself to its
 * container via `useMeasuredWidth` (fixed 560px fallback pre-measurement and in jsdom) so the chart
 * never spills out of its card at narrow viewports.
 */
function LineChartWidget({ data, series, width, height = 280, yTickFormatter }: LineChartWidgetProps) {
  const { ref, width: measuredWidth } = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH);

  // Recharts' tooltip formatter is typed for any tooltip value (string / array / undefined), while
  // `yTickFormatter` only formats numbers. Every series value fed to this widget is numeric, so the
  // guard is a type bridge rather than a behavior change: numbers format exactly as before, and the
  // non-numeric branch falls back to the raw value that Recharts would have rendered unformatted.
  // Left `undefined` when no formatter is supplied so Recharts keeps its default rendering.
  const tooltipFormatter = yTickFormatter
    ? (value: TooltipValueType | undefined) => (typeof value === 'number' ? yTickFormatter(value) : value)
    : undefined;

  return (
    <div ref={ref} data-testid="line-chart" data-point-count={data.length}>
      <LineChart data={data} width={width ?? measuredWidth} height={height}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--qiq-border-subtle)" />
        <XAxis dataKey="label" stroke="var(--qiq-text-secondary)" />
        <YAxis stroke="var(--qiq-text-secondary)" width={Y_AXIS_WIDTH} tickFormatter={yTickFormatter} />
        <Tooltip formatter={tooltipFormatter} />
        {series.map((line) => (
          <Line
            key={line.key}
            type="monotone"
            dataKey={line.key}
            name={line.name}
            stroke={line.color}
            strokeDasharray={line.dash}
            isAnimationActive={false}
            dot={false}
          />
        ))}
      </LineChart>
    </div>
  );
}

export default LineChartWidget;
