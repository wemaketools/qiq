/**
 * Tenant Manager domain failures (T-016, AC-028; spec §12 Tenant Manager).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Tenants/TenantErrors.cs` together with the status
 * mapping in `src/api/QuoteIQ.Api/Endpoints/TenantEndpoints.cs:86-95`:
 *
 *   TENANT_VALIDATION_FAILED       -> 422  (TenantEndpoints.cs:88)
 *   TENANT_NAME_DUPLICATE          -> 422  (:89)   NOT 409 — measured, not intuited
 *   TENANT_NOT_FOUND               -> 404  (:90)
 *   TENANT_ALREADY_REMOVED         -> 409  (:91)
 *   TENANT_NOT_REMOVED             -> 409  (:92)
 *   TENANT_VIEW_REMOVED_FORBIDDEN  -> 403  (:93)
 *
 * A DUPLICATE NAME IS 422, NOT 409. Intuition (and the sibling BrokerEndpoints mapper, which sends
 * its duplicate to 409) both say otherwise; TenantEndpoints.cs:89 is explicit, so 422 is what this
 * port returns.
 *
 * NO `code` EXTENSION ON THESE PROBLEMS — ALSO MEASURED
 * ====================================================
 * `BrokerEndpoints.ProblemFromError` (:123-144) emits `detail: "$"{code}: {message}"` plus a `code`
 * extension, and lib/errors/problem.ts renders exactly that whenever an `AppError` carries a code.
 * `TenantEndpoints.ProblemFromError` deliberately does NOT: every branch passes
 * `detail: error.Message` with no extensions dictionary. Since `detail` is what the SPA renders
 * (`detail ?? title`), attaching a code here would change the text a Tenant Manager user sees. The
 * errors below are therefore constructed WITHOUT a code, so the rendered detail is byte-identical
 * to the reference. The difference between the two mappers is the reference's, not this port's.
 */
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

/**
 * 422 for a well-formed body that breaks the ported FluentValidation rules
 * (`CreateTenantValidator` / `UpdateTenantValidator`). `message` is the reference's
 * `string.Join("; ", validation.Errors.Select(e => e.ErrorMessage))`
 * (CreateTenantCommandHandler.cs:45-46); `errors[]` is this port's additive structured form
 * (spec §14, AC-096) and does not alter `detail`.
 */
export function tenantValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), { fieldErrors });
}

/** 400 — the body could not be read at all (model-binding failure in the reference). */
export function unreadableBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}

/** TenantErrors.DuplicateActiveName (TenantErrors.cs:10-11) -> 422. */
export function duplicateActiveNameError(name: string): AppError {
  return new AppError(422, `An active tenant named '${name}' already exists.`);
}

/** TenantErrors.NotFound (TenantErrors.cs:13-14) -> 404. */
export function tenantNotFoundError(tenantId: number): NotFoundError {
  return new NotFoundError(`Tenant ${tenantId} was not found.`);
}

/** TenantErrors.AlreadyRemoved (TenantErrors.cs:16-17) -> 409. */
export function tenantAlreadyRemovedError(tenantId: number): ConflictError {
  return new ConflictError(`Tenant ${tenantId} is already removed.`);
}

/** TenantErrors.NotRemoved (TenantErrors.cs:19-20) -> 409. */
export function tenantNotRemovedError(tenantId: number): ConflictError {
  return new ConflictError(`Tenant ${tenantId} is not removed.`);
}

/** TenantErrors.ViewRemovedForbidden (TenantErrors.cs:22-23) -> 403. */
export function viewRemovedForbiddenError(): ForbiddenError {
  return new ForbiddenError('Caller lacks permission to view removed tenants.');
}
