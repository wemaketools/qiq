import { formatFullCurrency, formatPercent } from '../../../components/dashboards/formatters';
import type { BrokerTableRowDto } from '../brokersApi';

interface BrokerPerformanceTableProps {
  rows: BrokerTableRowDto[];
  currencyCode: string;
  /**
   * The matrix median conversion split (spec §10.1): a broker's conversion renders "strong" (green) at
   * or above it and "weak" (red) below it. Ties the table's green-strong/red-weak coloring to the same
   * split the PRD 15.3 quadrant classification uses, rather than an arbitrary absolute threshold — the
   * PRD defines "green when strong, red when weak" without an absolute cutoff (flagged in the task).
   */
  conversionSplit: number;
  /** Drills to a specific broker's leads (sets the broker filter, then navigates). */
  onDrillBroker: (brokerId: number, widgetKey: string) => void;
}

/**
 * Broker Performance table (spec FR-57, PRD 15.1, T-034): every partner ranked by volume, with the
 * broker (name + primary contact), tier chip, branch, quotes, conversion (green-strong/red-weak), won
 * premium, avg TAT, overdue count, and the top loss reason (mode of the broker's lost-lead reasons).
 * Full-width; each row drills to that broker's leads (AC-056).
 */
function BrokerPerformanceTable({ rows, currencyCode, conversionSplit, onDrillBroker }: BrokerPerformanceTableProps) {
  return (
    <div className="qiq-card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'center' }}>
        <span className="qiq-card-title">Broker Performance</span>
      </div>

      <div className="qiq-table-wrap">
        <table data-testid="broker-performance-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th scope="col">Broker</th>
              <th scope="col">Tier</th>
              <th scope="col">Branch</th>
              <th scope="col">Quotes</th>
              <th scope="col">Conversion</th>
              <th scope="col">Won Premium ({currencyCode})</th>
              <th scope="col">Avg TAT</th>
              <th scope="col">Overdue</th>
              <th scope="col">Top Loss Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="qiq-card-sub">
                  No brokers to display.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const conversionStrong = row.conversionRate != null && row.conversionRate >= conversionSplit;
              const conversionColor =
                row.conversionRate == null ? 'var(--qiq-text-secondary)' : conversionStrong ? 'var(--qiq-success)' : 'var(--qiq-danger)';

              return (
                <tr
                  key={row.brokerId}
                  data-testid="broker-table-row"
                  data-broker-id={row.brokerId}
                  onClick={() => onDrillBroker(row.brokerId, row.drillWidgetKey)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <button
                        type="button"
                        data-testid="broker-table-name"
                        className="qiq-card-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDrillBroker(row.brokerId, row.drillWidgetKey);
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                      >
                        {row.brokerName}
                      </button>
                      <span className="qiq-card-sub">{row.primaryContactName ?? '—'}</span>
                    </div>
                  </td>
                  <td>{row.tierName ? <span className="qiq-chip qiq-chip--neutral">{row.tierName}</span> : '—'}</td>
                  <td>{row.branch ?? '—'}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.quoteVolume.toLocaleString()}</td>
                  <td data-testid="broker-conversion" style={{ fontVariantNumeric: 'tabular-nums', color: conversionColor, fontWeight: 600 }}>
                    {formatPercent(row.conversionRate)}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFullCurrency(row.wonPremium, currencyCode)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.avgTurnaroundDays == null ? '—' : `${row.avgTurnaroundDays.toFixed(1)}d`}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.overdueFollowUps}</td>
                  <td data-testid="broker-top-loss-reason">{row.topLossReason ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default BrokerPerformanceTable;
