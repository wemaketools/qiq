import { useNavigate } from 'react-router-dom';
import StatusChip from '../../components/common/StatusChip';
import { formatFullCurrency } from '../../components/dashboards/formatters';
import { deriveLeadReportingCategory } from '../leads/leadStatusCategory';
import {
  ALERT_ACTION_LABELS,
  actionForAlertType,
  labelForAlertType,
  type AlertListItemDto,
} from './alertsApi';

interface AlertsQueueTableProps {
  alerts: AlertListItemDto[];
  currencyCode: string;
  agingAmberDays: number;
  agingRedDays: number;
  /** Opens the contextual workflow dialog for a row's alert (Assign / Follow up / Executive review). */
  onAction: (alert: AlertListItemDto) => void;
}

const MS_PER_DAY = 86_400_000;

function ageDaysFor(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / MS_PER_DAY));
}

/** Amber past the aging-amber threshold, red past the aging-red threshold (spec FR-62's amber/red age). */
function ageTone(ageDays: number, amberDays: number, redDays: number): 'red' | 'amber' | undefined {
  if (ageDays >= redDays) {
    return 'red';
  }
  if (ageDays >= amberDays) {
    return 'amber';
  }
  return undefined;
}

function ageColor(tone: 'red' | 'amber' | undefined): string | undefined {
  if (tone === 'red') {
    return 'var(--qiq-danger)';
  }
  if (tone === 'amber') {
    return 'var(--qiq-warning)';
  }
  return undefined;
}

/**
 * The Escalation Queue table (spec FR-62, PRD 18.2): ref (monospace; the alerting quote ref when the
 * alert is quote-level, else the lead ref), client with its product line beneath, broker or "Direct",
 * right-aligned premium at risk, the stage as a reporting-category StatusChip, amber/red age, owner,
 * flag chips, and the contextual Action link. Row click opens Lead Detail with the alerting quote
 * highlighted (`?highlightQuote=`), matching the shared at-risk-table drill pattern (T-033).
 */
function AlertsQueueTable({ alerts, currencyCode, agingAmberDays, agingRedDays, onAction }: AlertsQueueTableProps) {
  const navigate = useNavigate();

  function openLead(alert: AlertListItemDto): void {
    const suffix = alert.quoteId != null ? `?highlightQuote=${alert.quoteId}` : '';
    navigate(`/leads/${alert.leadId}${suffix}`);
  }

  return (
    <div className="qiq-table-wrap">
      <table data-testid="alerts-queue-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th scope="col">Ref</th>
            <th scope="col">Client</th>
            <th scope="col">Broker</th>
            <th scope="col" style={{ textAlign: 'right' }}>
              Premium at risk ({currencyCode})
            </th>
            <th scope="col">Stage</th>
            <th scope="col">Age</th>
            <th scope="col">Owner</th>
            <th scope="col">Flags</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((alert) => {
            const ageDays = ageDaysFor(alert.createdAt);
            const tone = ageTone(ageDays, agingAmberDays, agingRedDays);
            const action = actionForAlertType(alert.type);
            return (
              <tr
                key={alert.id}
                data-testid="alert-row"
                data-alert-id={alert.id}
                className="qiq-row-clickable"
                onClick={() => openLead(alert)}
                style={{ cursor: 'pointer' }}
              >
                <td data-testid="alert-ref-cell" className="qiq-mono">
                  {alert.quoteRef ?? alert.leadRef}
                </td>
                <td>
                  <div style={{ fontWeight: 600 }}>{alert.clientName}</div>
                  <div className="qiq-card-sub" data-testid="alert-product-line">
                    {alert.productLineName}
                  </div>
                </td>
                <td>{alert.brokerName ?? 'Direct'}</td>
                <td data-testid="alert-premium-cell" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {formatFullCurrency(alert.premiumAtRisk, currencyCode)}
                </td>
                <td>
                  <StatusChip label={alert.stage} category={deriveLeadReportingCategory(alert.stage)} />
                </td>
                <td
                  data-testid="alert-age-cell"
                  data-tone={tone}
                  style={{ fontVariantNumeric: 'tabular-nums', color: ageColor(tone), fontWeight: tone ? 600 : undefined }}
                >
                  {ageDays} days
                </td>
                <td>{alert.ownerName ?? 'Unassigned'}</td>
                <td data-testid="alert-flags-cell">
                  <span
                    className={`qiq-chip qiq-chip--${alert.severity === 'critical' ? 'danger' : 'warning'}`}
                    data-testid="alert-flag-chip"
                  >
                    {labelForAlertType(alert.type)}
                  </span>
                </td>
                <td>
                  {action ? (
                    <button
                      type="button"
                      data-testid="alert-action-link"
                      data-action={action}
                      className="qiq-card-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAction(alert);
                      }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    >
                      {ALERT_ACTION_LABELS[action]}
                    </button>
                  ) : (
                    <span aria-hidden="true">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default AlertsQueueTable;
