import { useNavigate } from 'react-router-dom';
import StatusChip from '../../../components/common/StatusChip';
import type { ReportingCategory } from '../../../components/common/StatusChip';
import Icon from '../../../components/common/Icon';
import ExportMenu from '../../../components/common/ExportMenu';
import { buildDashboardExportPath, type DashboardExportFilter } from '../../exports/exportsApi';
import { formatFullCurrency } from '../../../components/dashboards/formatters';
import type { ExecutiveHighValueRowDto } from '../executiveApi';

interface HighValueTableProps {
  rows: ExecutiveHighValueRowDto[];
  currencyCode: string;
  onViewAll: () => void;
  /** Active dashboard filter, so the table's Export menu reflects the same filters (spec FR-65, T-039). */
  exportFilter: DashboardExportFilter;
}

const KNOWN_CATEGORIES: ReportingCategory[] = ['open', 'quoted', 'won', 'lost', 'expired', 'withdrawn'];

function toReportingCategory(value: string): ReportingCategory {
  return (KNOWN_CATEGORIES as string[]).includes(value) ? (value as ReportingCategory) : 'open';
}

/**
 * High-Value Opportunities (spec FR-55, T-032): the top open items above the tenant high-value
 * threshold. Each row drills to its Lead Detail (spec AC-054), shows the client (with a party-type
 * icon), broker, product, full premium amount, a category-colored stage chip, next follow-up, and a
 * risk flag chip.
 */
function HighValueTable({ rows, currencyCode, onViewAll, exportFilter }: HighValueTableProps) {
  const navigate = useNavigate();

  return (
    <div className="qiq-card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'center' }}>
        <span className="qiq-card-title">High-Value Opportunities</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
          <ExportMenu
            testId="high-value-export-menu"
            fileNameBase="high-value-opportunities"
            buildPath={(format) => buildDashboardExportPath('exec.high_value', exportFilter, format)}
          />
          <button
            type="button"
            className="qiq-card-link"
            data-testid="high-value-view-all"
            onClick={onViewAll}
            style={{ background: 'none', border: 'none', cursor: 'pointer', marginTop: 0 }}
          >
            View all opportunities →
          </button>
        </div>
      </div>

      <div className="qiq-table-wrap">
        <table data-testid="high-value-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Broker</th>
              <th scope="col">Product</th>
              <th scope="col">Premium ({currencyCode})</th>
              <th scope="col">Stage</th>
              <th scope="col">Next follow-up</th>
              <th scope="col">Owner</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="qiq-card-sub">
                  No open opportunities above the high-value threshold.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.leadId}
                data-testid="high-value-row"
                onClick={() => navigate(`/leads/${row.leadId}`)}
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
                    <Icon name="parties" size={16} />
                    {row.clientName}
                    {row.riskFlag && (
                      <span data-testid="high-value-risk-flag" className="qiq-chip qiq-chip--warning">
                        At risk
                      </span>
                    )}
                  </span>
                </td>
                <td>{row.brokerName ?? '—'}</td>
                <td>{row.productLineName}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFullCurrency(row.premium, currencyCode)}</td>
                <td>
                  <StatusChip label={row.stageName} category={toReportingCategory(row.stageReportingCategory)} />
                </td>
                <td>{row.nextFollowUpDate ?? '—'}</td>
                <td>{row.ownerName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default HighValueTable;
