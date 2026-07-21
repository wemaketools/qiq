export type HeatmapSeverity = 'normal' | 'amber' | 'red';

export interface HeatmapCell {
  row: string;
  column: string;
  value: number;
  severity: HeatmapSeverity;
}

interface HeatmapChartWidgetProps {
  rowLabels: string[];
  columnLabels: string[];
  cells: HeatmapCell[];
  onCellClick?: (cell: HeatmapCell) => void;
}

const SEVERITY_BACKGROUND: Record<HeatmapSeverity, string> = {
  normal: 'var(--qiq-surface-card)',
  amber: 'var(--qiq-warning-soft)',
  red: 'var(--qiq-danger-soft)',
};

/**
 * Aging heatmap as a CSS-grid table with graded backgrounds (spec §10.1's explicit instruction, PRD
 * 15.5-style row/column aging matrices, T-031): every cell carries its numeric value as visible text
 * (never color alone, NFR-03/AC-069) with a severity-graded background behind it.
 */
function HeatmapChartWidget({ rowLabels, columnLabels, cells, onCellClick }: HeatmapChartWidgetProps) {
  const cellByKey = new Map(cells.map((cell) => [`${cell.row}::${cell.column}`, cell]));

  return (
    <table data-testid="heatmap-chart">
      <thead>
        <tr>
          <th />
          {columnLabels.map((column) => (
            <th key={column}>{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rowLabels.map((row) => (
          <tr key={row}>
            <th style={{ textAlign: 'left' }}>{row}</th>
            {columnLabels.map((column) => {
              const cell = cellByKey.get(`${row}::${column}`);
              if (!cell) {
                return <td key={column} />;
              }
              return (
                <td
                  key={column}
                  data-testid="heatmap-cell"
                  role={onCellClick ? 'button' : undefined}
                  tabIndex={onCellClick ? 0 : undefined}
                  onClick={() => onCellClick?.(cell)}
                  style={{
                    background: SEVERITY_BACKGROUND[cell.severity],
                    textAlign: 'center',
                    padding: 'var(--qiq-space-2)',
                    cursor: onCellClick ? 'pointer' : 'default',
                  }}
                >
                  {cell.value}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default HeatmapChartWidget;
