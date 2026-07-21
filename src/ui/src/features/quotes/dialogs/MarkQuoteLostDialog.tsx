import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import CurrencyInput from '../../../components/common/CurrencyInput';
import type { ReferenceItemDto } from '../../settings/settingsApi';

interface MarkQuoteLostDialogProps {
  open: boolean;
  quoteRef: string;
  partyName: string;
  lostReasons: ReferenceItemDto[] | null;
  currencySymbol: string;
  /** True when at least one other open quote remains on this quote's lead (drives the checkbox's default, mirrors `MarkQuoteLostCommandHandler`'s server-side default). */
  hasOtherOpenQuotes: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (
    lostReasonId: number,
    competitor: string | null,
    competitorPremium: number | null,
    lossComments: string | null,
    alsoCloseLead: boolean,
  ) => void;
  onCancel: () => void;
}

const OTHER_CANONICAL_KEY = 'other';

/**
 * Mark quote lost (spec FR-38/FR-40, PRD 10.4, T-029): required lost-reason dropdown, competitor
 * fields, loss comments (required when the reason is "Other", mirrors `MarkQuoteLostCommandHandler`'s
 * exact rule), and an "Also close the lead as Lost" checkbox — defaulted checked exactly when no
 * other open quote remains on the lead (mirrors the handler's own `AlsoCloseLead ?? noOtherOpenQuoteRemains`
 * default), always sent explicitly so the user's choice is authoritative over the server default.
 */
function MarkQuoteLostDialog({
  open,
  quoteRef,
  partyName,
  lostReasons,
  currencySymbol,
  hasOtherOpenQuotes,
  busy,
  error,
  onConfirm,
  onCancel,
}: MarkQuoteLostDialogProps) {
  const [lostReasonId, setLostReasonId] = useState('');
  const [competitor, setCompetitor] = useState('');
  const [competitorPremium, setCompetitorPremium] = useState<number | null>(null);
  const [lossComments, setLossComments] = useState('');
  const [alsoCloseLead, setAlsoCloseLead] = useState(!hasOtherOpenQuotes);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setLostReasonId('');
    setCompetitor('');
    setCompetitorPremium(null);
    setLossComments('');
    setAlsoCloseLead(!hasOtherOpenQuotes);
    setReasonError(null);
    setCommentsError(null);
  }, [open, quoteRef, hasOtherOpenQuotes]);

  if (!open) {
    return null;
  }

  const selectedReason = lostReasons?.find((reason) => String(reason.id) === lostReasonId) ?? null;
  const requiresComments = selectedReason?.canonicalKey === OTHER_CANONICAL_KEY;

  function handleConfirm(): void {
    let hasError = false;
    if (lostReasonId === '') {
      setReasonError('Select a lost reason.');
      hasError = true;
    } else {
      setReasonError(null);
    }
    if (requiresComments && lossComments.trim().length === 0) {
      setCommentsError("Loss comments are required when the lost reason is 'Other'.");
      hasError = true;
    } else {
      setCommentsError(null);
    }
    if (hasError) {
      return;
    }

    onConfirm(
      Number(lostReasonId),
      competitor.trim().length > 0 ? competitor.trim() : null,
      competitorPremium,
      lossComments.trim().length > 0 ? lossComments.trim() : null,
      alsoCloseLead,
    );
  }

  return (
    <WorkflowDialog
      testId="mark-quote-lost-dialog"
      open={open}
      action="Mark lost"
      entityRef={quoteRef}
      partyName={partyName}
      consequence="This quote will be marked Lost."
      confirmLabel="Mark lost"
      danger
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="quote-lost-reason">Lost reason *</label>
      <select
        id="quote-lost-reason"
        name="lostReasonId"
        data-testid="quote-lost-reason-select"
        value={lostReasonId}
        disabled={lostReasons === null}
        onChange={(event) => {
          setLostReasonId(event.target.value);
          if (reasonError) {
            setReasonError(null);
          }
        }}
      >
        <option value="">Select a reason…</option>
        {(lostReasons ?? []).map((reason) => (
          <option key={reason.id} value={reason.id}>
            {reason.name}
          </option>
        ))}
      </select>
      {reasonError && (
        <p role="alert" data-testid="field-error-lost-reason">
          {reasonError}
        </p>
      )}

      <label htmlFor="quote-lost-competitor">Competitor</label>
      <input id="quote-lost-competitor" name="competitor" type="text" value={competitor} onChange={(event) => setCompetitor(event.target.value)} />

      <label htmlFor="quote-lost-competitor-premium">Competitor premium</label>
      <CurrencyInput
        id="quote-lost-competitor-premium"
        name="competitorPremium"
        value={competitorPremium}
        currencySymbol={currencySymbol}
        onChange={setCompetitorPremium}
      />

      <label htmlFor="quote-lost-comments">Loss comments{requiresComments ? ' *' : ''}</label>
      <textarea
        id="quote-lost-comments"
        name="lossComments"
        data-testid="quote-lost-comments-textarea"
        value={lossComments}
        onChange={(event) => {
          setLossComments(event.target.value);
          if (commentsError) {
            setCommentsError(null);
          }
        }}
      />
      {commentsError && (
        <p role="alert" data-testid="field-error-loss-comments">
          {commentsError}
        </p>
      )}

      <label htmlFor="quote-lost-also-close-lead">
        <input
          id="quote-lost-also-close-lead"
          name="alsoCloseLead"
          type="checkbox"
          data-testid="also-close-lead-checkbox"
          checked={alsoCloseLead}
          onChange={(event) => setAlsoCloseLead(event.target.checked)}
        />
        Also close the lead as Lost
      </label>
    </WorkflowDialog>
  );
}

export default MarkQuoteLostDialog;
