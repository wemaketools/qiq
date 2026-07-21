/**
 * The Q-19 first-party API-key primitive (T-022, AC-040; spec §13, §16).
 *
 * This module is the ONLY place that knows what an API key looks like and how its stored form is
 * derived. Everything else — the admin service, the repository, T-030's intake middleware — works
 * in terms of the four functions below.
 *
 * KEY SHAPE
 * =========
 *     qiq_<32 hex chars>.<43 base64url chars>
 *     └────── key_id ──────┘ └─── secret ───┘
 *
 * The key id is the PUBLIC lookup handle. It is stored in plaintext (`api_credentials.key_id`),
 * displayed in the admin UI as `clientId`, and safe in logs and audit rows. It exists so that
 * verification is a single indexed point lookup instead of a scan that hashes every candidate row
 * (20260718002400_api_credentials.sql, "UNIQUENESS AND LOOKUP"). The `qiq_` prefix makes a leaked
 * key identifiable as ours by secret-scanning tools.
 *
 * The secret is 32 bytes of `randomBytes` — 256 bits. That is what makes the fast hash below the
 * right choice rather than a corner cut: password hashing (scrypt/argon2) exists to compensate for
 * LOW-entropy human secrets, and its cost would be paid on every single intake request in a
 * serverless runtime. A 256-bit uniformly random secret is not brute-forceable regardless of hash
 * speed, so HMAC-SHA-256 is both the standard choice for API keys and the one the migration header
 * anticipated ("scrypt or sha256-HMAC per security review — no custom crypto, standard library
 * only"). Flagged in the task file so a security reviewer can overrule it in one place.
 *
 * STORED FORM
 * ===========
 *     key_hash = HMAC-SHA-256(key = pepper, message = `${salt}:${secret}`)
 *
 * Three ingredients, three distinct jobs:
 *   - the SECRET is what the caller proves they hold;
 *   - the SALT is per credential and lives in the row, so two credentials that somehow shared a
 *     secret would still not share a hash — defeating precomputation and cross-row correlation;
 *   - the PEPPER is application-wide, lives in env config (a Vercel Sensitive Environment Variable,
 *     A-5/Q-5) and NEVER in the database, so a full database dump is not sufficient to verify — let
 *     alone forge — a single key.
 *
 * The `:` delimiter is load-bearing: concatenating salt and secret without one would make
 * ('ab','c') and ('a','bc') hash identically, so two distinct credentials could authenticate each
 * other's keys. The unit suite pins that.
 *
 * NO ENVIRONMENT ACCESS HERE. The pepper is a parameter. Only the typed config module reads the
 * process environment (AC-010), and keeping it out of this file is also what makes "rotating the
 * pepper invalidates every stored hash" a testable property rather than a claim.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Identifies a QuoteIQ-issued key at a glance, and to secret scanners. */
export const API_KEY_ID_PREFIX = 'qiq_';

/** Separates the public key id from the secret half. Absent from both alphabets, so the split is unambiguous. */
const KEY_SEPARATOR = '.';

const KEY_ID_BYTES = 16;
const SECRET_BYTES = 32;
const SALT_BYTES = 16;

/** A freshly issued key: three columns to store, one string to show the caller exactly once. */
export interface GeneratedApiKey {
  /** Public lookup handle, stored plaintext in `api_credentials.key_id`. */
  readonly keyId: string;
  /** Per-credential random salt, stored in `api_credentials.key_salt`. */
  readonly salt: string;
  /** Peppered, salted one-way hash, stored in `api_credentials.key_hash`. */
  readonly hash: string;
  /** The secret half. Never stored, never logged. */
  readonly secret: string;
  /** The full key the caller presents: `${keyId}${KEY_SEPARATOR}${secret}`. Never stored. */
  readonly plaintext: string;
}

/** The two halves of a presented key. */
export interface ParsedApiKey {
  readonly keyId: string;
  readonly secret: string;
}

/**
 * Derives the stored hash. Deterministic, so the same triple always verifies; one-way, so the row
 * it lands in can never be turned back into a usable key.
 */
export function hashApiKeySecret(secret: string, salt: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${salt}:${secret}`).digest('hex');
}

/**
 * Constant-time check of a presented secret against a stored hash.
 *
 * `timingSafeEqual` THROWS when the buffers differ in length, which a truncated or corrupted
 * `key_hash` would produce — that must be an ordinary authentication failure, not a 500 that tells
 * the caller their key id resolved to a real row. Hence the explicit length guard, which is safe to
 * do in variable time because the length of a SHA-256 digest is not a secret.
 *
 * A plain `===` here would leak the number of matching leading bytes through timing and let an
 * attacker walk a forgery out byte by byte; the unit suite asserts structurally that this stays a
 * timing-safe comparison.
 */
export function apiKeySecretMatches(
  expectedHash: string,
  secret: string,
  salt: string,
  pepper: string,
): boolean {
  const computed = Buffer.from(hashApiKeySecret(secret, salt, pepper), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

/** Issues a brand-new key. The caller stores `keyId`/`salt`/`hash` and shows `plaintext` once. */
export function generateApiKey(pepper: string): GeneratedApiKey {
  const keyId = `${API_KEY_ID_PREFIX}${randomBytes(KEY_ID_BYTES).toString('hex')}`;
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const salt = randomBytes(SALT_BYTES).toString('hex');

  return {
    keyId,
    salt,
    hash: hashApiKeySecret(secret, salt, pepper),
    secret,
    plaintext: `${keyId}${KEY_SEPARATOR}${secret}`,
  };
}

/**
 * Splits a presented key into its halves, or `undefined` when it is not one of ours.
 *
 * Rejecting a malformed key here — before any query — is deliberate: an unparseable key must not
 * become a database round trip, or the endpoint hands an unauthenticated caller a free way to make
 * the server work. Surrounding whitespace is tolerated because a key pasted into a header config
 * routinely carries a trailing newline, and refusing that produces an unexplainable 401.
 */
export function parseApiKey(presented: string): ParsedApiKey | undefined {
  const trimmed = presented.trim();
  if (!trimmed.startsWith(API_KEY_ID_PREFIX)) return undefined;

  const parts = trimmed.split(KEY_SEPARATOR);
  if (parts.length !== 2) return undefined;

  const [keyId, secret] = parts;
  if (keyId === undefined || secret === undefined) return undefined;
  if (keyId.length <= API_KEY_ID_PREFIX.length || secret.length === 0) return undefined;

  return { keyId, secret };
}
