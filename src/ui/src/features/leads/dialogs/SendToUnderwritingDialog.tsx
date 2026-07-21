import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import AssigneeSelect, { type AssigneeOption } from '../../../components/common/AssigneeSelect';
import type { BusinessAssignmentEntryDto, EligibleAssigneeApiDto } from '../../settings/settingsApi';
import { getEligibleAssignees, type LeadDetailDto } from '../leadsApi';

interface SendToUnderwritingDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  /** Tenant's configured Underwriting slot (`fetchBusinessAssignments().underwritingRole`), or `null` when unconfigured. */
  underwritingRole: BusinessAssignmentEntryDto | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: (underwritingOwnerUserId: number, note: string | null) => void;
  onCancel: () => void;
}

function toOption(user: EligibleAssigneeApiDto): AssigneeOption {
  return { id: user.userId, label: `${user.firstName} ${user.lastName}` };
}

/**
 * Send to underwriting (spec FR-36, PRD 10.4; two-slot amendment 2026-07-15): underwriting-owner
 * picker + optional note. The picker lists users eligible for the tenant's configured Underwriting
 * slot — the earlier /underwrit/i role-name matching (both here and in
 * `SendToUnderwritingCommandHandler`) is gone. When the slot is unconfigured, the picker is
 * disabled with a flagged-unavailable notice (the transition still proceeds server-side, but no
 * role assignment happens).
 */
function SendToUnderwritingDialog({ open, lead, underwritingRole, busy, error, onConfirm, onCancel }: SendToUnderwritingDialogProps) {
  const [owner, setOwner] = useState<AssigneeOption | null>(null);
  const [note, setNote] = useState('');
  const [ownerError, setOwnerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setOwner(null);
    setNote('');
    setOwnerError(null);
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    if (!owner) {
      setOwnerError('An underwriting owner is required.');
      return;
    }
    setOwnerError(null);
    onConfirm(owner.id, note.trim().length > 0 ? note.trim() : null);
  }

  return (
    <WorkflowDialog
      testId="send-to-underwriting-dialog"
      open={open}
      action="Send to underwriting"
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence="This lead moves to Underwriting and its underwriting SLA clock starts."
      confirmLabel="Send"
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      {underwritingRole === null && (
        <p role="alert" data-testid="underwriting-role-unavailable">
          No Underwriting role is configured for this tenant; ask an administrator to configure one under Business
          assignments.
        </p>
      )}
      <AssigneeSelect
        id="underwriting-owner"
        testId="underwriting-owner-select"
        label="Underwriting owner"
        required
        disabled={underwritingRole === null}
        value={owner}
        error={ownerError ?? undefined}
        loadOptions={() => (underwritingRole ? getEligibleAssignees(underwritingRole.assignmentId).then((users) => users.map(toOption)) : Promise.resolve([]))}
        onChange={(option) => {
          setOwner(option);
          if (option !== null) {
            setOwnerError(null);
          }
        }}
      />
      <label htmlFor="send-to-underwriting-note">Note</label>
      <textarea
        id="send-to-underwriting-note"
        name="note"
        data-testid="send-to-underwriting-note-textarea"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    </WorkflowDialog>
  );
}

export default SendToUnderwritingDialog;
