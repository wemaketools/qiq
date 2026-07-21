/**
 * Tenant business-rules domain failures (T-020, AC-037).
 *
 * Port of `src/api/QuoteIQ.Application/Features/BusinessRules/BusinessRuleErrors.cs` together with
 * the status mapping in `src/api/QuoteIQ.Api/Endpoints/BusinessRuleEndpoints.cs:72-90`:
 *
 *   BUSINESS_RULES_NOT_FOUND          -> 404  (:74)
 *   BUSINESS_RULES_VALIDATION_FAILED  -> 422  (:79)
 *   anything else                     -> 400  (:84)
 *
 * BOTH branches carry the code in `detail` AND as a `code` extension (:77-78, :82-83), the same
 * convention as the reference-data mapper and the OPPOSITE of the Tenant Manager one. Constructing
 * these with `code` makes lib/errors/problem.ts render `detail` as `"CODE: message"` and emit
 * `code` alongside, which is what the SPA reads.
 *
 * THE 404 IS A PROVISIONING ALARM, NOT AN EXPECTED CALLER ERROR
 * ============================================================
 * BusinessRuleErrors.cs:9-12 says so explicitly: every tenant is provisioned a `tenant_settings`
 * row inside the same transaction as the tenant itself (tenants/service.ts's
 * `provisionDefaultSettings`, and `uq_tenant_settings_tenant_id` makes a second row impossible), so
 * a caller can only ever see this if provisioning was bypassed. It is preserved as a 404 rather
 * than "helpfully" materialising a defaults row on read: silently creating settings here would give
 * the tenant a row whose `created_by` is whoever happened to open the Settings screen, and would
 * hide the provisioning bug that produced the situation.
 */
import { AppError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const BUSINESS_RULES_VALIDATION_FAILED = 'BUSINESS_RULES_VALIDATION_FAILED';
export const BUSINESS_RULES_NOT_FOUND = 'BUSINESS_RULES_NOT_FOUND';

/**
 * `BusinessRuleErrors.Validation` (:8) -> 422.
 *
 * `message` reproduces the reference's
 * `string.Join("; ", validation.Errors.Select(e => e.ErrorMessage))`
 * (UpdateBusinessRulesCommandHandler.cs:44-45); `errors[]` is this port's additive structured form
 * (spec §14, AC-096) and does not alter `detail`.
 */
export function businessRulesValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: BUSINESS_RULES_VALIDATION_FAILED,
    fieldErrors,
  });
}

/** `BusinessRuleErrors.NotFound` (:14-15) -> 404, message verbatim. */
export function businessRulesNotFoundError(): NotFoundError {
  return new NotFoundError('This tenant has no business-rules settings row.', {
    code: BUSINESS_RULES_NOT_FOUND,
  });
}

/** 400 — the body could not be read as JSON at all (model-binding failure in the reference). */
export function unreadableBodyError(): AppError {
  return new AppError(400, 'The request body could not be read as JSON.');
}
