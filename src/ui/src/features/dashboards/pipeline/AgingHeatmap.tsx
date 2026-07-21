import ChartCard from '../../../components/dashboards/ChartCard';
import HeatmapChartWidget, { type HeatmapCell, type HeatmapSeverity } from '../../../components/dashboards/charts/HeatmapChartWidget';
import type { AgingByStageDto } from '../pipelineApi';

interface AgingHeatmapProps {
  heatmap: AgingByStageDto;
  onDrill: (widgetKey: string) => void;
}

/**
 * Aging by Stage heatmap (spec FR-56, T-033): OPEN stages (rows) x age buckets + Total (columns), each
 * cell carrying the count of open items with a green -> amber -> red concentration grade behind it (the
 * numeric value is always visible text, never color alone — NFR-03). Won/Lost rows are omitted (the
 * prototype deviation this task honors). Clicking a hot cell drills to the matching aged items (AC-055).
 */
function AgingHeatmap({ heatmap, onDrill }: AgingHeatmapProps) {
  const rowLabels = heatmap.stages.map((stage) => stage.stageName);
  const cells: HeatmapCell[] = heatmap.cells.map((cell) => ({
    row: cell.stageName,
    column: cell.bucket,
    value: cell.count,
    severity: cell.grade as HeatmapSeverity,
  }));

  return (
    <ChartCard title="Aging by Stage">
      <div data-testid="aging-heatmap">
        <HeatmapChartWidget
          rowLabels={rowLabels}
          columnLabels={heatmap.buckets}
          cells={cells}
          onCellClick={() => onDrill(heatmap.drillWidgetKey)}
        />
      </div>
    </ChartCard>
  );
}

export default AgingHeatmap;
