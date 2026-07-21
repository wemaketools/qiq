import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import AssigneeSelect, { type AssigneeOption } from '../../../components/common/AssigneeSelect';
import type { BusinessAssignmentsDto, EligibleAssigneeApiDto } from '../../settings/settingsApi';
import { getEligibleAssignees } from '../../leads/leadsApi';
import type { QuoteAssignmentPayload } from '../quotesApi';

interface QuoteAssignDialogProps {
  open: boolean;
  quoteRef: string;
  partyName: string;
  /** Tenant's RM/Underwriting slot configuration (`fetchBusinessAssignments()`, two-slot amendment). */
  roles: BusinessAssignmentsDto | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: (assignments: QuoteAssignmentPayload[], comment: string | null) => void;
  onCancel: () => void;
}

function toOption(user: EligibleAssigneeApiDto): AssigneeOption {
  return { id: user.userId, label: `${user.firstName} ${user.lastName}` };
}

/**
 * Assign/Reassign a quote (spec FR-35/FR-38, PRD 10.4; two-slot amendment 2026-07-15): quotes hold
 * one assignee per configured slot (RM/Underwriter), both optional here — quotes have no
 * accountable-owner requirement. Never changes the quote's own status.
 *
 * Flagged gap (mirrors `leads/dialogs/AssignDialog`'s documented gap): `GET /quotes/{id}`
 * (`QuoteDto`) projects no per-slot assignment list, so this dialog cannot pre-fill either slot's
 * current holder on reassign — both start empty.
 */
function QuoteAssignDialog({ open, quoteRef, partyName, roles, busy, error, onConfirm, onCancel }: QuoteAssignDialogProps) {
  const rmRole = roles?.rmRole ?? null;
  const underwritingRole = roles?.underwritingRole ?? null;

  const [rmSelection, setRmSelection] = useState<AssigneeOption | null>(null);
  const [underwriterSelection, setUnderwriterSelection] = useState<AssigneeOption | null>(null);
  const [comment, setComment] = useState('');
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setRmSelection(null);
    setUnderwriterSelection(null);
    setComment('');
    setAssignmentsError(null);
  }, [open, quoteRef]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    const assignments: QuoteAssignmentPayload[] = [];
    if (rmRole && rmSelection) {
      assignments.push({ businessAssignmentId: rmRole.assignmentId, userId: rmSelection.id });
    }
    if (underwritingRole && underwriterSelection) {
      assignments.push({ businessAssignmentId: underwritingRole.assignmentId, userId: underwriterSelection.id });
    }
    if (assignments.length === 0) {
      setAssignmentsError('At least one role assignment is required.');
      return;
    }
    setAssignmentsError(null);
    onConfirm(assignments, comment.trim().length > 0 ? comment.trim() : null);
  }

  return (
    <WorkflowDialog
      testId="quote-assign-dialog"
      open={open}
      action="Assign"
      entityRef={quoteRef}
      partyName={partyName}
      consequence="Role assignments will be updated; the quote's status stays the same."
      confirmLabel="Assign"
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      {rmRole === null && underwritingRole === null && (
        <p role="alert" data-testid="quote-assign-no-roles-configured">
          No assignment roles are configured for this tenant; ask an administrator to configure them under Business
          assignments.
        </p>
      )}

      {rmRole && (
        <AssigneeSelect
          id="quote-assign-role-rm"
          testId="quote-role-select-rm"
          label="Relationship Manager"
          value={rmSelection}
          loadOptions={() => getEligibleAssignees(rmRole.assignmentId).then((users) => users.map(toOption))}
          onChange={setRmSelection}
        />
      )}
      {underwritingRole && (
        <AssigneeSelect
          id="quote-assign-role-underwriter"
          testId="quote-role-select-underwriter"
          label="Underwriter"
          value={underwriterSelection}
          loadOptions={() => getEligibleAssignees(underwritingRole.assignmentId).then((users) => users.map(toOption))}
          onChange={setUnderwriterSelection}
        />
      )}
      {assignmentsError && (
        <p role="alert" data-testid="field-error-assignments">
          {assignmentsError}
        </p>
      )}

      <label htmlFor="quote-assign-comment">Comment</label>
      <textarea
        id="quote-assign-comment"
        name="comment"
        data-testid="quote-assign-comment-textarea"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
    </WorkflowDialog>
  );
}

export default QuoteAssignDialog;
