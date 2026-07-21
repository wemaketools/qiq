import { formatFullCurrency, formatPercent } from '../../../components/dashboards/formatters';
import type { CompetitorAnalysisDto } from '../lossApi';

interface CompetitorTableProps {
  competitorAnalysis: CompetitorAnalysisDto;
  currencyCode: string;
  onDrill: (widgetKey: string) => void;
}

/**
 * Competitor Analysis table (spec FR-59, PRD 16, T-036): "where business is going" — each competitor we
 * lost business to with deals lost, premium lost, and the mean price gap over that competitor's records
 * with a known competitor premium. Each row drills to the loss list (AC-058).
 */
function CompetitorTable({ competitorAnalysis, currencyCode, onDrill }: CompetitorTableProps) {
  const { rows } = competitorAnalysis;

  return (
    <div className="qiq-card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'flex-start', flexDirection: 'column' }}>
        <span className="qiq-card-title">Competitor Analysis</span>
        <span className="qiq-card-sub">Where business is going</span>
      </div>

      <div className="qiq-table-wrap">
        <table data-testid="competitor-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th scope="col">Competitor</th>
              <th scope="col">Deals Lost</th>
              <th scope="col">Premium Lost ({currencyCode})</th>
              <th scope="col">Avg Price Gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="qiq-card-sub">
                  No competitor data to display.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.competitor}
                data-testid="competitor-row"
                data-competitor={row.competitor}
                onClick={() => onDrill(row.drillWidgetKey)}
                style={{ cursor: 'pointer' }}
              >
                <td>{row.competitor}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.dealsLost.toLocaleString()}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFullCurrency(row.premiumLost, currencyCode)}</td>
                <td data-testid="competitor-price-gap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatPercent(row.avgPriceGapPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default CompetitorTable;
