/**
 * Tenant reference-data domain failures (T-019, AC-035, AC-036; P-04, spec §12).
 *
 * Port of `src/api/QuoteIQ.Application/Features/ReferenceData/ReferenceDataErrors.cs` together with
 * the status mapping in `src/api/QuoteIQ.Api/Endpoints/ReferenceDataEndpoints.cs:115-135`:
 *
 *   REFERENCE_DATA_NOT_FOUND                    -> 404  (:117)
 *   REFERENCE_DATA_VALIDATION_FAILED            -> 422  (:118)
 *   REFERENCE_DATA_DUPLICATE_NAME               -> 422  (:119)
 *   REFERENCE_DATA_PRODUCT_LINE_REQUIRED        -> 422  (:120)
 *   REFERENCE_DATA_INVALID_PRODUCT_LINE         -> 422  (:121)
 *   REFERENCE_DATA_REPORTING_CATEGORY_REQUIRED  -> 422  (:122)
 *   REFERENCE_DATA_INVALID_INTERMEDIATE_CATEGORY-> 422  (:123)
 *   REFERENCE_DATA_CANONICAL_FIELDS_IMMUTABLE   -> 422  (:124)
 *   REFERENCE_DATA_REORDER_SET_MISMATCH         -> 422  (:125)
 *   TERMINAL_STATUS_CANNOT_BE_DISABLED          -> 422  (:126)
 *   anything else                               -> 400  (:127)
 *
 * A DUPLICATE NAME IS 422, NOT 409 — measured (:119), and the OPPOSITE of the sibling Tenant Manager
 * mapper's intuition-defying 422 only by coincidence: the two mappers disagree with each other in
 * general, so each port follows its own reference file rather than a house rule.
 *
 * THESE PROBLEMS DO CARRY A `code` EXTENSION — ALSO MEASURED, AND THE OPPOSITE OF tenants/errors.ts
 * ================================================================================================
 * `ReferenceDataEndpoints.UnprocessableOrNotFound` (:130-135) passes BOTH
 * `detail: $"{error.Code}: {error.Message}"` AND `extensions: { ["code"] = error.Code }`, and the
 * endpoint's own doc comment (:110-113) says why: the spec-mandated exact code
 * (`TERMINAL_STATUS_CANNOT_BE_DISABLED`) must be matchable without parsing extensions. Constructing
 * these with `code` makes lib/errors/problem.ts render exactly that pair — `detail` becomes
 * `"CODE: message"` via `renderDetail`, and `code` is emitted alongside. Tenant Manager's errors are
 * built WITHOUT a code precisely because ITS reference mapper omitted both; the difference between
 * the two surfaces is the reference's, not this port's.
 *
 * The unparseable list type is the one failure that is NOT built here: `InvalidListTypeProblem`
 * (:107-108) emits a bare 400 with no `code` extension at all, unlike every branch above. See
 * routes.ts.
 */
import { AppError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const REFERENCE_DATA_VALIDATION_FAILED = 'REFERENCE_DATA_VALIDATION_FAILED';
export const REFERENCE_DATA_NOT_FOUND = 'REFERENCE_DATA_NOT_FOUND';
export const REFERENCE_DATA_DUPLICATE_NAME = 'REFERENCE_DATA_DUPLICATE_NAME';
export const REFERENCE_DATA_PRODUCT_LINE_REQUIRED = 'REFERENCE_DATA_PRODUCT_LINE_REQUIRED';
export const REFERENCE_DATA_INVALID_PRODUCT_LINE = 'REFERENCE_DATA_INVALID_PRODUCT_LINE';
export const REFERENCE_DATA_REPORTING_CATEGORY_REQUIRED =
  'REFERENCE_DATA_REPORTING_CATEGORY_REQUIRED';
export const REFERENCE_DATA_INVALID_INTERMEDIATE_CATEGORY =
  'REFERENCE_DATA_INVALID_INTERMEDIATE_CATEGORY';
export const REFERENCE_DATA_CANONICAL_FIELDS_IMMUTABLE =
  'REFERENCE_DATA_CANONICAL_FIELDS_IMMUTABLE';
export const REFERENCE_DATA_REORDER_SET_MISMATCH = 'REFERENCE_DATA_REORDER_SET_MISMATCH';
/** Spec-mandated exact code (FR-20, AC-035). Note it carries NO `REFERENCE_DATA_` prefix. */
export const TERMINAL_STATUS_CANNOT_BE_DISABLED = 'TERMINAL_STATUS_CANNOT_BE_DISABLED';

/**
 * ReferenceDataErrors.Validation (:8) -> 422. `message` is the reference's
 * `string.Join("; ", validation.Errors.Select(e => e.ErrorMessage))`
 * (CreateItemCommandHandler.cs:35-36); `errors[]` is this port's additive structured form
 * (spec §14, AC-096) and does not alter `detail`.
 */
export function referenceValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: REFERENCE_DATA_VALIDATION_FAILED,
    fieldErrors,
  });
}

/** ReferenceDataErrors.NotFound (:10) -> 404. Also the answer for another tenant's id (N-01). */
export function referenceItemNotFoundError(id: number): NotFoundError {
  return new NotFoundError(`Reference item ${id} was not found.`, {
    code: REFERENCE_DATA_NOT_FOUND,
  });
}

/** ReferenceDataErrors.DuplicateName (:12-13) -> 422. */
export function duplicateNameError(name: string): AppError {
  return new AppError(422, `A value named '${name}' already exists in this list.`, {
    code: REFERENCE_DATA_DUPLICATE_NAME,
  });
}

/** ReferenceDataErrors.ProductLineRequired (:15-16) -> 422. */
export function productLineRequiredError(): AppError {
  return new AppError(422, 'Cover types require an active product line.', {
    code: REFERENCE_DATA_PRODUCT_LINE_REQUIRED,
  });
}

/**
 * ReferenceDataErrors.InvalidProductLine (:18-19) -> 422.
 *
 * This is also AC-036's server-side half: a product line that has been DISABLED is no longer an
 * active product line, so submitting its id for a new/edited cover type fails here — while the
 * disabled row itself stays in the table, resolvable for the cover types already pointing at it.
 */
export function invalidProductLineError(productLineId: number): AppError {
  return new AppError(422, `Product line ${productLineId} is not an active product line.`, {
    code: REFERENCE_DATA_INVALID_PRODUCT_LINE,
  });
}

/** ReferenceDataErrors.ReportingCategoryRequired (:21-22) -> 422. */
export function reportingCategoryRequiredError(): AppError {
  return new AppError(422, 'Lead/quote statuses require a reporting category.', {
    code: REFERENCE_DATA_REPORTING_CATEGORY_REQUIRED,
  });
}

/** ReferenceDataErrors.InvalidIntermediateCategory (:24-26) -> 422. */
export function invalidIntermediateCategoryError(): AppError {
  return new AppError(
    422,
    "New statuses may only be added with reporting category 'open' or 'quoted'.",
    { code: REFERENCE_DATA_INVALID_INTERMEDIATE_CATEGORY },
  );
}

/** ReferenceDataErrors.TerminalStatusCannotBeDisabled (:29-30) -> 422. */
export function terminalStatusCannotBeDisabledError(): AppError {
  return new AppError(422, 'Terminal statuses cannot be disabled.', {
    code: TERMINAL_STATUS_CANNOT_BE_DISABLED,
  });
}

/** ReferenceDataErrors.CanonicalFieldsImmutable (:32-34) -> 422. */
export function canonicalFieldsImmutableError(): AppError {
  return new AppError(
    422,
    'The canonical key and reporting category of a canonical status cannot be changed.',
    { code: REFERENCE_DATA_CANONICAL_FIELDS_IMMUTABLE },
  );
}

/** ReferenceDataErrors.ReorderSetMismatch (:39-41) -> 422. */
export function reorderSetMismatchError(): AppError {
  return new AppError(
    422,
    'The reorder request must include exactly the active item ids for this list.',
    { code: REFERENCE_DATA_REORDER_SET_MISMATCH },
  );
}

/**
 * `InvalidListTypeProblem` (ReferenceDataEndpoints.cs:107-108) -> 400, with the message inline and
 * NO `code` extension — the endpoint never routes this through `UnprocessableOrNotFound`, so the
 * `REFERENCE_DATA_INVALID_LIST_TYPE` code declared in ReferenceDataErrors.cs:36-37 is dead in the
 * reference and is deliberately not reproduced on the wire here.
 */
export function invalidListTypeError(listType: string): AppError {
  return new AppError(400, `'${listType}' is not a recognized reference list type.`);
}

/** 400 — the body could not be read at all (model-binding failure in the reference). */
export function unreadableBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}
