import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import AssigneeSelect, { type AssigneeOption } from '../../../components/common/AssigneeSelect';
import type { BusinessAssignmentsDto, EligibleAssigneeApiDto } from '../../settings/settingsApi';
import { getEligibleAssignees, type LeadAssignmentPayload, type LeadDetailDto } from '../leadsApi';

interface AssignDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  /** Tenant's RM/Underwriting slot configuration (`fetchBusinessAssignments()`, two-slot amendment). */
  roles: BusinessAssignmentsDto | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: (assignments: LeadAssignmentPayload[], comment: string | null) => void;
  onCancel: () => void;
}

function toOption(user: EligibleAssigneeApiDto): AssigneeOption {
  return { id: user.userId, label: `${user.firstName} ${user.lastName}` };
}

/**
 * Assign/Reassign (spec FR-34/FR-35, PRD 10.4; two-slot amendment 2026-07-15): one dropdown per
 * configured slot — the RM (accountable owner, required) and the Underwriter (optional, with an
 * "Unassigned" choice). Comment field is optional (audited per changed slot server-side).
 *
 * Flagged gap (T-028 final report, still open): `GET /leads/{id}` (`LeadDto`) projects only the
 * accountable owner (`LeadDetailDto.owner`), not the underwriter-slot assignee, so only the RM
 * pre-fills on reassign; the Underwriter starts empty even when assigned, which will look like
 * clearing it unless the user re-picks. Recommended follow-up: project the underwriter assignee on
 * `LeadDto` too.
 */
function AssignDialog({ open, lead, roles, busy, error, onConfirm, onCancel }: AssignDialogProps) {
  const rmRole = roles?.rmRole ?? null;
  const underwritingRole = roles?.underwritingRole ?? null;

  const [rmSelection, setRmSelection] = useState<AssigneeOption | null>(null);
  const [underwriterSelection, setUnderwriterSelection] = useState<AssigneeOption | null>(null);
  const [comment, setComment] = useState('');
  const [ownerError, setOwnerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setRmSelection(lead.owner ? { id: lead.owner.userId, label: `${lead.owner.firstName} ${lead.owner.lastName}` } : null);
    setUnderwriterSelection(null);
    setComment('');
    setOwnerError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog (re)opens for this lead.
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    if (rmRole && !rmSelection) {
      setOwnerError('An accountable owner is required.');
      return;
    }
    setOwnerError(null);
    const assignments: LeadAssignmentPayload[] = [];
    if (rmRole) {
      assignments.push({ businessAssignmentId: rmRole.assignmentId, userId: rmSelection?.id ?? null });
    }
    if (underwritingRole) {
      assignments.push({ businessAssignmentId: underwritingRole.assignmentId, userId: underwriterSelection?.id ?? null });
    }
    onConfirm(assignments, comment.trim().length > 0 ? comment.trim() : null);
  }

  const consequence =
    lead.statusCanonicalKey === 'new'
      ? 'Setting an accountable owner moves this lead from New to Assigned.'
      : 'Role assignments will be updated; the lead status stays the same.';

  return (
    <WorkflowDialog
      testId="assign-dialog"
      open={open}
      action={lead.owner ? 'Reassign' : 'Assign'}
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence={consequence}
      confirmLabel={lead.owner ? 'Reassign' : 'Assign'}
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      {rmRole === null && (
        <p role="alert" data-testid="assign-no-roles-configured">
          No RM role is configured for this tenant; ask an administrator to configure one under Business assignments.
        </p>
      )}

      {rmRole && (
        <AssigneeSelect
          id="assign-role-rm"
          testId="role-select-accountable"
          label="Relationship Manager"
          required
          value={rmSelection}
          error={ownerError ?? undefined}
          loadOptions={() => getEligibleAssignees(rmRole.assignmentId).then((users) => users.map(toOption))}
          onChange={(option) => {
            setRmSelection(option);
            if (option !== null) {
              setOwnerError(null);
            }
          }}
        />
      )}

      {underwritingRole && (
        <AssigneeSelect
          id="assign-role-underwriter"
          testId="role-select-underwriter"
          label="Underwriter"
          value={underwriterSelection}
          loadOptions={() => getEligibleAssignees(underwritingRole.assignmentId).then((users) => users.map(toOption))}
          onChange={setUnderwriterSelection}
        />
      )}

      <label htmlFor="assign-comment">Comment</label>
      <textarea id="assign-comment" name="comment" data-testid="assign-comment-textarea" value={comment} onChange={(event) => setComment(event.target.value)} />
    </WorkflowDialog>
  );
}

export default AssignDialog;
