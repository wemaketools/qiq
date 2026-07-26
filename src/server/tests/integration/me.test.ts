/**
 * The session bootstrap surface, end to end (T-015, AC-022, AC-025, AC-027, AC-034; V-027, V-032,
 * V-032's negative cases; P-01, spec §12).
 *
 * Nothing here is stubbed. Real signed-in sessions (T-011's `createTestUserWithSession`), real
 * `tenants`/`user_tenants`/`tenant_settings` rows, the real grant graph, the real Hono pipeline
 * through `app.fetch`, and read-back straight from Postgres. The contract this proves is a WIRE
 * contract, so it is asserted on parsed JSON keys rather than on TypeScript types — a type
 * assertion would be satisfied by a handler that emits the right shape and the wrong values, and
 * would not notice a renamed field at all if the DTO type were renamed alongside it.
 *
 * MEASURED REFERENCE SEMANTICS (cited at each assertion):
 *   GetMeQuery.cs:26-34 / :41-46          field names + nesting
 *   GetMeQueryHandler.cs:53-76            per-membership permission sets, ordinal sort, global set
 *   UserTenantMembershipReader.cs:39-50   left-joined currency w/ BWP fallback, order by name
 *   UserPreferencesStore.cs:27-35         null field = leave alone, NOT clear
 *   SetMePreferencesCommandHandler.cs:70  lastTenantId validated against real access
 *   MeEndpoints.cs:28-52                  401 / 403 / 422 / 200-empty-body
 *
 * The one DELIBERATE divergence — soft-removed tenants are excluded from memberships, where the
 * reference returned them — is required by AC-025/AC-027 and pinned by
 * `excludes a soft-removed tenant...` below. See me.service.ts's header for the full reasoning.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { INVALID_THEME_MESSAGE } from '../../domains/users/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../lib/errors/problem.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('GET /me and PUT /me/preferences', probe);

/**
 * The complete top-level key set of `GetMeResult` (GetMeQuery.cs:26-34) under System.Text.Json's
 * camelCase policy. Compared with `toEqual` on SORTED KEYS, so BOTH a missing field and an
 * unplanned extra one fail — a superset check would let a handler quietly add (or, via a rename,
 * drop-and-add) a field the SPA does not read.
 */
const ME_KEYS = [
  'email',
  'firstName',
  'globalPermissions',
  'lastName',
  'lastTenantId',
  'memberships',
  'themePreference',
  'userId',
].sort();

/** `MembershipDto` (GetMeQuery.cs:41-46). `effectivePermissions` — NOT `permissions`. */
const MEMBERSHIP_KEYS = [
  'currencyCode',
  'currencySymbol',
  'effectivePermissions',
  'tenantId',
  'tenantName',
].sort();

interface MembershipBody {
  readonly tenantId: number;
  readonly tenantName: string;
  readonly currencyCode: string;
  readonly currencySymbol: string;
  readonly effectivePermissions: string[];
}

interface MeBody {
  readonly userId: number;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly lastTenantId: number | null;
  readonly themePreference: string | null;
  readonly memberships: MembershipBody[];
  readonly globalPermissions: string[];
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;
  let app: ApiApp;

  /** Two memberships, different grants in each, plus one soft-removed tenant. */
  let multiTenant: TestUserSession;
  /** No `user_tenants` rows at all; global grants only (spec FR-16, prior-build T-045). */
  let zeroMembershipInternal: TestUserSession;
  /** A member of one tenant only — the isolation counterparty and the preferences subject. */
  let soloUser: TestUserSession;
  /** A member whose grants are purely tenant-scoped: the control for the global-union assertions. */
  let plainMember: TestUserSession;

  let tenantA: number;
  let tenantB: number;
  let tenantOther: number;
  let removedTenant: number;

  const createdTenants: number[] = [];

  async function createTenant(
    label: string,
    status: 'active' | 'removed',
    currency?: { code: string; symbol: string },
  ): Promise<number> {
    const rows = await auth.query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, $2, now(), now()) returning id::text as id`,
      [`t015-${label}-${crypto.randomUUID()}`, status],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`could not create tenant ${label}`);
    const id = Number(row.id);
    createdTenants.push(id);

    if (currency !== undefined) {
      // Only tenants that need a NON-default currency get a settings row: the tenants without one
      // exercise the left-join fallback (UserTenantMembershipReader.cs:47), which an inner join
      // would turn into a vanished membership rather than a visible wrong currency.
      await auth.query(
        `insert into tenant_settings (tenant_id, currency_code, currency_symbol, created_at, updated_at)
         values ($1, $2, $3, now(), now())`,
        [id, currency.code, currency.symbol],
      );
    }
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

  async function readPreferences(
    session: TestUserSession,
  ): Promise<{ last_tenant_id: number | null; theme_preference: string | null }> {
    const rows = await auth.query<{ last_tenant_id: string | null; theme_preference: string | null }>(
      `select last_tenant_id::text as last_tenant_id, theme_preference from users where id = $1`,
      [appUserId(session)],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('preferences row vanished');
    return {
      last_tenant_id: row.last_tenant_id === null ? null : Number(row.last_tenant_id),
      theme_preference: row.theme_preference,
    };
  }

  async function getMe(options: { token?: string; tenantId?: string | number } = {}): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    return await app.request('http://localhost/api/v1/me', { headers });
  }

  async function putPreferences(body: unknown, token?: string): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    return await app.request('http://localhost/api/v1/me/preferences', {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
  }

  async function meBody(session: TestUserSession): Promise<MeBody> {
    const response = await getMe({ token: session.accessToken });
    expect(response.status).toBe(200);
    return (await response.json()) as MeBody;
  }

  function membershipFor(body: MeBody, tenantId: number): MembershipBody {
    const found = body.memberships.find((m) => m.tenantId === tenantId);
    if (found === undefined) {
      throw new Error(
        `expected a membership for tenant ${tenantId}, got ${JSON.stringify(body.memberships.map((m) => m.tenantId))}`,
      );
    }
    return found;
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

    auth = new TestAuthFixtures(stack);
    fixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));

    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    pgLookup = createPgAppUserLookup(config);

    const loadGrantGraph = createGrantGraphLoader(db);
    app = buildApp({
      config,
      loggerOptions: { sink: () => undefined },
      auth: {
        verifyAccessToken: createAccessTokenVerifier({ config }),
        lookupAppUser: (authUserId) => pgLookup.lookup(authUserId),
      },
      tenancy: { db, validateTenantAccess: createTenantAccessValidator({ db, loadGrantGraph }) },
      rbac: { loadGrantGraph },
      me: { db, loadGrantGraph, validateTenantAccess: createTenantAccessValidator({ db, loadGrantGraph }) },
    });

    // Names force a deterministic, NON-insertion order so the `order by tenants.name` assertion
    // discriminates: 'zzz' is created first but must come last.
    tenantB = await createTenant('zzz-b', 'active', { code: 'ZAR', symbol: 'R' });
    tenantA = await createTenant('aaa-a', 'active');
    tenantOther = await createTenant('mmm-other', 'active');
    removedTenant = await createTenant('kkk-removed', 'removed');

    multiTenant = await auth.createTestUserWithSession({
      label: 'me-multi',
      firstName: 'Multi',
      lastName: 'Tenant',
    });
    zeroMembershipInternal = await auth.createTestUserWithSession({ label: 'me-internal' });
    soloUser = await auth.createTestUserWithSession({ label: 'me-solo' });
    plainMember = await auth.createTestUserWithSession({ label: 'me-plain' });

    await addMembership(appUserId(multiTenant), tenantA);
    await addMembership(appUserId(multiTenant), tenantB);
    // A membership in a soft-removed tenant: present in user_tenants, must NOT surface in /me.
    await addMembership(appUserId(multiTenant), removedTenant);

    // DIFFERENT grants per tenant. This is what makes the per-tenant assertions discriminating: a
    // handler that resolved one set and reused it for every membership would satisfy "tenant A has
    // leads.view" and fail "tenant B does not".
    await fixtures.grantDirectPermission(appUserId(multiTenant), 'leads.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(multiTenant), 'brokers.view', tenantB);
    // A tenant-less grant held by a MEMBER: must appear in globalPermissions AND be unioned into
    // every membership's set (GetMeQuery.cs:17-24).
    await fixtures.grantDirectPermission(appUserId(multiTenant), 'tenants.view', null);

    // Zero memberships, global grants only.
    await fixtures.grantDirectPermission(
      appUserId(zeroMembershipInternal),
      'global.view_any_tenant',
      null,
    );
    await fixtures.grantDirectPermission(appUserId(zeroMembershipInternal), 'tenants.view', null);

    await addMembership(appUserId(soloUser), tenantOther);
    await fixtures.grantDirectPermission(appUserId(soloUser), 'alerts.view', tenantOther);

    await addMembership(appUserId(plainMember), tenantA);
    await fixtures.grantDirectPermission(appUserId(plainMember), 'leads.view', tenantA);
  });

  afterAll(async () => {
    if (!probe.available) return;
    for (const tenantId of createdTenants) {
      await auth?.query('update users set last_tenant_id = null where last_tenant_id = $1', [tenantId]);
      await auth?.query('delete from user_tenants where tenant_id = $1', [tenantId]);
      await auth?.query('delete from tenant_settings where tenant_id = $1', [tenantId]);
      await auth?.query('delete from tenants where id = $1', [tenantId]);
    }
    await fixtures?.cleanup();
    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  });

  // ------------------------------------------------------------------ GET /me: the wire contract

  it('returns 200 with exactly the reference DTO field set (GetMeQuery.cs:26-34)', async () => {
    // POSITIVE CONTROL for every negative assertion in this file: without it, a handler that
    // rejected everything could satisfy the 401/403/422 cases below.
    const body = await meBody(multiTenant);

    expect(Object.keys(body).sort()).toEqual(ME_KEYS);
    expect(body.userId).toBe(appUserId(multiTenant));
    expect(typeof body.userId).toBe('number');
    expect(body.email).toBe(multiTenant.email);
    expect(body.firstName).toBe('Multi');
    expect(body.lastName).toBe('Tenant');
  });

  it('emits each membership with exactly the reference MembershipDto fields, `effectivePermissions` included (GetMeQuery.cs:41-46)', async () => {
    const body = await meBody(multiTenant);

    for (const membership of body.memberships) {
      expect(Object.keys(membership).sort()).toEqual(MEMBERSHIP_KEYS);
      expect(typeof membership.tenantId).toBe('number');
    }
    // Named explicitly: the Redux slice stores this array as `permissions` (sessionSlice.ts:17) and
    // AuthProvider.tsx:96 does the rename. Emitting `permissions` on the wire would produce a shell
    // with no permissions and no error.
    expect(body.memberships[0]).toHaveProperty('effectivePermissions');
    expect(body.memberships[0]).not.toHaveProperty('permissions');
  });

  it('returns null (not absent) for an unset lastTenantId and themePreference', async () => {
    const body = await meBody(plainMember);

    expect(body.lastTenantId).toBeNull();
    expect(body.themePreference).toBeNull();
    // `in` distinguishes "present and null" from "absent"; `toBeNull` alone cannot.
    expect('lastTenantId' in body).toBe(true);
    expect('themePreference' in body).toBe(true);
  });

  it('needs no X-Tenant-Id header: /me is a global route (TenantContextMiddleware.cs:20-26)', async () => {
    // The SPA cannot send a tenant header before /me has told it which tenants exist, so a tenant
    // requirement here would deadlock login entirely.
    const response = await getMe({ token: multiTenant.accessToken });

    expect(response.status).toBe(200);
  });

  // ------------------------------------------------------------------ memberships

  it('returns every active membership, ordered by tenant name (UserTenantMembershipReader.cs:50)', async () => {
    const body = await meBody(multiTenant);

    expect(body.memberships.map((m) => m.tenantId)).toHaveLength(2);
    expect(body.memberships.map((m) => m.tenantId)).toEqual(expect.arrayContaining([tenantA, tenantB]));

    const names = body.memberships.map((m) => m.tenantName);
    expect(names).toEqual([...names].sort());
    // Discriminating: tenantB was INSERTED FIRST but sorts LAST, so an unordered query fails here.
    expect(body.memberships[0]?.tenantId).toBe(tenantA);
    expect(body.memberships[1]?.tenantId).toBe(tenantB);
  });

  it('excludes a soft-removed tenant from memberships even though the user_tenants row exists (AC-025, AC-027, V-032)', async () => {
    // The membership row IS there — proving the exclusion happens in the query, not because the
    // fixture forgot to create it.
    const rows = await auth.query<{ count: string }>(
      'select count(*)::text as count from user_tenants where user_id = $1 and tenant_id = $2',
      [appUserId(multiTenant), removedTenant],
    );
    expect(rows[0]?.count).toBe('1');

    const body = await meBody(multiTenant);

    expect(body.memberships.map((m) => m.tenantId)).not.toContain(removedTenant);
  });

  it('carries each tenant display currency, defaulting to BWP with no tenant_settings row (AC-074)', async () => {
    const body = await meBody(multiTenant);

    // tenantB has a configured non-default currency; tenantA has no settings row at all.
    expect(membershipFor(body, tenantB).currencyCode).toBe('ZAR');
    expect(membershipFor(body, tenantB).currencySymbol).toBe('R');
    expect(membershipFor(body, tenantA).currencyCode).toBe('BWP');
    expect(membershipFor(body, tenantA).currencySymbol).toBe('BWP');
  });

  it('never returns another user\'s memberships (AC-022, V-027)', async () => {
    const mine = await meBody(soloUser);
    const theirs = await meBody(multiTenant);

    expect(mine.memberships.map((m) => m.tenantId)).toEqual([tenantOther]);
    expect(mine.memberships.map((m) => m.tenantId)).not.toContain(tenantA);
    expect(mine.memberships.map((m) => m.tenantId)).not.toContain(tenantB);
    expect(theirs.memberships.map((m) => m.tenantId)).not.toContain(tenantOther);
    expect(mine.userId).not.toBe(theirs.userId);
  });

  // ------------------------------------------------------------------ per-tenant permissions

  it('resolves effective permissions PER TENANT, not once for the whole caller (GetMeQueryHandler.cs:53-62)', async () => {
    const body = await meBody(multiTenant);
    const inA = membershipFor(body, tenantA).effectivePermissions;
    const inB = membershipFor(body, tenantB).effectivePermissions;

    // Both directions. A handler resolving every membership against ONE tenant passes half of
    // this and fails the other half whichever tenant it picked.
    expect(inA).toContain('leads.view');
    expect(inA).not.toContain('brokers.view');
    expect(inB).toContain('brokers.view');
    expect(inB).not.toContain('leads.view');
    // And the sets must actually differ — the assertion a "same set everywhere" bug cannot satisfy.
    expect(inA).not.toEqual(inB);
  });

  it('unions tenant-less global grants into every membership set and reports them separately (GetMeQuery.cs:17-24)', async () => {
    const body = await meBody(multiTenant);

    expect(body.globalPermissions).toContain('tenants.view');
    expect(membershipFor(body, tenantA).effectivePermissions).toContain('tenants.view');
    expect(membershipFor(body, tenantB).effectivePermissions).toContain('tenants.view');
  });

  it('reports an empty globalPermissions for a member holding only tenant-scoped grants', async () => {
    // CONTROL for the assertion above: proves `globalPermissions` is the tenant-less set and not
    // just a copy of the caller's permissions, which would make the previous test vacuous.
    const body = await meBody(plainMember);

    expect(body.globalPermissions).toEqual([]);
    expect(membershipFor(body, tenantA).effectivePermissions).toContain('leads.view');
  });

  it('ordinal-sorts permission arrays (GetMeQueryHandler.cs:60,74)', async () => {
    const body = await meBody(multiTenant);
    const inA = membershipFor(body, tenantA).effectivePermissions;

    expect(inA.length).toBeGreaterThan(1);
    expect(inA).toEqual([...inA].sort());
  });

  // ------------------------------------------------------------------ zero-membership Internal user

  it('gives a zero-membership Internal user a working /me carrying their global grants (spec FR-16)', async () => {
    const body = await meBody(zeroMembershipInternal);

    expect(body.memberships).toEqual([]);
    expect(body.globalPermissions).toContain('global.view_any_tenant');
    expect(body.globalPermissions).toContain('tenants.view');
    // The whole point of the separate field: with no memberships, this is the only place the shell
    // can learn what this persona may do. An empty array here locks them out of Tenant Manager.
    expect(body.globalPermissions.length).toBeGreaterThan(0);
  });

  it('has no user_tenants row for the Internal user, so the previous test cannot pass by accident', async () => {
    const rows = await auth.query<{ count: string }>(
      'select count(*)::text as count from user_tenants where user_id = $1',
      [appUserId(zeroMembershipInternal)],
    );

    expect(rows[0]?.count).toBe('0');
  });

  // ------------------------------------------------------------------ PUT /me/preferences

  it('persists lastTenantId and theme, returning 200 with an empty body (MeEndpoints.cs:41)', async () => {
    const response = await putPreferences(
      { lastTenantId: tenantOther, themePreference: 'dark' },
      soloUser.accessToken,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(await readPreferences(soloUser)).toEqual({
      last_tenant_id: tenantOther,
      theme_preference: 'dark',
    });
  });

  it('reflects persisted preferences on a subsequent GET /me (V-032)', async () => {
    await putPreferences({ lastTenantId: tenantOther, themePreference: 'dark' }, soloUser.accessToken);

    const body = await meBody(soloUser);

    expect(body.lastTenantId).toBe(tenantOther);
    expect(body.themePreference).toBe('dark');
  });

  it('reflects persisted preferences on a FRESH sign-in with a new token (V-032, P-01 login lands in last tenant)', async () => {
    await putPreferences({ lastTenantId: tenantOther, themePreference: 'dark' }, soloUser.accessToken);

    // A genuinely new session, not the cached one: preferences must live in the database, not in
    // anything attached to a token or to a warm server instance (N-02).
    const fresh = await auth.signIn(soloUser.email, soloUser.password);
    const response = await getMe({ token: fresh.accessToken });
    const body = (await response.json()) as MeBody;

    expect(response.status).toBe(200);
    expect(body.lastTenantId).toBe(tenantOther);
    expect(body.themePreference).toBe('dark');
  });

  it('leaves the other preference untouched when only one field is sent (UserPreferencesStore.cs:27-35)', async () => {
    await putPreferences({ lastTenantId: tenantOther, themePreference: 'dark' }, soloUser.accessToken);

    // Exactly what the tenant switcher sends (TenantSwitcher.tsx:80). Wiping the theme here would
    // silently reset every user's dark mode on every tenant switch.
    const response = await putPreferences({ lastTenantId: tenantOther }, soloUser.accessToken);

    expect(response.status).toBe(200);
    expect((await readPreferences(soloUser)).theme_preference).toBe('dark');
  });

  it('accepts a theme-only update without touching lastTenantId', async () => {
    await putPreferences({ lastTenantId: tenantOther, themePreference: 'dark' }, soloUser.accessToken);

    const response = await putPreferences({ themePreference: 'light' }, soloUser.accessToken);

    expect(response.status).toBe(200);
    expect(await readPreferences(soloUser)).toEqual({
      last_tenant_id: tenantOther,
      theme_preference: 'light',
    });
  });

  // ------------------------------------------------------------------ PUT: never trust the tenant id

  it('rejects a lastTenantId the caller has no access to, with 403 and NO side effect (SetMePreferencesCommandHandler.cs:70)', async () => {
    await putPreferences({ lastTenantId: tenantOther, themePreference: 'dark' }, soloUser.accessToken);
    const before = await readPreferences(soloUser);

    // tenantA is a real, active tenant that soloUser is simply not a member of — a client-supplied
    // id that is plausible in every way except authorization.
    const response = await putPreferences({ lastTenantId: tenantA }, soloUser.accessToken);

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain(PROBLEM_JSON_CONTENT_TYPE);
    // The write must not have happened at all, not merely have been reported as failed.
    expect(await readPreferences(soloUser)).toEqual(before);
  });

  it('rejects a soft-removed tenant as lastTenantId even for a member of it (AC-027)', async () => {
    // multiTenant IS a member of removedTenant, so this can only be refused on the status check —
    // pinning that a caller cannot pin themselves to a tenant they would be denied entry to.
    const response = await putPreferences({ lastTenantId: removedTenant }, multiTenant.accessToken);

    expect(response.status).toBe(403);
    expect((await readPreferences(multiTenant)).last_tenant_id).not.toBe(removedTenant);
  });

  it('lets an Internal global.view_any_tenant holder persist a tenant they are not a member of (spec §5.3)', async () => {
    // CONTROL for the two rejections above: proves the check is the shared tenant-access validator
    // (membership OR the Internal grant) rather than a bare membership lookup that would break
    // cross-tenant switching for Internal users.
    const response = await putPreferences(
      { lastTenantId: tenantA },
      zeroMembershipInternal.accessToken,
    );

    expect(response.status).toBe(200);
    expect((await readPreferences(zeroMembershipInternal)).last_tenant_id).toBe(tenantA);
  });

  // ------------------------------------------------------------------ PUT: validation

  it('rejects a theme outside the allow-list with 422 and the reference message (SetMePreferencesValidator.cs:21)', async () => {
    await putPreferences({ themePreference: 'light' }, soloUser.accessToken);

    const response = await putPreferences({ themePreference: 'solarized' }, soloUser.accessToken);
    const problem = (await response.json()) as { status: number; detail?: string };

    expect(response.status).toBe(422);
    expect(problem.status).toBe(422);
    expect(problem.detail).toContain(INVALID_THEME_MESSAGE);
    // No partial write.
    expect((await readPreferences(soloUser)).theme_preference).toBe('light');
  });

  it('accepts both allowed themes', async () => {
    // CONTROL: the 422 above must be the allow-list rejecting an unknown value, not the endpoint
    // rejecting every theme.
    for (const theme of ['light', 'dark']) {
      const response = await putPreferences({ themePreference: theme }, soloUser.accessToken);
      expect(response.status).toBe(200);
      expect((await readPreferences(soloUser)).theme_preference).toBe(theme);
    }
  });

  it('accepts an empty body as a no-op', async () => {
    await putPreferences({ lastTenantId: tenantOther, themePreference: 'dark' }, soloUser.accessToken);
    const before = await readPreferences(soloUser);

    const response = await putPreferences({}, soloUser.accessToken);

    expect(response.status).toBe(200);
    expect(await readPreferences(soloUser)).toEqual(before);
  });

  // ------------------------------------------------------------------ authentication

  it('answers 401 for an anonymous GET /me', async () => {
    const response = await getMe();

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('answers 401 for an anonymous PUT /me/preferences without writing anything', async () => {
    const response = await putPreferences({ themePreference: 'dark' });

    expect(response.status).toBe(401);
  });

  it('answers 401 for a garbage bearer token', async () => {
    const response = await getMe({ token: 'not-a-real-token' });

    expect(response.status).toBe(401);
  });
});
