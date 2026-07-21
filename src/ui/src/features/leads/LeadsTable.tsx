import { useNavigate } from 'react-router-dom';
import StatusChip from '../../components/common/StatusChip';
import SortableTh from '../../components/common/SortableTh';
import { deriveLeadReportingCategory } from './leadStatusCategory';
import { resolveAgeSeverity } from './agingThresholds';
import type { LeadListItemDto, LeadsSortField, LeadsSortState } from './leadsApi';

export interface LeadsTableColumnConfig {
  /** Omitted by consumers that already scope to one party, e.g. T-025's Party detail Leads card. */
  showParty?: boolean;
  /** Shows the leading checkbox column (visible only with `leads.reassign`, spec FR-43). */
  showCheckboxes?: boolean;
}

interface LeadsTableProps {
  leads: LeadListItemDto[];
  currencyCode: string;
  agingAmberDays: number;
  agingRedDays: number;
  columns?: LeadsTableColumnConfig;
  selectedIds?: ReadonlySet<number>;
  onToggleSelect?: (leadId: number) => void;
  onToggleSelectAll?: () => void;
  /**
   * Current sort state. Omitted entirely by consumers that don't drive sorting through this table
   * (e.g. T-025's Party detail Leads card) — headers then render as plain, non-interactive `<th>`s,
   * unchanged from before this was added.
   */
  sort?: LeadsSortState | null;
  onSortChange?: (field: LeadsSortField) => void;
}

interface SortableHeaderProps {
  field: LeadsSortField;
  label: string;
  sort?: LeadsSortState | null;
  onSortChange?: (field: LeadsSortField) => void;
  align?: 'left' | 'right';
}

/** Renders a plain `<th>` when the consumer doesn't opt into sorting (`onSortChange` omitted). */
function SortableHeader({ field, label, sort, onSortChange, align }: SortableHeaderProps) {
  if (!onSortChange) {
    return <th style={align === 'right' ? { textAlign: 'right' } : undefined}>{label}</th>;
  }
  return <SortableTh field={field} label={label} sort={sort} onSort={onSortChange} align={align} />;
}

function formatPremium(premium: number | null, currencyCode: string): string {
  if (premium == null) {
    return '—';
  }
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode, maximumFractionDigits: 0 }).format(
      premium,
    );
  } catch {
    return `${currencyCode} ${premium.toLocaleString()}`;
  }
}

function isOverdue(nextFollowUpDate: string | null): boolean {
  if (!nextFollowUpDate) {
    return false;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(nextFollowUpDate) < today;
}

const AGE_SEVERITY_COLOR: Record<string, string> = {
  normal: 'inherit',
  amber: 'var(--qiq-warning)',
  red: 'var(--qiq-danger)',
};

/** Flag chip families per UI Standards §4.2: Escalated danger, SLA/Expiring warning, High value accent. */
const FLAG_CHIP_VARIANT: Record<string, string> = {
  Escalated: 'danger',
  SLA: 'warning',
  Expiring: 'warning',
  'High value': 'accent',
  // Loss Analysis drill rows carry the pre-quote vs post-quote loss distinction (spec FR-59/PRD 16.3, T-036).
  'Pre-quote': 'warning',
  'Post-quote': 'neutral',
};

/**
 * Shared Leads table (spec FR-43, T-027): consumed directly by `LeadsListPage`, and designed for
 * reuse by T-025's Party detail Leads card and other drill-through views via `columns.showParty`.
 * Row click navigates to `/leads/{id}` (no inline editing, per FR-43); the Lead ID column is also an
 * independently-focusable monospace link for keyboard users.
 */
function LeadsTable({
  leads,
  currencyCode,
  agingAmberDays,
  agingRedDays,
  columns,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  sort,
  onSortChange,
}: LeadsTableProps) {
  const navigate = useNavigate();
  const showParty = columns?.showParty ?? true;
  const showCheckboxes = columns?.showCheckboxes ?? false;
  const allSelected = showCheckboxes && leads.length > 0 && leads.every((lead) => selectedIds?.has(lead.id));

  return (
    <div className="qiq-table-wrap">
    <table data-testid="leads-table">
      <thead>
        <tr>
          {showCheckboxes && (
            <th>
              <input
                type="checkbox"
                aria-label="Select all leads"
                checked={allSelected}
                onChange={() => onToggleSelectAll?.()}
              />
            </th>
          )}
          <SortableHeader field="leadRef" label="Lead ID" sort={sort} onSortChange={onSortChange} />
          {showParty && <SortableHeader field="party" label="Party" sort={sort} onSortChange={onSortChange} />}
          <SortableHeader field="broker" label="Broker" sort={sort} onSortChange={onSortChange} />
          <SortableHeader field="product" label="Product/Cover" sort={sort} onSortChange={onSortChange} />
          <SortableHeader field="premium" label="Premium" sort={sort} onSortChange={onSortChange} align="right" />
          <SortableHeader field="status" label="Status" sort={sort} onSortChange={onSortChange} />
          <SortableHeader field="age" label="Age" sort={sort} onSortChange={onSortChange} />
          <SortableHeader field="owner" label="Owner" sort={sort} onSortChange={onSortChange} />
          <SortableHeader field="nextFollowUp" label="Next follow-up" sort={sort} onSortChange={onSortChange} />
          {/* Flags is derived per row, not stored — there is no server sort key for it (leadsApi.LEADS_SORT_KEYS). */}
          <th>Flags</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((lead) => {
          const severity = resolveAgeSeverity(lead.ageDays, agingAmberDays, agingRedDays);
          const overdue = isOverdue(lead.nextFollowUpDate);

          return (
            <tr
              key={lead.id}
              data-testid="lead-row"
              onClick={() => navigate(`/leads/${lead.id}`)}
              style={{ cursor: 'pointer' }}
            >
              {showCheckboxes && (
                <td onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select lead ${lead.leadRef}`}
                    checked={selectedIds?.has(lead.id) ?? false}
                    onChange={() => onToggleSelect?.(lead.id)}
                  />
                </td>
              )}
              <td>
                <a
                  href={`/leads/${lead.id}`}
                  data-testid="lead-ref-link"
                  style={{ fontFamily: 'var(--qiq-font-mono, monospace)' }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    navigate(`/leads/${lead.id}`);
                  }}
                >
                  {lead.leadRef}
                </a>
              </td>
              {showParty && <td>{lead.partyName}</td>}
              <td>{lead.brokerName ?? 'Direct'}</td>
              <td>
                <div>{lead.productLineName}</div>
                <div style={{ color: 'var(--qiq-text-secondary)', fontSize: '12px' }}>{lead.coverTypeName}</div>
              </td>
              <td style={{ textAlign: 'right' }}>{formatPremium(lead.premium, currencyCode)}</td>
              <td>
                <StatusChip label={lead.statusName} category={deriveLeadReportingCategory(lead.statusName)} />
              </td>
              <td data-testid="lead-age" style={{ color: AGE_SEVERITY_COLOR[severity] }}>
                {lead.ageDays}d
              </td>
              <td>{lead.owner ? `${lead.owner.firstName} ${lead.owner.lastName}` : 'Unassigned'}</td>
              <td style={{ color: overdue ? 'var(--qiq-danger)' : 'inherit' }}>
                {lead.nextFollowUpDate ?? '—'}
                {overdue && (
                  <span
                    data-testid="overdue-chip"
                    style={{
                      marginLeft: 'var(--qiq-space-2)',
                      color: 'var(--qiq-danger)',
                      border: '1px solid var(--qiq-danger)',
                      borderRadius: 'var(--qiq-radius-chip)',
                      padding: '0 6px',
                      fontSize: '11px',
                    }}
                  >
                    Overdue
                  </span>
                )}
              </td>
              <td data-testid="flag-chips">
                {lead.flags.map((flag) => (
                  <span
                    key={flag}
                    data-testid="flag-chip"
                    className={`qiq-chip qiq-chip--${FLAG_CHIP_VARIANT[flag] ?? 'neutral'}`}
                    style={{ marginRight: 'var(--qiq-space-1)', fontSize: '11px' }}
                  >
                    {flag}
                  </span>
                ))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

export default LeadsTable;
