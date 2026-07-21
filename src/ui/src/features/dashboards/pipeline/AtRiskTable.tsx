import { useNavigate } from 'react-router-dom';
import StatusChip from '../../../components/common/StatusChip';
import type { ReportingCategory } from '../../../components/common/StatusChip';
import { formatFullCurrency } from '../../../components/dashboards/formatters';
import type { AtRiskRowDto } from '../pipelineApi';

interface AtRiskTableProps {
  rows: AtRiskRowDto[];
  currencyCode: string;
  /** True only in Internal cross-tenant mode; adds the Tenant column (spec FR-56). */
  showTenantColumn: boolean;
}

const KNOWN_CATEGORIES: ReportingCategory[] = ['open', 'quoted', 'won', 'lost', 'expired', 'withdrawn'];

function toReportingCategory(value: string): ReportingCategory {
  return (KNOWN_CATEGORIES as string[]).includes(value) ? (value as ReportingCategory) : 'open';
}

/**
 * At-Risk Pipeline table (spec FR-56, T-033): open leads carrying an open alert, each row showing the
 * client, broker, premium, stage chip, age, owner, its risk reason and a suggested-action chip, and a
 * lead-ref link. Row click opens Lead Detail (AC-055). The Tenant column appears only in Internal
 * cross-tenant mode.
 */
function AtRiskTable({ rows, currencyCode, showTenantColumn }: AtRiskTableProps) {
  const navigate = useNavigate();

  return (
    <div className="qiq-card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'center' }}>
        <span className="qiq-card-title">At-Risk Pipeline</span>
      </div>

      <div className="qiq-table-wrap">
        <table data-testid="at-risk-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              {showTenantColumn && <th scope="col">Tenant</th>}
              <th scope="col">Lead</th>
              <th scope="col">Client</th>
              <th scope="col">Broker</th>
              <th scope="col">Premium ({currencyCode})</th>
              <th scope="col">Stage</th>
              <th scope="col">Age</th>
              <th scope="col">Owner</th>
              <th scope="col">Risk reason</th>
              <th scope="col">Suggested action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={showTenantColumn ? 10 : 9} className="qiq-card-sub">
                  No at-risk items in the pipeline.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.leadId}
                data-testid="at-risk-row"
                onClick={() => navigate(`/leads/${row.leadId}`)}
                style={{ cursor: 'pointer' }}
              >
                {showTenantColumn && <td>{row.tenantName ?? '—'}</td>}
                <td>
                  <button
                    type="button"
                    data-testid="at-risk-lead-link"
                    className="qiq-card-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      navigate(`/leads/${row.leadId}`);
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    {row.leadRef}
                  </button>
                </td>
                <td>{row.clientName}</td>
                <td>{row.brokerName ?? '—'}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFullCurrency(row.premium, currencyCode)}</td>
                <td>
                  <StatusChip label={row.stageName} category={toReportingCategory(row.stageReportingCategory)} />
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.ageDays}d</td>
                <td>{row.ownerName ?? '—'}</td>
                <td>
                  <span data-testid="at-risk-reason" className="qiq-chip qiq-chip--danger">
                    {row.riskReason}
                  </span>
                </td>
                <td>
                  <span data-testid="at-risk-action" className="qiq-chip qiq-chip--warning">
                    {row.suggestedAction}
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

export default AtRiskTable;
