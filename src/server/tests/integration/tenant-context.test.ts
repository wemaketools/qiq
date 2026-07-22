/**
 * Tenant-context middleware, end to end (T-013, AC-020, AC-021, V-025, V-026; M-05, N-01, spec §13).
 *
 * This is the tenant-isolation boundary of the product, so nothing here is stubbed: real signed-in
 * sessions (T-011's `createTestUserWithSession`), real `tenants` / `user_tenants` rows, the real
 * grant graph, the real Hono pipeline through `app.fetch`, and a real `audit_log` read-back.
 *
 * Port of `src/api/QuoteIQ.Api/Tenancy/TenantContextMiddleware.cs` and
 * `src/api/QuoteIQ.Infrastructure/Tenancy/TenantAccessValidator.cs`. MEASURED reference semantics:
 *   missing OR unparseable X-Tenant-Id  -> 403  (TenantContextMiddleware.cs:50-55 + :120-132)
 *   tenant does not exist               -> 403  (TenantAccessValidator.cs:30-33)
 *   tenant soft-deleted                 -> 403  (:35-38)
 *   member                              -> Ok   (:46-53)
 *   global.view_any_tenant, not member  -> Ok, cross-tenant (:55-59)
 *   otherwise                           -> 403  (:61)
 *
 * The one deliberate deviation — a single denial message instead of the reference's three
 * reason-specific ones — is asserted below as an anti-oracle property, and explained in
 * lib/tenancy/middleware.ts.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { CROSS_TENANT_ACCESS_ACTION } from '../../domains/audit/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { forTenant, poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../lib/errors/problem.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import {
  TENANT_ACCESS_DENIED_MESSAGE,
  createTenantAccessValidator,
} from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('tenantContext: X-Tenant-Id verification', probe);

const SCOPED_ROUTE = '/api/v1/__tenant-probe';
const GLOBAL_ROUTE = '/api/v1/me/__profile-probe';
const UNKNOWN_ROUTE = '/api/v1/__no-such-route';

interface ProblemBody {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly correlationId?: string;
}

/**
 * Body with the per-request correlation id removed, so two denials can be compared exactly.
 * Every OTHER key is preserved: dropping unknown fields here would hide precisely the kind of
 * reason-specific extension that would reintroduce an existence oracle.
 */
function stableBody(body: ProblemBody): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...body };
  delete rest['correlationId'];
  return rest;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;
  /** Every SQL statement + parameters, so the tenant reaching the data layer can be inspected. */
  let queries: { sql: string; parameters: readonly unknown[] }[];

  let memberA: TestUserSession;
  let internal_: TestUserSession;
  let plainUser: TestUserSession;

  let tenantA: number;
  let tenantB: number;
  let removedTenant: number;
  /** An id no tenant row has ever had. */
  let missingTenant: number;

  const createdTenants: number[] = [];

  async function createTenant(name: string, status: 'active' | 'removed'): Promise<number> {
    const rows = await auth.query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, $2, now(), now()) returning id::text as id`,
      [`t013-${name}-${crypto.randomUUID()}`, status],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`could not create tenant ${name}`);
    const id = Number(row.id);
    createdTenants.push(id);
    return id;
  }

  async function addMembership(userId: number, tenantId: number): Promise<void> {
    await auth.query(
      `insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())`,
      [tenantId, userId],
    );
  }

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) {
      throw new Error(`fixture user ${session.email} has no application users row`);
    }
    return Number(session.appUserId);
  }

  interface Harness {
    readonly app: ApiApp;
    logText(): string;
    /** Tenant ids the probe handler actually queried with, in order. */
    readonly seenTenantIds: (number | undefined)[];
  }

  function harness(options: { withTenancy?: boolean } = {}): Harness {
    const lines: string[] = [];
    const seenTenantIds: (number | undefined)[] = [];

    const app = buildApp({
      config,
      loggerOptions: { sink: (line) => lines.push(line) },
      auth: {
        verifyAccessToken: createAccessTokenVerifier({ config }),
        lookupAppUser: (authUserId) => pgLookup.lookup(authUserId),
      },
      ...(options.withTenancy === false
        ? {}
        : {
            tenancy: {
              db,
              validateTenantAccess: createTenantAccessValidator({
                db,
                loadGrantGraph: createGrantGraphLoader(db),
              }),
            },
          }),
      rbac: { loadGrantGraph: createGrantGraphLoader(db) },
      registerRoutes: (api) => {
        api.get('/__tenant-probe', async (c) => {
          const tenant = c.get('tenant');
          seenTenantIds.push(tenant?.tenantId);
          if (tenant === undefined) return c.json({ ok: true, tenantId: null });

          // A REAL tenant-scoped query, so the value that reaches SQL can be inspected below.
          await forTenant(db, tenant.tenantId).selectFrom('brokers').select('id').execute();

          return c.json({
            ok: true,
            tenantId: String(tenant.tenantId),
            isCrossTenant: tenant.isCrossTenant,
            secret: 'tenant-scoped-payload',
          });
        });

        api.get('/me/__profile-probe', (c) =>
          c.json({ ok: true, tenantId: c.get('tenantId') ?? null }),
        );
      },
    });

    return { app, logText: () => lines.join(''), seenTenantIds };
  }

  async function get(
    app: ApiApp,
    path: string,
    options: { token?: string; tenantId?: string | number } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    return await app.request(`http://localhost${path}`, { headers });
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    config = loadConfig({
      APP_ENV: 'local',
      LOG_LEVEL: 'info',
      DATABASE_URL: stack.dbUrl,
      DIRECT_DATABASE_URL: stack.dbUrl,
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
        if (event.level === 'query') {
          queries.push({ sql: event.query.sql, parameters: event.query.parameters });
        }
      },
    });
    pgLookup = createPgAppUserLookup(config);

    tenantA = await createTenant('a', 'active');
    tenantB = await createTenant('b', 'active');
    removedTenant = await createTenant('removed', 'removed');
    missingTenant = 2_100_000_000 + Math.floor(Math.random() * 10_000_000);

    memberA = await auth.createTestUserWithSession({ label: 'tenant-member-a' });
    internal_ = await auth.createTestUserWithSession({ label: 'tenant-internal' });
    plainUser = await auth.createTestUserWithSession({ label: 'tenant-plain' });

    await addMembership(appUserId(memberA), tenantA);
    await addMembership(appUserId(memberA), removedTenant);

    // The Internal user is a member of NOTHING; its access comes only from the global grant.
    await fixtures.grantDirectPermission(appUserId(internal_), 'global.view_any_tenant', null);

    // Deliberately holds a different global permission: proves the cross-tenant path checks the
    // specific code rather than "has any global grant".
    await fixtures.grantDirectPermission(appUserId(plainUser), 'global.manage_templates', null);
  });

  afterAll(async () => {
    if (!probe.available) return;
    await auth?.query('delete from audit_log where action = $1', [CROSS_TENANT_ACCESS_ACTION]);
    for (const tenantId of createdTenants) {
      await auth?.query('delete from user_tenants where tenant_id = $1', [tenantId]);
      await auth?.query('delete from tenants where id = $1', [tenantId]);
    }
    await fixtures?.cleanup();
    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  });

  // ---------------------------------------------------------------- positive controls

  it('admits a member supplying their own tenant', async () => {
    // POSITIVE CONTROL. Without this, every denial assertion below could be satisfied by a
    // middleware that simply rejects everything.
    const response = await get(harness().app, SCOPED_ROUTE, {
      token: memberA.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      tenantId: String(tenantA),
      isCrossTenant: false,
    });
  });

  it('serves a global route with no X-Tenant-Id at all', async () => {
    // Second positive control: the middleware must not demand a tenant everywhere.
    const response = await get(harness().app, GLOBAL_ROUTE, { token: plainUser.accessToken });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tenantId: null });
  });

  // ---------------------------------------------------------------- fail closed

  it('refuses a tenant-scoped route with no X-Tenant-Id', async () => {
    const response = await get(harness().app, SCOPED_ROUTE, { token: memberA.accessToken });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    expect((await response.json() as ProblemBody).detail).toBe(TENANT_ACCESS_DENIED_MESSAGE);
  });

  it('never runs the handler when the tenant is not verified', async () => {
    // Status codes can be produced anywhere; this proves the request never reached the route.
    const instance = harness();

    await get(instance.app, SCOPED_ROUTE, { token: memberA.accessToken });
    await get(instance.app, SCOPED_ROUTE, { token: memberA.accessToken, tenantId: tenantB });

    expect(instance.seenTenantIds).toEqual([]);
  });

  it('refuses a tenant the caller is not a member of', async () => {
    const response = await get(harness().app, SCOPED_ROUTE, {
      token: memberA.accessToken,
      tenantId: tenantB,
    });

    expect(response.status).toBe(403);
    const raw = await response.text();
    expect(raw).not.toContain('tenant-scoped-payload');
  });

  it('refuses a soft-deleted tenant even to a member of it', async () => {
    // memberA IS a member of removedTenant; membership does not resurrect a removed tenant.
    const response = await get(harness().app, SCOPED_ROUTE, {
      token: memberA.accessToken,
      tenantId: removedTenant,
    });

    expect(response.status).toBe(403);
  });

  it.each([
    ['non-numeric', 'abc'],
    ['empty', ''],
    ['whitespace', '   '],
    ['fractional', '1.5'],
    ['negative', '-1'],
    ['zero', '0'],
    ['exponent', '1e3'],
    ['hex', '0x10'],
    ['trailing garbage', '12abc'],
    ['beyond safe integer', '9007199254740993'],
    ['sql-ish', "1 or 1=1"],
  ])('refuses a malformed X-Tenant-Id (%s) with 403, not 400', async (_label, value) => {
    // MEASURED: TenantContextMiddleware.cs:50-55 folds "missing" and "unparseable" into the same
    // 403 branch. A 400 here would also be a side channel distinguishing header syntax from
    // authorization.
    const response = await get(harness().app, SCOPED_ROUTE, {
      token: memberA.accessToken,
      tenantId: value,
    });

    expect(response.status).toBe(403);
    expect(response.status).not.toBe(400);
  });

  it('fails closed when the tenant middleware is not mounted', async () => {
    // The dangerous alternative is a route running with no verified tenant at all.
    const instance = harness({ withTenancy: false });

    const response = await get(instance.app, SCOPED_ROUTE, {
      token: memberA.accessToken,
      tenantId: tenantA,
    });

    // The handler may run, but it gets NO tenant — so it cannot query tenant-scoped data.
    expect(instance.seenTenantIds).toEqual([undefined]);
    expect(await response.json()).toEqual({ ok: true, tenantId: null });
  });

  it('answers 404, not 403, for an unknown route', async () => {
    // Otherwise the tenant guard becomes a route-table oracle for anyone with a token.
    const response = await get(harness().app, UNKNOWN_ROUTE, { token: memberA.accessToken });

    expect(response.status).toBe(404);
  });

  // ---------------------------------------------------------------- no leakage (N-01)

  it('answers every denial reason with a byte-identical body', async () => {
    // THE ANTI-ORACLE PROPERTY. Nonexistent, soft-deleted, and simply-not-yours must be
    // indistinguishable, or any caller can enumerate which tenants exist without belonging to one.
    const app = harness().app;

    const scenarios = {
      missing: await get(app, SCOPED_ROUTE, { token: plainUser.accessToken }),
      malformed: await get(app, SCOPED_ROUTE, { token: plainUser.accessToken, tenantId: 'abc' }),
      nonexistent: await get(app, SCOPED_ROUTE, {
        token: plainUser.accessToken,
        tenantId: missingTenant,
      }),
      removed: await get(app, SCOPED_ROUTE, {
        token: plainUser.accessToken,
        tenantId: removedTenant,
      }),
      notMember: await get(app, SCOPED_ROUTE, {
        token: plainUser.accessToken,
        tenantId: tenantA,
      }),
    };

    const bodies = await Promise.all(
      Object.values(scenarios).map(async (response) =>
        stableBody((await response.json()) as ProblemBody),
      ),
    );

    for (const response of Object.values(scenarios)) {
      expect(response.status).toBe(403);
    }
    // THE PROOF: every body deep-equals the first, so no field distinguishes the five reasons.
    for (const body of bodies) {
      expect(body).toEqual(bodies[0]);
    }

    // The shared body is the constant denial, and carries no reason-bearing extension field.
    //
    // Note on what this deliberately does NOT do: an earlier version substring-searched the body
    // for each tenant id. That is brittle in both directions — a low id like `1` matches the
    // digits inside `rfc9110` (a false red, which is how this was found after a `supabase db
    // reset` restarted the identity sequence), and a substring match would also pass vacuously for
    // ids that never appear. Pinning the exact key set and the exact detail is strictly stronger:
    // any id, reason code, or tenant name added to the body fails one of these.
    // `correlationId` is already stripped by stableBody (it legitimately differs per request).
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(['detail', 'status', 'title', 'type']);
    expect(bodies[0]?.['detail']).toBe(TENANT_ACCESS_DENIED_MESSAGE);
    expect(TENANT_ACCESS_DENIED_MESSAGE).not.toMatch(/exist|removed|deleted|member of/i);
  });

  it('does not log business data or the caller token', async () => {
    const instance = harness();

    await get(instance.app, SCOPED_ROUTE, { token: memberA.accessToken, tenantId: tenantB });

    const log = instance.logText();
    expect(log).toContain('not_member'); // diagnostic reason IS logged, server-side
    expect(log).not.toContain(memberA.accessToken);
    expect(log).not.toContain('tenant-scoped-payload');
  });

  // ---------------------------------------------------------------- the verified id is what flows

  it('passes the VERIFIED tenant id to the data layer, not the header string', async () => {
    const instance = harness();
    // Leading zeros: the header text and the verified id differ as strings, so a middleware that
    // forwarded the raw header would be caught here.
    const paddedHeader = `000${tenantA}`;
    queries.length = 0;

    const response = await get(instance.app, SCOPED_ROUTE, {
      token: memberA.accessToken,
      tenantId: paddedHeader,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenantId: String(tenantA) });
    expect(instance.seenTenantIds).toEqual([tenantA]);

    const brokerQuery = queries.find((entry) => entry.sql.includes('"brokers"'));
    expect(brokerQuery, 'the probe handler must have issued a tenant-scoped query').toBeDefined();
    // The parameter is the verified NUMBER, never the header text.
    expect(brokerQuery?.parameters).toContain(tenantA);
    expect(brokerQuery?.parameters).not.toContain(paddedHeader);
    expect(brokerQuery?.sql).toContain('"tenant_id" =');
  });

  // ---------------------------------------------------------------- Internal cross-tenant

  it('admits an Internal cross-tenant grant holder into a tenant they do not belong to', async () => {
    const response = await get(harness().app, SCOPED_ROUTE, {
      token: internal_.accessToken,
      tenantId: tenantB,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tenantId: String(tenantB),
      isCrossTenant: true,
    });
  });

  it('audits the cross-tenant access with both before and after keys', async () => {
    const targetTenant = await createTenant('audit-target', 'active');

    const response = await get(harness().app, SCOPED_ROUTE, {
      token: internal_.accessToken,
      tenantId: targetTenant,
    });
    expect(response.status).toBe(200);

    const row = await assertAudited((sql, params) => auth.query(sql, params ?? []), {
      action: CROSS_TENANT_ACCESS_ACTION,
      entityType: 'tenant',
      entityId: String(targetTenant),
      actorUserId: appUserId(internal_),
      tenantId: targetTenant,
      before: null,
    });

    const details = row.details as Record<string, unknown>;
    expect(details['after']).toMatchObject({ accessedTenantId: targetTenant });
    expect(details['correlationId']).toBeTruthy();
  });

  it('does not audit ordinary member access', async () => {
    // Auditing every request would drown the trail; only the exceptional path is evidence.
    const memberTenant = await createTenant('member-only', 'active');
    await addMembership(appUserId(memberA), memberTenant);

    const response = await get(harness().app, SCOPED_ROUTE, {
      token: memberA.accessToken,
      tenantId: memberTenant,
    });
    expect(response.status).toBe(200);

    const rows = await findAuditRows((sql, params) => auth.query(sql, params ?? []), {
      action: CROSS_TENANT_ACCESS_ACTION,
      entityId: String(memberTenant),
    });
    expect(rows).toEqual([]);
  });

  it('keeps a member entry non-cross-tenant even when the member also holds the global grant', async () => {
    // ENTRY MODE vs CAPABILITY (context.ts, rbac/admin-routes-support.ts): this flag drives the
    // cross-tenant audit row and the cross-tenant export gate, and a member working inside their
    // own tenant is doing neither — whatever else they hold. The capability side — an Internal
    // admin who is ALSO a member keeps their cross-tenant assignment ceiling — is pinned in
    // users.test.ts.
    const memberGrantTenant = await createTenant('member-grant', 'active');
    const memberWithGrant = await auth.createTestUserWithSession({ label: 'tenant-member-grant' });
    const local = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      await addMembership(appUserId(memberWithGrant), memberGrantTenant);
      await local.grantDirectPermission(
        appUserId(memberWithGrant),
        'global.view_any_tenant',
        null,
      );

      const response = await get(harness().app, SCOPED_ROUTE, {
        token: memberWithGrant.accessToken,
        tenantId: memberGrantTenant,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        tenantId: String(memberGrantTenant),
        isCrossTenant: false,
      });

      const rows = await findAuditRows((sql, params) => auth.query(sql, params ?? []), {
        action: CROSS_TENANT_ACCESS_ACTION,
        entityId: String(memberGrantTenant),
      });
      expect(rows).toEqual([]);
    } finally {
      await local.cleanup();
    }
  });

  it('does not let a global grant other than view_any_tenant cross tenants', async () => {
    // plainUser holds global.manage_templates — a real global grant, just not this one.
    const response = await get(harness().app, SCOPED_ROUTE, {
      token: plainUser.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(403);
  });

  it('does not honour a tenant-scoped view_any_tenant grant in another tenant', async () => {
    // The grant must be GLOBAL (tenant_id null) to cross tenants — TenantAccessValidator.cs:55
    // resolves in the global scope precisely so a tenant-A grant cannot open tenant B.
    const scoped = await auth.createTestUserWithSession({ label: 'tenant-scoped-grant' });
    const local = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      await local.grantDirectPermission(appUserId(scoped), 'global.view_any_tenant', tenantA);

      const response = await get(harness().app, SCOPED_ROUTE, {
        token: scoped.accessToken,
        tenantId: tenantB,
      });

      expect(response.status).toBe(403);
    } finally {
      await local.cleanup();
    }
  });

  it('does not honour a view_any_tenant grant scoped to the REQUESTED tenant', async () => {
    // The sharper version of the test above, and the one that actually pins the resolution scope.
    // Granting view_any_tenant *inside* tenant B is the case that distinguishes a correct global
    // resolution (TenantAccessValidator.cs:55 passes tenantId: null) from resolving in the
    // requested tenant's scope: the latter would honour this grant and admit a non-member. The
    // previous test cannot tell the two apart, because a tenant-A grant is absent from both scopes.
    //
    // Why this matters beyond pedantry: `view_any_tenant` is the Internal escalation capability. If
    // it were honoured tenant-scoped, any tenant admin able to grant permissions within their own
    // tenant could mint themselves cross-tenant access.
    const scoped = await auth.createTestUserWithSession({ label: 'tenant-selfgrant' });
    const local = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      await local.grantDirectPermission(appUserId(scoped), 'global.view_any_tenant', tenantB);

      const response = await get(harness().app, SCOPED_ROUTE, {
        token: scoped.accessToken,
        tenantId: tenantB,
      });

      expect(response.status).toBe(403);
    } finally {
      await local.cleanup();
    }
  });

  it('re-verifies membership on every request', async () => {
    // A warm serverless instance must not remember that this user was admitted a moment ago.
    const app = harness().app;
    const revocable = await auth.createTestUserWithSession({ label: 'tenant-revoke' });
    await addMembership(appUserId(revocable), tenantA);

    const before = await get(app, SCOPED_ROUTE, {
      token: revocable.accessToken,
      tenantId: tenantA,
    });
    expect(before.status).toBe(200);

    await auth.query('delete from user_tenants where user_id = $1', [appUserId(revocable)]);

    const after = await get(app, SCOPED_ROUTE, {
      token: revocable.accessToken,
      tenantId: tenantA,
    });
    expect(after.status).toBe(403);
  });

  it('requires authentication before tenant verification', async () => {
    // An anonymous caller gets 401 from the auth middleware, never a tenant-flavoured 403 that
    // would confirm the route exists and is tenant-scoped.
    const response = await get(harness().app, SCOPED_ROUTE, { tenantId: tenantA });

    expect(response.status).toBe(401);
  });
});
