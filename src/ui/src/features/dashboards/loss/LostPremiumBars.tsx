import ChartCard from '../../../components/dashboards/ChartCard';
import { formatCompactCurrency } from '../../../components/dashboards/formatters';

export interface LostPremiumBarItem {
  name: string;
  amount: number;
  drillWidgetKey: string;
}

interface LostPremiumBarsProps {
  title: string;
  testId: string;
  rowTestId: string;
  items: LostPremiumBarItem[];
  /** The bar hue token: `var(--qiq-danger)` (red) for the by-reason chart, `var(--qiq-warning)` (amber) for the by-product-line chart (spec FR-59/PRD 16). */
  barColor: string;
  currencyCode: string;
  emptyLabel: string;
  onDrill: (widgetKey: string) => void;
}

/**
 * A Lost-Premium horizontal-bar chart (spec FR-59, PRD 16, T-036): one bar per reason / product line
 * ranked by premium lost, with the premium amount beside each bar. Shared by the by-Reason (red/danger)
 * and by-Product-Line (amber/warning) charts. Clicking a bar drills to that loss list (AC-058). Rendered
 * as a token-styled CSS bar list (not Recharts), matching the `WonPremiumRanking` precedent so the fixed
 * hue and amounts read deterministically.
 */
function LostPremiumBars({ title, testId, rowTestId, items, barColor, currencyCode, emptyLabel, onDrill }: LostPremiumBarsProps) {
  const maxAmount = items.reduce((max, item) => Math.max(max, item.amount), 0) || 1;

  return (
    <ChartCard title={title} onViewDetails={() => onDrill(items[0]?.drillWidgetKey ?? 'loss.count_by_reason')}>
      <ul
        data-testid={testId}
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}
      >
        {items.length === 0 && <li className="qiq-card-sub">{emptyLabel}</li>}
        {items.map((item) => (
          <li key={item.name}>
            <button
              type="button"
              data-testid={rowTestId}
              data-bar-name={item.name}
              onClick={() => onDrill(item.drillWidgetKey)}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                display: 'grid',
                gridTemplateColumns: '1.4fr 3fr auto',
                alignItems: 'center',
                gap: 'var(--qiq-space-3)',
                textAlign: 'left',
              }}
            >
              <span className="qiq-kpi-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </span>
              <span aria-hidden="true" style={{ background: 'var(--qiq-border-subtle)', borderRadius: '999px', height: 12 }}>
                <span
                  data-testid="loss-bar-fill"
                  style={{
                    display: 'block',
                    height: 12,
                    width: `${(item.amount / maxAmount) * 100}%`,
                    background: barColor,
                    borderRadius: '999px',
                  }}
                />
              </span>
              <span data-testid="loss-bar-amount" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 84, textAlign: 'right' }}>
                {formatCompactCurrency(item.amount, currencyCode)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

export default LostPremiumBars;
