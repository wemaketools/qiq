/**
 * API-key authentication for the intake ingress (T-030, AC-061; V-078; Q-19, spec §13, §16).
 *
 * This is the ONLY authentication on `POST /intake/leads`. There is no Supabase session, no
 * `X-Tenant-Id`, and no permission resolution — the credential IS the principal, and the tenant and
 * broker it authorizes come from its own database row.
 *
 * THE FOUR FAILURE REASONS PRODUCE ONE BYTE-IDENTICAL 401
 * ======================================================
 * `verifyApiKey` distinguishes `malformed_key`, `unknown_key`, `credential_disabled` and
 * `secret_mismatch` FOR THE SERVER LOG ONLY (api-access/service.ts:273-286). Every one of them
 * leaves here as the same status, the same code and the same detail, because each distinction is an
 * oracle: "unknown vs mismatch" enumerates valid key ids, and "disabled" confirms that a tenant
 * exists and once had API access. A MISSING header joins them, so a caller cannot even learn
 * whether the header name it used was the right one.
 *
 * The suite asserts the bodies are identical rather than merely all-401 — four handlers that each
 * returned a differently-worded 401 would pass a status-only test while leaking the whole matrix.
 * The only field that legitimately varies is `correlationId`, which is per-request by construction.
 *
 * 401 RATHER THAN THE REFERENCE'S 403 — THE Q-19 CONTRACT DEVIATION (M-07)
 * =======================================================================
 * `IntakeEndpoints.cs:111-112` answers 403. That was correct THERE and is wrong HERE: under
 * Keycloak the bearer token had already authenticated the caller before the credential lookup ran,
 * so a failed lookup was an authorization verdict about an authenticated principal. Under Q-19 the
 * key IS the authentication, so a bad key means unauthenticated — 401, which is also what AC-061
 * and V-078 specify. Recorded as part of the approved auth-mechanism deviation.
 *
 * NOTHING DERIVED FROM THE PRESENTED KEY IS EVER LOGGED
 * ====================================================
 * Not the key, not its secret half, not its key id, not a prefix, not a length. A key id is enough
 * to confirm that a guessed credential exists, and log sinks are a far softer target than the
 * database. The failure log line carries the reason and the correlation id; on SUCCESS the resolved
 * `credentialId` (a database primary key, not key material) is logged for attribution.
 */
import { createMiddleware } from 'hono/factory';

import {
  recordApiKeyUse,
  verifyApiKey,
  type ApiAccessDeps,
  type CredentialContext,
} from '../api-access/index.js';
import { UnauthorizedError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';

/**
 * The documented header the key is presented in (spec §380, "presented in a documented header").
 *
 * `X-API-Key` rather than `Authorization: Bearer` DELIBERATELY. The bearer slot on this app already
 * means "Supabase session" everywhere else; overloading it would make a request whose session token
 * had expired indistinguishable from one presenting a key, and would let a future refactor of the
 * session middleware silently start consuming intake credentials. A distinct header keeps the two
 * schemes from ever being confused for one another. An `Authorization` header on this route is
 * IGNORED — it is not a fallback.
 */
export const API_KEY_HEADER = 'X-API-Key';

export const INTAKE_UNAUTHORIZED_CODE = 'INTAKE_CREDENTIAL_INVALID';

/**
 * The single opaque message. Deliberately says nothing about which of the five ways to fail
 * occurred, and deliberately does NOT echo the header name back with a hint about its format.
 */
export const INTAKE_UNAUTHORIZED_MESSAGE = 'A valid API key is required.';

function unauthorized(): UnauthorizedError {
  return new UnauthorizedError(INTAKE_UNAUTHORIZED_MESSAGE, { code: INTAKE_UNAUTHORIZED_CODE });
}

/**
 * Authenticates the request from `X-API-Key` and publishes the resolved `CredentialContext`.
 *
 * On success the handler downstream reads `c.get('credential')` — which no other middleware in this
 * app ever sets, so a handler that reached the intake service necessarily came through here.
 */
export function apiKeyAuth(deps: ApiAccessDeps) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const presented = c.req.header(API_KEY_HEADER);

    // A missing header short-circuits BEFORE `verifyApiKey`, so an anonymous probe never costs a
    // parse or a query — and still produces the identical 401 a wrong key does.
    if (presented === undefined || presented.trim() === '') {
      c.get('logger').warn('intake credential rejected', { reason: 'missing_key' });
      throw unauthorized();
    }

    const result = await verifyApiKey(deps, presented);
    if (!result.ok) {
      // The reason reaches the LOG and never the response.
      c.get('logger').warn('intake credential rejected', { reason: result.error.reason });
      throw unauthorized();
    }

    c.set('credential', result.value satisfies CredentialContext);

    // `last_used_at` is stamped on AUTHENTICATION, not on success: a key that authenticated and
    // then failed validation genuinely WAS used, and the admin UI's dormant-credential view would
    // be wrong to show it as unused. It is deliberately NOT awaited into the request's fate —
    // `verifyApiKey` is a pure read for exactly this reason (api-access/service.ts:322-325), so a
    // failed stamp must never turn a valid intake into an error.
    try {
      await recordApiKeyUse(deps, result.value);
    } catch (error) {
      c.get('logger').warn('failed to stamp api credential last_used_at', {
        credentialId: result.value.credentialId,
        err: error,
      });
    }

    await next();
  });
}
