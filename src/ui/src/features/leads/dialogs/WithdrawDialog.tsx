import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import type { LeadDetailDto } from '../leadsApi';

interface WithdrawDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  busy?: boolean;
  error?: string | null;
  onConfirm: (withdrawalNote: string) => void;
  onCancel: () => void;
}

/** Withdraw (PRD 10.4, T-028): a required note; danger styling; warns any open quotes will also be withdrawn. */
function WithdrawDialog({ open, lead, busy, error, onConfirm, onCancel }: WithdrawDialogProps) {
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setNote('');
    setNoteError(null);
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    if (note.trim().length === 0) {
      setNoteError('A note is required to withdraw this lead.');
      return;
    }
    setNoteError(null);
    onConfirm(note.trim());
  }

  return (
    <WorkflowDialog
      testId="withdraw-dialog"
      open={open}
      action="Withdraw"
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence="This lead will be withdrawn. Any open quotes on this lead will also be withdrawn."
      confirmLabel="Withdraw"
      danger
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="withdraw-note">Note *</label>
      <textarea
        id="withdraw-note"
        name="withdrawalNote"
        data-testid="withdraw-note-textarea"
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

export default WithdrawDialog;
