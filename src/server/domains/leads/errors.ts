/**
 * Leads domain failures (T-024, AC-042; spec §12, §14).
 *
 * Port of `Features/Leads/LeadErrors.cs` together with the status mapping in
 * `LeadEndpoints.cs:139-163`:
 *
 *   LEAD_NOT_FOUND                             -> 404  (:141)
 *   PARTY_NOT_FOUND                            -> 404  (:141)
 *   LEAD_CLOSED_REQUIRES_CORRECTION_PERMISSION -> 403  (:146)
 *   LEAD_VALIDATION_FAILED                     -> 422  (:151)
 *   LEAD_INVALID_PARTY                         -> 422  (:151)
 *   LEAD_INVALID_REQUEST_CHANNEL               -> 422  (:151)
 *   LEAD_INVALID_BROKER                        -> 422  (:151)
 *   LEAD_INVALID_REGION                        -> 422  (:152)
 *   LEAD_INVALID_PRODUCT_LINE                  -> 422  (:152)
 *   LEAD_INVALID_COVER_TYPE                    -> 422  (:152)
 *   LEAD_INVALID_OWNER                         -> 422  (:152)
 *   LEAD_EXTERNAL_REF_NOT_ENABLED              -> 422  (:153)
 *   anything else                              -> 400  (:158)
 *
 * Every branch carries BOTH `detail: "CODE: message"` and a `code` extension (:143-145), the same
 * convention as parties/errors.ts and reference-data/errors.ts.
 *
 * THE REFERENCE-VALUE ERRORS ARE DELIBERATELY UNDIFFERENTIATED (LeadErrors.cs:5-11)
 * ===============================================================================
 * The reference states it outright: "Every reference-value validation error is a single generic
 * code regardless of *why* the referenced id failed (inactive, wrong list type, wrong product line,
 * or belongs to another tenant)". An id belonging to ANOTHER TENANT must not get a distinguishable
 * answer from an inactive one — that difference is a cross-tenant existence oracle (N-01). Every
 * repository lookup behind these is tenant-predicated, so all cases genuinely fail the same check
 * and there is no branch here that could leak the distinction.
 *
 * NOTE `LEAD_CLOSED_REQUIRES_CORRECTION_PERMISSION` IS A 403, NOT A 422 — measured (:146-150). It
 * is an authorization verdict about the caller, not a complaint about the body, and the SPA
 * distinguishes them.
 */
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const LEAD_VALIDATION_FAILED = 'LEAD_VALIDATION_FAILED';
export const LEAD_NOT_FOUND = 'LEAD_NOT_FOUND';
export const LEAD_INVALID_PARTY = 'LEAD_INVALID_PARTY';
export const LEAD_INVALID_REQUEST_CHANNEL = 'LEAD_INVALID_REQUEST_CHANNEL';
export const LEAD_INVALID_BROKER = 'LEAD_INVALID_BROKER';
export const LEAD_INVALID_REGION = 'LEAD_INVALID_REGION';
export const LEAD_INVALID_PRODUCT_LINE = 'LEAD_INVALID_PRODUCT_LINE';
export const LEAD_INVALID_COVER_TYPE = 'LEAD_INVALID_COVER_TYPE';
export const LEAD_INVALID_OWNER = 'LEAD_INVALID_OWNER';
export const LEAD_EXTERNAL_REF_NOT_ENABLED = 'LEAD_EXTERNAL_REF_NOT_ENABLED';
export const LEAD_CLOSED_REQUIRES_CORRECTION_PERMISSION =
  'LEAD_CLOSED_REQUIRES_CORRECTION_PERMISSION';

/**
 * `LeadErrors.Validation` (:14) -> 422 with the structured `errors[]` this port adds (spec §14).
 * `message` reproduces the reference's `string.Join("; ", ...)` of the failing rule messages.
 */
export function leadValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: LEAD_VALIDATION_FAILED,
    fieldErrors,
  });
}

/** The same 422 code for a rule the SERVICE evaluates, which has no single owning field. */
export function leadRuleError(message: string): AppError {
  return new AppError(422, message, { code: LEAD_VALIDATION_FAILED });
}

/**
 * `LeadErrors.NotFound` (:16) -> 404. ALSO the answer for another tenant's lead id (N-01, AC-021):
 * every lookup applies the tenant predicate, so a foreign id simply does not resolve and lands here
 * with a message identical to a genuinely missing id.
 */
export function leadNotFoundError(id: number): NotFoundError {
  return new NotFoundError(`Lead ${id} was not found.`, { code: LEAD_NOT_FOUND });
}

/** `LeadErrors.InvalidParty` (:18-19) -> 422. */
export function invalidPartyError(partyId: number): AppError {
  return new AppError(422, `Party ${partyId} was not found for this tenant.`, {
    code: LEAD_INVALID_PARTY,
  });
}

/** `LeadErrors.InvalidRequestChannel` (:21-23) -> 422. */
export function invalidRequestChannelError(requestChannelId: number): AppError {
  return new AppError(
    422,
    `Request channel ${requestChannelId} is not an active request-channel reference value for this tenant.`,
    { code: LEAD_INVALID_REQUEST_CHANNEL },
  );
}

/** `LeadErrors.InvalidBroker` (:25-26) -> 422. */
export function invalidBrokerError(brokerId: number): AppError {
  return new AppError(422, `Broker ${brokerId} is not an active broker for this tenant.`, {
    code: LEAD_INVALID_BROKER,
  });
}

/** `LeadErrors.InvalidRegion` (:28-29) -> 422. */
export function invalidRegionError(regionId: number): AppError {
  return new AppError(
    422,
    `Region ${regionId} is not an active region reference value for this tenant.`,
    { code: LEAD_INVALID_REGION },
  );
}

/** `LeadErrors.InvalidProductLine` (:31-33) -> 422. */
export function invalidProductLineError(productLineId: number): AppError {
  return new AppError(
    422,
    `Product line ${productLineId} is not an active product-line reference value for this tenant.`,
    { code: LEAD_INVALID_PRODUCT_LINE },
  );
}

/** `LeadErrors.InvalidCoverType` (:35-37) -> 422. Names BOTH ids, as the reference's message does. */
export function invalidCoverTypeError(coverTypeId: number, productLineId: number): AppError {
  return new AppError(
    422,
    `Cover type ${coverTypeId} is not an active cover type belonging to product line ${productLineId} for this tenant.`,
    { code: LEAD_INVALID_COVER_TYPE },
  );
}

/** `LeadErrors.InvalidOwner` (:39-41) -> 422. */
export function invalidOwnerError(ownerUserId: number): AppError {
  return new AppError(
    422,
    `User ${ownerUserId} is not eligible for the accountable-owner role for this tenant.`,
    { code: LEAD_INVALID_OWNER },
  );
}

/** `LeadErrors.ExternalRefNotEnabled` (:43-44) -> 422. */
export function externalRefNotEnabledError(): AppError {
  return new AppError(422, 'This tenant does not allow a manually-entered external reference.', {
    code: LEAD_EXTERNAL_REF_NOT_ENABLED,
  });
}

/**
 * `LeadErrors.ClosedLeadRequiresCorrectionPermission` (:46-48) -> **403**, not 422 (:146-150).
 * The caller holds `leads.update` (the route guard passed) but not `leads.correct_closed`.
 */
export function closedLeadRequiresCorrectionError(id: number): ForbiddenError {
  return new ForbiddenError(
    `Lead ${id} is closed; editing a closed lead requires the correct-closed-lead permission.`,
    { code: LEAD_CLOSED_REQUIRES_CORRECTION_PERMISSION },
  );
}

/** 400 — the body could not be read at all (model-binding failure in the reference). */
export function unreadableBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}
