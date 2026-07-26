/**
 * Bearer authentication end to end against the local Supabase stack
 * (T-011, AC-016, AC-017, V-019, V-020).
 *
 * Integration-first by design: tokens are REAL sessions minted through the local Auth service
 * (Q-21), and requests go through the real Hono pipeline via `app.fetch`. The only injected
 * things are the log sink and the JWKS cache — the latter purely so outbound fetches can be
 * COUNTED, which is the evidence behind the "no per-request network call" claim.
 *
 * Negative cases that a real session cannot produce (foreign signing key, alg none, HS256,
 * wrong issuer, expired) are minted locally with WebCrypto in helpers/jwt.ts.
 *
 * 401-vs-403 parity note: the .NET reference (RequirePermissionFilter.cs, pinned by
 * RequirePermissionTests) answers 401 — not 403 — for an unknown OR deactivated application user.
 * 403 is reserved for a resolved, active user lacking a permission (T-012).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { AppUserLookup, PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../lib/errors/problem.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { getAdminClient } from '../../lib/supabase/index.js';
import { JwksCache, type JwksKeySource } from '../../lib/supabase/jwks.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import {
  decodeClaims,
  generateEcKeyPair,
  signEs256,
  signHs256,
  staticKeySource,
  tamperPayload,
  unsignedToken,
  type EcKeyPair,
} from '../helpers/jwt.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('auth middleware: Supabase bearer verification', probe);

const PROBE_ROUTE = '/api/v1/__auth-probe';

interface ProbeBody {
  readonly userId: string | undefined;
  readonly authUserId: string | undefined;
  readonly email: string | undefined;
  readonly tokenAlgorithm: string | undefined;
}

interface Harness {
  readonly app: ApiApp;
  logText(): string;
  logRecords(): Record<string, unknown>[];
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let fixtures: TestAuthFixtures;
  let pgLookup: PgAppUserLookup;
  let lookupAppUser: AppUserLookup;

  /** Real JWKS cache with a counting fetch — the instrument for the offline-verification claim. */
  let jwksFetches: string[];
  let jwksCache: JwksCache;

  let activeUser: TestUserSession;
  let inactiveUser: TestUserSession;
  let orphanUser: TestUserSession;
  let foreignKey: EcKeyPair;

  function harness(
    options: { keySource?: JwksKeySource; client?: SupabaseClient } = {},
  ): Harness {
    const lines: string[] = [];
    const app = buildApp({
      config,
      loggerOptions: { sink: (line) => lines.push(line) },
      auth: {
        verifyAccessToken: createAccessTokenVerifier({
          config,
          ...(options.keySource ? { jwks: options.keySource } : { jwks: jwksCache }),
          ...(options.client ? { client: options.client } : {}),
        }),
        lookupAppUser,
      },
      registerRoutes: (api) => {
        api.get('/__auth-probe', (c) => {
          const auth = c.get('auth');
          return c.json<ProbeBody>({
            userId: c.get('userId'),
            authUserId: auth?.authUserId,
            email: auth?.email,
            tokenAlgorithm: auth?.tokenAlgorithm,
          });
        });
      },
    });

    return {
      app,
      logText: () => lines.join(''),
      logRecords: () => lines.map((line) => JSON.parse(line.trimEnd()) as Record<string, unknown>),
    };
  }

  async function get(
    app: ApiApp,
    path: string,
    token?: string,
    rawHeader?: string,
  ): Promise<Response> {
    const headers = new Headers();
    if (rawHeader !== undefined) headers.set('authorization', rawHeader);
    else if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    return await app.request(`http://localhost${path}`, { headers });
  }

  async function expectUnauthorized(response: Response): Promise<Record<string, unknown>> {
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain(PROBLEM_JSON_CONTENT_TYPE);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe(401);
    // RequirePermissionFilter.cs emitted a bare 401 problem+json with no `code` extension.
    expect(body.code).toBeUndefined();
    return body;
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    config = loadConfig({
      APP_ENV: 'local',
      LOG_LEVEL: 'info',
      SUPABASE_DATABASE_URL: stack.dbUrl,
      SUPABASE_DIRECT_DATABASE_URL: stack.dbUrl,
      SUPABASE_URL: stack.apiUrl,
      SUPABASE_ANON_KEY: stack.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
      CRON_SECRET: 'local-cron-secret',
      INTERNAL_JOB_SECRET: 'local-internal-job-secret',
      API_KEY_PEPPER: 'local-api-key-pepper-value',
    });

    fixtures = new TestAuthFixtures(stack);
    await fixtures.sweepStaleTestUsers();

    pgLookup = createPgAppUserLookup(config);
    lookupAppUser = pgLookup.lookup;

    jwksFetches = [];
    jwksCache = new JwksCache({
      supabaseUrl: stack.apiUrl,
      fetchImpl: (input, init) => {
        jwksFetches.push(String(input));
        return globalThis.fetch(input, init);
      },
    });

    activeUser = await fixtures.createTestUserWithSession({ label: 'active' });
    inactiveUser = await fixtures.createTestUserWithSession({ label: 'inactive', isActive: false });
    orphanUser = await fixtures.createTestUserWithSession({ label: 'orphan', withAppUser: false });
    foreignKey = await generateEcKeyPair();
  });

  afterAll(async () => {
    if (!probe.available) return;
    await fixtures.cleanup();
    await pgLookup.close();
  });

  describe('accepted', () => {
    it('authenticates a real Supabase session and resolves the app user from auth_user_id', async () => {
      const { app } = harness();

      const response = await get(app, PROBE_ROUTE, activeUser.accessToken);
      const body = (await response.json()) as ProbeBody;

      expect(response.status).toBe(200);
      expect(body.userId).toBe(activeUser.appUserId);
      expect(body.authUserId).toBe(activeUser.authUserId);
      expect(body.email).toBe(activeUser.email);
      // Asymmetric signing is what makes offline verification possible (T-002 / AC-003).
      expect(body.tokenAlgorithm).toBe('ES256');
    });

    it('maps the token sub claim to users.auth_user_id, not to users.id', async () => {
      const claims = decodeClaims(activeUser.accessToken);

      expect(claims.sub).toBe(activeUser.authUserId);
      expect(claims.sub).not.toBe(activeUser.appUserId);
      const rows = await fixtures.query<{ id: string }>(
        'select id::text as id from users where auth_user_id = $1::uuid',
        [activeUser.authUserId],
      );
      expect(rows[0]?.id).toBe(activeUser.appUserId);
    });

    it('records the resolved userId on the request log line (AC-011 fields stay populated)', async () => {
      const h = harness();

      await get(h.app, PROBE_ROUTE, activeUser.accessToken);
      const completed = h.logRecords().find((record) => record.message === 'request completed');

      expect(completed?.userId).toBe(activeUser.appUserId);
      expect(completed?.status).toBe(200);
    });

    it('leaves GET /health anonymous', async () => {
      const { app } = harness();

      const response = await get(app, '/api/v1/health');

      expect(response.status).toBe(200);
      expect((await response.json()) as { status: string }).toMatchObject({ status: 'ok' });
    });

    it('still answers 404 (not 401) for an unknown route with no credentials', async () => {
      // ASP.NET resolved the endpoint before authorization, so an unknown path was a 404 for
      // anonymous callers too (T-009 V-017 pins this). Auth must not turn it into a 401.
      const { app } = harness();

      const response = await get(app, '/api/v1/definitely-not-a-route');

      expect(response.status).toBe(404);
    });
  });

  describe('rejected — token problems (all 401, all generic)', () => {
    it('rejects a request with no Authorization header', async () => {
      const { app } = harness();

      const body = await expectUnauthorized(await get(app, PROBE_ROUTE));

      // Must not disclose which check failed.
      expect(JSON.stringify(body)).not.toMatch(/missing_authorization_header|jwks|signature/i);
    });

    it('rejects malformed Authorization headers', async () => {
      const { app } = harness();

      for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Token abc', 'abc.def.ghi']) {
        await expectUnauthorized(await get(app, PROBE_ROUTE, undefined, header));
      }
    });

    it('rejects a structurally malformed token', async () => {
      const { app } = harness();

      for (const token of ['not-a-jwt', 'only.two', 'aaa.bbb.ccc']) {
        await expectUnauthorized(await get(app, PROBE_ROUTE, token));
      }
    });

    it('rejects a token whose payload was tampered with after signing', async () => {
      const { app } = harness();
      const forged = tamperPayload(activeUser.accessToken, (claims) => {
        claims.sub = crypto.randomUUID();
        claims.role = 'service_role';
      });

      await expectUnauthorized(await get(app, PROBE_ROUTE, forged));
    });

    it('rejects a tampered token that still names a real, active user', async () => {
      // Mutation testing exposed the weakness in the test above: changing `sub` means the user
      // lookup rejects the request, so it passes even with signature verification disabled. Here
      // `sub` stays valid and the kid stays ours, leaving the SIGNATURE as the only thing that
      // can refuse it — privilege escalation by claim editing.
      const { app } = harness();
      const forged = tamperPayload(activeUser.accessToken, (claims) => {
        claims.role = 'service_role';
        claims.email = 'attacker@example.com';
        claims.exp = Math.floor(Date.now() / 1000) + 86_400 * 365;
      });

      const control = await get(app, PROBE_ROUTE, activeUser.accessToken);
      expect(control.status, 'positive control: the untampered token must work').toBe(200);

      await expectUnauthorized(await get(app, PROBE_ROUTE, forged));
    });

    it('rejects a token signed by a different (locally generated) key pair — V-020', async () => {
      const { app } = harness();
      const claims = decodeClaims(activeUser.accessToken);
      const forged = await signEs256({ ...claims }, foreignKey);

      await expectUnauthorized(await get(app, PROBE_ROUTE, forged));
    });

    it('rejects an alg:none token without any network call', async () => {
      const { app } = harness();
      const before = jwksCache.fetchCount;
      const claims = decodeClaims(activeUser.accessToken);

      await expectUnauthorized(await get(app, PROBE_ROUTE, unsignedToken(claims)));

      // The allow-list refuses it before key resolution, so nothing is fetched.
      expect(jwksCache.fetchCount).toBe(before);
    });

    it('rejects an HS256-signed token even when its claims are otherwise valid', async () => {
      const { app } = harness();
      const claims = decodeClaims(activeUser.accessToken);

      // Both a random secret and the service-role key (the classic "the JWT secret is lying
      // around" attack) must fail: with asymmetric keys active, no HS token is ever legitimate.
      for (const secret of ['super-secret', stack.serviceRoleKey, stack.anonKey]) {
        const forged = await signHs256(claims, secret);
        await expectUnauthorized(await get(app, PROBE_ROUTE, forged));
      }
    });
  });

  describe('rejected — claim problems, proved with a locally trusted key', () => {
    // A key source containing our OWN test key: signature verification succeeds, isolating the
    // claim-level checks. The first test is the positive control that makes the rest meaningful.
    let localKeySource: JwksKeySource;
    let localKey: EcKeyPair;

    const nowSeconds = (): number => Math.floor(Date.now() / 1000);

    beforeAll(async () => {
      if (!probe.available) return;
      localKey = await generateEcKeyPair();
      localKeySource = staticKeySource([localKey.publicJwk]);
    });

    function baseClaims(sub: string): Record<string, unknown> {
      return {
        iss: `${stack.apiUrl.replace(/\/$/, '')}/auth/v1`,
        sub,
        aud: 'authenticated',
        role: 'authenticated',
        email: activeUser.email,
        iat: nowSeconds(),
        exp: nowSeconds() + 3600,
      };
    }

    it('POSITIVE CONTROL: a locally signed token with correct claims authenticates', async () => {
      const { app } = harness({ keySource: localKeySource });
      const token = await signEs256(baseClaims(activeUser.authUserId), localKey);

      const response = await get(app, PROBE_ROUTE, token);

      expect(response.status).toBe(200);
    });

    it('rejects an expired token', async () => {
      const { app } = harness({ keySource: localKeySource });
      const token = await signEs256(
        { ...baseClaims(activeUser.authUserId), iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 },
        localKey,
      );

      await expectUnauthorized(await get(app, PROBE_ROUTE, token));
    });

    it('rejects a correctly signed token issued by a different issuer', async () => {
      const { app } = harness({ keySource: localKeySource });
      const token = await signEs256(
        { ...baseClaims(activeUser.authUserId), iss: 'https://evil.example.com/auth/v1' },
        localKey,
      );

      await expectUnauthorized(await get(app, PROBE_ROUTE, token));
    });

    it('rejects a token signed by a different key published under the same kid', async () => {
      // The foreign-key test above is refused at kid resolution, before any crypto. This one
      // gets all the way to signature verification: the kid resolves to our published key, but
      // the token was signed by an impostor key. Only the signature check can catch it.
      const { app } = harness({ keySource: localKeySource });
      const impostor = await generateEcKeyPair(localKey.kid);
      const forged = await signEs256(baseClaims(activeUser.authUserId), impostor);

      expect(impostor.kid).toBe(localKey.kid);
      await expectUnauthorized(await get(app, PROBE_ROUTE, forged));
    });

    it('refuses a known-kid HS256 or none token WITHOUT contacting the Auth server', async () => {
      // This isolates the algorithm allow-list. With a kid the key source recognises, the JWKS
      // check cannot be what rejects these tokens. Without the allow-list, getClaims() would fall
      // back to a network getUser() call — handing an attacker-controlled header the power to turn
      // offline verification into a server round-trip. Zero outbound requests is the assertion.
      const outbound: string[] = [];
      const countingClient = createClient(stack.apiUrl, stack.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: {
          fetch: (input, init) => {
            outbound.push(String(input));
            return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
          },
        },
      });
      const { app } = harness({ keySource: localKeySource, client: countingClient });
      const claims = baseClaims(activeUser.authUserId);

      await expectUnauthorized(
        await get(app, PROBE_ROUTE, await signHs256(claims, 'whatever', localKey.kid)),
      );
      await expectUnauthorized(await get(app, PROBE_ROUTE, unsignedToken(claims, localKey.kid)));

      expect(outbound, `Auth server was contacted: ${outbound.join(', ')}`).toEqual([]);
    });

    it('rejects a token whose sub is not a uuid', async () => {
      const { app } = harness({ keySource: localKeySource });
      const token = await signEs256({ ...baseClaims('not-a-uuid') }, localKey);

      await expectUnauthorized(await get(app, PROBE_ROUTE, token));
    });
  });

  describe('rejected — application user problems (401, matching the .NET reference)', () => {
    it('rejects a valid token whose subject has no application users row', async () => {
      const { app } = harness();

      const body = await expectUnauthorized(await get(app, PROBE_ROUTE, orphanUser.accessToken));

      expect(body.detail).toBe(
        'No active application user could be resolved for the authenticated principal.',
      );
    });

    it('rejects a valid token for a deactivated application user (is_active = false)', async () => {
      const { app } = harness();

      const body = await expectUnauthorized(await get(app, PROBE_ROUTE, inactiveUser.accessToken));

      expect(body.detail).toBe(
        'No active application user could be resolved for the authenticated principal.',
      );
    });

    it('grants access again once the user is reactivated, using the same token', async () => {
      const { app } = harness();
      await fixtures.setAppUserActive(inactiveUser.authUserId, true);

      try {
        const response = await get(app, PROBE_ROUTE, inactiveUser.accessToken);
        expect(response.status).toBe(200);
      } finally {
        await fixtures.setAppUserActive(inactiveUser.authUserId, false);
      }
    });
  });

  describe('offline JWKS verification (AC-016, V-020)', () => {
    it('makes no outbound JWKS request per authenticated request once warmed', async () => {
      const { app } = harness();

      // Warm-up: the first verification of this cold cache is allowed exactly one fetch.
      await get(app, PROBE_ROUTE, activeUser.accessToken);
      const afterWarmUp = jwksCache.fetchCount;
      expect(afterWarmUp).toBeGreaterThanOrEqual(1);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => get(app, PROBE_ROUTE, activeUser.accessToken)),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(jwksCache.fetchCount).toBe(afterWarmUp);
      expect(jwksFetches.every((url) => url.endsWith('/auth/v1/.well-known/jwks.json'))).toBe(true);
    });

    it('does not re-fetch when the token carries an unknown kid within the refresh cooldown', async () => {
      const { app } = harness();
      await get(app, PROBE_ROUTE, activeUser.accessToken);
      const before = jwksCache.fetchCount;

      const claims = decodeClaims(activeUser.accessToken);
      for (let i = 0; i < 5; i += 1) {
        const forged = await signEs256(claims, await generateEcKeyPair(`unknown-${i}`));
        await expectUnauthorized(await get(app, PROBE_ROUTE, forged));
      }

      // At most one rotation-refresh across the burst, not one per request.
      expect(jwksCache.fetchCount - before).toBeLessThanOrEqual(1);
    });
  });

  describe('secrets never reach the logs (AC-011, V-014)', () => {
    it('logs neither the raw access token nor the Authorization header value', async () => {
      const h = harness();

      await get(h.app, PROBE_ROUTE, activeUser.accessToken);
      await get(h.app, PROBE_ROUTE, 'Bearer-shaped-garbage.aaa.bbb');
      await get(h.app, PROBE_ROUTE, undefined, `Bearer ${activeUser.accessToken}`);
      const text = h.logText();

      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(activeUser.accessToken);
      // Not even a distinctive fragment of it.
      expect(text).not.toContain(activeUser.accessToken.slice(0, 40));
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
      expect(text).not.toContain(stack.serviceRoleKey);
      expect(text).not.toContain(activeUser.password);
    });

    it('logs the rejection reason server-side so failures remain diagnosable', async () => {
      const h = harness();

      await get(h.app, PROBE_ROUTE, inactiveUser.accessToken);
      const rejected = h
        .logRecords()
        .find((record) => record.message === 'authentication rejected');

      expect(rejected?.reason).toBe('user_inactive');
    });
  });

  describe('Auth Admin client (AC-017)', () => {
    it('creates and disables an auth identity with the service-role key', async () => {
      const admin = getAdminClient(config);
      const email = `quoteiq-test-admin-${process.pid}-${Date.now()}@quoteiq.local`;
      const password = `Admin-${crypto.randomUUID()}!aA1`;

      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const userId = created.data.user?.id;
      expect(userId).toBeTruthy();

      try {
        // Ban duration is how the Auth Admin API disables an identity (the T-017 deactivate path).
        const banned = await admin.auth.admin.updateUserById(userId as string, {
          ban_duration: '87600h',
        });
        expect(banned.error).toBeNull();

        const signIn = await fixtures.anonClient.auth.signInWithPassword({ email, password });
        expect(signIn.error, 'a banned identity must not be able to sign in').not.toBeNull();
        expect(signIn.data.session).toBeNull();
      } finally {
        await admin.auth.admin.deleteUser(userId as string);
      }
    });
  });
});
