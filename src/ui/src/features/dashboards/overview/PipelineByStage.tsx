import ChartCard from '../../../components/dashboards/ChartCard';
import type { DashboardExportFilter } from '../../exports/exportsApi';
import type { ExecutivePipelineStageDto } from '../executiveApi';

interface PipelineByStageProps {
  stages: ExecutivePipelineStageDto[];
  onDrill: (widgetKey: string) => void;
  onViewFullPipeline: () => void;
  /** Active dashboard filter, so the card's ⋮ menu exports the same underlying leads the card renders (spec FR-65, T-039). */
  exportFilter: DashboardExportFilter;
}

/**
 * Pipeline by Stage (spec FR-55, T-032): horizontal bars of the CURRENT OPEN item count per stage —
 * NOT cumulative (the prototype deviation this task honors) — each with a count and share-of-open
 * percentage label, drilling to the stage's open leads on click. The bar widths are share-relative to
 * the largest stage so the chart reads like the prototype's funnel-shaped bars.
 */
function PipelineByStage({ stages, onDrill, onViewFullPipeline, exportFilter }: PipelineByStageProps) {
  const maxCount = stages.reduce((max, stage) => Math.max(max, stage.openCount), 0) || 1;

  return (
    <ChartCard
      title="Pipeline by Stage"
      viewAllLabel="View full pipeline"
      onViewAll={onViewFullPipeline}
      exportConfig={{ widgetKey: 'leads.filtered', filter: exportFilter, fileNameBase: 'pipeline-by-stage' }}
    >
      <div data-testid="pipeline-by-stage" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
        {stages.length === 0 && <span className="qiq-card-sub">No open items in the pipeline.</span>}
        {stages.map((stage) => (
          <button
            key={stage.stageCanonicalKey ?? stage.stageName}
            type="button"
            data-testid="pipeline-stage-row"
            onClick={() => onDrill(stage.drillWidgetKey)}
            style={{
              display: 'grid',
              gridTemplateColumns: '150px 1fr 48px 44px',
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
            <span className="qiq-kpi-label">{stage.stageName}</span>
            <span style={{ background: 'var(--qiq-border-subtle)', borderRadius: '4px', height: 18 }}>
              <span
                style={{
                  display: 'block',
                  height: 18,
                  width: `${Math.max(4, (stage.openCount / maxCount) * 100)}%`,
                  background: 'var(--qiq-accent)',
                  borderRadius: '4px',
                }}
              />
            </span>
            <span data-testid="pipeline-stage-count" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {stage.openCount}
            </span>
            <span
              data-testid="pipeline-stage-share"
              className="qiq-card-sub"
              style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {Math.round(stage.shareOfOpen * 100)}%
            </span>
          </button>
        ))}
      </div>
    </ChartCard>
  );
}

export default PipelineByStage;
