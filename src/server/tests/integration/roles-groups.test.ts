/**
 * Role, group and permission-catalog administration, end to end (T-017; AC-024, AC-030;
 * V-031, V-040).
 *
 * Real sessions, the real grant graph, the real Hono pipeline, the real seeded `permissions` table,
 * and a real `audit_log` read-back. Nothing is stubbed.
 *
 * MEASURED REFERENCE SEMANTICS PINNED BELOW
 * =========================================
 *   role route permissions            RoleEndpoints.cs:22-27
 *   group route permissions           GroupEndpoints.cs:31-39
 *   duplicate name -> 422             RoleEndpoints.cs:80, GroupEndpoints.cs:114  (NOT 409)
 *   role in use -> 409                RoleEndpoints.cs:78
 *   already/not a member -> 422       GroupEndpoints.cs:114-115                   (NOT 409)
 *   global role/group forbidden -> 403 RoleEndpoints.cs:77, GroupEndpoints.cs:110
 *   create -> 201 + Location          RoleEndpoints.cs:48, GroupEndpoints.cs:60
 *   disable/member/roles/permissions -> 200 empty body   RoleEndpoints.cs:65, GroupEndpoints.cs:75+
 *
 * WHY TENANT ISOLATION IS TESTED PER ENDPOINT RATHER THAN ONCE
 * ===========================================================
 * `roles` and `user_groups` are global, unpartitioned tables with a NULLABLE tenant_id, so
 * `forTenant(...)` cannot be applied to them, and Postgres RLS is not adopted (spec Q-10). Every
 * by-id handler therefore carries its OWN confinement check, and a forgotten one on a single route
 * is a complete cross-tenant hole on that route with nothing underneath to catch it. A single
 * "isolation works" test would pass while five of six routes leaked, so each route is probed.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createGrantGraphLoader,
  GROUP_CREATED_ACTION,
  GROUP_DISABLED_ACTION,
  GROUP_MEMBER_ADDED_ACTION,
  GROUP_MEMBER_REMOVED_ACTION,
  GROUP_PERMISSIONS_SET_ACTION,
  GROUP_ROLES_SET_ACTION,
  GROUP_UPDATED_ACTION,
  PERMISSION_CODES,
  ROLE_CREATED_ACTION,
  ROLE_DISABLED_ACTION,
  ROLE_UPDATED_ACTION,
} from '../../domains/rbac/index.js';
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
const title = suiteTitle('User Manager: /api/v1/roles, /groups, /permissions', probe);

interface ProblemBody {
  readonly detail?: string;
  readonly code?: string;
}

interface RoleBody {
  readonly id: number;
  readonly tenantId: number | null;
  readonly name: string;
  readonly isActive: boolean;
  readonly permissionCodes: string[];
}

interface GroupBody {
  readonly id: number;
  readonly tenantId: number | null;
  readonly name: string;
  readonly isActive: boolean;
}

interface GroupDetailBody extends GroupBody {
  readonly memberUserIds: number[];
  readonly roleIds: number[];
  readonly permissionCodes: string[];
}

interface RoleUsageBody {
  readonly users: { userId: number; email: string; tenantId: number | null }[];
  readonly groups: { groupId: number; name: string; tenantId: number | null }[];
}

interface CatalogEntry {
  readonly code: string;
  readonly category: string;
  readonly description: string;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Full role/group administration in tenant A. */
  let admin: TestUserSession;
  /** Full role/group administration in tenant B — the isolation counterpart. */
  let adminB: TestUserSession;
  /** `roles.view` + `groups.view` only in tenant A. */
  let viewer: TestUserSession;
  /** Internal: global cross-tenant + global-default management. */
  let internal: TestUserSession;
  /** A tenant-A member with no admin rights, used as a group-membership target. */
  let member: TestUserSession;

  let tenantA: number;
  let tenantB: number;

  const createdRoleIds: number[] = [];
  const createdGroupIds: number[] = [];
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
      userManager: {
        db,
        // Roles/groups/permissions never call the Auth Admin API; the port is required by the slot
        // and throwing here proves that (a call would fail the test loudly rather than silently).
        authAdmin: {
          createUser: () => Promise.reject(new Error('unexpected Auth Admin call')),
          deleteUser: () => Promise.reject(new Error('unexpected Auth Admin call')),
          setDisabled: () => Promise.reject(new Error('unexpected Auth Admin call')),
          sendRecoveryEmail: () => Promise.reject(new Error('unexpected Auth Admin call')),
        },
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

  function uniqueName(label: string): string {
    return `t017-${label}-${crypto.randomUUID()}`;
  }

  async function createTenantRow(label: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [uniqueName(label)],
    );
    const id = Number(rows[0]?.id);
    createdTenantIds.push(id);
    return id;
  }

  async function createRoleViaApi(
    body: Record<string, unknown>,
    options: { token: string; tenantId: number | string },
  ): Promise<RoleBody> {
    const response = await call('POST', '/api/v1/roles', { ...options, body });
    expect(response.status, `create role failed: ${await response.clone().text()}`).toBe(201);
    const role = (await response.json()) as RoleBody;
    createdRoleIds.push(role.id);
    return role;
  }

  async function createGroupViaApi(
    body: Record<string, unknown>,
    options: { token: string; tenantId: number | string },
  ): Promise<GroupBody> {
    const response = await call('POST', '/api/v1/groups', { ...options, body });
    expect(response.status, `create group failed: ${await response.clone().text()}`).toBe(201);
    const group = (await response.json()) as GroupBody;
    createdGroupIds.push(group.id);
    return group;
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

    tenantA = await createTenantRow('rg-tenant-a');
    tenantB = await createTenantRow('rg-tenant-b');

    admin = await auth.createTestUserWithSession({ label: 'rg-admin' });
    adminB = await auth.createTestUserWithSession({ label: 'rg-admin-b' });
    viewer = await auth.createTestUserWithSession({ label: 'rg-viewer' });
    internal = await auth.createTestUserWithSession({ label: 'rg-internal' });
    member = await auth.createTestUserWithSession({ label: 'rg-member' });

    for (const [session, tenantId] of [
      [admin, tenantA],
      [adminB, tenantB],
      [viewer, tenantA],
      [member, tenantA],
    ] as const) {
      await query(
        `insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())
         on conflict do nothing`,
        [tenantId, appUserId(session)],
      );
    }

    const adminCodes = [
      'roles.view',
      'roles.manage',
      'groups.view',
      'groups.manage',
      'users.view',
      'reports.view',
      'alerts.view',
    ] as const;

    // TENANT-SCOPED on both sides: the isolation cases are only meaningful if neither admin holds
    // anything globally.
    for (const code of adminCodes) {
      await fixtures.grantDirectPermission(appUserId(admin), code, tenantA);
      await fixtures.grantDirectPermission(appUserId(adminB), code, tenantB);
    }

    await fixtures.grantDirectPermission(appUserId(viewer), 'roles.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(viewer), 'groups.view', tenantA);

    for (const code of [
      'global.view_any_tenant',
      'global.manage_global_defaults',
      'roles.view',
      'roles.manage',
      'groups.view',
      'groups.manage',
      'reports.view',
    ] as const) {
      await fixtures.grantDirectPermission(appUserId(internal), code, null);
    }
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    for (const groupId of createdGroupIds) {
      for (const table of ['group_members', 'group_roles', 'group_permissions'] as const) {
        await query(`delete from ${table} where group_id = $1`, [groupId]).catch(() => undefined);
      }
      await query('delete from audit_log where entity_type = $1 and entity_id = $2', [
        'group',
        String(groupId),
      ]).catch(() => undefined);
      await query('delete from user_groups where id = $1', [groupId]).catch(() => undefined);
    }
    for (const roleId of createdRoleIds) {
      for (const table of ['role_permissions', 'user_roles', 'group_roles'] as const) {
        await query(`delete from ${table} where role_id = $1`, [roleId]).catch(() => undefined);
      }
      await query('delete from audit_log where entity_type = $1 and entity_id = $2', [
        'role',
        String(roleId),
      ]).catch(() => undefined);
      await query('delete from roles where id = $1', [roleId]).catch(() => undefined);
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

  // ------------------------------------------------------------- permission catalog (V-040)

  it('GET /permissions returns the seeded catalog exactly (count and key names)', async () => {
    const response = await call('GET', '/api/v1/permissions', {
      token: viewer.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    const catalog = (await response.json()) as CatalogEntry[];

    // Count AND membership: a count-only assertion would pass if a code were swapped for another.
    expect(catalog).toHaveLength(PERMISSION_CODES.length);
    expect(catalog.map((entry) => entry.code).sort()).toEqual([...PERMISSION_CODES].sort());

    // The rows come from the database, so every entry carries the seeded category/description the
    // SPA's picker groups by — not just a bare code list.
    for (const entry of catalog) {
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }

    // Spot-check the names the User Manager screens depend on.
    const codes = new Set(catalog.map((entry) => entry.code));
    for (const code of ['users.invite', 'roles.manage', 'groups.manage', 'leads.view_all']) {
      expect(codes.has(code), `catalog is missing ${code}`).toBe(true);
    }
  });

  it('gates the permission catalog behind roles.view', async () => {
    const stranger = await auth.createTestUserWithSession({ label: 'rg-stranger' });
    await query(
      `insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())
       on conflict do nothing`,
      [tenantA, appUserId(stranger)],
    );
    await fixtures.grantDirectPermission(appUserId(stranger), 'reports.view', tenantA);

    const response = await call('GET', '/api/v1/permissions', {
      token: stranger.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as ProblemBody).detail).toBe(
      "Missing required permission 'roles.view'.",
    );
  });

  // -------------------------------------------------------------- role permission matrix

  it('answers 403 on every mutating role and group route for a view-only caller', async () => {
    const cases = [
      ['POST', '/api/v1/roles', 'roles.manage'],
      ['PUT', '/api/v1/roles/1', 'roles.manage'],
      ['POST', '/api/v1/roles/1/disable', 'roles.manage'],
      ['POST', '/api/v1/groups', 'groups.manage'],
      ['PUT', '/api/v1/groups/1', 'groups.manage'],
      ['POST', '/api/v1/groups/1/disable', 'groups.manage'],
      ['POST', '/api/v1/groups/1/members', 'groups.manage'],
      ['POST', '/api/v1/groups/1/members/2/remove', 'groups.manage'],
      ['POST', '/api/v1/groups/1/roles', 'groups.manage'],
      ['POST', '/api/v1/groups/1/permissions', 'groups.manage'],
    ] as const;

    for (const [method, path, required] of cases) {
      const response = await call(method, path, {
        token: viewer.accessToken,
        tenantId: tenantA,
        body: {},
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(((await response.json()) as ProblemBody).detail).toBe(
        `Missing required permission '${required}'.`,
      );
    }

    // Positive control: the READ routes the viewer does hold are not denied.
    for (const path of ['/api/v1/roles', '/api/v1/groups'] as const) {
      const allowed = await call('GET', path, { token: viewer.accessToken, tenantId: tenantA });
      expect(allowed.status, path).toBe(200);
    }
  });

  // ------------------------------------------------------------------------ roles CRUD

  it('creates, reads, lists and updates a role with the reference shapes', async () => {
    const name = uniqueName('role');
    const created = await createRoleViaApi(
      { name, permissionCodes: ['reports.view'] },
      { token: admin.accessToken, tenantId: tenantA },
    );

    expect(created).toEqual({
      id: expect.any(Number),
      tenantId: tenantA,
      name,
      isActive: true,
      permissionCodes: ['reports.view'],
    });

    const fetched = await call('GET', `/api/v1/roles/${created.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(created);

    const listed = await call('GET', '/api/v1/roles', {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    const roles = (await listed.json()) as RoleBody[];
    expect(roles.some((role) => role.id === created.id)).toBe(true);

    const renamed = `${name}-v2`;
    const updated = await call('PUT', `/api/v1/roles/${created.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: renamed, permissionCodes: ['reports.view', 'alerts.view'] },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as RoleBody;
    expect(updatedBody.name).toBe(renamed);
    expect(updatedBody.permissionCodes.sort()).toEqual(['alerts.view', 'reports.view']);

    await assertAudited(query, {
      action: ROLE_CREATED_ACTION,
      entityType: 'role',
      entityId: String(created.id),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: null,
    });
    await assertAudited(query, {
      action: ROLE_UPDATED_ACTION,
      entityId: String(created.id),
      before: { name, permissionCodes: ['reports.view'] },
      after: { name: renamed, permissionCodes: ['reports.view', 'alerts.view'] },
    });
  });

  it('rejects a duplicate role name in the same scope with 422, not 409', async () => {
    const name = uniqueName('dupe-role');
    await createRoleViaApi({ name }, { token: admin.accessToken, tenantId: tenantA });

    const response = await call('POST', '/api/v1/roles', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('ROLE_NAME_DUPLICATE');

    // The SAME name in a DIFFERENT tenant is fine — uniqueness is per scope, not global.
    const other = await call('POST', '/api/v1/roles', {
      token: adminB.accessToken,
      tenantId: tenantB,
      body: { name },
    });
    expect(other.status).toBe(201);
    createdRoleIds.push(((await other.json()) as RoleBody).id);
  });

  it('rejects a permission code outside the seeded catalog with 422', async () => {
    const response = await call('POST', '/api/v1/roles', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('bogus-role'), permissionCodes: ['leads.telepathy'] },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('ROLE_PERMISSION_NOT_FOUND');
  });

  it('refuses to put a permission on a role that the caller does not hold (F-034)', async () => {
    const response = await call('POST', '/api/v1/roles', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('escalating'), permissionCodes: ['leads.delete'] },
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as ProblemBody).code).toBe(
      'ROLE_PERMISSION_EXCEEDS_CALLER_GRANT',
    );
  });

  it('requires global.manage_global_defaults to create a global role', async () => {
    const denied = await call('POST', '/api/v1/roles', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('global-role'), global: true },
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as ProblemBody).code).toBe('ROLE_GLOBAL_FORBIDDEN');

    const allowed = await createRoleViaApi(
      { name: uniqueName('global-role-ok'), global: true },
      { token: internal.accessToken, tenantId: tenantA },
    );
    expect(allowed.tenantId).toBeNull();
  });

  it('refuses a tenant-scoped admin the WRITE path on a global role, while still allowing the read', async () => {
    const globalRole = await createRoleViaApi(
      { name: uniqueName('global-write'), global: true },
      { token: internal.accessToken, tenantId: tenantA },
    );

    // Read: global rows are universally visible (spec §12.4).
    const read = await call('GET', `/api/v1/roles/${globalRole.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(read.status).toBe(200);

    // Write: refused, and indistinguishable from a missing id (F-032).
    const write = await call('PUT', `/api/v1/roles/${globalRole.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('hijacked') },
    });
    expect(write.status).toBe(404);
    expect(((await write.json()) as ProblemBody).code).toBe('ROLE_NOT_FOUND');
  });

  // --------------------------------------------------------------- role usage + disable

  it('lists assigned users and groups before disable, and blocks a disable that is in use', async () => {
    const role = await createRoleViaApi(
      { name: uniqueName('used-role'), permissionCodes: ['reports.view'] },
      { token: admin.accessToken, tenantId: tenantA },
    );
    const group = await createGroupViaApi(
      { name: uniqueName('using-group') },
      { token: admin.accessToken, tenantId: tenantA },
    );

    await fixtures.assignRole(appUserId(member), role.id, tenantA);
    await fixtures.assignRoleToGroup(group.id, role.id);

    const usageResponse = await call('GET', `/api/v1/roles/${role.id}/usage`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(usageResponse.status).toBe(200);
    const usage = (await usageResponse.json()) as RoleUsageBody;

    expect(usage.users.map((user) => user.userId)).toContain(appUserId(member));
    expect(usage.users.map((user) => user.email)).toContain(member.email);
    expect(usage.groups.map((entry) => entry.groupId)).toContain(group.id);

    const blocked = await call('POST', `/api/v1/roles/${role.id}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(blocked.status).toBe(409);
    const problem = (await blocked.json()) as ProblemBody;
    expect(problem.code).toBe('ROLE_IN_USE');
    // The message names the blast radius, so an administrator can act on it.
    expect(problem.detail).toContain(member.email);

    // Still active — a refused disable must not have half-applied.
    const stillActive = await query<{ is_active: boolean }>(
      'select is_active from roles where id = $1',
      [role.id],
    );
    expect(stillActive[0]?.is_active).toBe(true);

    const forced = await call('POST', `/api/v1/roles/${role.id}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { force: true },
    });
    expect(forced.status).toBe(200);
    expect(await forced.text()).toBe('');

    const after = await query<{ is_active: boolean }>('select is_active from roles where id = $1', [
      role.id,
    ]);
    expect(after[0]?.is_active).toBe(false);

    // Disable is NOT a delete: the assignments survive for history (AC-029/AC-030).
    const assignments = await query<{ n: string }>(
      'select count(*)::text as n from user_roles where role_id = $1',
      [role.id],
    );
    expect(Number(assignments[0]?.n)).toBe(1);

    await assertAudited(query, {
      action: ROLE_DISABLED_ACTION,
      entityType: 'role',
      entityId: String(role.id),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
    });
  });

  it('blocks disabling — even with force — a role the caller holds that carries admin codes', async () => {
    const role = await createRoleViaApi(
      { name: uniqueName('self-lockout'), permissionCodes: ['roles.view'] },
      { token: admin.accessToken, tenantId: tenantA },
    );
    await fixtures.assignRole(appUserId(admin), role.id, tenantA);

    const response = await call('POST', `/api/v1/roles/${role.id}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { force: true },
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as ProblemBody).code).toBe('ROLE_SELF_LOCKOUT');
  });

  it('blocks removing an access-administration code from a role the caller holds', async () => {
    const role = await createRoleViaApi(
      { name: uniqueName('narrowing'), permissionCodes: ['roles.view', 'reports.view'] },
      { token: admin.accessToken, tenantId: tenantA },
    );
    await fixtures.assignRole(appUserId(admin), role.id, tenantA);

    const denied = await call('PUT', `/api/v1/roles/${role.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: role.name, permissionCodes: ['reports.view'] },
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as ProblemBody).code).toBe('ROLE_SELF_LOCKOUT');

    // Removing a NON-admin code from the same role is ungated — the guard is narrow.
    const allowed = await call('PUT', `/api/v1/roles/${role.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: role.name, permissionCodes: ['roles.view'] },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  // ------------------------------------------------------------------- role isolation

  it('confines every by-id role route to the ambient tenant', async () => {
    const roleInB = await createRoleViaApi(
      { name: uniqueName('b-only-role') },
      { token: adminB.accessToken, tenantId: tenantB },
    );

    for (const [method, path, body] of [
      ['GET', `/api/v1/roles/${roleInB.id}`, undefined],
      ['GET', `/api/v1/roles/${roleInB.id}/usage`, undefined],
      ['PUT', `/api/v1/roles/${roleInB.id}`, { name: uniqueName('stolen') }],
      ['POST', `/api/v1/roles/${roleInB.id}/disable`, {}],
    ] as const) {
      const response = await call(method, path, {
        token: admin.accessToken,
        tenantId: tenantA,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path} leaked tenant B`).toBe(404);
      expect(((await response.json()) as ProblemBody).code).toBe('ROLE_NOT_FOUND');
    }

    // The list is filtered too, and the owner still sees it — so the 404s above are confinement.
    const listed = await call('GET', '/api/v1/roles', {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    const roles = (await listed.json()) as RoleBody[];
    expect(roles.some((role) => role.id === roleInB.id)).toBe(false);

    const ownerView = await call('GET', `/api/v1/roles/${roleInB.id}`, {
      token: adminB.accessToken,
      tenantId: tenantB,
    });
    expect(ownerView.status).toBe(200);
  });

  // ----------------------------------------------------------------------- groups CRUD

  it('creates, reads, updates and disables a group with member/role/permission subresources', async () => {
    const name = uniqueName('group');
    const group = await createGroupViaApi(
      { name },
      { token: admin.accessToken, tenantId: tenantA },
    );

    expect(group).toEqual({
      id: expect.any(Number),
      tenantId: tenantA,
      name,
      isActive: true,
    });

    const role = await createRoleViaApi(
      { name: uniqueName('group-role'), permissionCodes: ['alerts.view'] },
      { token: admin.accessToken, tenantId: tenantA },
    );

    // members
    const added = await call(`POST`, `/api/v1/groups/${group.id}/members`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { userId: appUserId(member) },
    });
    expect(added.status).toBe(200);

    const duplicate = await call('POST', `/api/v1/groups/${group.id}/members`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { userId: appUserId(member) },
    });
    expect(duplicate.status).toBe(422);
    expect(((await duplicate.json()) as ProblemBody).code).toBe('GROUP_USER_ALREADY_MEMBER');

    // roles + direct permissions
    const rolesSet = await call('POST', `/api/v1/groups/${group.id}/roles`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { roleIds: [role.id] },
    });
    expect(rolesSet.status).toBe(200);

    const permissionsSet = await call('POST', `/api/v1/groups/${group.id}/permissions`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { permissionCodes: ['reports.view'] },
    });
    expect(permissionsSet.status).toBe(200);

    const detail = await call('GET', `/api/v1/groups/${group.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as GroupDetailBody;
    expect(detailBody.memberUserIds).toEqual([appUserId(member)]);
    expect(detailBody.roleIds).toEqual([role.id]);
    expect(detailBody.permissionCodes).toEqual(['reports.view']);

    // The grants reach the member through the resolver, not just the join tables.
    const memberAccess = await call(`GET`, `/api/v1/users/${appUserId(member)}/effective-access`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(memberAccess.status).toBe(200);
    const access = (await memberAccess.json()) as {
      effectivePermissionsByTenant: Record<string, string[]>;
    };
    expect(access.effectivePermissionsByTenant[String(tenantA)]).toEqual(
      expect.arrayContaining(['alerts.view', 'reports.view']),
    );

    // rename
    const renamed = `${name}-v2`;
    const updated = await call('PUT', `/api/v1/groups/${group.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: renamed },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as GroupBody).name).toBe(renamed);

    // member removal (POST .../remove, never DELETE)
    const removed = await call(
      'POST',
      `/api/v1/groups/${group.id}/members/${appUserId(member)}/remove`,
      { token: admin.accessToken, tenantId: tenantA },
    );
    expect(removed.status).toBe(200);

    const notMember = await call(
      'POST',
      `/api/v1/groups/${group.id}/members/${appUserId(member)}/remove`,
      { token: admin.accessToken, tenantId: tenantA },
    );
    expect(notMember.status).toBe(422);
    expect(((await notMember.json()) as ProblemBody).code).toBe('GROUP_USER_NOT_MEMBER');

    // disable is a flag, not a delete
    const disabled = await call('POST', `/api/v1/groups/${group.id}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(disabled.status).toBe(200);
    const row = await query<{ is_active: boolean }>(
      'select is_active from user_groups where id = $1',
      [group.id],
    );
    expect(row[0]?.is_active).toBe(false);
    expect(
      Number(
        (
          await query<{ n: string }>(
            'select count(*)::text as n from group_permissions where group_id = $1',
            [group.id],
          )
        )[0]?.n,
      ),
      'disabling a group destroyed its grants',
    ).toBe(1);

    // Every mutation is audited (AC-024, V-031).
    for (const action of [
      GROUP_CREATED_ACTION,
      GROUP_UPDATED_ACTION,
      GROUP_DISABLED_ACTION,
      GROUP_MEMBER_ADDED_ACTION,
      GROUP_MEMBER_REMOVED_ACTION,
      GROUP_ROLES_SET_ACTION,
      GROUP_PERMISSIONS_SET_ACTION,
    ]) {
      await assertAudited(query, {
        action,
        entityType: 'group',
        entityId: String(group.id),
        actorUserId: appUserId(admin),
        tenantId: tenantA,
      });
    }
  }, 60_000);

  it('rejects a duplicate group name in the same scope with 422', async () => {
    const name = uniqueName('dupe-group');
    await createGroupViaApi({ name }, { token: admin.accessToken, tenantId: tenantA });

    const response = await call('POST', '/api/v1/groups', {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('GROUP_NAME_DUPLICATE');
  });

  // --------------------------------------------------- group escalation ceiling (F-031/F-033)

  it('refuses to attach a permission or role to a group that exceeds the caller’s own grants', async () => {
    const group = await createGroupViaApi(
      { name: uniqueName('ceiling-group') },
      { token: admin.accessToken, tenantId: tenantA },
    );

    const deniedPermission = await call('POST', `/api/v1/groups/${group.id}/permissions`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { permissionCodes: ['leads.delete'] },
    });
    expect(deniedPermission.status).toBe(403);
    expect(((await deniedPermission.json()) as ProblemBody).code).toBe(
      'GROUP_PERMISSION_EXCEEDS_CALLER_GRANT',
    );

    // A role carrying a code the caller lacks is refused by the same ceiling — the role route is
    // the cheaper bypass of the permission route and must not be open.
    const overprivilegedRole = await fixtures.createRole({
      tenantId: tenantA,
      permissions: ['leads.delete'],
    });
    const deniedRole = await call('POST', `/api/v1/groups/${group.id}/roles`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { roleIds: [overprivilegedRole] },
    });
    expect(deniedRole.status).toBe(403);
    expect(((await deniedRole.json()) as ProblemBody).code).toBe(
      'GROUP_PERMISSION_EXCEEDS_CALLER_GRANT',
    );

    // And joining someone to an already-over-privileged group is refused too (F-033) — otherwise
    // the ceiling above is bypassed by whoever created the group first.
    const escalated = await fixtures.createGroup({
      tenantId: tenantA,
      permissions: ['leads.delete'],
    });
    const deniedJoin = await call('POST', `/api/v1/groups/${escalated}/members`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { userId: appUserId(member) },
    });
    expect(deniedJoin.status).toBe(403);
    expect(((await deniedJoin.json()) as ProblemBody).code).toBe(
      'GROUP_PERMISSION_EXCEEDS_CALLER_GRANT',
    );
  });

  it('refuses a cross-tenant user as a group member, with the same not-found a missing user gives', async () => {
    const group = await createGroupViaApi(
      { name: uniqueName('member-scope') },
      { token: admin.accessToken, tenantId: tenantA },
    );

    const response = await call('POST', `/api/v1/groups/${group.id}/members`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { userId: appUserId(adminB) },
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('GROUP_USER_NOT_FOUND');
  });

  it('blocks a caller from removing themselves from a group that conveys admin permissions', async () => {
    const group = await createGroupViaApi(
      { name: uniqueName('leave-guard') },
      { token: admin.accessToken, tenantId: tenantA },
    );

    await call('POST', `/api/v1/groups/${group.id}/permissions`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { permissionCodes: ['roles.view'] },
    });
    await call('POST', `/api/v1/groups/${group.id}/members`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { userId: appUserId(admin) },
    });

    const denied = await call(
      'POST',
      `/api/v1/groups/${group.id}/members/${appUserId(admin)}/remove`,
      { token: admin.accessToken, tenantId: tenantA },
    );
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as ProblemBody).code).toBe('GROUP_SELF_LOCKOUT');

    // Another administrator can always do it — the guard is about self-removal, not the action.
    const byOther = await call(
      'POST',
      `/api/v1/groups/${group.id}/members/${appUserId(admin)}/remove`,
      { token: internal.accessToken, tenantId: tenantA },
    );
    expect(byOther.status, await byOther.clone().text()).toBe(200);
  });

  // ------------------------------------------------------------------ group isolation

  it('confines every by-id group route to the ambient tenant', async () => {
    const groupInB = await createGroupViaApi(
      { name: uniqueName('b-only-group') },
      { token: adminB.accessToken, tenantId: tenantB },
    );

    for (const [method, path, body] of [
      ['GET', `/api/v1/groups/${groupInB.id}`, undefined],
      ['PUT', `/api/v1/groups/${groupInB.id}`, { name: uniqueName('stolen-group') }],
      ['POST', `/api/v1/groups/${groupInB.id}/disable`, {}],
      ['POST', `/api/v1/groups/${groupInB.id}/members`, { userId: 1 }],
      ['POST', `/api/v1/groups/${groupInB.id}/members/1/remove`, undefined],
      ['POST', `/api/v1/groups/${groupInB.id}/roles`, { roleIds: [] }],
      ['POST', `/api/v1/groups/${groupInB.id}/permissions`, { permissionCodes: [] }],
    ] as const) {
      const response = await call(method, path, {
        token: admin.accessToken,
        tenantId: tenantA,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path} leaked tenant B`).toBe(404);
      expect(((await response.json()) as ProblemBody).code).toBe('GROUP_NOT_FOUND');
    }

    const listed = await call('GET', '/api/v1/groups', {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    const groups = (await listed.json()) as GroupBody[];
    expect(groups.some((group) => group.id === groupInB.id)).toBe(false);
  });

  it('rejects a role from another tenant on a group with a not-found, never a mismatch oracle', async () => {
    const group = await createGroupViaApi(
      { name: uniqueName('oracle-group') },
      { token: admin.accessToken, tenantId: tenantA },
    );
    const roleInB = await createRoleViaApi(
      { name: uniqueName('b-role') },
      { token: adminB.accessToken, tenantId: tenantB },
    );

    const response = await call('POST', `/api/v1/groups/${group.id}/roles`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { roleIds: [roleInB.id] },
    });

    // F-035: the invisible-role case must be indistinguishable from a nonexistent id.
    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('GROUP_ROLE_NOT_FOUND');
  });
});
