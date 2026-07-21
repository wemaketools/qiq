import type { LeadDuplicateMatchDto } from '../leadsApi';

interface DuplicateLeadDialogProps {
  open: boolean;
  duplicates: LeadDuplicateMatchDto[];
  busy?: boolean;
  onReviewExisting: (leadId: number) => void;
  onCreateAnyway: () => void;
  onCancel: () => void;
}

/**
 * Duplicate-lead warning dialog (spec FR-31, AC-030, PRD 9.3): shown when `POST /leads` returns the
 * confirm-gated `requiresConfirmation` envelope (an open lead already exists for the same party and
 * product line within the tenant's duplicate window). Non-blocking: "Create anyway" resubmits with
 * `createAnyway: true`; "Review existing" navigates to the first listed duplicate instead of
 * creating a new lead. Nothing has been persisted yet when this dialog is showing.
 */
function DuplicateLeadDialog({ open, duplicates, busy, onReviewExisting, onCreateAnyway, onCancel }: DuplicateLeadDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      role="presentation"
      data-testid="duplicate-lead-dialog"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-lead-dialog-title"
        style={{
          margin: '10vh auto',
          maxWidth: '480px',
          background: 'var(--qiq-surface-raised)',
          borderRadius: 'var(--qiq-radius-card)',
          padding: 'var(--qiq-space-5)',
        }}
      >
        <h2 id="duplicate-lead-dialog-title">Possible duplicate lead</h2>
        <p>An open lead already exists for this party and product line within the tenant&apos;s duplicate window:</p>
        <ul>
          {duplicates.map((duplicate) => (
            <li key={duplicate.leadId}>
              <a
                href={`/leads/${duplicate.leadId}`}
                data-testid="duplicate-lead-link"
                onClick={(event) => {
                  event.preventDefault();
                  onReviewExisting(duplicate.leadId);
                }}
              >
                {duplicate.leadRef}
              </a>{' '}
              — {duplicate.status} ({duplicate.dateReceived})
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--qiq-space-3)', marginTop: 'var(--qiq-space-4)' }}>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => duplicates[0] && onReviewExisting(duplicates[0].leadId)}
            disabled={busy || duplicates.length === 0}
          >
            Review existing
          </button>
          <button type="button" data-testid="dialog-danger-button" onClick={onCreateAnyway} disabled={busy}>
            Create anyway
          </button>
        </div>
      </div>
    </div>
  );
}

export default DuplicateLeadDialog;
