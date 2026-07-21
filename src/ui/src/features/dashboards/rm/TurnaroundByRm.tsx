import ChartCard from '../../../components/dashboards/ChartCard';
import type { TurnaroundByRmDto } from '../rmApi';

interface TurnaroundByRmProps {
  turnaround: TurnaroundByRmDto;
  /** Drills to that RM's quoted leads (sets the RM filter, then navigates). */
  onDrillRm: (rmUserId: number, widgetKey: string) => void;
}

/**
 * Turnaround by RM (spec FR-58/FR-60, AC-057/AC-059, PRD 15.2, T-035): horizontal bars of each RM's
 * average received-to-sent turnaround with a dashed vertical marker at the tenant SLA target
 * (`sla_received_to_sent_days`). Bars past the target render in the danger token; within-target bars in
 * success. Team grouping is deferred (MVP has no team entity) so bars are per-RM. Clicking a bar drills
 * to that RM's quoted leads (AC-057). CSS bar list (not Recharts) so the day values read deterministically.
 */
function TurnaroundByRm({ turnaround, onDrillRm }: TurnaroundByRmProps) {
  const { rows, slaTargetDays } = turnaround;
  const maxTurnaround = rows.reduce((max, row) => Math.max(max, row.avgTurnaroundDays ?? 0), 0);
  const scale = Math.max(maxTurnaround, slaTargetDays) * 1.25 || 1;
  const markerLeftPct = (slaTargetDays / scale) * 100;

  return (
    <ChartCard title="Turnaround by RM">
      <div data-testid="turnaround-bars" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
        {/* Dashed SLA target marker (PRD 15.2 / AC-059). */}
        <span
          data-testid="sla-target-marker"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${markerLeftPct}%`,
            top: 0,
            bottom: 0,
            borderLeft: '2px dashed var(--qiq-danger)',
          }}
        />

        {rows.length === 0 && <span className="qiq-card-sub">No turnaround data in this period.</span>}
        {rows.map((row) => (
          <button
            key={row.rmUserId}
            type="button"
            data-testid="turnaround-row"
            data-rm-id={row.rmUserId}
            data-beyond-target={row.beyondTarget}
            onClick={() => onDrillRm(row.rmUserId, row.drillWidgetKey)}
            style={{
              width: '100%',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              // Explicit stretch: components.css's bare-button rule (`button:not([class])`) sets
              // align-items: center, which would shrink the track to zero width and hide the bar.
              alignItems: 'stretch',
              gap: 'var(--qiq-space-1)',
              textAlign: 'left',
            }}
          >
            <span style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--qiq-space-2)' }}>
              <span className="qiq-kpi-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.rmName}
              </span>
              <span
                data-testid="turnaround-days"
                className="qiq-card-sub"
                style={{ fontVariantNumeric: 'tabular-nums', color: row.beyondTarget ? 'var(--qiq-danger)' : undefined }}
              >
                {row.avgTurnaroundDays == null ? '—' : `${row.avgTurnaroundDays.toFixed(1)}d`}
              </span>
            </span>
            <span aria-hidden="true" style={{ background: 'var(--qiq-border-subtle)', borderRadius: '999px', height: 10 }}>
              <span
                data-testid="turnaround-bar-fill"
                style={{
                  display: 'block',
                  height: 10,
                  width: `${((row.avgTurnaroundDays ?? 0) / scale) * 100}%`,
                  background: row.beyondTarget ? 'var(--qiq-danger)' : 'var(--qiq-success)',
                  borderRadius: '999px',
                }}
              />
            </span>
          </button>
        ))}
      </div>
      <span className="qiq-card-sub">Dashed line = {slaTargetDays}-day SLA target</span>
    </ChartCard>
  );
}

export default TurnaroundByRm;
