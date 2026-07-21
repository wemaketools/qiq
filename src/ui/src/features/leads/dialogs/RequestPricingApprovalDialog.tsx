import { useEffect, useState } from 'react';
import WorkflowDialog from '../../../components/common/WorkflowDialog';
import AssigneeSelect, { type AssigneeOption } from '../../../components/common/AssigneeSelect';
import CurrencyInput from '../../../components/common/CurrencyInput';
import type { EligibleAssigneeApiDto } from '../../settings/settingsApi';
import { getEligibleApprovers, type LeadDetailDto } from '../leadsApi';

interface RequestPricingApprovalDialogProps {
  open: boolean;
  lead: LeadDetailDto;
  currencySymbol: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (approverUserId: number, proposedPremium: number | null, note: string | null) => void;
  onCancel: () => void;
}

function toOption(user: EligibleAssigneeApiDto): AssigneeOption {
  return { id: user.userId, label: `${user.firstName} ${user.lastName}` };
}

/**
 * Request pricing approval (spec FR-37, PRD 10.4, T-028): approver picker limited to
 * `pricing.approve` holders (`getEligibleApprovers`, T-011), an optional proposed-premium
 * `CurrencyInput` (spec AC-028's tenant-symbol convention, reused rather than a bare number input),
 * and an optional note. Starts the Pending pricing-approval sub-state; the lead's own status is
 * untouched (spec FR-37).
 */
function RequestPricingApprovalDialog({ open, lead, currencySymbol, busy, error, onConfirm, onCancel }: RequestPricingApprovalDialogProps) {
  const [approver, setApprover] = useState<AssigneeOption | null>(null);
  const [proposedPremium, setProposedPremium] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [approverError, setApproverError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setApprover(null);
    setProposedPremium(null);
    setNote('');
    setApproverError(null);
  }, [open, lead.id]);

  if (!open) {
    return null;
  }

  function handleConfirm(): void {
    if (!approver) {
      setApproverError('An approver is required.');
      return;
    }
    setApproverError(null);
    onConfirm(approver.id, proposedPremium, note.trim().length > 0 ? note.trim() : null);
  }

  return (
    <WorkflowDialog
      testId="request-pricing-approval-dialog"
      open={open}
      action="Request pricing approval"
      entityRef={lead.leadRef}
      partyName={lead.partyName}
      consequence="This starts a pending pricing-approval request; the lead's status stays in Pricing."
      confirmLabel="Request approval"
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onCancel}
    >
      <AssigneeSelect
        id="pricing-approver"
        testId="pricing-approver-select"
        label="Approver"
        required
        value={approver}
        error={approverError ?? undefined}
        loadOptions={() => getEligibleApprovers().then((users) => users.map(toOption))}
        onChange={(option) => {
          setApprover(option);
          if (option !== null) {
            setApproverError(null);
          }
        }}
      />

      <label htmlFor="proposed-premium">Proposed premium</label>
      <CurrencyInput
        id="proposed-premium"
        name="proposedPremium"
        value={proposedPremium}
        currencySymbol={currencySymbol}
        onChange={setProposedPremium}
      />

      <label htmlFor="pricing-approval-note">Note</label>
      <textarea
        id="pricing-approval-note"
        name="note"
        data-testid="pricing-approval-note-textarea"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    </WorkflowDialog>
  );
}

export default RequestPricingApprovalDialog;
