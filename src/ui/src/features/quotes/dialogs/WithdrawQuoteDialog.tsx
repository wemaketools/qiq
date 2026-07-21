import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';

interface WithdrawQuoteDialogProps {
  open: boolean;
  quoteRef: string;
  partyName: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (withdrawalNote: string) => void;
  onCancel: () => void;
}

/** Withdraw quote (spec FR-38/FR-40, PRD 10.4, T-029): a required note; danger styling; the lead is never changed by this operation. */
function WithdrawQuoteDialog({ open, quoteRef, partyName, busy, error, onConfirm, onCancel }: WithdrawQuoteDialogProps) {
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setNote('');
    setNoteError(null);
  }, [open, quoteRef]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    if (note.trim().length === 0) {
      setNoteError('A note is required to withdraw this quote.');
      return;
    }
    setNoteError(null);
    onConfirm(note.trim());
  }

  return (
    <WorkflowDialog
      testId="withdraw-quote-dialog"
      open={open}
      action="Withdraw"
      entityRef={quoteRef}
      partyName={partyName}
      consequence="This quote will be withdrawn. The lead itself is not changed."
      confirmLabel="Withdraw"
      danger
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="withdraw-quote-note">Note *</label>
      <textarea
        id="withdraw-quote-note"
        name="withdrawalNote"
        data-testid="withdraw-quote-note-textarea"
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          if (noteError) {
            setNoteError(null);
          }
        }}
      />
      {noteError && (
        <p role="alert" data-testid="field-error">
          {noteError}
        </p>
      )}
    </WorkflowDialog>
  );
}

export default WithdrawQuoteDialog;
