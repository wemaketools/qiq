import type { ReactNode } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { formatWorkflowDialogTitle } from './workflowDialogTitle';

export interface WorkflowDialogProps {
  open: boolean;
  /** Action verb shown in the title, e.g. "Assign", "Mark lost". */
  action: string;
  /** The workflow item's own reference, e.g. a lead ref "L-2026-0001" (or a quote ref, T-029). */
  entityRef: string;
  /** The party/customer name shown after the ref. */
  partyName: string;
  /** One-sentence consequence line describing what this operation will do. */
  consequence: string;
  confirmLabel: string;
  /** Danger styling for destructive/irreversible actions (Mark lost, Withdraw, Reopen). */
  danger?: boolean;
  busy?: boolean;
  /** Server/validation error surfaced above the inputs, if the last submit attempt failed. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
  testId: string;
}

/**
 * Shared workflow/lifecycle dialog base (spec FR-41, AC-040, PRD 12.8, T-028): names the action and
 * target ("{Action} — {ref} · {party}"), states the consequence, an inputs slot, Cancel + a verb
 * primary button, danger styling for destructive actions. A thin, generic wrapper over the existing
 * `ConfirmDialog` (UI Standards §14.3) — which already implements this exact anatomy — rather than a
 * parallel modal implementation, so both share one focus-trap/overlay/keyboard-affordance
 * implementation. Used by every one of T-028's eight lead workflow dialogs and designed to be reused
 * as-is by T-029's quote dialogs (`entityRef`/`partyName` generalize to any workflow item, not just
 * leads).
 */
function WorkflowDialog({
  open,
  action,
  entityRef,
  partyName,
  consequence,
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
  testId,
}: WorkflowDialogProps) {
  return (
    <ConfirmDialog
      testId={testId}
      open={open}
      title={formatWorkflowDialogTitle(action, entityRef, partyName)}
      description={consequence}
      confirmLabel={confirmLabel}
      danger={danger}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {error && (
        <p role="alert" data-testid="workflow-dialog-error">
          {error}
        </p>
      )}
      {children}
    </ConfirmDialog>
  );
}

export default WorkflowDialog;
