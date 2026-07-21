/**
 * Parties domain failures (T-023, AC-041; P-05, spec §12, §14).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Parties/PartyErrors.cs` together with the status
 * mapping in `src/api/QuoteIQ.Api/Endpoints/PartyEndpoints.cs:76-94`:
 *
 *   PARTY_NOT_FOUND            -> 404  (:78)
 *   PARTY_VALIDATION_FAILED    -> 422  (:83)
 *   PARTY_INVALID_PARTY_TYPE   -> 422  (:83)
 *   PARTY_INVALID_SEGMENT      -> 422  (:83)
 *   PARTY_INVALID_INDUSTRY     -> 422  (:84)
 *   PARTY_INVALID_REGION       -> 422  (:84)
 *   anything else              -> 400  (:89)
 *
 * EVERY BRANCH CARRIES BOTH `detail: "CODE: message"` AND A `code` EXTENSION — measured (:81-82,
 * :86-87), the same convention as reference-data/errors.ts and the OPPOSITE of tenants/errors.ts.
 * The endpoint's own doc comment (:72-75) states it explicitly. Building these with a `code` makes
 * lib/errors/problem.ts render exactly that pair.
 *
 * THE FOUR REFERENCE-VALUE ERRORS ARE DELIBERATELY UNDIFFERENTIATED (PartyErrors.cs:5-17)
 * ======================================================================================
 * An id that is inactive, an id of the wrong list type, and an id belonging to ANOTHER TENANT all
 * produce the same code and the same 422. That is a security property, not sloppiness: a
 * distinguishable answer for "exists but is another tenant's" is a cross-tenant existence oracle
 * (N-01). The repository's `isActive*` checks are tenant-predicated, so all three cases genuinely
 * fail the same check — there is no branch here that could leak the difference.
 */
import { AppError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const PARTY_VALIDATION_FAILED = 'PARTY_VALIDATION_FAILED';
export const PARTY_NOT_FOUND = 'PARTY_NOT_FOUND';
export const PARTY_INVALID_PARTY_TYPE = 'PARTY_INVALID_PARTY_TYPE';
export const PARTY_INVALID_SEGMENT = 'PARTY_INVALID_SEGMENT';
export const PARTY_INVALID_INDUSTRY = 'PARTY_INVALID_INDUSTRY';
export const PARTY_INVALID_REGION = 'PARTY_INVALID_REGION';

/**
 * `PartyErrors.Validation` (:20) -> 422. `message` reproduces the reference's
 * `string.Join("; ", validation.Errors.Select(e => e.ErrorMessage))`
 * (CreatePartyCommandHandler.cs:38-39); `errors[]` is this port's additive structured form
 * (spec §14, AC-096) and does not alter `detail`.
 */
export function partyValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: PARTY_VALIDATION_FAILED,
    fieldErrors,
  });
}

/**
 * `PartyErrors.NotFound` (:22) -> 404. ALSO the answer for another tenant's party id (N-01):
 * `findParty` applies the tenant predicate, so a foreign id simply does not resolve and lands here
 * with a message identical to a genuinely missing id.
 */
export function partyNotFoundError(id: number): NotFoundError {
  return new NotFoundError(`Party ${id} was not found.`, { code: PARTY_NOT_FOUND });
}

/** `PartyErrors.InvalidPartyType` (:24-26) -> 422. */
export function invalidPartyTypeError(partyTypeId: number): AppError {
  return new AppError(
    422,
    `Party type ${partyTypeId} is not an active party-type reference value for this tenant.`,
    { code: PARTY_INVALID_PARTY_TYPE },
  );
}

/** `PartyErrors.InvalidSegment` (:28-30) -> 422. */
export function invalidSegmentError(segmentId: number): AppError {
  return new AppError(
    422,
    `Segment ${segmentId} is not an active party-segment reference value for this tenant.`,
    { code: PARTY_INVALID_SEGMENT },
  );
}

/** `PartyErrors.InvalidIndustry` (:32-34) -> 422. */
export function invalidIndustryError(industryId: number): AppError {
  return new AppError(
    422,
    `Industry ${industryId} is not an active industry reference value for this tenant.`,
    { code: PARTY_INVALID_INDUSTRY },
  );
}

/** `PartyErrors.InvalidRegion` (:36-38) -> 422. */
export function invalidRegionError(regionId: number): AppError {
  return new AppError(
    422,
    `Region ${regionId} is not an active region reference value for this tenant.`,
    { code: PARTY_INVALID_REGION },
  );
}

/** 400 — the body could not be read at all (model-binding failure in the reference). */
export function unreadableBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}
