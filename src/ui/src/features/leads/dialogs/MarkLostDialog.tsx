import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import CurrencyInput from '../../../components/common/CurrencyInput';
import type { ReferenceItemDto } from '../../settings/settingsApi';
import type { LeadDetailDto } from '../leadsApi';

interface MarkLostDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  /** `lost_reason` reference list (`listReferenceItems('lost_reason')`); `null` while still loading/unavailable. */
  lostReasons: ReferenceItemDto[] | null;
  currencySymbol: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (lostReasonId: number, competitor: string | null, competitorPremium: number | null, lossComments: string | null) => void;
  onCancel: () => void;
}

const OTHER_CANONICAL_KEY = 'other';

/**
 * Mark lost (spec FR-36/FR-40, PRD 10.4, T-028): a required lost-reason dropdown (inline "Select a
 * lost reason" error, mirroring `MarkLeadLostValidator`'s server-side requirement), competitor/
 * competitor-premium, and loss comments — required client-side when the selected reason's
 * `canonicalKey` is `"other"`, mirroring `MarkLeadLostCommandHandler`'s exact same rule. Danger
 * styling (destructive/terminal transition); warns that any open quotes will also be marked Lost.
 */
function MarkLostDialog({ open, lead, lostReasons, currencySymbol, busy, error, onConfirm, onCancel }: MarkLostDialogProps) {
  const [lostReasonId, setLostReasonId] = useState('');
  const [competitor, setCompetitor] = useState('');
  const [competitorPremium, setCompetitorPremium] = useState<number | null>(null);
  const [lossComments, setLossComments] = useState('');
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
    setReasonError(null);
    setCommentsError(null);
  }, [open, lead.id]);

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
    );
  }

  return (
    <WorkflowDialog
      testId="mark-lost-dialog"
      open={open}
      action="Mark lost"
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence="This lead will be marked Closed Lost. Any open quotes on this lead will also be marked Lost."
      confirmLabel="Mark lost"
      danger
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="lost-reason">Lost reason *</label>
      <select
        id="lost-reason"
        name="lostReasonId"
        data-testid="lost-reason-select"
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

      <label htmlFor="lost-competitor">Competitor</label>
      <input id="lost-competitor" name="competitor" type="text" value={competitor} onChange={(event) => setCompetitor(event.target.value)} />

      <label htmlFor="lost-competitor-premium">Competitor premium</label>
      <CurrencyInput
        id="lost-competitor-premium"
        name="competitorPremium"
        value={competitorPremium}
        currencySymbol={currencySymbol}
        onChange={setCompetitorPremium}
      />

      <label htmlFor="lost-comments">
        Loss comments{requiresComments ? ' *' : ''}
      </label>
      <textarea
        id="lost-comments"
        name="lossComments"
        data-testid="lost-comments-textarea"
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
    </WorkflowDialog>
  );
}

export default MarkLostDialog;
