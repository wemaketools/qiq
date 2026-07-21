import { useState } from 'react';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import type { EligibleLeadOwnerDto } from './leadsApi';

interface BulkReassignDialogProps {
  open: boolean;
  count: number;
  /** `null` = the eligible-owner lookup is unavailable for this caller (permission gap, see `leadsApi.getEligibleLeadOwners`). */
  eligibleOwners: EligibleLeadOwnerDto[] | null;
  busy?: boolean;
  onConfirm: (newOwnerUserId: number, note: string) => void;
  onCancel: () => void;
}

/**
 * Bulk Reassign dialog (spec FR-43, Q-12, T-027): visible only to `leads.reassign` holders (gated by
 * `LeadsListPage`). The audit note is required — Q-12: "Bulk reassign requires an audit note and is
 * audited per lead" — enforced here inline (before calling `onConfirm`) as UX, mirroring the
 * server-side `BulkReassignValidator` (T-018) which is the actual authority.
 */
function BulkReassignDialog({ open, count, eligibleOwners, busy, onConfirm, onCancel }: BulkReassignDialogProps) {
  const [ownerUserId, setOwnerUserId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    if (note.trim().length === 0) {
      setNoteError('An audit note is required to bulk reassign leads.');
      return;
    }
    if (ownerUserId === '') {
      return;
    }
    setNoteError(null);
    onConfirm(ownerUserId, note.trim());
  }

  function handleCancel(): void {
    setOwnerUserId('');
    setNote('');
    setNoteError(null);
    onCancel();
  }

  return (
    <ConfirmDialog
      testId="bulk-reassign-dialog"
      open={open}
      title="Bulk reassign leads"
      description={`Reassigning ${count} lead${count === 1 ? '' : 's'} to a new accountable owner. This is audited per lead.`}
      confirmLabel="Reassign"
      busy={busy}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    >
      <p data-testid="bulk-reassign-count">{count} lead(s) selected</p>

      <label htmlFor="bulk-reassign-owner">New owner</label>
      <select
        id="bulk-reassign-owner"
        data-testid="reassign-owner-select"
        disabled={eligibleOwners === null}
        value={ownerUserId}
        onChange={(event) => setOwnerUserId(event.target.value === '' ? '' : Number(event.target.value))}
      >
        <option value="">Select owner…</option>
        {(eligibleOwners ?? []).map((owner) => (
          <option key={owner.userId} value={owner.userId}>
            {owner.firstName} {owner.lastName}
          </option>
        ))}
      </select>
      {eligibleOwners === null && (
        <p role="alert" data-testid="reassign-owner-unavailable">
          Eligible owners could not be loaded. Ask an administrator to grant business-assignment configuration access.
        </p>
      )}

      <label htmlFor="bulk-reassign-note">Note (required)</label>
      <textarea
        id="bulk-reassign-note"
        name="note"
        data-testid="reassign-note-textarea"
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          if (noteError) {
            setNoteError(null);
          }
        }}
      />
      {noteError && (
        <p role="alert" data-testid="reassign-note-error">
          {noteError}
        </p>
      )}
    </ConfirmDialog>
  );
}

export default BulkReassignDialog;
