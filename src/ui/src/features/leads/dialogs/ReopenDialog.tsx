import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import type { LeadDetailDto } from '../leadsApi';

interface ReopenDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reopenReason: string) => void;
  onCancel: () => void;
}

/**
 * Reopen (spec A-13, PRD 10.4, T-028): a required reason; danger styling (a corrective, permission-
 * bound action on an otherwise-terminal lead).
 *
 * Flagged gap (T-028 final report): A-13's "returns to its last open status" is resolved server-side
 * from the lead's status history (`LeadOperationTargetMode.LastOpenOrQuotedFromHistory`,
 * `LeadOperationExecutor`) and is not exposed anywhere on `GET /leads/{id}` ahead of time, so this
 * dialog cannot name the exact status the lead will return to — it states the rule generically
 * instead. Recommended follow-up: add a `reopenTargetStatusName` (or similar) preview field to
 * `LeadDto` when `reopen` is in `availableOperations`.
 */
function ReopenDialog({ open, lead, busy, error, onConfirm, onCancel }: ReopenDialogProps) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setReason('');
    setReasonError(null);
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    if (reason.trim().length === 0) {
      setReasonError('A reason is required to reopen this lead.');
      return;
    }
    setReasonError(null);
    onConfirm(reason.trim());
  }

  return (
    <WorkflowDialog
      testId="reopen-dialog"
      open={open}
      action="Reopen"
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence="This lead will return to the last open status it held before it was closed."
      confirmLabel="Reopen"
      danger
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="reopen-reason">Reason *</label>
      <textarea
        id="reopen-reason"
        name="reopenReason"
        data-testid="reopen-reason-textarea"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          if (reasonError) {
            setReasonError(null);
          }
        }}
      />
      {reasonError && (
        <p role="alert" data-testid="field-error">
          {reasonError}
        </p>
      )}
    </WorkflowDialog>
  );
}

export default ReopenDialog;
