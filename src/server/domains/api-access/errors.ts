/**
 * API-credential domain failures (T-022, AC-040; spec §12.6).
 *
 * Port of `src/api/QuoteIQ.Application/Features/ApiAccess/ApiAccessErrors.cs` together with the
 * status mapping in `src/api/QuoteIQ.Api/Endpoints/ApiAccessEndpoints.cs:91-113`:
 *
 *   API_CREDENTIAL_NOT_FOUND        -> 404  (:93)
 *   API_CREDENTIAL_ALREADY_EXISTS   -> 409  (:98)
 *   API_CREDENTIAL_INVALID_BROKER   -> 422  (:103)
 *   anything else                   -> 400  (:108)
 *
 * Every branch of `ProblemFromError` passes BOTH `detail: $"{error.Code}: {error.Message}"` AND
 * `extensions: { ["code"] = error.Code }`, so these are constructed with `code` and lib/errors/
 * problem.ts renders exactly that pair — the same convention as the broker and reference-data
 * ports, and what the SPA's `NormalizedError` reads.
 *
 * THE ADDED CODE: API_CREDENTIAL_NOT_REVEALABLE (410)
 * ==================================================
 * The reference's `POST /{id}/reveal` re-served the secret by calling Keycloak's client-secret
 * endpoint live. Under Q-19 the secret is a salted hash and there is no such call to make — the
 * migration header states outright that "the .NET live-call-to-Keycloak reveal path has no
 * successor and must not grow one". The route is nonetheless kept registered with this explicit
 * code rather than deleted, because the SPA still calls it (`revealApiCredentialSecret`,
 * settingsApi.ts:314-316) and a bare 404 there is indistinguishable from a wiring bug. 410 Gone is
 * the precise statement: the resource existed, it is permanently gone, do not ask again.
 *
 * FLAGGED, NOT DECIDED: whether the UI's "Reveal secret" button should be removed (T-043) or
 * repointed at regenerate is a product call. Aliasing reveal to regenerate silently was rejected —
 * it would rotate a live integration's credential on a read-looking click.
 */
import { AppError, ConflictError, NotFoundError } from '../../lib/errors/index.js';

export const API_CREDENTIAL_NOT_FOUND = 'API_CREDENTIAL_NOT_FOUND';
export const API_CREDENTIAL_ALREADY_EXISTS = 'API_CREDENTIAL_ALREADY_EXISTS';
export const API_CREDENTIAL_INVALID_BROKER = 'API_CREDENTIAL_INVALID_BROKER';
export const API_CREDENTIAL_NOT_REVEALABLE = 'API_CREDENTIAL_NOT_REVEALABLE';
export const API_CREDENTIAL_VALIDATION_FAILED = 'API_CREDENTIAL_VALIDATION_FAILED';

/**
 * `ApiAccessErrors.NotFound` (:8-9) -> 404. Also the answer for another tenant's credential id
 * (N-01, AC-022): the tenant predicate filters it out before this point, so a cross-tenant id is
 * indistinguishable from a nonexistent one.
 */
export function credentialNotFoundError(id: number): NotFoundError {
  return new NotFoundError(`API credential ${String(id)} was not found for this tenant.`, {
    code: API_CREDENTIAL_NOT_FOUND,
  });
}

/**
 * `ApiAccessErrors.AlreadyExists` (:11-12) -> 409.
 *
 * MEASURED AND PRESERVED: the reference's existence check does NOT filter on status
 * (ApiCredentialStore.FindTenantCredentialAsync/FindBrokerCredentialAsync), so a DISABLED
 * credential still blocks re-provisioning that scope. That is a dead end in the admin UI — after
 * disable, `ApiCredentialControls` shows the disabled credential with no buttons and never offers
 * "Enable API access" again — and it is flagged in T-022's task file rather than silently
 * "improved", because relaxing it would let a tenant accumulate credentials per scope and change
 * what the unique-per-scope assumption means for intake.
 */
export function credentialAlreadyExistsError(): ConflictError {
  return new ConflictError('An API credential already exists for this scope.', {
    code: API_CREDENTIAL_ALREADY_EXISTS,
  });
}

/**
 * `ApiAccessErrors.InvalidBroker` (:14-15) -> 422.
 *
 * "An ACTIVE broker for THIS tenant" is the whole rule (ProvisionCredentialCommandHandler.cs:47-50
 * checks `is not { Status: BrokerStatus.Active }` through the tenant-scoped store), so a disabled
 * broker and another tenant's broker both land here rather than being bound to a credential.
 */
export function invalidBrokerError(brokerId: number): AppError {
  return new AppError(
    422,
    `Broker ${String(brokerId)} is not an active broker for this tenant.`,
    { code: API_CREDENTIAL_INVALID_BROKER },
  );
}

/** 410 — the retired reveal path. See the header. */
export function credentialNotRevealableError(): AppError {
  return new AppError(
    410,
    'API keys are shown once at issue and cannot be revealed again. Regenerate to obtain a new key; the current one will stop working.',
    { code: API_CREDENTIAL_NOT_REVEALABLE },
  );
}
