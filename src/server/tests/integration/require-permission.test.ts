/**
 * The `requirePermission` route guard, end to end (T-012, AC-018, AC-019, V-023, V-024).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/Auth/RequirePermissionTests.cs`, and deliberately the
 * same shape: a real signed-in session (not a hand-rolled token), a real Postgres-backed grant
 * lookup (not a stub), the real Hono pipeline via `app.fetch`, and a probe route mapped only inside
 * this suite so no test endpoint can ship in the real API surface.
 *
 * The four reference cases and their MEASURED status codes (RequirePermissionFilter.cs):
 *   grant present            -> 200   (RequirePermissionTests.cs:49)
 *   grant missing            -> 403   (:69)  — the only 403 in the whole filter
 *   no `users` row           -> 401   (:90)
 *   user row but !IsActive   -> 401   (:109)
 * The last two are enforced by the authentication middleware here (T-011) and are re-asserted
 * through a permission-guarded route, because it is the composed pipeline — not either middleware
 * alone — that has to reproduce them.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import {
  createAccessTokenVerifier,
  createPgAppUserLookup,
  getRequiredPermission,
  requirePermission,
} from '../../lib/auth/index.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import type { Database } from '../../lib/db/index.js';
import { poolerPoolConfig } from '../../lib/db/index.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../lib/errors/problem.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures, randomTenantId } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('requirePermission: route guard', probe);

const PROBE_ROUTE = '/api/v1/__permission-probe';
const TENANT_PROBE_ROUTE = '/api/v1/__tenant-permission-probe';
const DOUBLE_GUARD_ROUTE = '/api/v1/__double-guard-probe';

const REQUIRED = 'leads.view_all';
const SECOND_REQUIRED = 'leads.view';

interface ProblemBody {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly correlationId?: string;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;
  let queries: string[];

  let granted: TestUserSession;
  let ungranted: TestUserSession;
  let inactive: TestUserSession;
  let orphan: TestUserSession;
  let tenantScoped: TestUserSession;

  let tenantA: number;
  let tenantB: number;

  interface Harness {
    readonly app: ApiApp;
    logText(): string;
  }

  /**
   * Builds the app the way production composes it. `withRbac: false` exercises the
   * misconfiguration case — a guarded route with no resolver mounted.
   */
  function harness(options: { withRbac?: boolean } = {}): Harness {
    const lines: string[] = [];
    const app = buildApp({
      config,
      loggerOptions: { sink: (line) => lines.push(line) },
      auth: {
        verifyAccessToken: createAccessTokenVerifier({ config }),
        lookupAppUser: (authUserId) => pgLookup.lookup(authUserId),
      },
      ...(options.withRbac === false
        ? {}
        : { rbac: { loadGrantGraph: createGrantGraphLoader(db) } }),
      registerRoutes: (api) => {
        // Stand-in for the T-013 tenant middleware: the guard reads `tenantId` off the context,
        // and this suite has to be able to set it. Test-owned on purpose — T-013 will replace it
        // with real X-Tenant-Id resolution and membership checks.
        api.use('*', async (c, next) => {
          const header = c.req.header('x-tenant-id');
          if (header !== undefined) c.set('tenantId', header);
          await next();
        });

        api.get('/__permission-probe', requirePermission(REQUIRED), (c) =>
          c.json({ ok: true, secret: 'lead-payload' }),
        );
        api.get('/__tenant-permission-probe', requirePermission(REQUIRED), (c) =>
          c.json({ ok: true }),
        );
        api.get(
          '/__double-guard-probe',
          requirePermission(REQUIRED),
          requirePermission(SECOND_REQUIRED),
          (c) => c.json({ ok: true }),
        );
      },
    });

    return { app, logText: () => lines.join('') };
  }

  /**
   * `TestUserSession.appUserId` is nullable (the orphan fixture has no `users` row). Unwrapping it
   * explicitly keeps `Number(null) === 0` from turning a fixture mistake into a confusing foreign-key
   * error against user id 0.
   */
  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) {
      throw new Error(`fixture user ${session.email} has no application users row`);
    }
    return Number(session.appUserId);
  }

  async function get(
    app: ApiApp,
    path: string,
    options: { token?: string; tenantId?: number } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    return await app.request(`http://localhost${path}`, { headers });
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    // Explicit env source — never process.env — matching auth-middleware.test.ts and the
    // config module's contract (env is read only through lib/config).
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

    auth = new TestAuthFixtures(stack);
    fixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));

    queries = [];
    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') queries.push(event.query.sql);
      },
    });
    pgLookup = createPgAppUserLookup(config);

    tenantA = randomTenantId();
    tenantB = randomTenantId();

    granted = await auth.createTestUserWithSession({ label: 'perm-granted' });
    ungranted = await auth.createTestUserWithSession({ label: 'perm-ungranted' });
    inactive = await auth.createTestUserWithSession({ label: 'perm-inactive' });
    orphan = await auth.createTestUserWithSession({ label: 'perm-orphan', withAppUser: false });
    tenantScoped = await auth.createTestUserWithSession({ label: 'perm-tenant' });

    // Global grant (tenant_id null), matching the reference's SeedAppUserAsync, so it applies in
    // the global scope the un-tenanted probe route resolves in.
    await fixtures.grantDirectPermission(appUserId(granted), REQUIRED, null);
    await fixtures.grantDirectPermission(appUserId(granted), SECOND_REQUIRED, null);
    await fixtures.grantDirectPermission(appUserId(inactive), REQUIRED, null);

    // `ungranted` deliberately holds a DIFFERENT permission: it proves the guard checks the
    // required code specifically, rather than merely "has any permission at all".
    await fixtures.grantDirectPermission(appUserId(ungranted), 'reports.view', null);

    // Tenant-scoped grant, for the cross-tenant case.
    await fixtures.grantDirectPermission(appUserId(tenantScoped), REQUIRED, tenantA);

    await auth.setAppUserActive(inactive.authUserId, false);
  });

  afterAll(async () => {
    await fixtures?.cleanup();
    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  });

  it('allows a request whose caller holds the required permission', async () => {
    const response = await get(harness().app, PROBE_ROUTE, { token: granted.accessToken });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, secret: 'lead-payload' });
  });

  it('answers 403 problem+json when the caller lacks the required permission', async () => {
    const response = await get(harness().app, PROBE_ROUTE, { token: ungranted.accessToken });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);

    const body = (await response.json()) as ProblemBody;
    // Verbatim from RequirePermissionFilter.ForbiddenProblem (:65-69).
    expect(body.detail).toBe(`Missing required permission '${REQUIRED}'.`);
    expect(body.title).toBe('Forbidden');
    expect(body.status).toBe(403);
    expect(body.type).toBe('https://tools.ietf.org/html/rfc9110#section-15.5.4');
    expect(body.correlationId).toBeTruthy();
  });

  it('leaks no resource data in the 403 body', async () => {
    const response = await get(harness().app, PROBE_ROUTE, { token: ungranted.accessToken });

    const raw = await response.text();
    expect(raw).not.toContain('lead-payload');
    expect(raw).not.toContain('secret');
    // Nor the caller's other permissions — the body must not double as a permission oracle.
    expect(raw).not.toContain('reports.view');
    expect(raw).not.toContain(ungranted.email);
  });

  it('answers 401 to an anonymous caller, not 403', async () => {
    const response = await get(harness().app, PROBE_ROUTE);

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('answers 401 when the principal has no application user row', async () => {
    const response = await get(harness().app, PROBE_ROUTE, { token: orphan.accessToken });

    expect(response.status).toBe(401);
  });

  it('answers 401 for a deactivated user even though the grant exists', async () => {
    // Parity with RequirePermissionTests.cs:109 — inactive is 401, NOT 403, and the seeded grant
    // makes that distinguishable from a plain permission failure.
    const response = await get(harness().app, PROBE_ROUTE, { token: inactive.accessToken });

    expect(response.status).toBe(401);
  });

  it('applies a tenant-scoped grant in its own tenant and refuses it in another', async () => {
    const app = harness().app;

    const inTenantA = await get(app, TENANT_PROBE_ROUTE, {
      token: tenantScoped.accessToken,
      tenantId: tenantA,
    });
    const inTenantB = await get(app, TENANT_PROBE_ROUTE, {
      token: tenantScoped.accessToken,
      tenantId: tenantB,
    });

    // Positive control first: the grant genuinely works somewhere, so the 403 below is about the
    // tenant and not about a grant that never applied at all.
    expect(inTenantA.status).toBe(200);
    expect(inTenantB.status).toBe(403);
  });

  it('does not apply a tenant-scoped grant in the global scope', async () => {
    const response = await get(harness().app, TENANT_PROBE_ROUTE, {
      token: tenantScoped.accessToken,
    });

    expect(response.status).toBe(403);
  });

  it('resolves the grant graph once per request even with several guards on one route', async () => {
    const app = harness().app;
    queries.length = 0;

    const response = await get(app, DOUBLE_GUARD_ROUTE, { token: granted.accessToken });

    expect(response.status).toBe(200);
    expect(queries).toHaveLength(1);
  });

  it('re-resolves permissions on every request (no cross-request cache, N-02)', async () => {
    // The security property: a warm serverless instance must not reuse a previous request's
    // permission set. Two requests => two resolutions, and a grant revoked between them takes
    // effect immediately.
    const app = harness().app;
    const revocable = await auth.createTestUserWithSession({ label: 'perm-revoke' });
    const local = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      await local.grantDirectPermission(appUserId(revocable), REQUIRED, null);

      queries.length = 0;
      const before = await get(app, PROBE_ROUTE, { token: revocable.accessToken });
      expect(before.status).toBe(200);
      expect(queries).toHaveLength(1);

      await auth.query('delete from user_permissions where user_id = $1', [
        appUserId(revocable),
      ]);

      const after = await get(app, PROBE_ROUTE, { token: revocable.accessToken });
      expect(after.status).toBe(403);
      // A second database resolution happened — the first request's set was not reused.
      expect(queries).toHaveLength(2);
    } finally {
      await local.cleanup();
    }
  });

  it('fails closed with 500 when the resolver middleware is not mounted', async () => {
    // The dangerous alternative is treating "cannot evaluate permissions" as "allowed".
    const response = await get(harness({ withRbac: false }).app, PROBE_ROUTE, {
      token: granted.accessToken,
    });

    expect(response.status).toBe(500);
    expect(response.status).not.toBe(200);
  });

  it('never logs the caller permission set', async () => {
    const instance = harness();

    await get(instance.app, PROBE_ROUTE, { token: ungranted.accessToken });

    const log = instance.logText();
    // The required permission IS logged (it is the reason for the denial and carries no secret).
    expect(log).toContain(REQUIRED);
    // The caller's own granted permissions are not — that is their authorization profile.
    expect(log).not.toContain('reports.view');
    expect(log).not.toContain(ungranted.accessToken);
  });

  it('exposes the required permission as route metadata for the AC-019 sweep', async () => {
    // V-024 drives an exhaustive route sweep from this metadata rather than a hand-kept list.
    const guard = requirePermission('quotes.view');

    expect(getRequiredPermission(guard)).toBe('quotes.view');
    expect(getRequiredPermission(() => undefined)).toBeUndefined();
    expect(getRequiredPermission('not a handler')).toBeUndefined();
  });

  it('finds the declared permission on the registered route handlers', async () => {
    const app = harness().app;

    const probeRoute = app.routes.find(
      (route) => route.path === `${'/api/v1'}/__permission-probe` && route.method === 'GET',
    );

    expect(probeRoute).toBeDefined();
    // The sweep in T-043 walks app.routes exactly like this.
    const declared = app.routes
      .filter((route) => route.path.endsWith('__permission-probe'))
      .map((route) => getRequiredPermission(route.handler))
      .filter((permission) => permission !== undefined);

    expect(declared).toContain(REQUIRED);
  });
});
