/**
 * Access-token verification (T-011, AC-016, V-019, V-020, spec §13 AuthN, A-10).
 *
 * The pipeline is deliberately ordered cheapest-and-most-suspicious first:
 *
 *   1. decode the (unsigned) header            — malformed input never reaches crypto
 *   2. algorithm allow-list                    — blocks the `none`/HS* downgrade into getClaims'
 *                                                network `getUser()` fallback
 *   3. resolve the `kid` in our cached JWKS    — offline; unknown key => reject, no round-trip
 *   4. getClaims(token, { keys: [signingKey] }) — pure local WebCrypto verification + exp check
 *   5. issuer pin                              — getClaims does not check `iss`
 *
 * Steps 2 and 3 are what make the "no per-request network call" guarantee hold: by the time
 * `getClaims` runs, it has been handed the exact key it needs, so it cannot decide to phone home.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config/index.js';
import { err, ok, type Result } from '../result.js';
import { getJwksCache, getVerificationClient, type JwksKeySource } from '../supabase/index.js';
import {
  decodeJwtHeader,
  isAllowedAlgorithm,
  issuerMatches,
  type TokenRejectionReason,
} from './token.js';

/** The subset of verified claims this application trusts. Nothing else is carried forward. */
export interface VerifiedToken {
  /** `sub` — the auth.users(id) uuid, mapped to users.auth_user_id. */
  readonly authUserId: string;
  readonly email: string | undefined;
  readonly sessionId: string | undefined;
  readonly algorithm: string;
  readonly expiresAt: number | undefined;
}

export type AccessTokenVerifier = (
  token: string,
) => Promise<Result<VerifiedToken, TokenRejectionReason>>;

export interface AccessTokenVerifierDeps {
  readonly config: AppConfig;
  /** Overridable for tests; defaults to the memoized anon-key client. */
  readonly client?: SupabaseClient;
  /** Overridable for tests (fetch counting); defaults to the process-wide cache for this URL. */
  readonly jwks?: JwksKeySource;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAccessTokenVerifier(deps: AccessTokenVerifierDeps): AccessTokenVerifier {
  const supabaseUrl = deps.config.supabase.url;
  const client = deps.client ?? getVerificationClient(deps.config);
  const jwks = deps.jwks ?? getJwksCache(supabaseUrl);

  return async function verifyAccessToken(token) {
    const header = decodeJwtHeader(token);
    if (!header.ok) return header;

    if (!isAllowedAlgorithm(header.value.alg)) {
      return err('unsupported_algorithm');
    }

    // A kid-less token is also a getClaims -> getUser fallback trigger, so it is refused here
    // rather than being allowed to become a network call.
    const kid = header.value.kid;
    if (kid === undefined) {
      return err('unsupported_algorithm');
    }

    const signingKey = await jwks.findKey(kid);
    if (signingKey === null) {
      return err('unknown_signing_key');
    }

    // `keys` is supplied so GoTrueClient resolves the signing key from memory. Signature and
    // expiry are checked inside; an expired or tampered token comes back as an error.
    const { data, error } = await client.auth.getClaims(token, { keys: [signingKey] });
    if (error !== null || data === null) {
      return err('invalid_token');
    }

    const { claims } = data;
    if (!issuerMatches(claims.iss, supabaseUrl)) {
      return err('unexpected_issuer');
    }

    const sub: unknown = claims.sub;
    if (typeof sub !== 'string' || !UUID_PATTERN.test(sub)) {
      return err('invalid_token');
    }

    const email: unknown = claims.email;
    const sessionId: unknown = claims.session_id;
    const exp: unknown = claims.exp;

    return ok({
      authUserId: sub,
      email: typeof email === 'string' && email !== '' ? email : undefined,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      algorithm: header.value.alg,
      expiresAt: typeof exp === 'number' ? exp : undefined,
    });
  };
}
