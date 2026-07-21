/**
 * Broker domain failures (T-021, AC-039; P-04, spec §12 Settings).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Brokers/BrokerErrors.cs` together with the status
 * mapping in `src/api/QuoteIQ.Api/Endpoints/BrokerEndpoints.cs:123-145`:
 *
 *   BROKER_NOT_FOUND                  -> 404  (:125)
 *   BROKER_CONTACT_NOT_FOUND          -> 404  (:125)
 *   BROKER_DUPLICATE_NAME             -> 409  (:130)
 *   BROKER_VALIDATION_FAILED          -> 422  (:135)
 *   BROKER_INVALID_BROKER_TYPE        -> 422  (:135)
 *   BROKER_CONTACT_VALIDATION_FAILED  -> 422  (:135)
 *   anything else                     -> 400  (:140)
 *
 * A DUPLICATE NAME IS 409 HERE — AND 422 IN THE SIBLING REFERENCE-DATA SURFACE
 * ===========================================================================
 * `ReferenceDataEndpoints.cs:119` maps ITS duplicate to 422, and `TenantEndpoints` does the same.
 * This mapper measurably does not (:130-134 is a `Status409Conflict` branch). The two disagree in
 * the reference, so each port follows its own reference file rather than a house rule; the suite
 * pins 409 with the `BROKER_DUPLICATE_NAME` code so a later "consistency" tidy-up cannot silently
 * change what the SPA sees.
 *
 * THESE PROBLEMS DO CARRY A `code` EXTENSION — ALSO MEASURED
 * =========================================================
 * Every branch of `ProblemFromError` passes BOTH `detail: $"{error.Code}: {error.Message}"` AND
 * `extensions: { ["code"] = error.Code }` (:125-144), which the endpoint's own doc comment (:118-122)
 * calls the same convention as `ReferenceDataEndpoints`/`BusinessAssignmentEndpoints`. Constructing
 * these with `code` makes lib/errors/problem.ts render exactly that pair. (Tenant Manager's errors
 * are built WITHOUT a code because ITS mapper omitted both — the difference is the reference's.)
 */
import { AppError, ConflictError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const BROKER_VALIDATION_FAILED = 'BROKER_VALIDATION_FAILED';
export const BROKER_NOT_FOUND = 'BROKER_NOT_FOUND';
export const BROKER_DUPLICATE_NAME = 'BROKER_DUPLICATE_NAME';
export const BROKER_INVALID_BROKER_TYPE = 'BROKER_INVALID_BROKER_TYPE';
export const BROKER_CONTACT_VALIDATION_FAILED = 'BROKER_CONTACT_VALIDATION_FAILED';
export const BROKER_CONTACT_NOT_FOUND = 'BROKER_CONTACT_NOT_FOUND';

/**
 * BrokerErrors.Validation (:8) -> 422. `message` is the reference's
 * `string.Join("; ", validation.Errors.Select(e => e.ErrorMessage))`
 * (CreateBrokerCommandHandler.cs:36-37); `errors[]` is this port's additive structured form
 * (spec §14, AC-096) and does not alter `detail`.
 */
export function brokerValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: BROKER_VALIDATION_FAILED,
    fieldErrors,
  });
}

/** BrokerErrors.ContactValidation (:19) -> 422. Distinct code, so the SPA can tell the two apart. */
export function brokerContactValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: BROKER_CONTACT_VALIDATION_FAILED,
    fieldErrors,
  });
}

/** BrokerErrors.NotFound (:10) -> 404. Also the answer for another tenant's id (N-01, AC-022). */
export function brokerNotFoundError(id: number): NotFoundError {
  return new NotFoundError(`Broker ${String(id)} was not found.`, { code: BROKER_NOT_FOUND });
}

/**
 * BrokerErrors.ContactNotFound (:21-22) -> 404.
 *
 * Also the answer when the contact exists but belongs to a DIFFERENT broker: the reference looks the
 * contact up within the parent broker's contact list (RemoveContactCommandHandler.cs:49-50), so the
 * broker/contact association is part of the lookup rather than a decoration on the URL.
 */
export function brokerContactNotFoundError(contactId: number): NotFoundError {
  return new NotFoundError(`Contact ${String(contactId)} was not found on this broker.`, {
    code: BROKER_CONTACT_NOT_FOUND,
  });
}

/** BrokerErrors.DuplicateName (:12-13) -> 409. See the header for why this is not 422. */
export function duplicateBrokerNameError(name: string): ConflictError {
  return new ConflictError(`A broker named '${name}' already exists in this tenant.`, {
    code: BROKER_DUPLICATE_NAME,
  });
}

/**
 * BrokerErrors.InvalidBrokerType (:15-17) -> 422.
 *
 * "Active broker-type reference value FOR THIS TENANT" is the whole rule: `IsActiveBrokerTypeAsync`
 * (ReferenceDataStore.cs:83-92) pins tenant, id, `list_type = 'broker_type'` AND `is_active`, so a
 * disabled type, a region id, and another tenant's type all land here rather than being stored.
 */
export function invalidBrokerTypeError(brokerTypeId: number): AppError {
  return new AppError(
    422,
    `Broker type ${String(brokerTypeId)} is not an active broker-type reference value for this tenant.`,
    { code: BROKER_INVALID_BROKER_TYPE },
  );
}

/** 400 — the body could not be read at all (model-binding failure in the reference). */
export function unreadableBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}
