import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import { deriveLeadReportingCategory } from '../leadStatusCategory';
import type { LeadDetailDto } from '../leadsApi';

interface LogFollowUpDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  busy?: boolean;
  error?: string | null;
  onConfirm: (followUpDate: string | null, outcomeNote: string, nextFollowUpDate: string | null) => void;
  onCancel: () => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Log follow-up (spec FR-51, PRD 10.4, T-028): follow-up date defaults to today, an outcome note is
 * always required, and a next-follow-up date is required and must be strictly in the future while
 * the lead is open past Quote Sent (`LogFollowUpCommandHandler`'s "reporting category Quoted" rule,
 * mirrored client-side via the same `deriveLeadReportingCategory` heuristic `LeadsTable` already
 * uses — see that function's own flagged-gap doc comment: `LeadDetailDto` has no reporting-category
 * field either, only a name to derive from). Never changes the lead's status.
 */
function LogFollowUpDialog({ open, lead, busy, error, onConfirm, onCancel }: LogFollowUpDialogProps) {
  const requiresFutureNextDate = deriveLeadReportingCategory(lead.statusName) === 'quoted';

  const [followUpDate, setFollowUpDate] = useState(todayIso());
  const [outcomeNote, setOutcomeNote] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [nextDateError, setNextDateError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setFollowUpDate(todayIso());
    setOutcomeNote('');
    setNextFollowUpDate('');
    setNoteError(null);
    setNextDateError(null);
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    let hasError = false;
    if (outcomeNote.trim().length === 0) {
      setNoteError('An outcome note is required.');
      hasError = true;
    } else {
      setNoteError(null);
    }

    if (requiresFutureNextDate) {
      if (nextFollowUpDate === '') {
        setNextDateError('A next follow-up date is required while this lead is open past Quote Sent.');
        hasError = true;
      } else if (nextFollowUpDate <= todayIso()) {
        setNextDateError('The next follow-up date must be in the future.');
        hasError = true;
      } else {
        setNextDateError(null);
      }
    } else {
      setNextDateError(null);
    }

    if (hasError) {
      return;
    }

    onConfirm(followUpDate, outcomeNote.trim(), nextFollowUpDate === '' ? null : nextFollowUpDate);
  }

  return (
    <WorkflowDialog
      testId="log-follow-up-dialog"
      open={open}
      action="Log follow-up"
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence="This records a follow-up on the timeline; the lead's status is not changed."
      confirmLabel="Log follow-up"
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="follow-up-date">Follow-up date</label>
      <input
        id="follow-up-date"
        name="followUpDate"
        type="date"
        value={followUpDate}
        onChange={(event) => setFollowUpDate(event.target.value)}
      />

      <label htmlFor="follow-up-outcome-note">Outcome note *</label>
      <textarea
        id="follow-up-outcome-note"
        name="outcomeNote"
        data-testid="follow-up-outcome-note-textarea"
        value={outcomeNote}
        onChange={(event) => {
          setOutcomeNote(event.target.value);
          if (noteError) {
            setNoteError(null);
          }
        }}
      />
      {noteError && (
        <p role="alert" data-testid="field-error-outcome-note">
          {noteError}
        </p>
      )}

      <label htmlFor="next-follow-up-date">
        Next follow-up date{requiresFutureNextDate ? ' *' : ''}
      </label>
      <input
        id="next-follow-up-date"
        name="nextFollowUpDate"
        type="date"
        value={nextFollowUpDate}
        onChange={(event) => {
          setNextFollowUpDate(event.target.value);
          if (nextDateError) {
            setNextDateError(null);
          }
        }}
      />
      {nextDateError && (
        <p role="alert" data-testid="field-error-next-follow-up">
          {nextDateError}
        </p>
      )}
    </WorkflowDialog>
  );
}

export default LogFollowUpDialog;
