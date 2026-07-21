import ChartCard from '../../../components/dashboards/ChartCard';
import DonutChartWidget from '../../../components/dashboards/charts/DonutChartWidget';
import type { PipelineDonutDto } from '../pipelineApi';

interface PipelineDonutProps {
  title: string;
  testId: string;
  donut: PipelineDonutDto;
  onDrill: (widgetKey: string) => void;
}

/**
 * A labelled Pipeline donut (spec FR-56, T-033): reused for both Quote Volume by Source and Lead Volume
 * by Channel. Renders the shared `DonutChartWidget` with a legend of counts and shares, drilling to the
 * widget's underlying rows on click (AC-055).
 */
function PipelineDonut({ title, testId, donut, onDrill }: PipelineDonutProps) {
  const data = donut.slices.map((slice) => ({ label: slice.label, value: slice.count }));

  return (
    <ChartCard title={title}>
      <div data-testid={testId} style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-4)' }}>
        <div style={{ cursor: 'pointer' }} role="presentation" onClick={() => onDrill(donut.drillWidgetKey)}>
          <DonutChartWidget data={data} height={220} width={220} onSliceClick={() => onDrill(donut.drillWidgetKey)} />
        </div>
        <ul data-testid={`${testId}-legend`} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
          {donut.slices.length === 0 && <li className="qiq-card-sub">No data.</li>}
          {donut.slices.map((slice) => (
            <li key={slice.label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
              <span className="qiq-kpi-label" style={{ minWidth: 110 }}>
                {slice.label}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right' }}>{slice.count}</span>
              <span className="qiq-card-sub" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(slice.share * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}

export default PipelineDonut;
