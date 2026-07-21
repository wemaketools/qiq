import { useEffect, useState } from 'react';
import { formatWorkflowDialogTitle } from '../../../components/common/workflowDialogTitle';
import type { LeadDetailDto } from '../leadsApi';

interface ApproveRejectPricingDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  currencySymbol: string;
  /** Server-granted operations gate which button(s) render (AC-016: hidden, not disabled). */
  canApprove: boolean;
  canReject: boolean;
  busy?: boolean;
  error?: string | null;
  onApprove: (note: string | null) => void;
  onReject: (reason: string) => void;
  onCancel: () => void;
}

/**
 * Approve/Reject pricing (spec FR-37, PRD 10.4, T-028): restates the pending request (requester,
 * proposed premium, note) and offers two distinct actions in one dialog — approve (optional note) or
 * reject (reason required) — so it does not fit `WorkflowDialog`'s single-verb-primary-button shape
 * and is built as its own small modal instead, reusing the same title format/testid conventions.
 *
 * Flagged gap (T-028 final report): `LeadDto` does not project the pending pricing-approval
 * request's own requester/proposed-premium/note (T-019 tracks the sub-state, but `GetLeadQueryHandler`
 * never surfaces it) — this dialog cannot literally "restate" those fields today and instead states
 * the generic consequence of each action. Recommended follow-up: project a `PendingPricingApproval`
 * object (requester name, proposed premium, note) on `LeadDto`.
 */
function ApproveRejectPricingDialog({
  open,
  lead,
  canApprove,
  canReject,
  busy,
  error,
  onApprove,
  onReject,
  onCancel,
}: ApproveRejectPricingDialogProps) {
  const [approveNote, setApproveNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejectReasonError, setRejectReasonError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setApproveNote('');
    setRejectReason('');
    setRejectReasonError(null);
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  function handleReject(): void {
    if (rejectReason.trim().length === 0) {
      setRejectReasonError('A rejection reason is required.');
      return;
    }
    setRejectReasonError(null);
    onReject(rejectReason.trim());
  }

  return (
    <div role="presentation" data-testid="approve-reject-pricing-dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="approve-reject-pricing-title" style={{ margin: '10vh auto', maxWidth: '480px', background: 'var(--qiq-surface-raised)', borderRadius: 'var(--qiq-radius-card)', padding: 'var(--qiq-space-5)' }}>
        <h2 id="approve-reject-pricing-title" data-testid="workflow-dialog-title">
          {formatWorkflowDialogTitle('Approve/Reject pricing', lead.leadRef, lead.partyName)}
        </h2>
        <p>This lead has a pending pricing-approval request.</p>

        {error && (
          <p role="alert" data-testid="workflow-dialog-error">
            {error}
          </p>
        )}

        {canApprove && (
          <div>
            <label htmlFor="approve-pricing-note">Approval note</label>
            <textarea
              id="approve-pricing-note"
              name="approveNote"
              data-testid="approve-pricing-note-textarea"
              value={approveNote}
              onChange={(event) => setApproveNote(event.target.value)}
            />
          </div>
        )}

        {canReject && (
          <div>
            <label htmlFor="reject-pricing-reason">Rejection reason</label>
            <textarea
              id="reject-pricing-reason"
              name="rejectReason"
              data-testid="reject-pricing-reason-textarea"
              value={rejectReason}
              onChange={(event) => {
                setRejectReason(event.target.value);
                if (rejectReasonError) {
                  setRejectReasonError(null);
                }
              }}
            />
            {rejectReasonError && (
              <p role="alert" data-testid="field-error">
                {rejectReasonError}
              </p>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--qiq-space-3)', marginTop: 'var(--qiq-space-4)' }}>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {canReject && (
            <button
              type="button"
              data-testid="dialog-danger-button"
              disabled={busy}
              onClick={handleReject}
              style={{ background: 'var(--qiq-danger)', color: 'var(--qiq-accent-contrast)', border: 'none', borderRadius: '6px', padding: 'var(--qiq-space-2) var(--qiq-space-4)' }}
            >
              Reject
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              data-testid="dialog-primary-button"
              disabled={busy}
              onClick={() => onApprove(approveNote.trim().length > 0 ? approveNote.trim() : null)}
              style={{ background: 'var(--qiq-accent)', color: 'var(--qiq-accent-contrast)', border: 'none', borderRadius: '6px', padding: 'var(--qiq-space-2) var(--qiq-space-4)' }}
            >
              Approve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ApproveRejectPricingDialog;
