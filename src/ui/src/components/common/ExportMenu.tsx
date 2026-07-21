import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { useOptionalToast } from './Toast';
import { downloadExport, type ExportFormat } from '../../features/exports/exportsApi';
import type { NormalizedError } from '../../api/client';

interface ExportMenuProps {
  /** Builds the export API path for a chosen format (e.g. `/exports/leads?...&format=csv`). */
  buildPath: (format: ExportFormat) => string;
  /** Fallback filename base if the server omits a Content-Disposition filename (e.g. `leads`). */
  fileNameBase: string;
  /** Hides/disables the trigger (e.g. no export permission or nothing to export). */
  disabled?: boolean;
  /** Trigger label; defaults to "Export". */
  label?: string;
  /** Root test id; defaults to `export-menu`. */
  testId?: string;
  /** Render as a bare menu item (used inside the ChartCard ⋮ menu) rather than a standalone button+dropdown. */
  variant?: 'button' | 'inline';
}

/**
 * CSV / Excel export affordance (spec FR-65, AC-064, T-039). Wired to the Leads/Parties list toolbars,
 * the dashboard ChartCard ⋮ menus, and the TopBar Export action. Downloads stream through the shared
 * API client's blob path so bearer-token + `X-Tenant-Id` handling stay centralised; the server-supplied
 * `{tenant}-{entity}-{yyyyMMdd}.{ext}` filename drives the saved name. Styled entirely with the T-043
 * design-system classes (`.qiq-*`) and the shared `Icon`, no ad-hoc CSS.
 */
function ExportMenu({ buildPath, fileNameBase, disabled = false, label = 'Export', testId = 'export-menu', variant = 'button' }: ExportMenuProps) {
  const toast = useOptionalToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocumentClick(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  async function handleSelect(format: ExportFormat): Promise<void> {
    setOpen(false);
    setBusy(true);
    try {
      await downloadExport(buildPath(format), `${fileNameBase}.${format}`);
    } catch (err) {
      toast?.showError((err as NormalizedError).title ?? 'Unable to generate export.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} data-testid={testId} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className={variant === 'button' ? 'qiq-btn' : 'qiq-menu-dots'}
        data-testid={`${testId}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="export" size={16} />
        {variant === 'button' && <span>{busy ? 'Exporting…' : label}</span>}
      </button>

      {open && (
        <ul
          data-testid={`${testId}-list`}
          role="menu"
          className="qiq-menu"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', minWidth: 160 }}
        >
          <li role="none">
            <button type="button" role="menuitem" data-testid={`${testId}-csv`} onClick={() => void handleSelect('csv')}>
              CSV
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" data-testid={`${testId}-xlsx`} onClick={() => void handleSelect('xlsx')}>
              Excel (.xlsx)
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

export default ExportMenu;
