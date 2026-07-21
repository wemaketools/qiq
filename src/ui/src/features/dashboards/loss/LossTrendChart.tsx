import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import ChartCard from '../../../components/dashboards/ChartCard';
import type { LossTrendDto } from '../lossApi';

interface LossTrendChartProps {
  trend: LossTrendDto;
  onDrill: (widgetKey: string) => void;
}

/**
 * Lost Premium Trend (spec FR-59, PRD 16, T-036): the last six months of premium lost, rendered as a
 * line with an area fill in the danger (red) hue. Clicking the chart drills to the trend-by-reason loss
 * list (AC-058). Uses the shared Recharts dependency (as `LineChartWidget` does) with token colors.
 */
function LossTrendChart({ trend, onDrill }: LossTrendChartProps) {
  const data = trend.points.map((point) => ({ label: point.monthLabel, amount: point.amount }));

  return (
    <ChartCard title="Lost Premium Trend" onViewDetails={() => onDrill(trend.drillWidgetKey)}>
      <div data-testid="loss-trend" data-point-count={data.length}>
        <AreaChart data={data} width={560} height={280}>
          <defs>
            <linearGradient id="lossTrendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--qiq-danger)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--qiq-danger)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--qiq-border-subtle)" />
          <XAxis dataKey="label" stroke="var(--qiq-text-secondary)" />
          <YAxis stroke="var(--qiq-text-secondary)" />
          <Tooltip />
          <Area
            type="monotone"
            dataKey="amount"
            name="Lost Premium"
            stroke="var(--qiq-danger)"
            fill="url(#lossTrendFill)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </div>
    </ChartCard>
  );
}

export default LossTrendChart;
