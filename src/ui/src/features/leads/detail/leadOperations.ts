import { LEAD_OPERATION_CODES, type LeadDetailDto } from '../leadsApi';

/** Display label per lead workflow operation wire code (`LeadOperationCodes`, T-019/T-028, PRD 10.4/12.8). */
export const LEAD_OPERATION_LABELS: Record<string, string> = {
  [LEAD_OPERATION_CODES.Assign]: 'Assign',
  [LEAD_OPERATION_CODES.StartInformationGathering]: 'Start information gathering',
  [LEAD_OPERATION_CODES.SendToUnderwriting]: 'Send to underwriting',
  [LEAD_OPERATION_CODES.StartPricing]: 'Start pricing',
  [LEAD_OPERATION_CODES.RequestPricingApproval]: 'Request pricing approval',
  [LEAD_OPERATION_CODES.ApprovePricing]: 'Approve/Reject pricing',
  [LEAD_OPERATION_CODES.RejectPricing]: 'Approve/Reject pricing',
  [LEAD_OPERATION_CODES.LogFollowUp]: 'Log follow-up',
  [LEAD_OPERATION_CODES.StartNegotiation]: 'Start negotiation',
  [LEAD_OPERATION_CODES.MarkLost]: 'Mark lost',
  [LEAD_OPERATION_CODES.Withdraw]: 'Withdraw',
  [LEAD_OPERATION_CODES.Reopen]: 'Reopen',
};

/** Assign's PRD 10.4 special case: "Assign" the first time (no owner yet), "Reassign" thereafter. */
export function labelForOperation(op: string, lead: LeadDetailDto): string {
  if (op === LEAD_OPERATION_CODES.Assign) {
    return lead.owner ? 'Reassign' : 'Assign';
  }
  return LEAD_OPERATION_LABELS[op] ?? op;
}

/**
 * PrimaryActionResolver (spec FR-44, PRD 12.5, T-028): New status -&gt; Assign, Quote Sent -&gt; Log
 * follow-up, otherwise the first legal operation in `LeadOperation`'s declared enum order (the order
 * `LeadWorkflow.GetLegalOperations`/`LeadDto.ComputeAvailableOperations` already return them in) —
 * `null` once every operation is exhausted (a closed lead is read-only, no primary action renders).
 * "draft-quote-exists -&gt; Send" is a quote-level primary action owned by T-029, out of this
 * resolver's scope (this resolver only ever looks at `lead.availableOperations`, never quote state).
 */
export function resolvePrimaryOperation(lead: LeadDetailDto): string | null {
  const ops = lead.availableOperations;
  if (lead.statusCanonicalKey === 'new' && ops.includes(LEAD_OPERATION_CODES.Assign)) {
    return LEAD_OPERATION_CODES.Assign;
  }
  if (lead.statusCanonicalKey === 'quote_sent' && ops.includes(LEAD_OPERATION_CODES.LogFollowUp)) {
    return LEAD_OPERATION_CODES.LogFollowUp;
  }
  return ops[0] ?? null;
}

/**
 * The More-actions menu's entries: every `availableOperations` code except the resolved primary one
 * (spec FR-17/FR-41, AC-016: "workflow actions show only server-computed legal operations, hidden
 * not disabled"), de-duplicating `approve-pricing`/`reject-pricing` into a single "Approve/Reject
 * pricing" entry (`ApproveRejectPricingDialog` renders whichever of the two the server actually
 * granted).
 */
export function moreActionsOperations(lead: LeadDetailDto, primaryOp: string | null): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const op of lead.availableOperations) {
    if (op === primaryOp) {
      continue;
    }
    const dedupeKey =
      op === LEAD_OPERATION_CODES.ApprovePricing || op === LEAD_OPERATION_CODES.RejectPricing ? 'approve-reject-pricing' : op;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    result.push(op);
  }
  return result;
}

/** True when at least one of the pricing sub-state operations is legal (drives the merged menu entry / dialog). */
export function hasPricingApprovalOperation(operations: string[]): boolean {
  return operations.includes(LEAD_OPERATION_CODES.ApprovePricing) || operations.includes(LEAD_OPERATION_CODES.RejectPricing);
}
