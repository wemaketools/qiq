import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import CurrencyInput from '../../../components/common/CurrencyInput';

interface ReviseQuoteDialogProps {
  open: boolean;
  quoteRef: string;
  partyName: string;
  currentQuotedPremium: number | null;
  currencySymbol: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (newQuotedPremium: number | null, termsNotes: string | null, revisionNote: string) => void;
  onCancel: () => void;
}

/**
 * Revise quote (spec FR-38/FR-49/FR-50, PRD 10.4, T-029): at least one of a new premium or terms
 * notes is required (mirrors `ReviseQuoteValidator`'s exact rule), a revision note is always
 * required. Inserts a new current version; the prior version stays visible in history. Legal only
 * from Sent.
 */
function ReviseQuoteDialog({ open, quoteRef, partyName, currentQuotedPremium, currencySymbol, busy, error, onConfirm, onCancel }: ReviseQuoteDialogProps) {
  const [newQuotedPremium, setNewQuotedPremium] = useState<number | null>(null);
  const [termsNotes, setTermsNotes] = useState('');
  const [revisionNote, setRevisionNote] = useState('');
  const [changeError, setChangeError] = useState<string | null>(null);
  const [revisionNoteError, setRevisionNoteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setNewQuotedPremium(null);
    setTermsNotes('');
    setRevisionNote('');
    setChangeError(null);
    setRevisionNoteError(null);
  }, [open, quoteRef]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    let hasError = false;
    if (newQuotedPremium === null && termsNotes.trim().length === 0) {
      setChangeError('At least one of a new quoted premium or terms notes must be supplied.');
      hasError = true;
    } else {
      setChangeError(null);
    }
    if (revisionNote.trim().length === 0) {
      setRevisionNoteError('A revision note is required.');
      hasError = true;
    } else {
      setRevisionNoteError(null);
    }
    if (hasError) {
      return;
    }
    onConfirm(newQuotedPremium, termsNotes.trim().length > 0 ? termsNotes.trim() : null, revisionNote.trim());
  }

  return (
    <WorkflowDialog
      testId="revise-quote-dialog"
      open={open}
      action="Revise"
      entityRef={quoteRef}
      partyName={partyName}
      consequence="A new current version will be created; the prior version stays visible in history. The quote moves to Revised."
      confirmLabel="Revise"
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <p data-testid="revise-current-premium">Current premium: {currencySymbol} {(currentQuotedPremium ?? 0).toLocaleString('en-US')}</p>

      <label htmlFor="revise-new-premium">New quoted premium</label>
      <CurrencyInput
        id="revise-new-premium"
        name="newQuotedPremium"
        value={newQuotedPremium}
        currencySymbol={currencySymbol}
        onChange={(value) => {
          setNewQuotedPremium(value);
          if (changeError) {
            setChangeError(null);
          }
        }}
      />

      <label htmlFor="revise-terms-notes">Terms notes</label>
      <textarea
        id="revise-terms-notes"
        name="termsNotes"
        data-testid="revise-terms-notes-textarea"
        value={termsNotes}
        onChange={(event) => {
          setTermsNotes(event.target.value);
          if (changeError) {
            setChangeError(null);
          }
        }}
      />
      {changeError && (
        <p role="alert" data-testid="field-error-change">
          {changeError}
        </p>
      )}

      <label htmlFor="revise-revision-note">Revision note *</label>
      <textarea
        id="revise-revision-note"
        name="revisionNote"
        data-testid="revise-revision-note-textarea"
        value={revisionNote}
        onChange={(event) => {
          setRevisionNote(event.target.value);
          if (revisionNoteError) {
            setRevisionNoteError(null);
          }
        }}
      />
      {revisionNoteError && (
        <p role="alert" data-testid="field-error-revision-note">
          {revisionNoteError}
        </p>
      )}
    </WorkflowDialog>
  );
}

export default ReviseQuoteDialog;
