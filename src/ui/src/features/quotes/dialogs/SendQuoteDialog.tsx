import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import CurrencyInput from '../../../components/common/CurrencyInput';

interface SendQuoteDialogProps {
  open: boolean;
  quoteRef: string;
  partyName: string;
  quotedPremium: number | null;
  /** The quote's stored valid-until (set at Draft), pre-filling the required field below. */
  defaultValidUntil?: string | null;
  currencySymbol: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (sentDate: string, validUntil: string, nextFollowUpDate: string) => void;
  onCancel: () => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Send quote (spec FR-38/FR-46, PRD 10.4, T-029): sent date defaults today, valid-until and the
 * lead's next follow-up date are BOTH required (`SendQuoteValidator`'s exact server-side rule —
 * mirrored here for UX only, the server remains authoritative), quoted premium shown read-only for
 * confirmation. Valid-until pre-fills from the value stored on the quote at Draft — it stays
 * editable, and is only truly required here because a DRAFT may legally lack one. Legal only from
 * Draft; the lead's status chip becomes Quote Sent on the first send.
 */
function SendQuoteDialog({ open, quoteRef, partyName, quotedPremium, defaultValidUntil, currencySymbol, busy, error, onConfirm, onCancel }: SendQuoteDialogProps) {
  const [sentDate, setSentDate] = useState(today());
  const [validUntil, setValidUntil] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [validUntilError, setValidUntilError] = useState<string | null>(null);
  const [nextFollowUpError, setNextFollowUpError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSentDate(today());
    setValidUntil(defaultValidUntil ?? '');
    setNextFollowUpDate('');
    setValidUntilError(null);
    setNextFollowUpError(null);
  }, [open, quoteRef, defaultValidUntil]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    let hasError = false;
    if (validUntil.trim().length === 0) {
      setValidUntilError('Valid-until is required to send a quote.');
      hasError = true;
    } else {
      setValidUntilError(null);
    }
    if (nextFollowUpDate.trim().length === 0) {
      setNextFollowUpError('A next follow-up date is required to send a quote.');
      hasError = true;
    } else {
      setNextFollowUpError(null);
    }
    if (hasError) {
      return;
    }
    onConfirm(sentDate, validUntil, nextFollowUpDate);
  }

  return (
    <WorkflowDialog
      testId="send-quote-dialog"
      open={open}
      action="Send"
      entityRef={quoteRef}
      partyName={partyName}
      consequence="This quote will be marked Sent. If this is the lead's first sent quote, the lead moves to Quote Sent."
      confirmLabel="Send"
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="send-quote-premium">Quoted premium</label>
      <CurrencyInput id="send-quote-premium" name="quotedPremium" value={quotedPremium} currencySymbol={currencySymbol} onChange={() => {}} disabled />

      <label htmlFor="send-quote-sent-date">Sent date</label>
      <input id="send-quote-sent-date" name="sentDate" type="date" value={sentDate} onChange={(event) => setSentDate(event.target.value)} />

      <label htmlFor="send-quote-valid-until">Valid until *</label>
      <input
        id="send-quote-valid-until"
        name="validUntil"
        type="date"
        value={validUntil}
        onChange={(event) => {
          setValidUntil(event.target.value);
          if (validUntilError) {
            setValidUntilError(null);
          }
        }}
      />
      {validUntilError && (
        <p role="alert" data-testid="field-error-valid-until">
          {validUntilError}
        </p>
      )}

      <label htmlFor="send-quote-next-follow-up">Next follow-up date *</label>
      <input
        id="send-quote-next-follow-up"
        name="nextFollowUpDate"
        type="date"
        value={nextFollowUpDate}
        onChange={(event) => {
          setNextFollowUpDate(event.target.value);
          if (nextFollowUpError) {
            setNextFollowUpError(null);
          }
        }}
      />
      {nextFollowUpError && (
        <p role="alert" data-testid="field-error-next-follow-up">
          {nextFollowUpError}
        </p>
      )}
    </WorkflowDialog>
  );
}

export default SendQuoteDialog;
