import { useState } from 'react';
import ChartCard from '../../../components/dashboards/ChartCard';
import LineChartWidget from '../../../components/dashboards/charts/LineChartWidget';
import type { LineChartSeries } from '../../../components/dashboards/charts/LineChartWidget';
import { formatCompactCurrency } from '../../../components/dashboards/formatters';
import type { ExecutiveTrendDto } from '../executiveApi';

interface WonLostTrendProps {
  trend: ExecutiveTrendDto;
  currencyCode: string;
  onViewTrendAnalysis: () => void;
}

type Granularity = 'weekly' | 'monthly';

/**
 * Won vs Lost Trend (spec FR-55, T-032): won premium (solid) vs lost premium (dashed) with a
 * Weekly/Monthly selector that toggles between the two pre-bucketed series without a refetch.
 */
function WonLostTrend({ trend, currencyCode, onViewTrendAnalysis }: WonLostTrendProps) {
  const [granularity, setGranularity] = useState<Granularity>('weekly');

  const points = granularity === 'weekly' ? trend.weekly : trend.monthly;
  const data = points.map((point) => ({ label: point.label, won: point.wonPremium, lost: point.lostPremium }));

  const series: LineChartSeries[] = [
    { key: 'won', name: `Won Premium (${currencyCode})`, color: 'var(--qiq-success)' },
    { key: 'lost', name: `Lost Premium (${currencyCode})`, color: 'var(--qiq-danger)', dash: '6 4' },
  ];

  return (
    <ChartCard title="Won vs Lost Trend" viewAllLabel="View trend analysis" onViewAll={onViewTrendAnalysis}>
      <div data-testid="won-lost-trend">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--qiq-space-2)' }}>
          <label htmlFor="trend-granularity" className="qiq-card-sub" style={{ marginRight: 'var(--qiq-space-2)' }}>
            Period
          </label>
          <select
            id="trend-granularity"
            data-testid="trend-granularity"
            value={granularity}
            onChange={(event) => setGranularity(event.target.value as Granularity)}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        {/* Compact currency on the y-axis (AC-074 "compact notation on cards/axes"): raw premium
            values ("26000000") overflowed and clipped in the axis gutter. */}
        <LineChartWidget data={data} series={series} yTickFormatter={(value) => formatCompactCurrency(value, currencyCode)} />
      </div>
    </ChartCard>
  );
}

export default WonLostTrend;
