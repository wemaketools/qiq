import { CartesianGrid, Cell, LabelList, ReferenceArea, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis, type LabelProps } from 'recharts';
import ChartCard from '../../../components/dashboards/ChartCard';
import { formatFullCurrency, formatPercent } from '../../../components/dashboards/formatters';
import type { BrokerMatrixDto, BrokerMatrixPointDto } from '../brokersApi';
import { QUADRANTS, quadrantColor } from '../quadrantPalette';

interface MatrixTooltipContentProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: BrokerMatrixPointDto }>;
  currencyCode: string;
}

/**
 * Custom scatter tooltip naming the hovered broker (Recharts' default tooltip only lists the axis
 * values, leaving the point anonymous) plus its palette-colored quadrant and the three encoded metrics.
 * Exported for direct unit testing — Recharts tooltip activation isn't reliably drivable in jsdom.
 */
export function MatrixTooltipContent({ active, payload, currencyCode }: MatrixTooltipContentProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }
  const quadrant = QUADRANTS.find((entry) => entry.key === point.quadrant);
  return (
    <div
      data-testid="broker-matrix-tooltip"
      style={{
        background: 'var(--qiq-surface-raised)',
        border: '1px solid var(--qiq-border-subtle)',
        borderRadius: 'var(--qiq-radius-card)',
        boxShadow: 'var(--qiq-shadow-card)',
        padding: 'var(--qiq-space-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--qiq-space-1)',
      }}
    >
      <strong style={{ color: 'var(--qiq-text-primary)' }}>{point.brokerName}</strong>
      {quadrant && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
          <span
            aria-hidden="true"
            data-testid="broker-matrix-tooltip-swatch"
            style={{ width: 10, height: 10, borderRadius: '2px', background: quadrant.color }}
          />
          <span className="qiq-kpi-label">{quadrant.label}</span>
        </span>
      )}
      <span style={{ color: 'var(--qiq-text-secondary)' }}>Quote volume: {point.quoteVolume}</span>
      <span style={{ color: 'var(--qiq-text-secondary)' }}>Conversion: {formatPercent(point.conversionRate)}</span>
      <span style={{ color: 'var(--qiq-text-secondary)' }}>Won premium: {formatFullCurrency(point.wonPremium, currencyCode)}</span>
    </div>
  );
}

/**
 * Recharts' label `viewBox` is a cartesian-or-polar union; this scatter is cartesian, so the polar
 * shape (which carries `cx`/`cy` instead of `x`/`y`) is narrowed out rather than cast away.
 */
function isCartesianViewBox(box: NonNullable<LabelProps['viewBox']>): box is Extract<NonNullable<LabelProps['viewBox']>, { x: number }> {
  return 'x' in box;
}

interface LabelRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function intersects(a: LabelRect, b: LabelRect): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

const LABEL_FONT_SIZE = 11;
/** One rendered line of LABEL_FONT_SIZE text, ascent to descent. */
const LABEL_HEIGHT = 12;
/** Estimated advance per character at LABEL_FONT_SIZE — labels are measured, not wrapped. */
const AVG_CHAR_WIDTH = 6.2;
/** Keep-out band above the bottom edge where the x-axis ticks live. */
const X_AXIS_BAND = 35;
const EDGE_PAD = 2;

/**
 * Collision-aware, SELECTIVE broker-name labels for the scatter's `LabelList`.
 *
 * The previous renderer labeled every point independently (stagger by index parity, flip below at
 * the top edge) — with clustered brokers the labels overwrote each other and clipped at the plot
 * top. This one lays labels out greedily with shared state: each label tries above, below, right,
 * then left of its bubble, takes the first spot that stays on the canvas (clear of the x-axis
 * band) and does not intersect an already-placed label, and is DROPPED entirely when no spot is
 * free. A dropped label loses nothing: the hover tooltip and the Broker Performance table below
 * the chart name every broker.
 *
 * Placement accumulates in the closure for one render pass (the factory runs per component
 * render, so the map starts empty each pass); rects are keyed by point index so a re-invocation
 * for the same label replaces its own entry instead of colliding with it.
 */
function makeBrokerLabelRenderer(canvasWidth: number, canvasHeight: number) {
  const placedByIndex = new Map<number, LabelRect>();

  return function renderBrokerLabel(props: LabelProps) {
    const box = props.viewBox;
    if (!box || !isCartesianViewBox(box) || box.x == null || box.y == null) {
      return null;
    }
    const index = props.index ?? -1;
    const label = String(props.value ?? '');
    if (label.length === 0) {
      return null;
    }

    const boxWidth = box.width ?? 0;
    const boxHeight = box.height ?? 0;
    const cx = box.x + boxWidth / 2;
    const cy = box.y + boxHeight / 2;
    const textWidth = label.length * AVG_CHAR_WIDTH;
    const half = textWidth / 2;
    // Middle-anchored candidates slide inward so the text itself never leaves the canvas.
    const clampedCx = Math.min(Math.max(cx, half + EDGE_PAD), canvasWidth - half - EDGE_PAD);

    const candidates: ReadonlyArray<{ x: number; y: number; anchor: 'middle' | 'start' | 'end' }> = [
      { x: clampedCx, y: box.y - 6, anchor: 'middle' },
      { x: clampedCx, y: box.y + boxHeight + LABEL_HEIGHT, anchor: 'middle' },
      { x: box.x + boxWidth + 5, y: cy + 4, anchor: 'start' },
      { x: box.x - 5, y: cy + 4, anchor: 'end' },
    ];

    for (const candidate of candidates) {
      const x1 =
        candidate.anchor === 'middle'
          ? candidate.x - half
          : candidate.anchor === 'start'
            ? candidate.x
            : candidate.x - textWidth;
      const rect: LabelRect = { x1, x2: x1 + textWidth, y1: candidate.y - LABEL_HEIGHT, y2: candidate.y };

      const onCanvas =
        rect.x1 >= EDGE_PAD &&
        rect.x2 <= canvasWidth - EDGE_PAD &&
        rect.y1 >= EDGE_PAD &&
        rect.y2 <= canvasHeight - X_AXIS_BAND;
      if (!onCanvas) {
        continue;
      }

      let collides = false;
      for (const [otherIndex, other] of placedByIndex) {
        if (otherIndex !== index && intersects(rect, other)) {
          collides = true;
          break;
        }
      }
      if (collides) {
        continue;
      }

      placedByIndex.set(index, rect);
      return (
        <text x={candidate.x} y={candidate.y} textAnchor={candidate.anchor} fill="var(--qiq-text-secondary)" fontSize={LABEL_FONT_SIZE}>
          {label}
        </text>
      );
    }

    placedByIndex.delete(index);
    return null;
  };
}

interface BrokerMatrixScatterProps {
  matrix: BrokerMatrixDto;
  /** Tenant display currency for the tooltip's won-premium line (NFR-08: never a hardcoded symbol). */
  currencyCode: string;
  /** Drills to a specific broker's quoted leads (sets the broker filter, then navigates). */
  onDrillBroker: (brokerId: number, widgetKey: string) => void;
  width?: number;
  height?: number;
}

/**
 * Broker Performance Matrix (spec FR-57, PRD 15.1/15.3, T-034): a Recharts scatter with x = quote
 * volume, y = conversion rate, bubble size = won premium, and each point colored by the SERVER-classified
 * quadrant (no client re-derivation). Bubbles are SELECTIVELY direct-labeled with their broker names —
 * `makeBrokerLabelRenderer` drops any label it cannot place without a collision, and hovering names
 * every broker plus its quadrant via `MatrixTooltipContent` (the table below the chart is the complete
 * textual view). The
 * four-quadrant background shading AND the legend both consume the single shared `quadrantPalette`
 * constant (`QUADRANTS`/`quadrantColor`) — the one source of truth imported unchanged by the RM
 * Performance matrix (T-035). Uses Recharts directly (the approved chart lib) rather than the generic
 * `ScatterChartWidget` precisely so it consumes the server quadrant + the shared palette instead of
 * re-classifying client-side. Clicking a point drills to that broker's quoted leads (AC-056).
 */
function BrokerMatrixScatter({ matrix, currencyCode, onDrillBroker, width = 460, height = 340 }: BrokerMatrixScatterProps) {
  const points = matrix.points;
  const maxVolume = points.reduce((max, point) => Math.max(max, point.quoteVolume), 0);
  const volumeMax = Math.max(maxVolume, matrix.volumeSplit * 2, 1);
  const conversionMax = 1;

  const { volumeSplit, conversionSplit } = matrix;

  return (
    <ChartCard title="Broker Performance Matrix" onViewDetails={() => onDrillBroker(0, matrix.drillWidgetKey)}>
      <div data-testid="broker-matrix" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
        {/* Extra top/right margin keeps broker labels visible for points at 100% conversion / max volume. */}
        <ScatterChart width={width} height={height} margin={{ top: 24, right: 28, bottom: 5, left: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--qiq-border-subtle)" />
          {/* Quadrant background shading from the shared palette (PRD 15.3). */}
          <ReferenceArea x1={volumeSplit} x2={volumeMax} y1={conversionSplit} y2={conversionMax} fill={quadrantColor('high-high')} fillOpacity={0.12} stroke="none" />
          <ReferenceArea x1={volumeSplit} x2={volumeMax} y1={0} y2={conversionSplit} fill={quadrantColor('high-low')} fillOpacity={0.12} stroke="none" />
          <ReferenceArea x1={0} x2={volumeSplit} y1={conversionSplit} y2={conversionMax} fill={quadrantColor('low-high')} fillOpacity={0.12} stroke="none" />
          <ReferenceArea x1={0} x2={volumeSplit} y1={0} y2={conversionSplit} fill={quadrantColor('low-low')} fillOpacity={0.12} stroke="none" />
          <XAxis type="number" dataKey="quoteVolume" name="Quote volume" domain={[0, volumeMax]} stroke="var(--qiq-text-secondary)" />
          <YAxis type="number" dataKey="conversionRate" name="Conversion" domain={[0, conversionMax]} stroke="var(--qiq-text-secondary)" />
          <ZAxis type="number" dataKey="wonPremium" range={[80, 480]} name="Won premium" />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<MatrixTooltipContent currencyCode={currencyCode} />} />
          <Scatter
            data={points}
            isAnimationActive={false}
            onClick={(payload: unknown) => {
              const point = payload as { brokerId: number; drillWidgetKey: string };
              onDrillBroker(point.brokerId, point.drillWidgetKey);
            }}
          >
            {/* Selective broker-name labels in text ink; colliding labels drop (tooltip + table name everyone). */}
            <LabelList dataKey="brokerName" content={makeBrokerLabelRenderer(width, height)} />
            {points.map((point) => (
              <Cell key={point.brokerId} fill={quadrantColor(point.quadrant)} />
            ))}
          </Scatter>
        </ScatterChart>

        <ul
          data-testid="quadrant-legend"
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 'var(--qiq-space-3)' }}
        >
          {QUADRANTS.map((quadrant) => (
            <li key={quadrant.key} data-testid="quadrant-legend-item" data-quadrant={quadrant.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '2px', background: quadrant.color }} />
              <span className="qiq-kpi-label">{quadrant.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}

export default BrokerMatrixScatter;
