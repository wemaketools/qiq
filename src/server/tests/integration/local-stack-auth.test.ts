/**
 * AC-003 / V-004: the local Supabase Auth service must issue access tokens signed with an
 * ASYMMETRIC key, so the backend can verify them offline against the published JWKS
 * (`auth.getClaims()`, A-10) instead of holding a shared HS256 secret. T-011 builds the
 * verification middleware directly on this behaviour, so if the local stack silently fell
 * back to HS256 the entire auth path would be untested locally.
 *
 * Also covers the V-004 expectation that the printed anon and service-role keys work: the
 * service-role key is exercised through the Auth Admin API (the T-017 provisioning path) and
 * the anon key through password sign-in (the P-01 SPA path).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('local Supabase Auth: asymmetric JWT signing keys', probe);

const SYMMETRIC_ALGS = ['HS256', 'HS384', 'HS512'];

/** Public EC JWK as published by the Supabase Auth JWKS endpoint. `d` is the private scalar
 *  and must never appear there — it is typed here only so the test can assert its absence. */
interface EcJwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  ext?: boolean;
  d?: string;
}

function decodeJwtHeader(token: string): { alg?: string; kid?: string; typ?: string } {
  const [header] = token.split('.');
  if (!header) throw new Error('Access token is not a JWT');
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
}

describeStack(title, () => {
  let stack: LocalStack;
  let admin: SupabaseClient;
  let anon: SupabaseClient;

  const email = `t002-probe-${process.pid}-${Date.now()}@quoteiq.local`;
  const password = `Probe!${process.pid}-${Date.now()}`;
  let createdUserId: string | undefined;
  let accessToken: string;

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    admin = createClient(stack.apiUrl, stack.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    anon = createClient(stack.apiUrl, stack.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Provisioning via the Auth Admin API is the only way an identity is created in this
    // product (P-03) — self-service signup is disabled in config.toml, so this also proves
    // the service-role key works and that admin creation bypasses the signup lockout.
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, `admin.createUser failed: ${created.error?.message}`).toBeNull();
    createdUserId = created.data.user?.id;

    const signedIn = await anon.auth.signInWithPassword({ email, password });
    expect(signedIn.error, `signInWithPassword failed: ${signedIn.error?.message}`).toBeNull();
    accessToken = signedIn.data.session?.access_token ?? '';
    expect(accessToken).not.toBe('');
  });

  afterAll(async () => {
    // Throwaway user must not survive the run: repeated runs would otherwise collide and the
    // local auth schema would accumulate junk identities across resets.
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId);
    }
  });

  it('signs access tokens with an asymmetric algorithm, not a shared HS256 secret', () => {
    const header = decodeJwtHeader(accessToken);
    expect(header.alg).toBeDefined();
    expect(SYMMETRIC_ALGS).not.toContain(header.alg);
    expect(header.alg).toBe('ES256');
    // A key id is what lets a verifier select the right JWKS entry offline.
    expect(header.kid).toBeTruthy();
  });

  it('publishes a JWKS whose public key verifies the issued token offline', async () => {
    const response = await fetch(stack.jwksUrl);
    expect(response.status).toBe(200);
    const jwks = (await response.json()) as { keys: EcJwk[] };

    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
    // A JWKS must only ever expose public key material.
    for (const key of jwks.keys) {
      expect(key.kty).toBe('EC');
      expect(key.d, 'JWKS leaked a private key component').toBeUndefined();
    }

    const { kid } = decodeJwtHeader(accessToken);
    const jwk = jwks.keys.find((k) => k.kid === kid);
    expect(jwk, `no JWKS entry matching token kid ${kid}`).toBeDefined();

    // Verify the signature with WebCrypto only — no network, no shared secret. This is the
    // primitive that auth.getClaims() relies on.
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );

    const [headerPart, payloadPart, signaturePart] = accessToken.split('.');
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(signaturePart!, 'base64url'),
      Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
    );
    expect(verified, 'token signature did not verify against the published JWKS').toBe(true);
  });

  it('verifies the token offline through auth.getClaims() (the T-011 backend path)', async () => {
    const { data, error } = await anon.auth.getClaims(accessToken);

    expect(error, `getClaims failed: ${error?.message}`).toBeNull();
    expect(data?.claims.email).toBe(email);
    expect(data?.claims.sub).toBe(createdUserId);
    expect(data?.claims.role).toBe('authenticated');
  });

  /**
   * Guards a subtle config trap: `[auth.email].enable_signup` enables the email PROVIDER
   * (setting it false also rejects sign-in), while `[auth].enable_signup` is what blocks
   * self-service registration. The two assertions below pin both halves — the provider must
   * stay usable for sign-in while anonymous signup stays closed (P-01/P-03).
   */
  it('refuses anonymous self-service signup while permitting admin-provisioned sign-in', async () => {
    const { data, error } = await anon.auth.signUp({
      email: `t002-selfserve-${Date.now()}@quoteiq.local`,
      password: 'Sh0uld-Not-Work!',
    });

    expect(error, 'anonymous signUp unexpectedly succeeded').not.toBeNull();
    expect(data.session).toBeNull();
  });

  it('rejects a token whose payload has been tampered with', async () => {
    const [headerPart, payloadPart, signaturePart] = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.role = 'service_role';
    const forgedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const forged = `${headerPart}.${forgedPayload}.${signaturePart}`;

    const { data, error } = await anon.auth.getClaims(forged);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});
