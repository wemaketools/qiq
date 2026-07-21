/**
 * Quotes domain failures (T-026; AC-052..AC-055, AC-096).
 *
 * Port of `Features/Quotes/QuoteErrors.cs` and `Features/Quotes/Workflow/QuoteWorkflowErrors.cs`
 * together with the status mapping in `QuoteEndpoints.ProblemFromError` (:151-165):
 *
 *   QUOTE_NOT_FOUND                            -> 404  (:153)
 *   QUOTE_LEAD_NOT_FOUND                       -> 404  (:153)
 *   QUOTE_OPERATION_FORBIDDEN                  -> 403  (:156)
 *   QUOTE_CLOSED_REQUIRES_CORRECTION_PERMISSION-> 403  (:156)
 *   QUOTE_ILLEGAL_TRANSITION                   -> 409  (:159) + the legal-operation hint
 *   QUOTE_DRAFT_EDIT_ONLY                      -> 409  (:159)
 *   QUOTE_LEAD_CLOSED_CANNOT_CREATE            -> 409  (:159)
 *   PRICING_APPROVAL_REQUIRED                  -> 422  (:162, the default arm)
 *   QUOTE_VALIDATION_FAILED                    -> 422
 *   QUOTE_WORKFLOW_VALIDATION_FAILED           -> 422
 *   QUOTE_WORKFLOW_INVALID_ASSIGNEE            -> 422
 *   QUOTE_WORKFLOW_INVALID_LOST_REASON         -> 422
 *   QUOTE_INVALID_PRODUCT_LINE                 -> 422
 *   QUOTE_INVALID_COVER_TYPE                   -> 422
 *
 * THE 403/409 SPLIT ON A CLOSED QUOTE IS MEASURED, AND IT IS NOT WHAT AC-055 DESCRIBES
 * ===================================================================================
 * AC-055 says "update attempts on a closed lead/quote via normal endpoints fail 409". The reference
 * does something different and more useful, and it is what is ported here (recorded as a
 * contradiction in the task file):
 *
 *   - a closed (terminal-status) quote answers **403** `QUOTE_CLOSED_REQUIRES_CORRECTION_PERMISSION`
 *     when the caller lacks `quotes.correct_closed`, and **SUCCEEDS** when the caller holds it. The
 *     PUT route IS the corrections path; there is no separate corrections endpoint anywhere in
 *     `QuoteEndpoints`. (`UpdateDraftQuoteCommandHandler.cs:73-81`.)
 *   - a Sent/Revised (non-draft, non-closed) quote answers **409** `QUOTE_DRAFT_EDIT_ONLY`, because
 *     no permission would ever make a direct PUT legal there — the path is Revise (:82-85).
 *
 * So 409 IS the answer for a non-draft quote, just not for a CLOSED one. The lead side was ported
 * the same way in T-024 (`LEAD_CLOSED_REQUIRES_CORRECTION_PERMISSION` -> 403), so the two surfaces
 * agree; changing only the quote side to match the AC's prose would have split them.
 *
 * EVERY CODE IS DISTINCT BECAUSE EVERY CODE IS THE ONLY DISCRIMINATOR
 * ==================================================================
 * Nearly every rejection in this feature answers 409 or 422. An illegal transition, a draft-only
 * edit, a closed lead, a missing valid-until and the high-value pricing gate are indistinguishable
 * by status alone, so the code is the contract the SPA branches on and the integration suite asserts.
 */
import { AppError, ForbiddenError, IllegalOperationError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const QUOTE_VALIDATION_FAILED = 'QUOTE_VALIDATION_FAILED';
export const QUOTE_NOT_FOUND = 'QUOTE_NOT_FOUND';
export const QUOTE_LEAD_NOT_FOUND = 'QUOTE_LEAD_NOT_FOUND';
export const QUOTE_INVALID_PRODUCT_LINE = 'QUOTE_INVALID_PRODUCT_LINE';
export const QUOTE_INVALID_COVER_TYPE = 'QUOTE_INVALID_COVER_TYPE';
export const QUOTE_LEAD_CLOSED_CANNOT_CREATE = 'QUOTE_LEAD_CLOSED_CANNOT_CREATE';
export const QUOTE_CLOSED_REQUIRES_CORRECTION_PERMISSION =
  'QUOTE_CLOSED_REQUIRES_CORRECTION_PERMISSION';
export const QUOTE_DRAFT_EDIT_ONLY = 'QUOTE_DRAFT_EDIT_ONLY';

export const QUOTE_OPERATION_FORBIDDEN = 'QUOTE_OPERATION_FORBIDDEN';
export const QUOTE_ILLEGAL_TRANSITION = 'QUOTE_ILLEGAL_TRANSITION';
export const QUOTE_WORKFLOW_VALIDATION_FAILED = 'QUOTE_WORKFLOW_VALIDATION_FAILED';
export const QUOTE_WORKFLOW_INVALID_ASSIGNEE = 'QUOTE_WORKFLOW_INVALID_ASSIGNEE';
export const QUOTE_WORKFLOW_INVALID_LOST_REASON = 'QUOTE_WORKFLOW_INVALID_LOST_REASON';

/**
 * `QuoteWorkflowErrors.PricingApprovalRequired` (:27-29) -> 422.
 *
 * NOT prefixed `QUOTE_`: the reference names this code `PRICING_APPROVAL_REQUIRED` exactly, and it
 * is the code AC-049/V-063 were amended to specify, so the bare name is the preserved contract.
 */
export const PRICING_APPROVAL_REQUIRED = 'PRICING_APPROVAL_REQUIRED';

/** `QuoteErrors.Validation` (:12) -> 422 with the structured `errors[]` this port adds (spec §14). */
export function quoteValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: QUOTE_VALIDATION_FAILED,
    fieldErrors,
  });
}

/** The same 422 code for a rule the SERVICE evaluates, which has no single owning field. */
export function quoteRuleError(message: string): AppError {
  return new AppError(422, message, { code: QUOTE_VALIDATION_FAILED });
}

/**
 * `QuoteErrors.NotFound` (:14) -> 404. ALSO the answer for another tenant's quote id (N-01,
 * AC-021): every lookup applies the tenant predicate, so a foreign id simply does not resolve and
 * lands here with a message identical to a genuinely missing id.
 */
export function quoteNotFoundError(id: number): NotFoundError {
  return new NotFoundError(`Quote ${id} was not found.`, { code: QUOTE_NOT_FOUND });
}

/**
 * `QuoteErrors.LeadNotFound` (:16) -> 404 — a distinct CODE from `QUOTE_NOT_FOUND` but the same
 * STATUS, so a cross-tenant lead id on the create route is indistinguishable from a missing one.
 */
export function quoteLeadNotFoundError(leadId: number): NotFoundError {
  return new NotFoundError(`Lead ${leadId} was not found.`, { code: QUOTE_LEAD_NOT_FOUND });
}

/** `QuoteErrors.InvalidProductLine` (:18-20) -> 422. Undifferentiated on purpose (N-01). */
export function invalidQuoteProductLineError(productLineId: number): AppError {
  return new AppError(
    422,
    `Product line ${productLineId} is not an active product-line reference value for this tenant.`,
    { code: QUOTE_INVALID_PRODUCT_LINE },
  );
}

/** `QuoteErrors.InvalidCoverType` (:22-24) -> 422. Names BOTH ids, as the reference's message does. */
export function invalidQuoteCoverTypeError(coverTypeId: number, productLineId: number): AppError {
  return new AppError(
    422,
    `Cover type ${coverTypeId} is not an active cover type belonging to product line ${productLineId} for this tenant.`,
    { code: QUOTE_INVALID_COVER_TYPE },
  );
}

/**
 * `QuoteErrors.LeadClosedCannotCreateQuote` (:27-28) -> **409** (:159).
 *
 * Create's own lead-status legality gate, distinct from a quote's own illegal-transition 409 —
 * hence the separate code, because the two carry different remedies.
 */
export function leadClosedCannotCreateQuoteError(leadId: number): AppError {
  // A bare `AppError(409, ...)` rather than `IllegalOperationError`, which REQUIRES an
  // `availableOperations` hint. That hint would be a lie here: this 409 is about the LEAD's status,
  // and the legal quote operations from a nonexistent quote are not a meaningful answer. The
  // reference likewise attaches no extension to this error (`QuoteErrors.cs:27-28`).
  return new AppError(409, `Lead ${leadId} is closed; a new quote cannot be created for it.`, {
    code: QUOTE_LEAD_CLOSED_CANNOT_CREATE,
  });
}

/**
 * `QuoteErrors.ClosedQuoteRequiresCorrectionPermission` (:30-32) -> **403**, not 422 or 409
 * (:156-158). The caller holds `quotes.update` (the route guard passed) but not
 * `quotes.correct_closed`. See this file's header on the AC-055 divergence.
 */
export function closedQuoteRequiresCorrectionError(id: number): ForbiddenError {
  return new ForbiddenError(
    `Quote ${id} is closed; editing a closed quote requires the correct-closed-quote permission.`,
    { code: QUOTE_CLOSED_REQUIRES_CORRECTION_PERMISSION },
  );
}

/** `QuoteErrors.DraftEditOnlyOutsideDraft` (:35-36) -> 409: "Sent changes only via Revise" (FR-49). */
export function draftEditOnlyError(id: number): AppError {
  // Same reasoning as `leadClosedCannotCreateQuoteError`: 409 with no operations hint, because the
  // remedy is a specific named operation (Revise) rather than "one of these", and the reference
  // attaches no extension either (`QuoteErrors.cs:35-36`).
  return new AppError(409, `Quote ${id} is not a draft; edit it via the Revise operation instead.`, {
    code: QUOTE_DRAFT_EDIT_ONLY,
  });
}

/**
 * `QuoteWorkflowErrors.Forbidden` (:9-10) -> 403.
 *
 * The executor re-checks the operation's permission even though the route guard already did — the
 * same "defense in depth" the lead side keeps, so a future non-HTTP caller (the T-032 expiry job, a
 * cascade, a queue handler) cannot reach an operation ungated by forgetting a guard it never had.
 */
export function quoteOperationForbiddenError(permissionCode: string): ForbiddenError {
  return new ForbiddenError(
    `Missing required permission '${permissionCode}' for this quote operation.`,
    { code: QUOTE_OPERATION_FORBIDDEN },
  );
}

/**
 * `QuoteWorkflowErrors.IllegalTransition` (:13-16) -> 409 carrying what IS legal from here.
 *
 * The hint extension is named `availableOperations`, matching T-009's shipped problem+json writer
 * and the lead workflow's identical divergence from the reference's `legalOperations` — see
 * `leads/workflow/errors.ts`'s header. Renaming it is a T-009 decision, not this task's.
 */
export function quoteIllegalTransitionError(
  operation: string,
  legalOperationCodes: readonly string[],
): IllegalOperationError {
  return new IllegalOperationError(
    `Operation '${operation}' is not legal from the quote's current status.`,
    { code: QUOTE_ILLEGAL_TRANSITION, availableOperations: legalOperationCodes },
  );
}

/** `QuoteWorkflowErrors.Validation` (:18) -> 422 — a rule with no single owning field. */
export function quoteWorkflowRuleError(message: string): AppError {
  return new AppError(422, message, { code: QUOTE_WORKFLOW_VALIDATION_FAILED });
}

/** `QuoteWorkflowErrors.InvalidAssignee` (:23-24) -> 422. */
export function invalidQuoteAssigneeError(userId: number): AppError {
  return new AppError(422, `User ${userId} is not eligible for this role.`, {
    code: QUOTE_WORKFLOW_INVALID_ASSIGNEE,
  });
}

/** `QuoteWorkflowErrors.InvalidLostReason` (:20-21) -> 422. Undifferentiated on purpose (N-01). */
export function invalidQuoteLostReasonError(lostReasonId: number): AppError {
  return new AppError(
    422,
    `Lost reason ${lostReasonId} is not an active lost-reason reference value for this tenant.`,
    { code: QUOTE_WORKFLOW_INVALID_LOST_REASON },
  );
}

/**
 * `QuoteWorkflowErrors.PricingApprovalRequired` (:27-29) -> **422**, and NOTHING PERSISTS.
 *
 * The "nothing persists" half is not a property of this function — it is a property of WHERE the
 * check runs. It is raised from inside the operation's transaction, so the throw rolls back the
 * quote mutation, the history row and the audit row together. The integration suite asserts the
 * absence of all three rather than trusting this comment.
 */
export function pricingApprovalRequiredError(leadId: number): AppError {
  return new AppError(
    422,
    `Lead ${leadId}'s pricing approval must be approved before sending a high-value quote.`,
    { code: PRICING_APPROVAL_REQUIRED },
  );
}

/** 400 — the body could not be read at all (model-binding failure in the reference). */
export function unreadableQuoteBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}
