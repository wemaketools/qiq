import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/common/Icon';
import type { IconName } from '../../../components/common/Icon';
import type { ImmediateActionDto } from '../pipelineApi';

interface ImmediateActionsPanelProps {
  actions: ImmediateActionDto[];
}

/** Per-category icon (color reinforces, text always carries the meaning — no color-only signal, NFR-03). */
const CATEGORY_META: Record<string, { icon: IconName; color: string }> = {
  overdue_quotes: { icon: 'calendar', color: 'var(--qiq-danger)' },
  pending_pricing_approvals: { icon: 'reports', color: 'var(--qiq-warning)' },
  exec_escalations: { icon: 'warning', color: 'var(--qiq-danger)' },
  sla_breaches: { icon: 'alerts', color: 'var(--qiq-danger)' },
  unassigned_leads: { icon: 'parties', color: 'var(--qiq-warning)' },
  overdue_follow_ups: { icon: 'calendar', color: 'var(--qiq-warning)' },
  expiring_quotes: { icon: 'warning', color: 'var(--qiq-warning)' },
  follow_ups_due_today: { icon: 'calendar', color: 'var(--qiq-info)' },
};

/**
 * Immediate Actions panel (spec FR-56, T-033): eight action categories, each a count that drills into
 * the pre-filtered Alerts center tab on click (AC-055). The overdue-quotes and follow-ups-due-today
 * categories are pipeline-computed; the rest consume the T-024 alert data.
 */
function ImmediateActionsPanel({ actions }: ImmediateActionsPanelProps) {
  const navigate = useNavigate();

  function goToAlerts(tab: string | null): void {
    navigate(tab ? `/alerts?tab=${tab}` : '/alerts');
  }

  return (
    <div
      data-testid="immediate-actions"
      className="qiq-card"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}
    >
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'center' }}>
        <span className="qiq-card-title">Immediate Actions</span>
        <button
          type="button"
          className="qiq-card-link"
          data-testid="immediate-actions-view-all"
          onClick={() => goToAlerts(null)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', marginTop: 0 }}
        >
          Go to alerts center →
        </button>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
        {actions.map((action) => {
          const meta = CATEGORY_META[action.category] ?? { icon: 'alerts' as IconName, color: 'var(--qiq-text-secondary)' };
          return (
            <li key={action.category}>
              <button
                type="button"
                data-testid="immediate-action-row"
                data-category={action.category}
                onClick={() => goToAlerts(action.tab)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto auto',
                  alignItems: 'center',
                  gap: 'var(--qiq-space-3)',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  padding: 'var(--qiq-space-2) 0',
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: 'var(--qiq-text-primary)',
                }}
              >
                <span className="qiq-kpi-halo" aria-hidden="true">
                  <Icon name={meta.icon} size={18} />
                </span>
                <span className="qiq-kpi-label">{action.name}</span>
                <span
                  data-testid="immediate-action-count"
                  style={{ color: meta.color, fontWeight: 700, fontSize: '1.25rem', fontVariantNumeric: 'tabular-nums' }}
                >
                  {action.count}
                </span>
                <Icon name="arrow-right" size={18} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ImmediateActionsPanel;
