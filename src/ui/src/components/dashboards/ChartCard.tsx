import { useState } from 'react';
import type { ReactNode } from 'react';
import { useOptionalToast } from '../common/Toast';
import {
  buildDashboardExportPath,
  downloadExport,
  type DashboardExportFilter,
  type ExportFormat,
} from '../../features/exports/exportsApi';
import type { NormalizedError } from '../../api/client';

/** Wires a ChartCard's ⋮ menu Export entry to the dashboard-table export endpoint (spec FR-65, T-039). */
export interface ChartCardExportConfig {
  /** Drill widget key whose underlying rows this card exports (e.g. `exec.high_value`, `leads.filtered`). */
  widgetKey: string;
  /** Active dashboard filter, so the export reflects the same filters the card renders under. */
  filter: DashboardExportFilter;
  /** Fallback filename base if the server omits a Content-Disposition filename. */
  fileNameBase: string;
}

interface ChartCardProps {
  title: string;
  /** "View … →" contextual link slot (spec FR-54/UI standards 3.3), e.g. "View pipeline →". Omitted entirely when the card has no dedicated drill-through screen. */
  viewAllLabel?: string;
  onViewAll?: () => void;
  /** ⋮ menu's Export entry (spec FR-65, T-039): when set, the menu offers CSV and Excel export of this card's underlying rows. */
  exportConfig?: ChartCardExportConfig;
  /** ⋮ menu's View details entry (drills the whole chart's underlying rows, AC-053). */
  onViewDetails?: () => void;
  children: ReactNode;
}

/**
 * Chart container card (spec FR-54, UI standards 3.3, T-031): title, optional "View … →" link slot,
 * and an optional ⋮ menu (Export / View details). Every dashboard's individual chart wrappers render
 * inside this shell so the header chrome is identical everywhere.
 */
function ChartCard({ title, viewAllLabel, onViewAll, exportConfig, onViewDetails, children }: ChartCardProps) {
  const toast = useOptionalToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenu = exportConfig !== undefined || onViewDetails !== undefined;

  async function handleExport(format: ExportFormat): Promise<void> {
    if (!exportConfig) {
      return;
    }
    setMenuOpen(false);
    try {
      await downloadExport(
        buildDashboardExportPath(exportConfig.widgetKey, exportConfig.filter, format),
        `${exportConfig.fileNameBase}.${format}`,
      );
    } catch (err) {
      toast?.showError((err as NormalizedError).title ?? 'Unable to generate export.');
    }
  }

  return (
    <div data-testid="chart-card" className="qiq-card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'center' }}>
        <span data-testid="chart-card-title" className="qiq-card-title">
          {title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
          {viewAllLabel && onViewAll && (
            <button
              type="button"
              data-testid="chart-card-view-all"
              onClick={onViewAll}
              className="qiq-card-link"
              style={{ background: 'none', border: 'none', cursor: 'pointer', marginTop: 0 }}
            >
              {viewAllLabel} →
            </button>
          )}
          {hasMenu && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="qiq-menu-dots"
                data-testid="chart-card-menu-button"
                aria-label={`${title} chart options`}
                onClick={() => setMenuOpen((open) => !open)}
              >
                ⋮
              </button>
              {menuOpen && (
                <ul data-testid="chart-card-menu" className="qiq-menu" style={{ position: 'absolute', right: 0, top: '100%', minWidth: 150 }}>
                  {exportConfig && (
                    <>
                      <li>
                        <button
                          type="button"
                          data-testid="chart-card-menu-export-csv"
                          onClick={() => void handleExport('csv')}
                        >
                          Export CSV
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          data-testid="chart-card-menu-export-xlsx"
                          onClick={() => void handleExport('xlsx')}
                        >
                          Export Excel (.xlsx)
                        </button>
                      </li>
                    </>
                  )}
                  {onViewDetails && (
                    <li>
                      <button
                        type="button"
                        data-testid="chart-card-menu-view-details"
                        onClick={() => {
                          onViewDetails();
                          setMenuOpen(false);
                        }}
                      >
                        View details
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
      <div data-testid="chart-card-body" style={{ minWidth: 0, overflowX: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

export default ChartCard;
