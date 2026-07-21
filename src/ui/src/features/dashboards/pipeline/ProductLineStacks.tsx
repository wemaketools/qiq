import ChartCard from '../../../components/dashboards/ChartCard';
import { resolveSeriesColor } from '../../../components/dashboards/palettes';
import { formatCompactCurrency } from '../../../components/dashboards/formatters';
import type { PipelineByProductLineDto } from '../pipelineApi';

interface ProductLineStacksProps {
  data: PipelineByProductLineDto;
  currencyCode: string;
  onDrill: (widgetKey: string) => void;
}

/**
 * Pipeline by Product Line (spec FR-56, T-033): stacked monthly columns of open pipeline value, each
 * segment colored by the fixed product-line series palette (`resolveSeriesColor`, UI Standards 3.5),
 * with the monthly total above each column and a shared legend. Clicking the chart drills to the open
 * pipeline (AC-055). Rendered as a token-styled CSS stack (not Recharts) so the fixed palette and the
 * per-column totals read deterministically.
 */
function ProductLineStacks({ data, currencyCode, onDrill }: ProductLineStacksProps) {
  const maxTotal = data.columns.reduce((max, column) => Math.max(max, column.monthlyTotal), 0) || 1;

  return (
    <ChartCard title="Pipeline by Product Line" onViewDetails={() => onDrill(data.drillWidgetKey)}>
      <div data-testid="product-line-stacks" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--qiq-space-3)', height: 180 }}>
          {data.columns.map((column) => (
            <div
              key={column.monthLabel}
              data-testid="stack-column"
              role="button"
              tabIndex={0}
              onClick={() => onDrill(data.drillWidgetKey)}
              onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onDrill(data.drillWidgetKey)}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--qiq-space-1)', cursor: 'pointer' }}
            >
              <span data-testid="stack-column-total" className="qiq-card-sub" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatCompactCurrency(column.monthlyTotal, currencyCode)}
              </span>
              <div style={{ width: '70%', height: 130, display: 'flex', flexDirection: 'column-reverse' }}>
                {column.segments.map((segment) => (
                  <div
                    key={segment.productLineName}
                    data-testid="stack-segment"
                    data-product-line={segment.productLineName}
                    title={`${segment.productLineName}: ${formatCompactCurrency(segment.value, currencyCode)}`}
                    style={{
                      height: `${(segment.value / maxTotal) * 100}%`,
                      background: resolveSeriesColor(segment.productLineName),
                    }}
                  />
                ))}
              </div>
              <span className="qiq-card-sub">{column.monthLabel}</span>
            </div>
          ))}
        </div>

        <ul data-testid="stack-legend" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 'var(--qiq-space-3)' }}>
          {data.productLines.map((name) => (
            <li key={name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '2px', background: resolveSeriesColor(name) }} />
              <span className="qiq-kpi-label">{name}</span>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}

export default ProductLineStacks;
