import ChartCard from '../../../components/dashboards/ChartCard';
import { formatPercent } from '../../../components/dashboards/formatters';
import type { TopBrokerDto } from '../brokersApi';

interface TopBrokersRankingProps {
  brokers: TopBrokerDto[];
  /** Drills to a specific broker's quoted leads (sets the broker filter, then navigates). */
  onDrillBroker: (brokerId: number, widgetKey: string) => void;
}

/**
 * Top Brokers / Partners ranking (spec FR-57, PRD 15.1, T-034): a horizontal bar ranking by quote
 * volume with the quote count and conversion% columns beside each bar. Clicking a bar drills to that
 * broker's quoted leads (AC-056). Rendered as a token-styled CSS bar list (not Recharts) so the
 * per-broker count/conversion columns read deterministically, matching `ProductLineStacks`' precedent.
 */
function TopBrokersRanking({ brokers, onDrillBroker }: TopBrokersRankingProps) {
  const maxVolume = brokers.reduce((max, broker) => Math.max(max, broker.quoteVolume), 0) || 1;

  return (
    <ChartCard title="Top Brokers / Partners" viewAllLabel="View all brokers" onViewAll={() => onDrillBroker(0, 'broker.quotes')}>
      <ul
        data-testid="top-brokers-ranking"
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}
      >
        {brokers.length === 0 && <li className="qiq-card-sub">No broker quote activity in this period.</li>}
        {brokers.map((broker) => (
          <li key={broker.brokerId}>
            <button
              type="button"
              data-testid="top-broker-row"
              data-broker-id={broker.brokerId}
              onClick={() => onDrillBroker(broker.brokerId, broker.drillWidgetKey)}
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
                {broker.brokerName}
              </span>
              <span aria-hidden="true" style={{ background: 'var(--qiq-border-subtle)', borderRadius: '999px', height: 10 }}>
                <span
                  style={{
                    display: 'block',
                    height: 10,
                    width: `${(broker.quoteVolume / maxVolume) * 100}%`,
                    background: 'var(--qiq-accent)',
                    borderRadius: '999px',
                  }}
                />
              </span>
              <span data-testid="top-broker-volume" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 48, textAlign: 'right' }}>
                {broker.quoteVolume.toLocaleString()}
              </span>
              <span data-testid="top-broker-conversion" className="qiq-card-sub" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'right' }}>
                {formatPercent(broker.conversionRate)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

export default TopBrokersRanking;
