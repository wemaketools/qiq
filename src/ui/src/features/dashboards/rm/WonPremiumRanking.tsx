import ChartCard from '../../../components/dashboards/ChartCard';
import { formatCompactCurrency, formatPercent } from '../../../components/dashboards/formatters';

export interface RankingItem {
  id: number;
  name: string;
  wonPremium: number;
  conversionRate: number | null;
  drillWidgetKey: string;
}

interface WonPremiumRankingProps {
  title: string;
  testId: string;
  rowTestId: string;
  items: RankingItem[];
  currencyCode: string;
  emptyLabel: string;
  viewAllLabel: string;
  /** Drills to a specific subject (RM or broker): sets the narrowing filter, then navigates. */
  onDrill: (id: number, widgetKey: string) => void;
}

/**
 * A won-premium ranking (spec FR-58, PRD 15.2, T-035): a horizontal bar ranking by won premium with the
 * won-premium amount and conversion% columns beside each bar. Used by the RM dashboard's Top RMs ranking
 * (its Top Brokers instance was removed 2026-07-16 — broker widgets live on the Brokers dashboard).
 * Clicking a bar drills to that subject's leads (AC-057). Rendered as a token-styled CSS bar list
 * (not Recharts), matching `TopBrokersRanking`'s precedent.
 */
function WonPremiumRanking({ title, testId, rowTestId, items, currencyCode, emptyLabel, viewAllLabel, onDrill }: WonPremiumRankingProps) {
  const maxWon = items.reduce((max, item) => Math.max(max, item.wonPremium), 0) || 1;

  return (
    <ChartCard title={title} viewAllLabel={viewAllLabel} onViewAll={() => onDrill(0, items[0]?.drillWidgetKey ?? 'rm.leads')}>
      <ul
        data-testid={testId}
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}
      >
        {items.length === 0 && <li className="qiq-card-sub">{emptyLabel}</li>}
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              data-testid={rowTestId}
              data-subject-id={item.id}
              onClick={() => onDrill(item.id, item.drillWidgetKey)}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                display: 'grid',
                gridTemplateColumns: '1fr 3fr auto auto',
                alignItems: 'center',
                gap: 'var(--qiq-space-3)',
                textAlign: 'left',
              }}
            >
              <span className="qiq-kpi-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </span>
              <span aria-hidden="true" style={{ background: 'var(--qiq-border-subtle)', borderRadius: '999px', height: 10 }}>
                <span
                  style={{
                    display: 'block',
                    height: 10,
                    width: `${(item.wonPremium / maxWon) * 100}%`,
                    background: 'var(--qiq-accent)',
                    borderRadius: '999px',
                  }}
                />
              </span>
              <span data-testid="ranking-won-premium" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 84, textAlign: 'right' }}>
                {formatCompactCurrency(item.wonPremium, currencyCode)}
              </span>
              <span data-testid="ranking-conversion" className="qiq-card-sub" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'right' }}>
                {formatPercent(item.conversionRate)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

export default WonPremiumRanking;
