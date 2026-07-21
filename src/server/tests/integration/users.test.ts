/**
 * User Manager users surface, end to end (T-017; AC-024, AC-029, AC-030, AC-031;
 * V-031, V-038, V-040, V-041).
 *
 * Nothing here is stubbed. Real signed-in sessions (T-011's `createTestUserWithSession`), the real
 * grant graph, the real Hono pipeline through `app.fetch`, the REAL local Supabase Auth Admin API
 * (`createSupabaseAuthAdmin`), real `auth.users` rows, and a real `audit_log` read-back.
 *
 * MEASURED REFERENCE SEMANTICS PINNED BELOW
 * =========================================
 *   route permissions                       UserEndpoints.cs:30-35
 *   duplicate email -> 422                  UserEndpoints.cs:113   (NOT 409 — measured)
 *   already inactive -> 409                 UserEndpoints.cs:111
 *   assign_* gaps -> 403                    UserEndpoints.cs:108-110
 *   role/group tenant mismatch -> 422       UserEndpoints.cs:114
 *   create -> 201 + Location                UserEndpoints.cs:68
 *   deactivate -> 200 empty body            UserEndpoints.cs:93
 *   zero-tenant needs global.*              CreateUserCommandHandler.cs:72-80
 *   per-tenant assignment shape             UpdateUserCommand.cs:6-9
 *
 * WHY THE PROVISIONING-FAILURE TESTS LOOK LIKE THAT
 * =================================================
 * "Provisioning is atomic" is not observable from a passing create. Both halves are therefore
 * forced to fail against the real stack: the AUTH half by pre-creating an identity for the address
 * (GoTrue then refuses the duplicate), and the DATABASE half by installing a BEFORE INSERT trigger
 * on `users` that raises for this suite's fixture email only. Each time the assertion is that
 * NOTHING survives — no app row, and (for the DB failure) no orphaned auth identity either, because
 * an orphan would make the address permanently unusable: Auth would reject every retry as a
 * duplicate while the app has no record of the user at all. The trigger is dropped in a `finally`
 * and is scoped by email so a concurrently running suite cannot be hit by it.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import {
  createSupabaseAuthAdmin,
  USER_ACTIVATED_ACTION,
  USER_CREATED_ACTION,
  USER_DEACTIVATED_ACTION,
  USER_UPDATED_ACTION,
} from '../../domains/users/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('User Manager: /api/v1/users', probe);

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
}

interface UserBody {
  readonly id: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly tenantIds: number[];
}

interface CreateUserBody {
  readonly userId: number;
  readonly email: string;
  readonly isActive: boolean;
  readonly emailSent: boolean;
}

interface EffectiveAccessBody {
  readonly userId: number;
  readonly directRoles: { roleId: number; roleName: string; tenantId: number | null }[];
  readonly directPermissions: { permissionCode: string; tenantId: number | null }[];
  readonly groups: { groupId: number; groupName: string; tenantId: number | null }[];
  readonly tenantAssignments: { tenantId: number; tenantName: string }[];
  readonly effectivePermissionsByTenant: Record<string, string[]>;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Full user-administration rights in tenant A. */
  let admin: TestUserSession;
  /** Full user-administration rights in tenant B — the isolation counterpart. */
  let adminB: TestUserSession;
  /** `users.view` only in tenant A: the positive control that denials are not blanket. */
  let viewer: TestUserSession;
  /** `users.invite`/`users.edit` but NONE of the `users.assign_*` codes (F-028). */
  let inviterOnly: TestUserSession;
  /** Internal: global `view_any_tenant`, so it may create zero-tenant users. */
  let internal: TestUserSession;
  /** A tenant-B-only user, used as the by-id cross-tenant probe target. */
  let tenantBUser: TestUserSession;

  let tenantA: number;
  let tenantB: number;

  /** Auth identities this suite provisioned through the API, for teardown. */
  const provisionedAuthIds: string[] = [];
  const provisionedUserIds: number[] = [];
  const createdTenantIds: number[] = [];

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) throw new Error(`fixture ${session.email} has no users row`);
    return Number(session.appUserId);
  }

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  function harness(): ApiApp {
    return buildApp({
      config,
      loggerOptions: { sink: () => undefined },
      auth: {
        verifyAccessToken: createAccessTokenVerifier({ config }),
        lookupAppUser: (authUserId) => pgLookup.lookup(authUserId),
      },
      tenancy: {
        db,
        validateTenantAccess: createTenantAccessValidator({
          db,
          loadGrantGraph: createGrantGraphLoader(db),
        }),
      },
      rbac: { loadGrantGraph: createGrantGraphLoader(db) },
      me: {
        db,
        loadGrantGraph: createGrantGraphLoader(db),
        validateTenantAccess: createTenantAccessValidator({
          db,
          loadGrantGraph: createGrantGraphLoader(db),
        }),
      },
      userManager: {
        db,
        // The REAL Admin client against the local GoTrue: AC-031 is about a live identity, and a
        // stubbed port here would prove nothing about provisioning, linking, or the ban.
        authAdmin: createSupabaseAuthAdmin(auth.adminClient),
        loadGrantGraph: createGrantGraphLoader(db),
      },
    });
  }

  interface RequestOptions {
    readonly token?: string;
    readonly body?: unknown;
    readonly tenantId?: number | string;
  }

  async function call(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    return await harness().request(`http://localhost${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  /** Same prefix TestAuthFixtures uses, so its stale-identity sweep also covers ours. */
  function uniqueEmail(label: string): string {
    return `quoteiq-test-t017-${label}-${process.pid}-${crypto.randomUUID()}@quoteiq.local`;
  }

  async function createTenantRow(label: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`t017-${label}-${crypto.randomUUID()}`],
    );
    const id = Number(rows[0]?.id);
    createdTenantIds.push(id);
    return id;
  }

  async function addMembership(userId: number, tenantId: number): Promise<void> {
    await query(
      `insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())
       on conflict do nothing`,
      [tenantId, userId],
    );
  }

  /** Creates a user through the API and records both halves for teardown. */
  async function createUserViaApi(
    body: Record<string, unknown>,
    options: { token: string; tenantId: number | string },
  ): Promise<CreateUserBody> {
    const response = await call('POST', '/api/v1/users', { ...options, body });
    expect(response.status, `create failed: ${await response.clone().text()}`).toBe(201);
    const created = (await response.json()) as CreateUserBody;
    provisionedUserIds.push(created.userId);

    const rows = await query<{ auth_user_id: string }>(
      'select auth_user_id::text as auth_user_id from users where id = $1',
      [created.userId],
    );
    const authId = rows[0]?.auth_user_id;
    if (authId !== undefined) provisionedAuthIds.push(authId);
    return created;
  }

  /**
   * Signs in as a provisioned user. The initial password is random and deliberately never returned
   * by the API (auth-admin.ts), so the suite sets a known one through the Admin API first — which
   * is exactly what an administrator-driven password reset does, and still exercises the real
   * GoTrue sign-in path the SPA uses.
   */
  async function signInAs(
    authUserId: string,
    email: string,
  ): Promise<{ ok: boolean; accessToken: string | null }> {
    const password = `Test-${crypto.randomUUID()}!aA1`;
    await auth.adminClient.auth.admin.updateUserById(authUserId, { password });
    const { data, error } = await auth.anonClient.auth.signInWithPassword({ email, password });
    return {
      ok: error === null && data.session !== null,
      accessToken: data.session?.access_token ?? null,
    };
  }

  async function countRows(sql: string, params: unknown[] = []): Promise<number> {
    const rows = await query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
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

    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    pgLookup = createPgAppUserLookup(config);

    tenantA = await createTenantRow('tenant-a');
    tenantB = await createTenantRow('tenant-b');

    admin = await auth.createTestUserWithSession({ label: 'um-admin' });
    adminB = await auth.createTestUserWithSession({ label: 'um-admin-b' });
    viewer = await auth.createTestUserWithSession({ label: 'um-viewer' });
    inviterOnly = await auth.createTestUserWithSession({ label: 'um-inviter' });
    internal = await auth.createTestUserWithSession({ label: 'um-internal' });
    tenantBUser = await auth.createTestUserWithSession({ label: 'um-tenantb-user' });

    await addMembership(appUserId(admin), tenantA);
    await addMembership(appUserId(adminB), tenantB);
    await addMembership(appUserId(viewer), tenantA);
    await addMembership(appUserId(inviterOnly), tenantA);
    await addMembership(appUserId(tenantBUser), tenantB);

    const fullAdminCodes = [
      'users.view',
      'users.invite',
      'users.edit',
      'users.deactivate',
      'users.assign_tenant',
      'users.assign_role',
      'users.assign_group',
      'users.grant_direct_permission',
      'roles.view',
      'roles.manage',
      'groups.view',
      'groups.manage',
      'reports.view',
    ] as const;

    // Tenant-SCOPED grants on both sides: the isolation cases below are only meaningful if neither
    // admin holds anything globally.
    for (const code of fullAdminCodes) {
      await fixtures.grantDirectPermission(appUserId(admin), code, tenantA);
      await fixtures.grantDirectPermission(appUserId(adminB), code, tenantB);
    }

    await fixtures.grantDirectPermission(appUserId(viewer), 'users.view', tenantA);

    // Deliberately WITHOUT any users.assign_* code — that is the whole point of this persona.
    await fixtures.grantDirectPermission(appUserId(inviterOnly), 'users.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(inviterOnly), 'users.invite', tenantA);
    await fixtures.grantDirectPermission(appUserId(inviterOnly), 'users.edit', tenantA);

    // Internal: global grants, so it reaches every tenant and may create zero-tenant users.
    for (const code of ['global.view_any_tenant', 'users.view', 'users.invite'] as const) {
      await fixtures.grantDirectPermission(appUserId(internal), code, null);
    }
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    for (const userId of provisionedUserIds) {
      for (const table of [
        'user_permissions',
        'user_roles',
        'group_members',
        'user_tenants',
      ] as const) {
        await query(`delete from ${table} where user_id = $1`, [userId]).catch(() => undefined);
      }
      await query('delete from audit_log where entity_type = $1 and entity_id = $2', [
        'user',
        String(userId),
      ]).catch(() => undefined);
      await query('delete from users where id = $1', [userId]).catch(() => undefined);
    }
    for (const authId of provisionedAuthIds) {
      await auth?.adminClient.auth.admin.deleteUser(authId).catch(() => undefined);
    }

    await fixtures?.cleanup();

    for (const tenantId of createdTenantIds) {
      await query('delete from audit_log where tenant_id = $1', [tenantId]).catch(() => undefined);
      await query('delete from user_tenants where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 180_000);

  // ------------------------------------------------------------------- route surface (AC-029)

  it('registers no DELETE route for a user — deactivate-not-delete is structural', () => {
    const routes = harness()
      .routes.filter((route) => route.path.startsWith('/api/v1/users'))
      .map((route) => `${route.method} ${route.path}`);

    expect(routes.some((route) => route.startsWith('DELETE'))).toBe(false);
    // Positive control: the sweep is looking at a populated route table, not an empty one.
    expect(routes.some((route) => route.includes('/api/v1/users/:id/deactivate'))).toBe(true);
  });

  // ------------------------------------------------------------------ permission matrix (V-040)

  it('answers 403 on every users route for a caller holding only an unrelated permission', async () => {
    const cases = [
      ['GET', '/api/v1/users', 'users.view'],
      ['GET', '/api/v1/users/1', 'users.view'],
      ['GET', '/api/v1/users/1/effective-access', 'users.view'],
      ['POST', '/api/v1/users', 'users.invite'],
      ['PUT', '/api/v1/users/1', 'users.edit'],
      ['POST', '/api/v1/users/1/deactivate', 'users.deactivate'],
      ['POST', '/api/v1/users/1/activate', 'users.deactivate'],
    ] as const;

    // `viewer` holds ONLY users.view in tenant A, so the four mutating routes must all deny it and
    // the three read routes must not — proving the guard checks the specific code per route.
    for (const [method, path, required] of cases) {
      const response = await call(method, path, {
        token: viewer.accessToken,
        tenantId: tenantA,
        ...(method === 'POST' || method === 'PUT' ? { body: {} } : {}),
      });

      if (required === 'users.view') {
        expect([200, 404], `${method} ${path} should not be a permission denial`).toContain(
          response.status,
        );
        continue;
      }

      expect(response.status, `${method} ${path} must require ${required}`).toBe(403);
      const body = (await response.json()) as ProblemBody;
      expect(body.detail).toBe(`Missing required permission '${required}'.`);
    }
  });

  it('denies a tenant-A grant in tenant B — the route guard resolves in the verified tenant', async () => {
    // `admin` holds every users.* code, but scoped to tenant A. Entering tenant B is refused by
    // the tenant middleware (no membership, no global grant), which is the first line; the second
    // line — that the grant itself does not travel — is proved by adminB being able to do the same
    // call in tenant B while admin cannot.
    const denied = await call('GET', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantB,
    });
    expect(denied.status).toBe(403);

    const allowed = await call('GET', '/api/v1/users', {
      token: adminB.accessToken,
      tenantId: tenantB,
    });
    expect(allowed.status).toBe(200);
  });

  // ------------------------------------------------------------------ creation (AC-029/AC-031)

  it('requires first name, last name and email with 422 each (AC-029)', async () => {
    const base = { firstName: 'Ada', lastName: 'Lovelace', email: uniqueEmail('valid') };

    for (const missing of ['firstName', 'lastName', 'email'] as const) {
      const body: Record<string, unknown> = { ...base, tenantIds: [tenantA] };
      delete body[missing];

      const response = await call('POST', '/api/v1/users', {
        token: admin.accessToken,
        tenantId: tenantA,
        body,
      });

      expect(response.status, `missing ${missing} must be 422`).toBe(422);
      const problem = (await response.json()) as ProblemBody;
      expect(problem.code).toBe('USER_VALIDATION_FAILED');
    }

    // Whitespace-only is rejected too — FluentValidation's NotEmpty(), which z.string().min(1)
    // would have accepted.
    const blank = await call('POST', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { ...base, firstName: '   ', tenantIds: [tenantA] },
    });
    expect(blank.status).toBe(422);
  });

  it('provisions a Supabase Auth identity, links auth_user_id, and the new user can sign in (AC-031, V-041)', async () => {
    const email = uniqueEmail('provision');
    const created = await createUserViaApi(
      { firstName: 'Grace', lastName: 'Hopper', email, tenantIds: [tenantA] },
      { token: admin.accessToken, tenantId: tenantA },
    );

    expect(created).toEqual({
      userId: expect.any(Number),
      email,
      isActive: true,
      emailSent: expect.any(Boolean),
    });

    // The link is a real FK onto auth.users(id) — this join proves the identity exists, not merely
    // that a uuid-shaped string was stored.
    const linked = await query<{ auth_user_id: string; email: string }>(
      `select u.auth_user_id::text as auth_user_id, a.email::text as email
         from users u join auth.users a on a.id = u.auth_user_id
        where u.id = $1`,
      [created.userId],
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]?.email?.toLowerCase()).toBe(email.toLowerCase());

    // The identity signs in against the real local Auth service, and its token calls the API AS
    // that app user.
    const authUserId = linked[0]?.auth_user_id as string;
    const session = await signInAs(authUserId, email);
    expect(session.ok).toBe(true);

    const me = await call('GET', '/api/v1/me', { token: session.accessToken as string });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { userId: number; email: string };
    expect(meBody.userId).toBe(created.userId);
  });

  it('returns 201 with a Location header and the reference CreateUserResult shape', async () => {
    const email = uniqueEmail('location');
    const response = await call('POST', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { firstName: 'Alan', lastName: 'Turing', email, tenantIds: [tenantA] },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateUserBody;
    provisionedUserIds.push(body.userId);
    const rows = await query<{ auth_user_id: string }>(
      'select auth_user_id::text as auth_user_id from users where id = $1',
      [body.userId],
    );
    if (rows[0] !== undefined) provisionedAuthIds.push(rows[0].auth_user_id);

    expect(response.headers.get('Location')).toBe(`/api/v1/users/${body.userId}`);
    expect(Object.keys(body).sort()).toEqual(['email', 'emailSent', 'isActive', 'userId']);
  });

  it('rejects a duplicate application email with 422 USER_EMAIL_DUPLICATE, not 409', async () => {
    const email = uniqueEmail('dupe');
    await createUserViaApi(
      { firstName: 'First', lastName: 'Copy', email, tenantIds: [tenantA] },
      { token: admin.accessToken, tenantId: tenantA },
    );

    const before = await countRows('select count(*)::text as n from users where email = $1', [email]);

    const response = await call('POST', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { firstName: 'Second', lastName: 'Copy', email, tenantIds: [tenantA] },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('USER_EMAIL_DUPLICATE');
    expect(
      await countRows('select count(*)::text as n from users where email = $1', [email]),
    ).toBe(before);
  });

  it('surfaces an Auth provisioning failure as a typed error and creates no app user (V-041)', async () => {
    const email = uniqueEmail('auth-conflict');

    // Pre-create the identity so GoTrue refuses the API's createUser as a duplicate, while the app
    // `users` table has never heard of the address (so the app-side duplicate check passes).
    const { data, error } = await auth.adminClient.auth.admin.createUser({
      email,
      password: `Test-${crypto.randomUUID()}!aA1`,
      email_confirm: true,
    });
    expect(error).toBeNull();
    const orphanId = data.user?.id as string;

    try {
      const response = await call('POST', '/api/v1/users', {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { firstName: 'Half', lastName: 'Created', email, tenantIds: [tenantA] },
      });

      expect(response.status).toBe(422);
      const problem = (await response.json()) as ProblemBody;
      expect(problem.code).toBe('USER_AUTH_PROVISIONING_FAILED');
      // The auth-side message is never echoed — it can carry the address or an internal id.
      expect(problem.detail).not.toContain(email);

      expect(
        await countRows('select count(*)::text as n from users where email = $1', [email]),
        'a half-created app user survived a provisioning failure',
      ).toBe(0);
    } finally {
      await auth.adminClient.auth.admin.deleteUser(orphanId).catch(() => undefined);
    }
  });

  it('compensates a post-provisioning database failure by deleting the auth identity (AC-031)', async () => {
    const email = uniqueEmail('compensate');

    // Fail the app-side INSERT for THIS email only, after the Auth identity already exists.
    await query(`
      create or replace function t017_block_user_insert() returns trigger as $$
      begin
        if new.email::text like '%t017-compensate-%' then
          raise exception 'T-017 fault injection';
        end if;
        return new;
      end $$ language plpgsql`);
    await query(`
      create trigger t017_block_user_insert before insert on users
      for each row execute function t017_block_user_insert()`);

    try {
      const response = await call('POST', '/api/v1/users', {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { firstName: 'Rolled', lastName: 'Back', email, tenantIds: [tenantA] },
      });

      expect(response.status).toBe(500);
      expect(
        await countRows('select count(*)::text as n from users where email = $1', [email]),
      ).toBe(0);
      // The compensating delete is the point: an orphaned identity would make this address
      // permanently un-creatable, since Auth would reject every retry as a duplicate.
      expect(
        await countRows('select count(*)::text as n from auth.users where email = $1', [email]),
        'an orphaned auth identity survived a rolled-back creation',
      ).toBe(0);
    } finally {
      await query('drop trigger if exists t017_block_user_insert on users').catch(() => undefined);
      await query('drop function if exists t017_block_user_insert()').catch(() => undefined);
    }
  });

  it('requires at least one tenant unless the caller is Internal (AC-030, FR-16)', async () => {
    const denied = await call('POST', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { firstName: 'No', lastName: 'Tenant', email: uniqueEmail('no-tenant'), tenantIds: [] },
    });

    expect(denied.status).toBe(422);
    expect(((await denied.json()) as ProblemBody).code).toBe('USER_REQUIRES_TENANT');

    // The Internal caller holds `global.view_any_tenant` — a `global.*` code — so the same body
    // succeeds for them.
    const created = await createUserViaApi(
      { firstName: 'Internal', lastName: 'User', email: uniqueEmail('internal-user'), tenantIds: [] },
      { token: internal.accessToken, tenantId: tenantA },
    );
    expect(created.isActive).toBe(true);
    expect(
      await countRows('select count(*)::text as n from user_tenants where user_id = $1', [
        created.userId,
      ]),
    ).toBe(0);
  });

  // ------------------------------------------------------------------- assignment gating (F-028)

  it('refuses assignment inputs to a caller lacking the dedicated users.assign_* code', async () => {
    const roleId = await fixtures.createRole({ tenantId: tenantA, permissions: ['reports.view'] });
    const groupId = await fixtures.createGroup({ tenantId: tenantA });

    // `inviterOnly` holds NO assign_* code, so it cannot even attach a tenant.
    const noTenantGate = await call('POST', '/api/v1/users', {
      token: inviterOnly.accessToken,
      tenantId: tenantA,
      body: {
        firstName: 'Gate',
        lastName: 'Tenant',
        email: uniqueEmail('gate-tenant'),
        tenantIds: [tenantA],
      },
    });
    expect(noTenantGate.status).toBe(403);
    expect(((await noTenantGate.json()) as ProblemBody).code).toBe('USER_REQUIRES_ASSIGN_TENANT');

    /*
     * The remaining three gates are only REACHABLE with a tenant attached: the zero-tenant branch
     * (CreateUserCommandHandler.cs:72-80) rejects `tenantIds: []` with USER_REQUIRES_TENANT long
     * before them. So the persona for these cases holds users.assign_tenant and nothing else —
     * which is also the realistic escalation shape: a caller who may onboard someone into a tenant
     * must not thereby be able to decide what they can DO there.
     */
    const partial = await auth.createTestUserWithSession({ label: 'um-partial-assigner' });
    await addMembership(appUserId(partial), tenantA);
    for (const code of ['users.invite', 'users.assign_tenant'] as const) {
      await fixtures.grantDirectPermission(appUserId(partial), code, tenantA);
    }

    const cases = [
      [{ directRoleIds: [roleId] }, 'USER_REQUIRES_ASSIGN_ROLE'],
      [{ groupIds: [groupId] }, 'USER_REQUIRES_ASSIGN_GROUP'],
      [{ directPermissions: ['reports.view'] }, 'USER_REQUIRES_GRANT_DIRECT_PERMISSION'],
    ] as const;

    for (const [extra, expectedCode] of cases) {
      const response = await call('POST', '/api/v1/users', {
        token: partial.accessToken,
        tenantId: tenantA,
        body: {
          firstName: 'Gate',
          lastName: 'Test',
          email: uniqueEmail('gate'),
          tenantIds: [tenantA],
          ...extra,
        },
      });

      expect(response.status, `${expectedCode} case`).toBe(403);
      expect(((await response.json()) as ProblemBody).code).toBe(expectedCode);
    }
  });

  it('refuses to grant a permission the caller does not hold themselves (grant-no-higher-than-self)', async () => {
    // `admin` holds every users.* code but NOT leads.delete, so it cannot hand leads.delete out.
    const response = await call('POST', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: {
        firstName: 'Escalate',
        lastName: 'Attempt',
        email: uniqueEmail('escalate'),
        tenantIds: [tenantA],
        directPermissions: ['leads.delete'],
      },
    });

    expect(response.status).toBe(403);
    const problem = (await response.json()) as ProblemBody;
    expect(problem.code).toBe('USER_PERMISSION_EXCEEDS_CALLER_GRANT');

    // Positive control: a code the admin DOES hold passes the same ceiling.
    const created = await createUserViaApi(
      {
        firstName: 'Within',
        lastName: 'Ceiling',
        email: uniqueEmail('within'),
        tenantIds: [tenantA],
        directPermissions: ['reports.view'],
      },
      { token: admin.accessToken, tenantId: tenantA },
    );
    expect(created.userId).toEqual(expect.any(Number));
  });

  it('rejects a permission code outside the seeded catalog with 422', async () => {
    const response = await call('POST', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: {
        firstName: 'Bogus',
        lastName: 'Code',
        email: uniqueEmail('bogus'),
        tenantIds: [tenantA],
        directPermissions: ['leads.telepathy'],
      },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('USER_PERMISSION_NOT_FOUND');
  });

  // ------------------------------------------------------------- per-tenant isolation (AC-030)

  it('confines list and by-id access to members of the ambient tenant (F-027)', async () => {
    const targetId = appUserId(tenantBUser);

    const list = await call('GET', '/api/v1/users', {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as UserBody[];
    expect(listed.some((user) => user.id === targetId)).toBe(false);
    // Positive control: the tenant-A admin IS in their own list, so the filter is not "empty".
    expect(listed.some((user) => user.id === appUserId(admin))).toBe(true);

    // Every by-id path answers the SAME 404 a missing id would, so existence is not probeable.
    for (const [method, path] of [
      ['GET', `/api/v1/users/${targetId}`],
      ['GET', `/api/v1/users/${targetId}/effective-access`],
      ['POST', `/api/v1/users/${targetId}/deactivate`],
    ] as const) {
      const response = await call(method, path, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(((await response.json()) as ProblemBody).code).toBe('USER_NOT_FOUND');
    }

    // And adminB, for whom the user IS in scope, gets 200 on the same id — proving the 404 above
    // is confinement rather than a broken fixture.
    const visible = await call('GET', `/api/v1/users/${targetId}`, {
      token: adminB.accessToken,
      tenantId: tenantB,
    });
    expect(visible.status).toBe(200);
  });

  it('an Internal cross-tenant caller sees users from every tenant', async () => {
    const response = await call('GET', '/api/v1/users', {
      token: internal.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    const listed = (await response.json()) as UserBody[];
    expect(listed.some((user) => user.id === appUserId(tenantBUser))).toBe(true);
  });

  // -------------------------------------------------------------- effective access (AC-030)

  it('resolves per-tenant assignments independently: tenant A grants nothing in tenant B', async () => {
    const target = await createUserViaApi(
      {
        firstName: 'Split',
        lastName: 'Access',
        email: uniqueEmail('split'),
        tenantIds: [tenantA],
        directPermissions: ['reports.view'],
      },
      { token: admin.accessToken, tenantId: tenantA },
    );

    // Give them tenant-B membership plus a DIFFERENT permission there, straight through fixtures so
    // this test measures resolution rather than the update route.
    await addMembership(target.userId, tenantB);
    await fixtures.grantDirectPermission(target.userId, 'brokers.view', tenantB);

    const response = await call('GET', `/api/v1/users/${target.userId}/effective-access`, {
      token: internal.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    const access = (await response.json()) as EffectiveAccessBody;

    const inA = access.effectivePermissionsByTenant[String(tenantA)] ?? [];
    const inB = access.effectivePermissionsByTenant[String(tenantB)] ?? [];

    expect(inA).toContain('reports.view');
    expect(inA, 'a tenant-B grant leaked into tenant A').not.toContain('brokers.view');
    expect(inB).toContain('brokers.view');
    expect(inB, 'a tenant-A grant leaked into tenant B').not.toContain('reports.view');

    // The global scope holds neither: both grants are tenant-scoped.
    expect(access.effectivePermissionsByTenant['global']).toEqual([]);

    expect(access.tenantAssignments.map((assignment) => assignment.tenantId).sort()).toEqual(
      [tenantA, tenantB].sort(),
    );
    expect(access.directPermissions).toEqual(
      expect.arrayContaining([
        { permissionCode: 'reports.view', tenantId: tenantA },
        { permissionCode: 'brokers.view', tenantId: tenantB },
      ]),
    );
  });

  it('reports role and group grants in the effective-access view, resolved through T-012', async () => {
    const roleId = await fixtures.createRole({
      tenantId: tenantA,
      permissions: ['alerts.view'],
    });
    const groupId = await fixtures.createGroup({
      tenantId: tenantA,
      permissions: ['audit.view'],
    });

    const target = await createUserViaApi(
      { firstName: 'Via', lastName: 'Paths', email: uniqueEmail('paths'), tenantIds: [tenantA] },
      { token: admin.accessToken, tenantId: tenantA },
    );

    await fixtures.assignRole(target.userId, roleId, tenantA);
    await fixtures.addGroupMember(groupId, target.userId);

    const response = await call('GET', `/api/v1/users/${target.userId}/effective-access`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    const access = (await response.json()) as EffectiveAccessBody;

    expect(access.directRoles.map((role) => role.roleId)).toContain(roleId);
    expect(access.groups.map((group) => group.groupId)).toContain(groupId);
    expect(access.effectivePermissionsByTenant[String(tenantA)]).toEqual(
      expect.arrayContaining(['alerts.view', 'audit.view']),
    );
  });

  // ------------------------------------------------------------------------- update (AC-030)

  it('replaces per-tenant role and permission assignments through PUT', async () => {
    const roleId = await fixtures.createRole({ tenantId: tenantA, permissions: ['reports.view'] });

    const target = await createUserViaApi(
      { firstName: 'Edit', lastName: 'Me', email: uniqueEmail('edit'), tenantIds: [tenantA] },
      { token: admin.accessToken, tenantId: tenantA },
    );

    const response = await call('PUT', `/api/v1/users/${target.userId}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: {
        firstName: 'Edited',
        lastName: 'Name',
        tenantIds: [tenantA],
        roleAssignments: [{ roleId, tenantId: tenantA }],
        permissionAssignments: [{ permissionCode: 'reports.view', tenantId: tenantA }],
        groupIds: [],
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as UserBody;
    expect(body.firstName).toBe('Edited');
    expect(body.tenantIds).toEqual([tenantA]);

    const roleRows = await query<{ role_id: string; tenant_id: string }>(
      'select role_id::text as role_id, tenant_id::text as tenant_id from user_roles where user_id = $1',
      [target.userId],
    );
    expect(roleRows).toEqual([{ role_id: String(roleId), tenant_id: String(tenantA) }]);

    await assertAudited(query, {
      action: USER_UPDATED_ACTION,
      entityType: 'user',
      entityId: String(target.userId),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
    });
  });

  it('refuses a self-edit that changes the caller’s own access, and allows one that does not', async () => {
    const selfId = appUserId(admin);

    const denied = await call('PUT', `/api/v1/users/${selfId}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: {
        firstName: 'Self',
        lastName: 'Escalate',
        tenantIds: [tenantA],
        roleAssignments: [],
        permissionAssignments: [{ permissionCode: 'reports.view', tenantId: tenantA }],
        groupIds: [],
      },
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as ProblemBody).code).toBe('USER_CANNOT_CHANGE_OWN_ACCESS');

    // Resubmitting the current access state (how the UI saves a name change) is permitted.
    const currentPermissions = await query<{ permission_code: string; tenant_id: string | null }>(
      'select permission_code, tenant_id::text as tenant_id from user_permissions where user_id = $1',
      [selfId],
    );
    const allowed = await call('PUT', `/api/v1/users/${selfId}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: {
        firstName: 'Renamed',
        lastName: 'Admin',
        tenantIds: [tenantA],
        roleAssignments: [],
        permissionAssignments: currentPermissions.map((row) => ({
          permissionCode: row.permission_code,
          tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
        })),
        groupIds: [],
      },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  // --------------------------------------------------------------------- lifecycle (AC-029)

  it('deactivates without deleting: blocks sign-in and API access, preserves assignments (V-038)', async () => {
    const email = uniqueEmail('lifecycle');
    const target = await createUserViaApi(
      {
        firstName: 'Life',
        lastName: 'Cycle',
        email,
        tenantIds: [tenantA],
        directPermissions: ['reports.view'],
      },
      { token: admin.accessToken, tenantId: tenantA },
    );

    const authUserId = (
      await query<{ auth_user_id: string }>(
        'select auth_user_id::text as auth_user_id from users where id = $1',
        [target.userId],
      )
    )[0]?.auth_user_id as string;

    const before = await signInAs(authUserId, email);
    expect(before.ok, 'fixture user could not sign in before deactivation').toBe(true);

    const response = await call('POST', `/api/v1/users/${target.userId}/deactivate`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');

    // is_active flipped; NOTHING deleted.
    const row = await query<{ is_active: boolean }>(
      'select is_active from users where id = $1',
      [target.userId],
    );
    expect(row[0]?.is_active).toBe(false);
    expect(
      await countRows('select count(*)::text as n from user_permissions where user_id = $1', [
        target.userId,
      ]),
      'deactivation destroyed grant history',
    ).toBe(1);
    expect(
      await countRows('select count(*)::text as n from user_tenants where user_id = $1', [
        target.userId,
      ]),
    ).toBe(1);

    // The Auth identity is banned: a fresh sign-in fails.
    const password = `Test-${crypto.randomUUID()}!aA1`;
    await auth.adminClient.auth.admin.updateUserById(authUserId, { password });
    const blocked = await auth.anonClient.auth.signInWithPassword({ email, password });
    expect(blocked.error, 'a deactivated identity could still sign in').not.toBeNull();

    // Their previously-issued token is refused at the API too (T-011 rejects an inactive app user).
    const apiCall = await call('GET', '/api/v1/me', { token: before.accessToken as string });
    expect(apiCall.status).toBe(401);

    await assertAudited(query, {
      action: USER_DEACTIVATED_ACTION,
      entityType: 'user',
      entityId: String(target.userId),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: { email, isActive: true },
      after: { email, isActive: false },
    });

    // Deactivating twice conflicts (409), matching UserEndpoints.cs:111.
    const again = await call('POST', `/api/v1/users/${target.userId}/deactivate`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ProblemBody).code).toBe('USER_ALREADY_INACTIVE');

    // ---- reactivation restores both halves (AC-029) ----
    const reactivated = await call('POST', `/api/v1/users/${target.userId}/activate`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(reactivated.status).toBe(200);

    const restored = await signInAs(authUserId, email);
    expect(restored.ok, 'reactivation did not restore sign-in').toBe(true);

    const restoredCall = await call('GET', '/api/v1/me', {
      token: restored.accessToken as string,
    });
    expect(restoredCall.status).toBe(200);

    await assertAudited(query, {
      action: USER_ACTIVATED_ACTION,
      entityType: 'user',
      entityId: String(target.userId),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: { email, isActive: false },
      after: { email, isActive: true },
    });
  }, 60_000);

  it('never lets a caller deactivate themselves (self-lockout)', async () => {
    const response = await call('POST', `/api/v1/users/${appUserId(admin)}/deactivate`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as ProblemBody).code).toBe('USER_CANNOT_DEACTIVATE_SELF');
    const row = await query<{ is_active: boolean }>('select is_active from users where id = $1', [
      appUserId(admin),
    ]);
    expect(row[0]?.is_active).toBe(true);
  });

  // ------------------------------------------------------------------------- audit (AC-024)

  it('writes exactly one user.created audit row carrying the actor, tenant and payload', async () => {
    const email = uniqueEmail('audited');
    const created = await createUserViaApi(
      { firstName: 'Aud', lastName: 'Ited', email, tenantIds: [tenantA] },
      { token: admin.accessToken, tenantId: tenantA },
    );

    const row = await assertAudited(query, {
      action: USER_CREATED_ACTION,
      entityType: 'user',
      entityId: String(created.userId),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: null,
    });

    const after = (row.details as { after: Record<string, unknown> }).after;
    expect(after['email']).toBe(email);
    expect(after['tenantIds']).toEqual([tenantA]);
  });
});
