export interface FunnelStage {
  label: string;
  value: number;
}

interface FunnelChartWidgetProps {
  /** Stages in display order (spec FR-56: "cumulative conversion funnel with Lost last"). */
  stages: FunnelStage[];
  onStageClick?: (stage: FunnelStage) => void;
}

/**
 * Conversion funnel as tapered bars (spec §10.1's explicit "Funnel as tapered bars" instruction --
 * not Recharts' own `FunnelChart`, which renders trapezoids Recharts itself doesn't style well with
 * token colors). Each bar's width is proportional to its value against the largest stage, tapering
 * visually top-to-bottom exactly like a funnel.
 */
function FunnelChartWidget({ stages, onStageClick }: FunnelChartWidgetProps) {
  const maxValue = Math.max(1, ...stages.map((stage) => stage.value));

  return (
    <div data-testid="funnel-chart" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
      {stages.map((stage) => {
        const widthPercent = Math.round((stage.value / maxValue) * 100);
        return (
          <div key={stage.label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
            <span style={{ width: 80, fontSize: '13px', color: 'var(--qiq-text-secondary)' }}>{stage.label}</span>
            <div
              data-testid="funnel-stage-bar"
              role={onStageClick ? 'button' : undefined}
              tabIndex={onStageClick ? 0 : undefined}
              onClick={() => onStageClick?.(stage)}
              style={{
                width: `${widthPercent}%`,
                minWidth: 4,
                height: 24,
                background: 'var(--qiq-accent)',
                borderRadius: 'var(--qiq-radius-chip)',
                cursor: onStageClick ? 'pointer' : 'default',
              }}
            />
            <span style={{ fontSize: '13px', color: 'var(--qiq-text-primary)' }}>{stage.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export default FunnelChartWidget;
