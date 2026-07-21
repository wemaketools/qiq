export type KpiGoodDirection = 'higherIsBetter' | 'lowerIsBetter';

interface KpiCardProps {
  label: string;
  value: string;
  /** Pre-formatted delta string (e.g. "+3.6pp", "-0.6"), or `null` when there is no prior-period value to compare against. */
  delta: string | null;
  goodDirection: KpiGoodDirection;
  /**
   * Whether `delta` should render as "good" (green) -- server-computed from `KpiValue.IsFavorableDelta`
   * (`src/api/.../QuoteIQ.Application/Dashboards/KpiValue.cs`) so the good/bad direction rule lives in
   * exactly one place (spec §9.6/AC-080-adjacent isolation, UI standards 3.4). `null` when `delta` is `null`.
   */
  isFavorableDelta: boolean | null;
  /** Icon glyph/initial rendered in the tinted halo (UI standards 3.3's "tinted icon halo"); optional so callers without an icon set still render a clean card. */
  icon?: string;
  onClick?: () => void;
}

/**
 * A dashboard KPI card (spec FR-54/UI standards 3.3-3.4, T-031): tinted icon halo, label, value, and a
 * delta arrow colored by the KPI's declared good direction. Clicking the card (when `onClick` is
 * given) drills through to the underlying rows (AC-053: "every KPI ... drills to underlying items").
 */
function KpiCard({ label, value, delta, goodDirection, isFavorableDelta, icon, onClick }: KpiCardProps) {
  const deltaColor = isFavorableDelta === null ? 'var(--qiq-text-secondary)' : isFavorableDelta ? 'var(--qiq-success)' : 'var(--qiq-danger)';
  const arrow = delta?.trim().startsWith('-') ? '↓' : '↑';

  return (
    <div
      data-testid="kpi-card"
      data-good-direction={goodDirection}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                onClick();
              }
            }
          : undefined
      }
      className="qiq-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--qiq-space-2)',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
        {icon && (
          <span data-testid="kpi-icon-halo" className="qiq-kpi-halo">
            {icon}
          </span>
        )}
        <span data-testid="kpi-label" className="qiq-kpi-label">
          {label}
        </span>
      </span>
      <span data-testid="kpi-value" className="qiq-kpi-value">
        {value}
      </span>
      {delta !== null && (
        <span data-testid="kpi-delta" className="qiq-kpi-delta" style={{ color: deltaColor }}>
          {arrow} {delta}
        </span>
      )}
    </div>
  );
}

export default KpiCard;
