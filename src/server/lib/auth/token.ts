/**
 * Pure bearer/JWT parsing and pre-verification policy (T-011, spec §13 AuthN, A-10).
 *
 * Everything here is synchronous, dependency-free, and does NO cryptography — it decides which
 * tokens are even eligible for verification. Two of these checks are security controls, not
 * conveniences:
 *
 * 1. `isAllowedAlgorithm` — `auth.getClaims()` (GoTrueClient) treats a token whose `alg` starts
 *    with `HS`, or that carries no `kid`, as unverifiable offline and silently falls back to a
 *    network `getUser()` call. That fallback is attacker-triggerable (the header is unsigned
 *    input), turns our offline path into a per-request round-trip, and moves the trust decision
 *    to the Auth server. We refuse those tokens outright: with asymmetric signing keys active
 *    (T-002 proved ES256 locally) no legitimate token is ever symmetric or kid-less.
 * 2. `issuerMatches` — `getClaims()` verifies the signature but does not check `iss`. Pinning the
 *    issuer to the configured Supabase URL stops a token minted by a different project from being
 *    accepted should its `kid` ever collide with ours.
 */
import { err, ok, type Result } from '../result.js';

/**
 * Asymmetric algorithms only. Supabase issues ES256 by default for the current signing-key
 * generation; the RSA and EdDSA variants are listed so a key-type rotation needs no code change.
 * `none` and every `HS*` algorithm are absent by design.
 */
export const ALLOWED_JWT_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA',
] as const;

export type AllowedJwtAlgorithm = (typeof ALLOWED_JWT_ALGORITHMS)[number];

/**
 * Why a request was refused. Kept server-side only: the client always receives the same generic
 * 401 body (V-019: "without leaking verification detail"), while the reason is logged.
 */
export type TokenRejectionReason =
  | 'missing_authorization_header'
  | 'malformed_authorization_header'
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'unknown_signing_key'
  | 'unexpected_issuer'
  | 'invalid_token';

export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

const BEARER_HEADER = /^Bearer[ \t]+(\S+)$/i;

/** Parses an `Authorization` header value, distinguishing "absent" from "present but wrong". */
export function extractBearerToken(
  headerValue: string | null | undefined,
): Result<string, TokenRejectionReason> {
  if (headerValue === null || headerValue === undefined || headerValue.trim() === '') {
    return err('missing_authorization_header');
  }

  const match = BEARER_HEADER.exec(headerValue.trim());
  if (match === null) {
    return err('malformed_authorization_header');
  }

  return ok(match[1] as string);
}

function decodeSegment(segment: string): unknown {
  // Buffer.from silently ignores invalid base64url characters, so JSON.parse is the real gate.
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json);
}

/**
 * Reads the UNVERIFIED header of a compact JWS. The values are used only to select a signing key
 * and to enforce the algorithm allow-list — never to make an authorization decision.
 */
export function decodeJwtHeader(token: string): Result<JwtHeader, TokenRejectionReason> {
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment === '')) {
    return err('malformed_token');
  }

  let decoded: unknown;
  try {
    decoded = decodeSegment(segments[0] as string);
  } catch {
    return err('malformed_token');
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return err('malformed_token');
  }

  const header = decoded as Record<string, unknown>;
  if (typeof header.alg !== 'string') {
    return err('malformed_token');
  }

  return ok({
    alg: header.alg,
    ...(typeof header.kid === 'string' ? { kid: header.kid } : {}),
    ...(typeof header.typ === 'string' ? { typ: header.typ } : {}),
  });
}

export function isAllowedAlgorithm(alg: string): alg is AllowedJwtAlgorithm {
  return (ALLOWED_JWT_ALGORITHMS as readonly string[]).includes(alg);
}

/** The `iss` GoTrue stamps into access tokens for a given Supabase project URL. */
export function expectedIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
}

export function issuerMatches(issuer: unknown, supabaseUrl: string): boolean {
  if (typeof issuer !== 'string') return false;
  return issuer.replace(/\/+$/, '') === expectedIssuer(supabaseUrl);
}
