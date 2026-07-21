/**
 * Locally minted tokens for the rejection matrix (T-011, AC-016, V-020).
 *
 * Real Supabase sessions (helpers/auth.ts) prove the happy path; these prove the negative space,
 * which a real session cannot: a token signed by a FOREIGN key pair, an `alg: none` token, an
 * HS256 token, and a correctly-signed token bearing the wrong `iss`. All are produced with
 * WebCrypto — no new dependency, and the signatures are genuine, so the verifier is exercised
 * rather than short-circuited.
 */
import type { webcrypto } from 'node:crypto';

import type { JWK } from '@supabase/supabase-js';

type SigningKey = webcrypto.CryptoKey;

export interface EcKeyPair {
  readonly privateKey: SigningKey;
  /** Public JWK in the shape the JWKS endpoint publishes, including a kid. */
  readonly publicJwk: JWK;
  readonly kid: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Generates a P-256 signing key pair standing in for "somebody else's Supabase project". */
export async function generateEcKeyPair(kid = `test-${crypto.randomUUID()}`): Promise<EcKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);

  return {
    privateKey: pair.privateKey,
    kid,
    publicJwk: { ...exported, kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] } as JWK,
  };
}

/** Signs a real ES256 JWT with the supplied key pair. */
export async function signEs256(
  payload: Record<string, unknown>,
  keyPair: EcKeyPair,
): Promise<string> {
  const signingInput = `${encode({ alg: 'ES256', typ: 'JWT', kid: keyPair.kid })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    Buffer.from(signingInput, 'utf8'),
  );

  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

/** An `alg: none` token: structurally valid, cryptographically worthless. */
export function unsignedToken(payload: Record<string, unknown>, kid = 'anything'): string {
  return `${encode({ alg: 'none', typ: 'JWT', kid })}.${encode(payload)}.`;
}

/** An HS256 token — the classic algorithm-confusion downgrade attempt. */
export async function signHs256(
  payload: Record<string, unknown>,
  secret: string,
  kid = 'anything',
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(secret, 'utf8'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT', kid })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign('HMAC', key, Buffer.from(signingInput, 'utf8'));

  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

/** Replaces the payload of a signed token, leaving the original signature attached. */
export function tamperPayload(token: string, mutate: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  mutate(claims);
  return `${header}.${encode(claims)}.${signature}`;
}

export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] as string;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** A key source backed by an in-memory key set, for tests that must not touch the network. */
export function staticKeySource(keys: readonly JWK[]): { findKey(kid: string): Promise<JWK | null> } {
  return {
    findKey: async (kid) => keys.find((key) => key.kid === kid) ?? null,
  };
}
