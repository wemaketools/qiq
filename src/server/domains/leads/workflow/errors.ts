/**
 * Lead workflow-operation failures (T-025; AC-047, AC-051, AC-096).
 *
 * Port of `Features/Leads/Workflow/LeadWorkflowErrors.cs` together with the status mapping in
 * `LeadWorkflowEndpoints.cs:154-179`:
 *
 *   LEAD_NOT_FOUND                              -> 404  (:167)
 *   LEAD_OPERATION_FORBIDDEN                    -> 403  (:170)
 *   LEAD_ILLEGAL_TRANSITION                     -> 409  (:173) + the legal-operation hint
 *   LEAD_NO_PRIOR_OPEN_STATUS                   -> 422  (:176, the default arm)
 *   LEAD_WORKFLOW_VALIDATION_FAILED             -> 422
 *   LEAD_WORKFLOW_INVALID_ASSIGNEE              -> 422
 *   LEAD_WORKFLOW_INVALID_LOST_REASON           -> 422
 *   LEAD_WORKFLOW_NO_PENDING_PRICING_APPROVAL   -> 422
 *   LEAD_WORKFLOW_APPROVER_NOT_ELIGIBLE         -> 422
 *
 * THE 409 HINT IS NAMED `availableOperations` HERE, NOT `legalOperations` — FLAGGED DIVERGENCE
 * ===========================================================================================
 * The reference puts the hint in an extension called `legalOperations`
 * (`LeadWorkflowErrors.IllegalTransition`, :13-16). T-009 had already shipped this port's problem+json
 * writer with the extension named `availableOperations` (`lib/errors/index.ts`, `lib/errors/problem.ts`),
 * pinned by `problem.test.ts` and `http.skeleton.test.ts`. Renaming it now would break two passing
 * suites in another task's files to match a name no shipped consumer reads — the SPA reads
 * `availableOperations` off the LEAD DTO and never parses the 409 body's hint at all (verified:
 * no `legalOperations` occurrence anywhere under `src/ui`). So this port keeps T-009's name and
 * records the divergence rather than silently picking. If the hint must match the reference byte for
 * byte, that is a one-line change in `lib/errors/problem.ts` plus its two pins — a T-009 decision,
 * not a T-025 one.
 *
 * EVERY CODE IS DISTINCT BECAUSE EVERY CODE IS THE ONLY DISCRIMINATOR
 * ==================================================================
 * Nearly every rejection in this feature answers 409 or 422. An illegal transition, a duplicate
 * pending approval, an ineligible approver and a missing lost-reason comment are indistinguishable
 * by status alone, so the code is the contract the SPA branches on and the integration suite asserts.
 */
import { AppError, ForbiddenError, IllegalOperationError } from '../../../lib/errors/index.js';

export const LEAD_OPERATION_FORBIDDEN = 'LEAD_OPERATION_FORBIDDEN';
export const LEAD_ILLEGAL_TRANSITION = 'LEAD_ILLEGAL_TRANSITION';
export const LEAD_NO_PRIOR_OPEN_STATUS = 'LEAD_NO_PRIOR_OPEN_STATUS';
export const LEAD_WORKFLOW_VALIDATION_FAILED = 'LEAD_WORKFLOW_VALIDATION_FAILED';
export const LEAD_WORKFLOW_INVALID_ASSIGNEE = 'LEAD_WORKFLOW_INVALID_ASSIGNEE';
export const LEAD_WORKFLOW_INVALID_LOST_REASON = 'LEAD_WORKFLOW_INVALID_LOST_REASON';
export const LEAD_WORKFLOW_NO_PENDING_PRICING_APPROVAL =
  'LEAD_WORKFLOW_NO_PENDING_PRICING_APPROVAL';
export const LEAD_WORKFLOW_APPROVER_NOT_ELIGIBLE = 'LEAD_WORKFLOW_APPROVER_NOT_ELIGIBLE';

/**
 * `LeadWorkflowErrors.Forbidden` (:9-10) -> 403.
 *
 * The executor re-checks the operation's permission even though the route guard already did
 * (`LeadWorkflowEndpoints.cs:27-28` calls this "defense in depth"). Keeping both means a future
 * non-HTTP caller — a job, a cascade, a queue handler — cannot reach an operation ungated by
 * forgetting a guard it never had.
 */
export function operationForbiddenError(permissionCode: string): ForbiddenError {
  return new ForbiddenError(
    `Missing required permission '${permissionCode}' for this lead operation.`,
    { code: LEAD_OPERATION_FORBIDDEN },
  );
}

/**
 * `LeadWorkflowErrors.IllegalTransition` (:13-16) -> 409 carrying what IS legal from here.
 *
 * The hint is the whole point: a 409 that only says "no" forces the SPA to guess, and a stale UI
 * would keep offering the same dead action.
 */
export function illegalTransitionError(
  operation: string,
  legalOperationCodes: readonly string[],
): IllegalOperationError {
  return new IllegalOperationError(
    `Operation '${operation}' is not legal from the lead's current status.`,
    { code: LEAD_ILLEGAL_TRANSITION, availableOperations: legalOperationCodes },
  );
}

/** `LeadWorkflowErrors.NoPriorOpenStatusToReopenTo` (:18-19) -> 422. */
export function noPriorOpenStatusError(leadId: number): AppError {
  return new AppError(422, `Lead ${leadId} has no prior open/quoted status to reopen to.`, {
    code: LEAD_NO_PRIOR_OPEN_STATUS,
  });
}

/** `LeadWorkflowErrors.Validation` (:21) -> 422 — a rule with no single owning field. */
export function workflowRuleError(message: string): AppError {
  return new AppError(422, message, { code: LEAD_WORKFLOW_VALIDATION_FAILED });
}

/** `LeadWorkflowErrors.InvalidAssignee` (:23-24) -> 422. */
export function invalidAssigneeError(userId: number): AppError {
  return new AppError(422, `User ${userId} is not eligible for this role.`, {
    code: LEAD_WORKFLOW_INVALID_ASSIGNEE,
  });
}

/**
 * `LeadWorkflowErrors.InvalidLostReason` (:26-27) -> 422.
 *
 * Undifferentiated on purpose, same reasoning as `leads/errors.ts`: an inactive reason, a wrong
 * list type and ANOTHER TENANT'S reason id must all answer identically, or the difference is a
 * cross-tenant existence oracle (N-01).
 */
export function invalidLostReasonError(lostReasonId: number): AppError {
  return new AppError(
    422,
    `Lost reason ${lostReasonId} is not an active lost-reason reference value for this tenant.`,
    { code: LEAD_WORKFLOW_INVALID_LOST_REASON },
  );
}

/** `LeadWorkflowErrors.NoPendingPricingApproval` (:29-30) -> 422. */
export function noPendingPricingApprovalError(leadId: number): AppError {
  return new AppError(422, `Lead ${leadId} has no pending pricing-approval request.`, {
    code: LEAD_WORKFLOW_NO_PENDING_PRICING_APPROVAL,
  });
}

/** `LeadWorkflowErrors.ApproverNotEligible` (:32-33) -> 422. */
export function approverNotEligibleError(userId: number): AppError {
  return new AppError(
    422,
    `User ${userId} does not hold the pricing-approval permission for this tenant.`,
    { code: LEAD_WORKFLOW_APPROVER_NOT_ELIGIBLE },
  );
}

// There is deliberately NO workflow-specific not-found error: the executor raises the leads core's
// `leadNotFoundError`, so a missing lead and a foreign-tenant lead answer identically on the
// workflow surface and on the detail surface. A second, near-identical 404 here would be one
// refactor away from the two surfaces drifting into a cross-tenant existence oracle.
