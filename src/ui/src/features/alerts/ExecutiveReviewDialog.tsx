import { useEffect, useState } from 'react';
import WorkflowDialog from '../../components/common/WorkflowDialog';

interface ExecutiveReviewDialogProps {
  open: boolean;
  entityRef: string;
  partyName: string;
  /**
   * True when the alerting lead is open past Quote Sent (reporting category Quoted). In that state
   * `LogFollowUpCommandHandler` requires a strictly-future next-follow-up date, so the dialog must
   * collect one — otherwise the executive-review action would dead-end on a backend 4xx (F-037-06).
   */
  requiresNextFollowUpDate?: boolean;
  busy?: boolean;
  error?: string | null;
  /**
   * Records the review comment as a follow-up note on the lead (triggers alert re-evaluation). When
   * the lead is open past Quote Sent, a future next-follow-up date is also passed through; otherwise
   * it is null.
   */
  onConfirm: (comment: string, nextFollowUpDate: string | null) => void;
  onCancel: () => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Executive review (spec FR-62, PRD 18.2): the contextual action for `executive_escalation` /
 * `high_value_stalled` alerts. A reviewer acknowledges the escalation with a required comment, which
 * is written as a follow-up note on the lead (`POST /leads/{id}/operations/log-follow-up`) — that
 * counts as lead activity, so the backend's targeted re-evaluation clears/downgrades the stalled/
 * escalation alert. Because these two alert types typically fire on a sent-then-stalled or expiring
 * quote, the alerting lead is usually open past Quote Sent (reporting category Quoted), where
 * `LogFollowUpCommandHandler` requires a strictly-future next-follow-up date; when
 * `requiresNextFollowUpDate` is set the dialog collects and validates that date (matching
 * `LogFollowUpDialog`, T-028) so the action never dead-ends on a backend 4xx (F-037-06). Built on the
 * shared `WorkflowDialog` base so it carries the same title/consequence/inline-error anatomy as every
 * other workflow dialog (spec FR-41).
 */
function ExecutiveReviewDialog({
  open,
  entityRef,
  partyName,
  requiresNextFollowUpDate = false,
  busy,
  error,
  onConfirm,
  onCancel,
}: ExecutiveReviewDialogProps) {
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [nextDateError, setNextDateError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setComment('');
    setCommentError(null);
    setNextFollowUpDate('');
    setNextDateError(null);
  }, [open, entityRef]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    let hasError = false;

    if (comment.trim().length === 0) {
      setCommentError('A review comment is required.');
      hasError = true;
    } else {
      setCommentError(null);
    }

    if (requiresNextFollowUpDate) {
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

    onConfirm(comment.trim(), nextFollowUpDate === '' ? null : nextFollowUpDate);
  }

  return (
    <WorkflowDialog
      testId="executive-review-dialog"
      open={open}
      action="Executive review"
      entityRef={entityRef}
      partyName={partyName}
      consequence="This records your review as a follow-up note and acknowledges the escalation; the alert clears or downgrades once activity is re-evaluated."
      confirmLabel="Acknowledge"
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <label htmlFor="executive-review-comment">Review comment *</label>
      <textarea
        id="executive-review-comment"
        name="comment"
        data-testid="executive-review-comment-textarea"
        value={comment}
        onChange={(event) => {
          setComment(event.target.value);
          if (commentError) {
            setCommentError(null);
          }
        }}
      />
      {commentError && (
        <p role="alert" data-testid="field-error-review-comment">
          {commentError}
        </p>
      )}

      {requiresNextFollowUpDate && (
        <>
          <label htmlFor="executive-review-next-date">Next follow-up date *</label>
          <input
            id="executive-review-next-date"
            name="nextFollowUpDate"
            type="date"
            data-testid="executive-review-next-follow-up-date"
            value={nextFollowUpDate}
            onChange={(event) => {
              setNextFollowUpDate(event.target.value);
              if (nextDateError) {
                setNextDateError(null);
              }
            }}
          />
          {nextDateError && (
            <p role="alert" data-testid="field-error-exec-next-follow-up">
              {nextDateError}
            </p>
          )}
        </>
      )}
    </WorkflowDialog>
  );
}

export default ExecutiveReviewDialog;
