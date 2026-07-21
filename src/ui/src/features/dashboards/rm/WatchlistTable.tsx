import { formatFullCurrency, formatPercent } from '../../../components/dashboards/formatters';
import type { WatchlistRowDto } from '../rmApi';

interface WatchlistTableProps {
  rows: WatchlistRowDto[];
  currencyCode: string;
  /** Drills to that RM's leads (sets the RM filter, then navigates). */
  onDrillRm: (rmUserId: number, widgetKey: string) => void;
}

/**
 * Performance Watchlist (spec FR-58, PRD 15.2/15.4, T-035): every RM with quotes, won premium,
 * conversion, avg turnaround, overdue follow-ups, and a color-coded suggested-action chip (the tone is
 * server-computed by `SuggestedActionRule`, so the chip just renders `qiq-chip--{tone}` — one place owns
 * the mapping). Full-width; each row drills to that RM's leads (AC-057).
 */
function WatchlistTable({ rows, currencyCode, onDrillRm }: WatchlistTableProps) {
  return (
    <div className="qiq-card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'center' }}>
        <span className="qiq-card-title">Performance Watchlist</span>
      </div>

      <div className="qiq-table-wrap">
        <table data-testid="performance-watchlist" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th scope="col">RM</th>
              <th scope="col">Quotes</th>
              <th scope="col">Won Premium ({currencyCode})</th>
              <th scope="col">Conversion</th>
              <th scope="col">Avg TAT</th>
              <th scope="col">Overdue</th>
              <th scope="col">Suggested Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="qiq-card-sub">
                  No RMs to display.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.rmUserId}
                data-testid="watchlist-row"
                data-rm-id={row.rmUserId}
                onClick={() => onDrillRm(row.rmUserId, row.drillWidgetKey)}
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <button
                    type="button"
                    data-testid="watchlist-name"
                    className="qiq-card-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDrillRm(row.rmUserId, row.drillWidgetKey);
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                  >
                    {row.name}
                  </button>
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.quoteVolume.toLocaleString()}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFullCurrency(row.wonPremium, currencyCode)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPercent(row.conversionRate)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.avgTurnaroundDays == null ? '—' : `${row.avgTurnaroundDays.toFixed(1)}d`}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.overdueFollowUps}</td>
                <td>
                  <span data-testid="suggested-action-chip" className={`qiq-chip qiq-chip--${row.suggestedAction.tone}`}>
                    {row.suggestedAction.label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default WatchlistTable;
