/**
 * Grant-graph lookup against the real schema (T-012, AC-018, V-023).
 *
 * Ported from `EffectivePermissionResolverTests.cs` — the same fixtures, the same assertions, over
 * real rows and real joins. Nothing is mocked: if a column, join or scope column were wrong, these
 * fail, which a unit test over a hand-built graph could never do.
 *
 * The round-trip count is MEASURED (Kysely's `log` hook counts executed statements), because "no
 * N+1" is a claim about what the database is asked to do, and the natural way to write this
 * repository issues one query per group and per role.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  computeEffectivePermissions,
  createEffectiveAccess,
} from '../../domains/rbac/effective-permissions.js';
import { PERMISSION_CODES } from '../../domains/rbac/permission-catalog.js';
import { loadGrantGraph } from '../../domains/rbac/repository.js';
import type { Database } from '../../lib/db/index.js';
import { poolerPoolConfig, toTenantId, type TenantId } from '../../lib/db/index.js';
import { TestAuthFixtures } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures, randomTenantId } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('rbac: grant-graph lookup', probe);

/** Four distinct real catalog codes, one per grant path, so contributions never alias. */
const P_DIRECT = 'leads.view';
const P_ROLE = 'leads.create';
const P_GROUP_ROLE = 'quotes.view';
const P_GROUP_DIRECT = 'quotes.create';
/** Granted globally in every fixture: proves an exclusion is targeted, not a blanket denial. */
const P_CONTROL = 'alerts.view';

describeStack(title, () => {
  let stack: LocalStack;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  /** Every statement Kysely executes, so the round-trip count is evidence rather than assertion. */
  let executed: string[];

  let userId: number;
  let tenantA: TenantId;
  let tenantB: TenantId;

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    auth = new TestAuthFixtures(stack);
    fixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));

    executed = [];
    // The PROJECT's pool configuration, not a bare `new pg.Pool(...)`. It installs the int8 type
    // parser (lib/db/pool.ts), without which `tenant_id` arrives as a STRING and every
    // `scope === tenantId` comparison is false — i.e. the scope predicate silently denies every
    // tenant-scoped grant. Found by this suite failing when it was first written against a raw
    // pool; kept wired this way so the test exercises the same driver setup production uses.
    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') executed.push(event.query.sql);
      },
    });

    const user = await auth.createTestUserWithSession({ label: 'rbac-repo' });
    if (user.appUserId === null) throw new Error('fixture user has no application users row');
    userId = Number(user.appUserId);

    tenantA = toTenantId(randomTenantId());
    tenantB = toTenantId(randomTenantId());

    // The AC-018 fixture: all four grant paths, in tenant A only.
    await fixtures.grantDirectPermission(userId, P_DIRECT, tenantA);

    const directRole = await fixtures.createRole({ tenantId: tenantA, permissions: [P_ROLE] });
    await fixtures.assignRole(userId, directRole, tenantA);

    const groupRole = await fixtures.createRole({ tenantId: tenantA, permissions: [P_GROUP_ROLE] });
    const group = await fixtures.createGroup({
      tenantId: tenantA,
      permissions: [P_GROUP_DIRECT],
    });
    await fixtures.assignRoleToGroup(group, groupRole);
    await fixtures.addGroupMember(group, userId);

    // Plus one GLOBAL direct grant, the positive control for the cross-tenant cases.
    await fixtures.grantDirectPermission(userId, P_CONTROL, null);
  });

  afterAll(async () => {
    await fixtures?.cleanup();
    await auth?.cleanup();
    await db?.destroy();
  });

  it('returns every grant path for the user', async () => {
    const graph = await loadGrantGraph(db, userId);

    expect(graph.userId).toBe(userId);
    expect([...new Set(graph.grants.map((g) => g.source))].sort()).toEqual([
      'direct',
      'group_direct',
      'group_role',
      'role',
    ]);
  });

  it('returns tenant scopes as numbers, not bigint strings', async () => {
    // The scope predicate is a strict `===` against a numeric TenantId, so a scope arriving as a
    // string would deny every tenant-scoped grant while leaving global grants working — a failure
    // that looks like a permissions bug and is actually a driver-configuration bug. Pinned here so
    // the next person gets the cause, not the symptom.
    const graph = await loadGrantGraph(db, userId);

    const scopes = graph.grants.flatMap((g) => g.pathScopes).filter((s) => s !== null);
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(typeof scope).toBe('number');
    }
  });

  it('resolves tenant A to exactly the union of the four grant paths plus the global control', async () => {
    const graph = await loadGrantGraph(db, userId);

    const effective = computeEffectivePermissions(graph, { tenantId: tenantA });

    expect([...effective].sort()).toEqual(
      [P_DIRECT, P_ROLE, P_GROUP_ROLE, P_GROUP_DIRECT, P_CONTROL].sort(),
    );
  });

  it.each([
    ['direct', P_DIRECT],
    ['role', P_ROLE],
    ['group-role', P_GROUP_ROLE],
    ['group-direct', P_GROUP_DIRECT],
  ])('confers the tenant-A permission granted via the %s path', async (_label, code) => {
    const graph = await loadGrantGraph(db, userId);

    expect(computeEffectivePermissions(graph, { tenantId: tenantA }).has(code)).toBe(true);
  });

  it('confers none of the tenant-A grants in tenant B, while the global grant still applies', async () => {
    const graph = await loadGrantGraph(db, userId);

    const effective = computeEffectivePermissions(graph, { tenantId: tenantB });

    for (const code of [P_DIRECT, P_ROLE, P_GROUP_ROLE, P_GROUP_DIRECT]) {
      expect(effective.has(code)).toBe(false);
    }
    // Positive control: tenant B is not empty merely because everything was denied.
    expect(effective.has(P_CONTROL)).toBe(true);
  });

  it('resolves only global grants in the global (zero-membership Internal) scope', async () => {
    const graph = await loadGrantGraph(db, userId);

    expect([...computeEffectivePermissions(graph, { tenantId: null })]).toEqual([P_CONTROL]);
  });

  it('loads the whole grant graph in a single round trip', async () => {
    executed.length = 0;

    await loadGrantGraph(db, userId);

    expect(executed).toHaveLength(1);
    // And it really is the union — not one branch that happens to be one query.
    const [statement] = executed;
    expect(statement?.match(/union all/gi)).toHaveLength(3);
  });

  it('still issues one round trip when the user belongs to several groups and roles', async () => {
    // The N+1 shape this guards against only shows up with more than one group/role: a
    // per-membership query loop passes the single-group case above and fails here.
    const extraFixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      for (let i = 0; i < 3; i += 1) {
        const role = await extraFixtures.createRole({
          tenantId: tenantA,
          permissions: [PERMISSION_CODES[40 + i]!],
        });
        await extraFixtures.assignRole(userId, role, tenantA);

        const groupRole = await extraFixtures.createRole({
          tenantId: tenantA,
          permissions: [PERMISSION_CODES[50 + i]!],
        });
        const group = await extraFixtures.createGroup({
          tenantId: tenantA,
          permissions: [PERMISSION_CODES[60 + i]!],
        });
        await extraFixtures.assignRoleToGroup(group, groupRole);
        await extraFixtures.addGroupMember(group, userId);
      }

      executed.length = 0;
      const graph = await loadGrantGraph(db, userId);

      expect(executed).toHaveLength(1);
      // Positive control: the extra grants were actually loaded, so the count is not 1 because
      // the query silently returned nothing.
      const effective = computeEffectivePermissions(graph, { tenantId: tenantA });
      for (let i = 0; i < 3; i += 1) {
        expect(effective.has(PERMISSION_CODES[40 + i]!)).toBe(true);
        expect(effective.has(PERMISSION_CODES[50 + i]!)).toBe(true);
        expect(effective.has(PERMISSION_CODES[60 + i]!)).toBe(true);
      }
    } finally {
      await extraFixtures.cleanup();
    }
  });

  it('excludes grants reached through a disabled role or a disabled group', async () => {
    const local = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      const disabledRole = await local.createRole({
        tenantId: tenantA,
        isActive: false,
        permissions: ['tenants.view'],
      });
      await local.assignRole(userId, disabledRole, tenantA);

      const roleInDisabledGroup = await local.createRole({
        tenantId: tenantA,
        permissions: ['tenants.create'],
      });
      const disabledGroup = await local.createGroup({
        tenantId: tenantA,
        isActive: false,
        permissions: ['tenants.edit'],
      });
      await local.assignRoleToGroup(disabledGroup, roleInDisabledGroup);
      await local.addGroupMember(disabledGroup, userId);

      const effective = computeEffectivePermissions(await loadGrantGraph(db, userId), {
        tenantId: tenantA,
      });

      expect(effective.has('tenants.view')).toBe(false);
      expect(effective.has('tenants.create')).toBe(false);
      expect(effective.has('tenants.edit')).toBe(false);
      // Positive control: the enabled grants from the shared fixture are unaffected.
      expect(effective.has(P_DIRECT)).toBe(true);
      expect(effective.has(P_GROUP_ROLE)).toBe(true);
    } finally {
      await local.cleanup();
    }
  });

  it('drops a group grant once the membership row is removed', async () => {
    const local = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      const group = await local.createGroup({ tenantId: tenantA, permissions: ['reports.view'] });
      await local.addGroupMember(group, userId);

      const before = computeEffectivePermissions(await loadGrantGraph(db, userId), {
        tenantId: tenantA,
      });
      expect(before.has('reports.view')).toBe(true);

      await auth.query('delete from group_members where group_id = $1 and user_id = $2', [
        group,
        userId,
      ]);

      const after = computeEffectivePermissions(await loadGrantGraph(db, userId), {
        tenantId: tenantA,
      });
      expect(after.has('reports.view')).toBe(false);
      expect(after.has(P_DIRECT)).toBe(true);
    } finally {
      await local.cleanup();
    }
  });

  it('surfaces visibility breadth from a real grant, scoped to its tenant', async () => {
    const local = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));
    try {
      await local.grantDirectPermission(userId, 'leads.view_all', tenantA);

      const graph = await loadGrantGraph(db, userId);

      expect(createEffectiveAccess(graph, { tenantId: tenantA }).canViewAll('leads')).toBe(true);
      expect(createEffectiveAccess(graph, { tenantId: tenantA }).canViewAll('quotes')).toBe(false);
      expect(createEffectiveAccess(graph, { tenantId: tenantB }).canViewAll('leads')).toBe(false);
    } finally {
      await local.cleanup();
    }
  });

  it('resolves an empty set for a user with no grants at all', async () => {
    const stranger = await auth.createTestUserWithSession({ label: 'rbac-nogrants' });
    if (stranger.appUserId === null) throw new Error('fixture user has no application users row');

    const graph = await loadGrantGraph(db, Number(stranger.appUserId));

    expect(graph.grants).toHaveLength(0);
    expect(computeEffectivePermissions(graph, { tenantId: tenantA }).size).toBe(0);
  });

  it('agrees with the permission catalog seeded in the database', async () => {
    // Closes the drift loop: unit tests pin the TS constant to seed.sql, this pins it to the
    // table the foreign keys actually reference.
    const rows = await auth.query<{ code: string }>('select code from permissions order by code');

    expect(rows.map((r) => r.code)).toEqual([...PERMISSION_CODES].sort());
  });
});
