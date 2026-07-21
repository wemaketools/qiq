import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import CurrencyInput from '../../../components/common/CurrencyInput';

interface MarkWonDialogProps {
  open: boolean;
  quoteRef: string;
  partyName: string;
  quotedPremium: number | null;
  currencySymbol: string;
  hasOtherOpenQuotes: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (boundPremium: number | null, decisionDate: string | null) => void;
  onCancel: () => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mark won (spec FR-38/FR-39/FR-40, PRD 10.4, T-029): bound premium defaults to the quote's current
 * quoted premium (mirrors `MarkQuoteWonCommandHandler`'s server-side default when omitted), decision
 * date defaults today. This is the ONLY path to Closed Won (FR-39): moves the lead to Closed Won and
 * withdraws every other open quote on the lead — warned inline when any exist.
 */
function MarkWonDialog({ open, quoteRef, partyName, quotedPremium, currencySymbol, hasOtherOpenQuotes, busy, error, onConfirm, onCancel }: MarkWonDialogProps) {
  const [boundPremium, setBoundPremium] = useState<number | null>(quotedPremium);
  const [decisionDate, setDecisionDate] = useState(today());

  useEffect(() => {
    if (!open) {
      return;
    }
    setBoundPremium(quotedPremium);
    setDecisionDate(today());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog (re)opens for this quote.
  }, [open, quoteRef]);

  if (!open) {
    return null;
  }

  return (
    <WorkflowDialog
      testId="mark-won-dialog"
      open={open}
      action="Mark won"
      entityRef={quoteRef}
      partyName={partyName}
      consequence={
        hasOtherOpenQuotes
          ? 'This quote will be marked Won and the lead moves to Closed Won. Other open quotes on this lead will be withdrawn.'
          : 'This quote will be marked Won and the lead moves to Closed Won.'
      }
      confirmLabel="Mark won"
      busy={busy}
      error={error}
      onConfirm={() => onConfirm(boundPremium, decisionDate)}
      onCancel={onCancel}
    >
      <label htmlFor="mark-won-bound-premium">Bound premium</label>
      <CurrencyInput id="mark-won-bound-premium" name="boundPremium" value={boundPremium} currencySymbol={currencySymbol} onChange={setBoundPremium} />

      <label htmlFor="mark-won-decision-date">Decision date</label>
      <input
        id="mark-won-decision-date"
        name="decisionDate"
        type="date"
        value={decisionDate}
        onChange={(event) => setDecisionDate(event.target.value)}
      />
    </WorkflowDialog>
  );
}

export default MarkWonDialog;
