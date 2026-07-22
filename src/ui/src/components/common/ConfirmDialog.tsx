import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
  /**
   * Overrides the outer `role="presentation"` overlay's `data-testid` (default `confirm-dialog`).
   * The overlay is `position: fixed`, so it contributes no box to its parent's layout — feature
   * dialogs that need a stable, ancestor-independent test selector (e.g. Playwright) should set
   * this rather than wrapping `<ConfirmDialog>` in another `data-testid` element, which would
   * collapse to a zero-size (and therefore "hidden") box.
   */
  testId?: string;
  /** `lg` widens the dialog (`.qiq-dialog--lg`, 760px) for forms that lay fields out in columns. */
  size?: 'md' | 'lg';
}

/**
 * Base workflow/confirmation dialog (UI Standards §14.3): names the action and target, states the
 * consequence, one primary button naming the verb, danger styling for destructive/irreversible
 * actions. Feature dialogs (Assign, Mark lost, etc. — later tasks) compose this with their own
 * inputs via `children`.
 */
function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
  children,
  testId = 'confirm-dialog',
  size = 'md',
}: ConfirmDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div role="presentation" data-testid={testId} className="qiq-scrim">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className={size === 'lg' ? 'qiq-dialog qiq-dialog--lg' : 'qiq-dialog'}
      >
        <div className="qiq-dialog-header">
          <h2 id="confirm-dialog-title" data-testid="workflow-dialog-title">
            {title}
          </h2>
        </div>
        <div className="qiq-dialog-body">
          <p style={{ marginTop: 0, color: 'var(--qiq-text-secondary)' }}>{description}</p>
          {children}
        </div>
        <div className="qiq-dialog-footer">
          <button type="button" className="qiq-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'qiq-btn qiq-btn--danger' : 'qiq-btn qiq-btn--primary'}
            data-testid={danger ? 'dialog-danger-button' : 'dialog-primary-button'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
