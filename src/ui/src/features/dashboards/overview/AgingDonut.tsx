import ChartCard from '../../../components/dashboards/ChartCard';
import DonutChartWidget from '../../../components/dashboards/charts/DonutChartWidget';
import type { ExecutiveAgingDto } from '../executiveApi';

interface AgingDonutProps {
  aging: ExecutiveAgingDto;
  onDrill: (widgetKey: string) => void;
  onViewAgingReport: () => void;
}

/**
 * The four age buckets are an ordered severity ramp, not unrelated categories: fresh (success) through
 * overdue (danger), the same fresh→amber→red convention `LeadsTable` already uses for lead age
 * (`AGE_SEVERITY_COLOR`). `GetExecutiveOverviewQueryHandler.BuildAging` always emits exactly these four
 * in this order, so a bucket's position is its identity and indexing by it is stable.
 *
 * One array feeds both the donut slices and the legend swatches. They were previously coloured
 * independently — the legend from here, the slices from `DonutChartWidget`'s internal rotation — which
 * is why the 15+ bucket rendered red in the chart against a teal legend dot.
 */
const BUCKET_COLORS = ['var(--qiq-success)', 'var(--qiq-info)', 'var(--qiq-warning)', 'var(--qiq-danger)'];

/**
 * Open Quotes Aging (spec FR-55, T-032): a donut of the 0-3 / 4-7 / 8-14 / 15+ day buckets with the
 * total open-quote count in the center and a legend of counts and percentages, drilling to the open
 * pipeline on click.
 */
function AgingDonut({ aging, onDrill, onViewAgingReport }: AgingDonutProps) {
  const data = aging.buckets.map((bucket, index) => ({
    label: bucket.bucket,
    value: bucket.count,
    color: BUCKET_COLORS[index % BUCKET_COLORS.length],
  }));

  return (
    <ChartCard title="Open Quotes Aging" viewAllLabel="View aging report" onViewAll={onViewAgingReport}>
      <div data-testid="aging-donut" style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-4)' }}>
        <div style={{ position: 'relative', cursor: 'pointer' }} onClick={() => onDrill(aging.drillWidgetKey)} role="presentation">
          <DonutChartWidget data={data} onSliceClick={() => onDrill(aging.drillWidgetKey)} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <span data-testid="aging-center-total" className="qiq-kpi-value">
              {aging.totalOpenQuotes}
            </span>
            <span className="qiq-card-sub">Open Quotes</span>
          </div>
        </div>
        <ul data-testid="aging-legend" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
          {aging.buckets.map((bucket, index) => (
            <li key={bucket.bucket} style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
              <span
                aria-hidden="true"
                style={{ width: 10, height: 10, borderRadius: '50%', background: BUCKET_COLORS[index % BUCKET_COLORS.length] }}
              />
              <span className="qiq-kpi-label" style={{ minWidth: 84 }}>
                {bucket.bucket}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>{bucket.count}</span>
              <span className="qiq-card-sub" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(bucket.share * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}

export default AgingDonut;
