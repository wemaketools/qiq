import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { resolveSeriesColor } from '../palettes';

export interface DonutChartDatum {
  label: string;
  value: number;
  /**
   * Explicit slice color, winning over `seriesName`. Callers that render their own legend must set
   * this and paint their swatches from the same array — otherwise the legend and the slices each pick
   * their own colors and silently disagree.
   */
  color?: string;
  /** Drives the slice's series color via `resolveSeriesColor`; falls back to a neutral rotation when omitted. */
  seriesName?: string;
}

/** Typed as a non-empty tuple so the modulo lookup below has a statically guaranteed fallback element. */
const NEUTRAL_ROTATION: readonly [string, ...string[]] = ['var(--qiq-info)', 'var(--qiq-accent)', 'var(--qiq-warning)', 'var(--qiq-danger)', 'var(--qiq-neutral)'];

function resolveFill(datum: DonutChartDatum, index: number): string {
  if (datum.color) {
    return datum.color;
  }
  if (datum.seriesName) {
    return resolveSeriesColor(datum.seriesName);
  }
  // `index` is a non-negative render index, so the modulo is always in range; the `??` only satisfies
  // `noUncheckedIndexedAccess` and is unreachable at runtime.
  return NEUTRAL_ROTATION[index % NEUTRAL_ROTATION.length] ?? NEUTRAL_ROTATION[0];
}

interface DonutChartWidgetProps {
  data: DonutChartDatum[];
  width?: number;
  height?: number;
  onSliceClick?: (datum: DonutChartDatum) => void;
}

/** Thin Recharts donut wrapper (`innerRadius` > 0, spec §10.1, T-031), token-based series coloring, click-to-drill (AC-053). */
function DonutChartWidget({ data, width = 280, height = 280, onSliceClick }: DonutChartWidgetProps) {
  return (
    <div data-testid="donut-chart" data-point-count={data.length}>
      <PieChart width={width} height={height}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius={height * 0.28}
          outerRadius={height * 0.42}
          isAnimationActive={false}
          onClick={(payload: unknown) => onSliceClick?.(payload as DonutChartDatum)}
        >
          {data.map((datum, index) => (
            <Cell key={datum.label} fill={resolveFill(datum, index)} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </div>
  );
}

export default DonutChartWidget;
