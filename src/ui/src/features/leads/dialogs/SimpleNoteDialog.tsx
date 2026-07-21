import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import type { LeadDetailDto } from '../leadsApi';

interface SimpleNoteDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  action: string;
  consequence: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (note: string | null) => void;
  onCancel: () => void;
  testId: string;
}

/**
 * A single optional-note confirmation, shared by the three lead workflow operations PRD 12.8 does
 * not call out as one of the eight named dialogs (Start information gathering, Start pricing, Start
 * negotiation — each takes only `OptionalNoteRequest`, T-019). Built on `WorkflowDialog` like every
 * other lead dialog, so it still carries the shared title format/consequence/danger-off anatomy.
 */
function SimpleNoteDialog({ open, lead, action, consequence, confirmLabel, busy, error, onConfirm, onCancel, testId }: SimpleNoteDialogProps) {
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) {
      return;
    }
    setNote('');
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  return (
    <WorkflowDialog
      testId={testId}
      open={open}
      action={action}
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence={consequence}
      confirmLabel={confirmLabel}
      busy={busy}
      error={error}
      onConfirm={() => onConfirm(note.trim().length > 0 ? note.trim() : null)}
      onCancel={onCancel}
    >
      <label htmlFor="simple-note">Note</label>
      <textarea id="simple-note" name="note" data-testid="simple-note-textarea" value={note} onChange={(event) => setNote(event.target.value)} />
    </WorkflowDialog>
  );
}

export default SimpleNoteDialog;
