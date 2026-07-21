/**
 * Business-assignment slot domain failures (T-020, AC-038).
 *
 * Port of `src/api/QuoteIQ.Application/Features/BusinessAssignments/BusinessAssignmentErrors.cs`
 * with the status mapping in `src/api/QuoteIQ.Api/Endpoints/BusinessAssignmentEndpoints.cs:83-107`:
 *
 *   BUSINESS_ASSIGNMENTS_NOT_FOUND          -> 404  (:85)
 *   ASSIGNMENT_ROLE_IN_USE                  -> 409  (:90)
 *   BUSINESS_ASSIGNMENTS_VALIDATION_FAILED  -> 422  (:95)
 *   BUSINESS_ASSIGNMENTS_ROLE_INVALID       -> 422  (:95, same branch)
 *   anything else                           -> 400  (:100)
 *
 * All branches carry the code both in `detail` and as a `code` extension (:87-88 etc.), the same
 * convention as the business-rules and reference-data mappers.
 *
 * WHERE `BUSINESS_ASSIGNMENTS_NOT_FOUND` IS ACTUALLY EMITTED — CORRECTED 2026-07-19
 * ================================================================================
 * T-020's first pass recorded this code as "dead in the reference". That was WRONG, and the mistake
 * was one of scope rather than of reading: the two CONFIG handlers genuinely never emit it
 * (`GetBusinessAssignmentsQueryHandler` always succeeds — an unconfigured slot is `null`, not an
 * error, and is the normal state of every freshly created tenant), but
 * `GetEligibleAssigneesQueryHandler.cs:28-32` DOES, when the requested `assignmentId` is not one of
 * this tenant's slot rows. Measuring the endpoint group's other two routes is what surfaced it.
 *
 * That 404 is also a tenant-isolation boundary, not merely a lookup miss: the handler resolves the
 * assignment from the tenant-scoped `_store.ListAsync()` (:26-27), so ANOTHER tenant's slot id is
 * indistinguishable from a nonexistent one. Without it, a caller could enumerate another tenant's
 * members by guessing slot ids.
 *
 * WHY `ASSIGNMENT_ROLE_IN_USE` IS 409 WHILE ROLE_INVALID IS 422
 * ============================================================
 * Measured, and the distinction is meaningful: an invalid role id is a bad REQUEST (422 — fix the
 * payload), whereas clearing a slot that live leads/quotes still point at is a bad STATE (409 —
 * the payload is fine, the world is not ready for it). Note the code carries no
 * `BUSINESS_ASSIGNMENTS_` prefix, matching the reference exactly.
 */
import { AppError, ConflictError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const BUSINESS_ASSIGNMENTS_VALIDATION_FAILED = 'BUSINESS_ASSIGNMENTS_VALIDATION_FAILED';
export const BUSINESS_ASSIGNMENTS_ROLE_INVALID = 'BUSINESS_ASSIGNMENTS_ROLE_INVALID';
/** Spec-exact code, no domain prefix (BusinessAssignmentErrors.cs:14). */
export const ASSIGNMENT_ROLE_IN_USE = 'ASSIGNMENT_ROLE_IN_USE';
/** Emitted by the eligible-users lookup for an unknown/foreign assignment id (:85). See header. */
export const BUSINESS_ASSIGNMENTS_NOT_FOUND = 'BUSINESS_ASSIGNMENTS_NOT_FOUND';

/**
 * `BusinessAssignmentErrors.Validation` (:8) -> 422. `message` reproduces the reference's
 * `string.Join("; ", ...)` over the FluentValidation failures
 * (UpdateBusinessAssignmentsCommandHandler.cs:47-48).
 */
export function assignmentsValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: BUSINESS_ASSIGNMENTS_VALIDATION_FAILED,
    fieldErrors,
  });
}

/**
 * `BusinessAssignmentErrors.RoleInvalid` (:10-12) -> 422, message verbatim.
 *
 * ONE MESSAGE COVERS THREE DISTINCT CAUSES ON PURPOSE — the role does not exist, is inactive, or
 * belongs to another tenant. Splitting them would turn this endpoint into a cross-tenant existence
 * oracle: "role 41 is inactive" tells the caller role 41 exists in a tenant they cannot see, while
 * "not an active role visible to this tenant" says only that they may not use it (spec §14, N-01,
 * the same reasoning behind reference-data's 404-for-another-tenant's-id).
 */
export function assignmentRoleInvalidError(roleId: number): AppError {
  return new AppError(422, `Role ${String(roleId)} is not an active role visible to this tenant.`, {
    code: BUSINESS_ASSIGNMENTS_ROLE_INVALID,
  });
}

/** `BusinessAssignmentErrors.SlotInUse` (:15-19) -> 409, message and slot labels verbatim. */
export function assignmentSlotInUseError(roleName: string, slotLabel: string): ConflictError {
  return new ConflictError(
    `The ${slotLabel} role ('${roleName}') cannot be cleared because at least one lead or quote ` +
      'currently has an assignee holding it.',
    { code: ASSIGNMENT_ROLE_IN_USE },
  );
}

/** 400 — the body could not be read as JSON at all (model-binding failure in the reference). */
export function unreadableBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}

/**
 * `GetEligibleAssigneesQueryHandler.cs:30-31` -> 404, message verbatim.
 *
 * Answers BOTH "no such assignment id" and "that assignment id belongs to another tenant" with the
 * identical response, because the handler cannot tell them apart by construction: it looks the id
 * up in the tenant-scoped slot list (spec §14, N-01).
 */
export function businessAssignmentNotFoundError(assignmentId: number): NotFoundError {
  return new NotFoundError(`Business assignment ${String(assignmentId)} was not found.`, {
    code: BUSINESS_ASSIGNMENTS_NOT_FOUND,
  });
}

/** 400 — a required query parameter is missing or unparseable (model-binding failure, not a 422). */
export function invalidQueryParameterError(message: string): AppError {
  return new AppError(400, message);
}
