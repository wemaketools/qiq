import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/common/Icon';
import type { IconName } from '../../../components/common/Icon';
import type { ExecutiveAttentionRowDto } from '../executiveApi';

interface RequiresAttentionPanelProps {
  rows: ExecutiveAttentionRowDto[];
}

/** Per-category icon + count color (color reinforces, text always carries the meaning — no color-only signal, NFR-03). */
const CATEGORY_META: Record<string, { icon: IconName; color: string }> = {
  escalated: { icon: 'warning', color: 'var(--qiq-danger)' },
  stalled: { icon: 'reports', color: 'var(--qiq-warning)' },
  overdue: { icon: 'calendar', color: 'var(--qiq-warning)' },
  expiring: { icon: 'warning', color: 'var(--qiq-warning)' },
  sla: { icon: 'alerts', color: 'var(--qiq-danger)' },
};

/**
 * Requires Attention (spec FR-55, T-032): rows fed by the T-024 alert summary categories (icon, name,
 * definition, count). Each row's chevron navigates to the Alerts center pre-filtered to that category's
 * tab (spec AC-054); the footer link goes to the unfiltered Alerts center.
 */
function RequiresAttentionPanel({ rows }: RequiresAttentionPanelProps) {
  const navigate = useNavigate();

  function goToAlerts(tab: string | null): void {
    navigate(tab ? `/alerts?tab=${tab}` : '/alerts');
  }

  return (
    <div
      data-testid="requires-attention"
      className="qiq-card"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}
    >
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'center' }}>
        <span className="qiq-card-title">Requires Attention</span>
        <button
          type="button"
          className="qiq-card-link"
          data-testid="attention-view-all"
          onClick={() => goToAlerts(null)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', marginTop: 0 }}
        >
          View all alerts →
        </button>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
        {rows.map((row) => {
          const meta = CATEGORY_META[row.category] ?? { icon: 'alerts' as IconName, color: 'var(--qiq-text-secondary)' };
          return (
            <li key={row.category}>
              <button
                type="button"
                data-testid="attention-row"
                data-category={row.category}
                onClick={() => goToAlerts(row.tab)}
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
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="qiq-kpi-label">{row.name}</span>
                  <span className="qiq-card-sub">{row.definition}</span>
                </span>
                <span
                  data-testid="attention-count"
                  style={{ color: meta.color, fontWeight: 700, fontSize: '1.25rem', fontVariantNumeric: 'tabular-nums' }}
                >
                  {row.count}
                </span>
                <Icon name="arrow-right" size={18} />
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="qiq-card-link"
        data-testid="attention-go-to-center"
        onClick={() => goToAlerts(null)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', alignSelf: 'flex-start' }}
      >
        Go to alerts center →
      </button>
    </div>
  );
}

export default RequiresAttentionPanel;
