import ChartCard from '../../../components/dashboards/ChartCard';
import type { FunnelStageDto } from '../pipelineApi';

interface ConversionFunnelProps {
  stages: FunnelStageDto[];
  onDrill: (widgetKey: string) => void;
}

/**
 * Stage Conversion funnel (spec FR-56, T-033): cumulative reached-stage counts as tapered bars with a
 * conversion-from-top percentage label per stage, and the terminal Lost bar rendered last in red
 * (server-flagged `isLost`, never color alone — the row also reads "Lost"). Each bar drills to the
 * stage's underlying leads on click (AC-055).
 */
function ConversionFunnel({ stages, onDrill }: ConversionFunnelProps) {
  const maxCount = stages.reduce((max, stage) => Math.max(max, stage.reachedCount), 0) || 1;

  return (
    <ChartCard title="Pipeline Stage Conversion">
      <div data-testid="conversion-funnel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
        {stages.length === 0 && <span className="qiq-card-sub">No pipeline activity yet.</span>}
        {stages.map((stage) => (
          <button
            key={stage.stageCanonicalKey ?? stage.stageName}
            type="button"
            data-testid="funnel-stage-row"
            data-is-lost={stage.isLost}
            onClick={() => onDrill(stage.drillWidgetKey)}
            style={{
              display: 'grid',
              gridTemplateColumns: '130px 1fr 48px 52px',
              alignItems: 'center',
              gap: 'var(--qiq-space-2)',
              background: 'none',
              border: 'none',
              padding: 'var(--qiq-space-1) 0',
              cursor: 'pointer',
              textAlign: 'left',
              color: 'var(--qiq-text-primary)',
            }}
          >
            <span className="qiq-kpi-label" style={{ color: stage.isLost ? 'var(--qiq-danger)' : undefined }}>
              {stage.stageName}
            </span>
            <span style={{ background: 'var(--qiq-border-subtle)', borderRadius: '4px', height: 18 }}>
              <span
                style={{
                  display: 'block',
                  height: 18,
                  width: `${Math.max(4, (stage.reachedCount / maxCount) * 100)}%`,
                  background: stage.isLost ? 'var(--qiq-danger)' : 'var(--qiq-accent)',
                  borderRadius: '4px',
                }}
              />
            </span>
            <span data-testid="funnel-stage-count" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {stage.reachedCount}
            </span>
            <span
              data-testid="funnel-stage-conversion"
              className="qiq-card-sub"
              style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {Math.round(stage.conversionFromTop * 100)}%
            </span>
          </button>
        ))}
      </div>
    </ChartCard>
  );
}

export default ConversionFunnel;
