/**
 * Tenant Manager, end to end (T-016; AC-024, AC-026, AC-027, AC-028; V-031, V-034, V-035, V-037).
 *
 * Nothing here is stubbed: real signed-in sessions (T-011's `createTestUserWithSession`), the real
 * grant graph, the real Hono pipeline through `app.fetch`, the real `create_tenant_partitions`
 * function, the real 93-row global template, and a real `audit_log` read-back.
 *
 * MEASURED REFERENCE SEMANTICS PINNED BELOW
 * =========================================
 *   route permissions                 TenantEndpoints.cs:25-30
 *   duplicate active name -> 422      TenantEndpoints.cs:89   (NOT 409 — measured)
 *   already removed / not removed 409 TenantEndpoints.cs:91-92
 *   includeRemoved needs view_removed ListTenantsQueryHandler.cs:25-33
 *   create -> 201 + Location          TenantEndpoints.cs:56-58
 *   remove/restore -> 200 empty body  TenantEndpoints.cs:75,83
 *   creation order                    TenantStore.cs:36-46 + CreateTenantCommandHandler.cs:63-85
 *
 * WHY THE FAULT-INJECTION TESTS LOOK LIKE THAT
 * ============================================
 * "Creation is transactional" is not observable from a passing create. Each stage of the creation
 * is therefore forced to fail against the REAL database — the partition function is temporarily
 * replaced with one that raises, the live template is corrupted, and BEFORE INSERT triggers are
 * installed on `tenant_settings` and `audit_log` that raise for this suite's fixtures only — and
 * each time the assertion is that NOTHING survives: no tenant row, no partitions, no reference
 * rows, no settings row, no audit row. Every injection is reverted in a `finally`, and every
 * trigger is scoped by tenant name so a concurrently running suite cannot be hit by it.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CROSS_TENANT_ACCESS_ACTION } from '../../domains/audit/index.js';
import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { REFERENCE_SEEDED_ACTION } from '../../domains/reference-data/index.js';
import {
  TENANT_CREATED_ACTION,
  TENANT_REMOVED_ACTION,
  TENANT_RESTORED_ACTION,
  TENANT_UPDATED_ACTION,
} from '../../domains/tenants/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../lib/errors/problem.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('Tenant Manager: /api/v1/tenants', probe);

/** Test-owned tenant-scoped probe, for the "removed tenants are not switch targets" case. */
const SCOPED_PROBE = '/api/v1/__tenant-scoped-probe';

interface ProblemBody {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
  readonly correlationId?: string;
}

interface TenantBody {
  readonly id: number;
  readonly name: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly status: string;
  readonly removedAt: string | null;
}

interface CreateBody {
  readonly tenantId: number;
  readonly name: string;
  readonly status: string;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Full global tenant-management rights. */
  let admin: TestUserSession;
  /** Global `tenants.view` only — the positive control that denials are not blanket. */
  let viewer: TestUserSession;
  /** Every tenant permission, but granted INSIDE a tenant rather than globally. */
  let tenantScoped: TestUserSession;
  /** Holds an unrelated global permission and nothing tenant-related. */
  let stranger: TestUserSession;

  let scopeTenant: number;
  const createdTenantIds: number[] = [];

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) {
      throw new Error(`fixture user ${session.email} has no application users row`);
    }
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
      tenants: { db },
      globalTemplate: { db },
      registerRoutes: (api) => {
        // A TENANT-SCOPED route (not on GLOBAL_ROUTE_PREFIXES), used only to prove that a
        // soft-removed tenant stops being a usable switch target.
        api.get('/__tenant-scoped-probe', (c) => c.json({ tenantId: c.get('tenantId') ?? null }));
      },
    });
  }

  interface RequestOptions {
    readonly token?: string;
    readonly body?: unknown;
    readonly tenantId?: number | string;
  }

  async function call(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Response> {
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
    return `t016-${label}-${crypto.randomUUID()}`;
  }

  /** Creates a tenant through the API as the admin and records it for teardown. */
  async function createTenantViaApi(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<CreateBody> {
    const response = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name, ...extra },
    });
    expect(response.status, `create ${name} failed: ${await response.clone().text()}`).toBe(201);
    const created = (await response.json()) as CreateBody;
    createdTenantIds.push(created.tenantId);
    return created;
  }

  /** Every `public` table LIST-partitioned on tenant_id — the same set the SQL function walks. */
  async function partitionedParents(): Promise<string[]> {
    const rows = await query<{ relname: string }>(
      `select c.relname
         from pg_partitioned_table p
         join pg_class c on c.oid = p.partrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and p.partstrat = 'l' and p.partnatts = 1
          and (select a.attname from pg_attribute a
                where a.attrelid = c.oid and a.attnum = p.partattrs[0]) = 'tenant_id'
        order by c.relname`,
    );
    return rows.map((row) => row.relname);
  }

  async function relationExists(name: string): Promise<boolean> {
    const rows = await query<{ present: boolean }>(
      `select to_regclass('public.' || $1) is not null as present`,
      [name],
    );
    return rows[0]?.present === true;
  }

  /** The id the NEXT tenant insert will consume — used to hunt for debris after a rollback. */
  async function lastTenantSequenceValue(): Promise<number> {
    const rows = await query<{ last_value: string }>(
      `select last_value::text as last_value from pg_sequences
        where schemaname = 'public' and sequencename = (
          select split_part(pg_get_serial_sequence('tenants','id'), '.', 2))`,
    );
    return Number(rows[0]?.last_value ?? 0);
  }

  async function countRows(sql: string, params: unknown[] = []): Promise<number> {
    const rows = await query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Asserts a failed creation left NO trace anywhere. `attemptedName` covers the tenant row;
   * `attemptedId` (the identity value the rolled-back insert consumed) covers the partitions and
   * every child row, which no longer have a name to be found by.
   */
  async function assertNothingPersisted(attemptedName: string, attemptedId: number): Promise<void> {
    expect(
      await countRows('select count(*)::text as n from tenants where name = $1', [attemptedName]),
      'a tenant row survived a failed creation',
    ).toBe(0);
    expect(
      await countRows('select count(*)::text as n from tenants where id = $1', [attemptedId]),
    ).toBe(0);
    expect(
      await relationExists(`reference_items_p${attemptedId}`),
      'a reference_items partition survived a failed creation',
    ).toBe(false);
    expect(
      await relationExists(`tenant_settings_p${attemptedId}`),
      'a tenant_settings partition survived a failed creation',
    ).toBe(false);
    expect(
      await countRows('select count(*)::text as n from reference_items where tenant_id = $1', [
        attemptedId,
      ]),
      'seeded reference rows survived a failed creation',
    ).toBe(0);
    expect(
      await countRows('select count(*)::text as n from tenant_settings where tenant_id = $1', [
        attemptedId,
      ]),
      'a settings row survived a failed creation',
    ).toBe(0);
    expect(
      // `entity_type` is load-bearing, not decoration: `entity_id` is only unique WITHIN a type, so
      // without this predicate any other suite's audit row (broker, broker_contact, party — all of
      // which now exist) whose id happens to equal `attemptedId` is counted as a surviving tenant
      // audit row and fails this assertion. That is not hypothetical: T-023 hit it for real when an
      // aborted run left `party` rows with low ids, and it reddened this file rather than its own.
      await countRows(
        "select count(*)::text as n from audit_log where entity_type = 'tenant' and entity_id = $1",
        [String(attemptedId)],
      ),
      'an audit row survived a failed creation',
    ).toBe(0);
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

    admin = await auth.createTestUserWithSession({ label: 'tenant-admin' });
    viewer = await auth.createTestUserWithSession({ label: 'tenant-viewer' });
    tenantScoped = await auth.createTestUserWithSession({ label: 'tenant-scopedgrant' });
    stranger = await auth.createTestUserWithSession({ label: 'tenant-stranger' });

    for (const permission of [
      'tenants.view',
      'tenants.create',
      'tenants.edit',
      'tenants.deactivate',
      'tenants.restore',
      'tenants.view_removed',
      'global.manage_templates',
    ] as const) {
      await fixtures.grantDirectPermission(appUserId(admin), permission, null);
    }

    // Global view only: proves `includeRemoved` is a SEPARATE gate, and that create/edit/remove
    // are not opened by the view permission.
    await fixtures.grantDirectPermission(appUserId(viewer), 'tenants.view', null);

    // A tenant to scope the tenant-scoped grants to, created through the API so it has partitions.
    // (Created after the admin's grants exist.)
    scopeTenant = (await createTenantViaApi(uniqueName('scope'))).tenantId;

    for (const permission of [
      'tenants.view',
      'tenants.create',
      'tenants.edit',
      'tenants.deactivate',
      'tenants.restore',
      'tenants.view_removed',
    ] as const) {
      await fixtures.grantDirectPermission(appUserId(tenantScoped), permission, scopeTenant);
    }

    // Deliberately a DIFFERENT global permission: proves the guards check the required code rather
    // than "holds any global grant".
    await fixtures.grantDirectPermission(appUserId(stranger), 'reports.view', null);
  }, 120_000);

  afterAll(async () => {
    if (!probe.available) return;

    const parents = await partitionedParents().catch(() => []);
    for (const tenantId of createdTenantIds) {
      for (const parent of parents) {
        await query(`drop table if exists public.${parent}_p${tenantId}`).catch(() => undefined);
      }
      await query('delete from reference_items where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      await query('delete from tenant_settings where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      // Two statements, not one `or`: `entity_id` is text and `tenant_id` is bigint, so a single
      // parameter cannot serve both without a `bigint = text` type error — which, being caught
      // below, would silently leave audit debris behind instead of failing.
      //
      // `entity_type = 'tenant'` is mandatory here and is the more dangerous of the two omissions:
      // `entity_id` is unique only WITHIN a type, so without it this cleanup DELETES other suites'
      // audit rows (broker, broker_contact, party) that happen to share the id — destroying another
      // test's fixtures rather than merely miscounting its own.
      await query("delete from audit_log where entity_type = 'tenant' and entity_id = $1", [
        String(tenantId),
      ]).catch(() => undefined);
      await query('delete from audit_log where tenant_id = $1', [tenantId]).catch(() => undefined);
      await query('delete from user_tenants where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }
    await query('delete from audit_log where action = $1', [CROSS_TENANT_ACCESS_ACTION]).catch(
      () => undefined,
    );

    await fixtures?.cleanup();
    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 120_000);

  // ------------------------------------------------------------------ CRUD contract (positive)

  it('creates a tenant with 201, a Location header, and the reference CreateTenantResult shape', async () => {
    const name = uniqueName('create');
    const response = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name, contactName: 'Ada', contactEmail: 'ada@example.com', contactPhone: '+267 1' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateBody;
    createdTenantIds.push(body.tenantId);

    expect(response.headers.get('Location')).toBe(`/api/v1/tenants/${body.tenantId}`);
    expect(body).toEqual({
      tenantId: expect.any(Number),
      name,
      status: 'active',
    });
  });

  it('returns the full TenantDto field set on GET /tenants/{id}', async () => {
    const name = uniqueName('get');
    const created = await createTenantViaApi(name, {
      contactName: 'Grace',
      contactEmail: 'grace@example.com',
      contactPhone: '+267 2',
    });

    const response = await call('GET', `/api/v1/tenants/${created.tenantId}`, {
      token: admin.accessToken,
    });

    expect(response.status).toBe(200);
    // Field-for-field contract check against TenantDto.cs:6-13 — extra or missing keys fail here.
    expect(await response.json()).toEqual({
      id: created.tenantId,
      name,
      contactName: 'Grace',
      contactEmail: 'grace@example.com',
      contactPhone: '+267 2',
      status: 'active',
      removedAt: null,
    } satisfies TenantBody);
  });

  it('updates name and contact fields and returns the updated tenant', async () => {
    const created = await createTenantViaApi(uniqueName('update'), { contactName: 'Before' });
    const newName = uniqueName('updated');

    const response = await call('PUT', `/api/v1/tenants/${created.tenantId}`, {
      token: admin.accessToken,
      body: { name: newName, contactName: 'After', contactEmail: null, contactPhone: null },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: created.tenantId,
      name: newName,
      contactName: 'After',
      status: 'active',
    });
  });

  it('does not answer 404 for a tenant that exists (positive control for the 404 cases)', async () => {
    const created = await createTenantViaApi(uniqueName('exists'));
    const response = await call('GET', `/api/v1/tenants/${created.tenantId}`, {
      token: admin.accessToken,
    });
    expect(response.status).toBe(200);
  });

  it('answers 404 for an unknown tenant id', async () => {
    const response = await call('GET', '/api/v1/tenants/2147480000', {
      token: admin.accessToken,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    // TenantErrors.NotFound (TenantErrors.cs:13-14), rendered with no `code` prefix — the tenant
    // mapper (TenantEndpoints.cs:90) passes `detail: error.Message` and no extensions.
    expect((await response.json() as ProblemBody).detail).toBe('Tenant 2147480000 was not found.');
  });

  // ------------------------------------------------------- transactional creation (AC-026/V-034)

  it('seeds every template list into the new tenant and creates all its partitions atomically', async () => {
    const templateCounts = await query<{ list_type: string; n: string }>(
      `select list_type, count(*)::text as n from default_reference_items
        where is_active group by list_type order by list_type`,
    );
    expect(templateCounts.length, 'the global template must be seeded for this test to mean anything')
      .toBeGreaterThan(0);

    const created = await createTenantViaApi(uniqueName('seeded'));

    // (a) every list type arrived, with the same per-list-type counts as the template.
    const seeded = await query<{ list_type: string; n: string }>(
      `select list_type, count(*)::text as n from reference_items
        where tenant_id = $1 group by list_type order by list_type`,
      [created.tenantId],
    );
    expect(seeded).toEqual(templateCounts);

    // (b) the guarded statuses kept their canonical key, reporting category and terminal flag.
    const wonStatus = await query<{ reporting_category: string; is_terminal: boolean }>(
      `select reporting_category, is_terminal from reference_items
        where tenant_id = $1 and list_type = 'quote_status' and canonical_key = 'won'`,
      [created.tenantId],
    );
    expect(wonStatus[0]).toEqual({ reporting_category: 'won', is_terminal: true });

    // (c) a partition exists on EVERY LIST(tenant_id)-partitioned table, including ones added by
    //     migrations written after T-003 — the catalog-driven function is supposed to cover them.
    const parents = await partitionedParents();
    expect(parents.length).toBeGreaterThan(5);
    for (const parent of parents) {
      expect(
        await relationExists(`${parent}_p${created.tenantId}`),
        `missing partition ${parent}_p${created.tenantId}`,
      ).toBe(true);
    }

    // (d) THE ROWS ACTUALLY ROUTED THERE. Without this the suite would still pass if partitions
    //     were created but seeding had already dumped everything into the DEFAULT partition.
    const routed = await query<{ partition: string; n: string }>(
      `select tableoid::regclass::text as partition, count(*)::text as n
         from reference_items where tenant_id = $1 group by 1`,
      [created.tenantId],
    );
    expect(routed).toEqual([
      { partition: `reference_items_p${created.tenantId}`, n: expect.any(String) },
    ]);

    // (e) the default tenant_settings row exists, and in its own partition too.
    const settings = await query<{ partition: string }>(
      `select tableoid::regclass::text as partition from tenant_settings where tenant_id = $1`,
      [created.tenantId],
    );
    expect(settings).toEqual([{ partition: `tenant_settings_p${created.tenantId}` }]);
  });

  it('rolls the whole creation back when PARTITION CREATION fails', async () => {
    const name = uniqueName('fault-partitions');
    const original = (
      await query<{ def: string }>(
        `select pg_get_functiondef('create_tenant_partitions(bigint)'::regprocedure) as def`,
      )
    )[0]?.def;
    expect(original, 'could not capture the real partition function').toBeTruthy();

    let response: Response;
    try {
      await query(`create or replace function create_tenant_partitions(p_tenant_id bigint)
                   returns void language plpgsql as $fn$
                   begin raise exception 'T-016 induced partition failure'; end $fn$`);

      response = await call('POST', '/api/v1/tenants', {
        token: admin.accessToken,
        body: { name },
      });
    } finally {
      await query(original as string);
    }

    expect(response.status).toBe(500);
    await assertNothingPersisted(name, await lastTenantSequenceValue());

    // The real function is back: a creation succeeds again, so the assertions above cannot be
    // satisfied by a permanently broken database.
    await createTenantViaApi(uniqueName('fault-partitions-recovered'));
  });

  it('rolls the whole creation back when TEMPLATE SEEDING fails', async () => {
    const name = uniqueName('fault-template');

    let response: Response;
    try {
      // Corrupt the guarded taxonomy the seeder verifies (TenantReferenceSeeder.cs:143-163).
      await query(
        `update default_reference_items set reporting_category = 'lost'
          where list_type = 'quote_status' and canonical_key = 'won'`,
      );

      response = await call('POST', '/api/v1/tenants', {
        token: admin.accessToken,
        body: { name },
      });
    } finally {
      await query(
        `update default_reference_items set reporting_category = 'won'
          where list_type = 'quote_status' and canonical_key = 'won'`,
      );
    }

    expect(response.status).toBe(500);
    // The tenant row AND the partitions created before the seeding step are both gone.
    await assertNothingPersisted(name, await lastTenantSequenceValue());

    await createTenantViaApi(uniqueName('fault-template-recovered'));
  });

  it('rolls the whole creation back when the SETTINGS row fails', async () => {
    const name = uniqueName('fault-settings');

    let response: Response;
    try {
      // Scoped to this fixture's tenant name so a concurrent suite cannot be affected.
      await query(`create or replace function t016_fail_settings() returns trigger
                   language plpgsql as $fn$
                   begin
                     if exists (select 1 from tenants t
                                 where t.id = new.tenant_id and t.name like 't016-fault-settings-%')
                     then raise exception 'T-016 induced settings failure'; end if;
                     return new;
                   end $fn$`);
      await query(`create trigger t016_fail_settings before insert on tenant_settings
                   for each row execute function t016_fail_settings()`);

      response = await call('POST', '/api/v1/tenants', {
        token: admin.accessToken,
        body: { name },
      });
    } finally {
      await query('drop trigger if exists t016_fail_settings on tenant_settings');
      await query('drop function if exists t016_fail_settings()');
    }

    expect(response.status).toBe(500);
    await assertNothingPersisted(name, await lastTenantSequenceValue());

    await createTenantViaApi(uniqueName('fault-settings-recovered'));
  });

  it('rolls the whole creation back when the AUDIT write fails', async () => {
    const name = uniqueName('fault-audit');

    let response: Response;
    try {
      await query(`create or replace function t016_fail_audit() returns trigger
                   language plpgsql as $fn$
                   begin
                     if new.action = 'tenant.created'
                        and new.details -> 'after' ->> 'name' like 't016-fault-audit-%'
                     then raise exception 'T-016 induced audit failure'; end if;
                     return new;
                   end $fn$`);
      await query(`create trigger t016_fail_audit before insert on audit_log
                   for each row execute function t016_fail_audit()`);

      response = await call('POST', '/api/v1/tenants', {
        token: admin.accessToken,
        body: { name },
      });
    } finally {
      await query('drop trigger if exists t016_fail_audit on audit_log');
      await query('drop function if exists t016_fail_audit()');
    }

    expect(response.status).toBe(500);
    // Also proves the `tenant.reference_seeded` audit row written EARLIER in the transaction is
    // gone: an audit trail that survives a rolled-back change is a false record.
    await assertNothingPersisted(name, await lastTenantSequenceValue());

    await createTenantViaApi(uniqueName('fault-audit-recovered'));
  });

  it('writes the audit row on the creation TRANSACTION, not a separate connection', async () => {
    // The fault-injection tests above are blind to WHICH executor writes the audit row: whether
    // writeAudit receives `trx` or `deps.db`, an induced failure still rolls the tenant back, so
    // swapping them left 26/26 green (finding F-016-2). A separate connection is a real defect —
    // it would autocommit the audit row independently of the change it claims to record.
    //
    // This trigger discriminates by VISIBILITY: inside the transaction the not-yet-committed tenant
    // row is visible, so the insert proceeds. On another connection it is not, so the trigger
    // raises. Nothing else about the request differs.
    const name = uniqueName('audit-executor');

    let response: Response;
    try {
      await query(`create or replace function t016_audit_executor() returns trigger
                   language plpgsql as $fn$
                   begin
                     if new.action = 'tenant.created'
                        and new.details -> 'after' ->> 'name' like 't016-audit-executor-%'
                        and not exists (select 1 from tenants where id = new.entity_id::bigint)
                     then raise exception 'T-016 audit row written outside the creation transaction';
                     end if;
                     return new;
                   end $fn$`);
      await query(`create trigger t016_audit_executor before insert on audit_log
                   for each row execute function t016_audit_executor()`);

      response = await call('POST', '/api/v1/tenants', {
        token: admin.accessToken,
        body: { name },
      });
    } finally {
      await query('drop trigger if exists t016_audit_executor on audit_log');
      await query('drop function if exists t016_audit_executor()');
    }

    // Positive control: this must be an ordinary success. If the trigger fired we would see 500,
    // which is precisely the mutant's signature.
    expect(response.status).toBe(201);

    // This test creates a REAL tenant via the raw `call` helper rather than createTenantViaApi, so
    // nothing registered it for cleanup and it leaked one tenant + its audit rows on every run.
    createdTenantIds.push(((await response.json()) as CreateBody).tenantId);
  });

  it('creates nothing at all when the name duplicates an active tenant', async () => {
    const name = uniqueName('dup');
    await createTenantViaApi(name);
    const before = await lastTenantSequenceValue();

    const response = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).detail).toBe(
      `An active tenant named '${name}' already exists.`,
    );
    expect(
      await countRows('select count(*)::text as n from tenants where name = $1', [name]),
    ).toBe(1);
    expect(await lastTenantSequenceValue(), 'the duplicate check must run before any insert').toBe(
      before,
    );
  });

  it('lets a removed tenant free its name for reuse', async () => {
    const name = uniqueName('name-reuse');
    const first = await createTenantViaApi(name);

    await call('POST', `/api/v1/tenants/${first.tenantId}/remove`, { token: admin.accessToken });

    const second = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name },
    });
    expect(second.status).toBe(201);
    createdTenantIds.push(((await second.json()) as CreateBody).tenantId);
  });

  // ------------------------------------------------- soft remove / restore (AC-027, V-035)

  it('soft-removes without deleting the tenant or any of its data, and restores it', async () => {
    const created = await createTenantViaApi(uniqueName('lifecycle'));
    const referenceRowsBefore = await countRows(
      'select count(*)::text as n from reference_items where tenant_id = $1',
      [created.tenantId],
    );
    expect(referenceRowsBefore).toBeGreaterThan(0);

    const removed = await call('POST', `/api/v1/tenants/${created.tenantId}/remove`, {
      token: admin.accessToken,
    });
    expect(removed.status).toBe(200);
    expect(await removed.text(), 'Results.Ok() sends an empty body').toBe('');

    // The ROW is still there, with a status and a removal stamp — not deleted.
    const afterRemove = await query<{ status: string; removed_at: Date | null; removed_by: string | null }>(
      `select status, removed_at, removed_by::text as removed_by from tenants where id = $1`,
      [created.tenantId],
    );
    expect(afterRemove[0]?.status).toBe('removed');
    expect(afterRemove[0]?.removed_at).not.toBeNull();
    expect(afterRemove[0]?.removed_by).toBe(String(appUserId(admin)));

    // ...and so is every row in its partitions.
    expect(
      await countRows('select count(*)::text as n from reference_items where tenant_id = $1', [
        created.tenantId,
      ]),
      'soft removal must not delete tenant data',
    ).toBe(referenceRowsBefore);
    expect(await relationExists(`reference_items_p${created.tenantId}`)).toBe(true);

    const restored = await call('POST', `/api/v1/tenants/${created.tenantId}/restore`, {
      token: admin.accessToken,
    });
    expect(restored.status).toBe(200);

    const afterRestore = (await (
      await call('GET', `/api/v1/tenants/${created.tenantId}`, { token: admin.accessToken })
    ).json()) as TenantBody;
    expect(afterRestore.status).toBe('active');
    expect(afterRestore.removedAt).toBeNull();
  });

  it('excludes removed tenants from the default list but keeps them visible with includeRemoved', async () => {
    const name = uniqueName('listing');
    const created = await createTenantViaApi(name);

    const activeBefore = (await (
      await call('GET', '/api/v1/tenants', { token: admin.accessToken })
    ).json()) as TenantBody[];
    expect(activeBefore.some((tenant) => tenant.id === created.tenantId)).toBe(true);

    await call('POST', `/api/v1/tenants/${created.tenantId}/remove`, { token: admin.accessToken });

    const activeAfter = (await (
      await call('GET', '/api/v1/tenants', { token: admin.accessToken })
    ).json()) as TenantBody[];
    expect(activeAfter.some((tenant) => tenant.id === created.tenantId)).toBe(false);

    // ...but an authorized Internal user can still see it, with its history intact.
    const all = (await (
      await call('GET', '/api/v1/tenants?includeRemoved=true', { token: admin.accessToken })
    ).json()) as TenantBody[];
    const found = all.find((tenant) => tenant.id === created.tenantId);
    expect(found?.status).toBe('removed');
    expect(found?.removedAt).not.toBeNull();
  });

  it('stops a removed tenant from being a switch target, and lets restore reinstate it', async () => {
    const created = await createTenantViaApi(uniqueName('switching'));
    await query('insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())', [
      created.tenantId,
      appUserId(viewer),
    ]);

    // Positive control: while active, the member can enter the tenant.
    const before = await call('GET', SCOPED_PROBE, {
      token: viewer.accessToken,
      tenantId: created.tenantId,
    });
    expect(before.status).toBe(200);

    await call('POST', `/api/v1/tenants/${created.tenantId}/remove`, { token: admin.accessToken });

    const during = await call('GET', SCOPED_PROBE, {
      token: viewer.accessToken,
      tenantId: created.tenantId,
    });
    expect(during.status, 'a removed tenant must not be enterable').toBe(403);

    await call('POST', `/api/v1/tenants/${created.tenantId}/restore`, { token: admin.accessToken });

    const after = await call('GET', SCOPED_PROBE, {
      token: viewer.accessToken,
      tenantId: created.tenantId,
    });
    expect(after.status, 'restore must reinstate the tenant as a switch target').toBe(200);
  });

  it('refuses to remove an already-removed tenant and to restore an active one', async () => {
    const created = await createTenantViaApi(uniqueName('conflicts'));

    const restoreActive = await call('POST', `/api/v1/tenants/${created.tenantId}/restore`, {
      token: admin.accessToken,
    });
    expect(restoreActive.status).toBe(409);
    expect((await restoreActive.json() as ProblemBody).detail).toBe(
      `Tenant ${created.tenantId} is not removed.`,
    );

    await call('POST', `/api/v1/tenants/${created.tenantId}/remove`, { token: admin.accessToken });

    const removeAgain = await call('POST', `/api/v1/tenants/${created.tenantId}/remove`, {
      token: admin.accessToken,
    });
    expect(removeAgain.status).toBe(409);
    expect((await removeAgain.json() as ProblemBody).detail).toBe(
      `Tenant ${created.tenantId} is already removed.`,
    );
  });

  it('exposes no hard-delete route for a tenant', async () => {
    const created = await createTenantViaApi(uniqueName('no-delete'));

    const response = await call('DELETE', `/api/v1/tenants/${created.tenantId}`, {
      token: admin.accessToken,
    });

    expect(response.status, 'a DELETE route would be a hard-delete path (AC-027/N-09)').toBe(404);
    expect(
      await countRows('select count(*)::text as n from tenants where id = $1', [created.tenantId]),
    ).toBe(1);
  });

  // ------------------------------------------------------------- authorization (AC-028, V-037)

  const ROUTES = [
    { method: 'GET', path: () => '/api/v1/tenants', body: undefined },
    { method: 'GET', path: (id: number) => `/api/v1/tenants/${id}`, body: undefined },
    { method: 'POST', path: () => '/api/v1/tenants', body: { name: 'denied' } },
    { method: 'PUT', path: (id: number) => `/api/v1/tenants/${id}`, body: { name: 'denied' } },
    { method: 'POST', path: (id: number) => `/api/v1/tenants/${id}/remove`, body: undefined },
    { method: 'POST', path: (id: number) => `/api/v1/tenants/${id}/restore`, body: undefined },
  ] as const;

  it('denies every Tenant Manager route to a caller with no tenant-management permission', async () => {
    for (const route of ROUTES) {
      const response = await call(route.method, route.path(scopeTenant), {
        token: stranger.accessToken,
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect(response.status, `${route.method} ${route.path(scopeTenant)}`).toBe(403);
    }
  });

  it('denies every Tenant Manager route to an anonymous caller', async () => {
    for (const route of ROUTES) {
      const response = await call(route.method, route.path(scopeTenant), {
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect(response.status, `${route.method} ${route.path(scopeTenant)}`).toBe(401);
    }
  });

  it('does not accept a TENANT-SCOPED grant for these cross-tenant routes', async () => {
    // The user holds every tenant permission — inside `scopeTenant`. These routes resolve in the
    // GLOBAL scope, so the grants must not apply, even when the request names that same tenant.
    for (const route of ROUTES) {
      const response = await call(route.method, route.path(scopeTenant), {
        token: tenantScoped.accessToken,
        tenantId: scopeTenant,
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect(response.status, `${route.method} ${route.path(scopeTenant)}`).toBe(403);
    }
  });

  it('serves the Tenant Manager without any X-Tenant-Id header (cross-tenant surface)', async () => {
    // Positive control for the three denial tests above: the same routes DO work for the admin,
    // and they work with no tenant header at all.
    const created = await createTenantViaApi(uniqueName('no-header'));

    expect((await call('GET', '/api/v1/tenants', { token: admin.accessToken })).status).toBe(200);
    expect(
      (await call('GET', `/api/v1/tenants/${created.tenantId}`, { token: admin.accessToken }))
        .status,
    ).toBe(200);
  });

  it('gates ?includeRemoved=true behind tenants.view_removed, separately from tenants.view', async () => {
    // Positive control first: the plain list works for this caller.
    const allowed = await call('GET', '/api/v1/tenants', { token: viewer.accessToken });
    expect(allowed.status).toBe(200);

    const denied = await call('GET', '/api/v1/tenants?includeRemoved=true', {
      token: viewer.accessToken,
    });
    expect(denied.status).toBe(403);
    expect((await denied.json() as ProblemBody).detail).toBe(
      'Caller lacks permission to view removed tenants.',
    );

    // ...and the admin, who holds it, gets 200 for the same request.
    expect(
      (await call('GET', '/api/v1/tenants?includeRemoved=true', { token: admin.accessToken }))
        .status,
    ).toBe(200);
  });

  // ---------------------------------------------------------------------------- validation

  it('requires a name on create and on update', async () => {
    const missing = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { contactName: 'no name' },
    });
    expect(missing.status).toBe(422);
    const problem = (await missing.json()) as ProblemBody;
    expect(problem.errors?.map((error) => error.field)).toContain('name');

    const blank = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name: '   ' },
    });
    expect(blank.status, 'FluentValidation NotEmpty rejects a whitespace-only name').toBe(422);

    const created = await createTenantViaApi(uniqueName('needs-name'));
    const update = await call('PUT', `/api/v1/tenants/${created.tenantId}`, {
      token: admin.accessToken,
      body: { contactName: 'still no name' },
    });
    expect(update.status).toBe(422);
  });

  it('rejects an over-long name and a malformed contact email, but accepts a blank one', async () => {
    const tooLong = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name: 'x'.repeat(201) },
    });
    expect(tooLong.status).toBe(422);

    const badEmail = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name: uniqueName('bad-email'), contactEmail: 'not-an-email' },
    });
    expect(badEmail.status).toBe(422);

    // `.When(!string.IsNullOrWhiteSpace(ContactEmail))` — a blank email skips the format rule.
    const blankEmail = await call('POST', '/api/v1/tenants', {
      token: admin.accessToken,
      body: { name: uniqueName('blank-email'), contactEmail: '   ' },
    });
    expect(blankEmail.status).toBe(201);
    createdTenantIds.push(((await blankEmail.json()) as CreateBody).tenantId);
  });

  // ------------------------------------------------------------------- audit (AC-024, V-031)

  it('audits create, update, remove and restore with before/after payloads', async () => {
    const name = uniqueName('audited');
    const created = await createTenantViaApi(name, { contactName: 'First' });
    const entityId = String(created.tenantId);
    const actorUserId = appUserId(admin);

    await assertAudited(query, {
      action: TENANT_CREATED_ACTION,
      entityType: 'tenant',
      entityId,
      actorUserId,
      // Tenant lifecycle is a GLOBAL action: audit_log.tenant_id is nullable for exactly this.
      tenantId: null,
      before: null,
      after: { name, contactName: 'First', contactEmail: null, contactPhone: null },
    });

    // Seeding is audited too, and THAT row is tenant-scoped (TenantReferenceSeeder.cs:63,109).
    const seededRow = await assertAudited(query, {
      action: REFERENCE_SEEDED_ACTION,
      entityType: 'tenant',
      entityId,
      actorUserId,
      tenantId: created.tenantId,
    });
    expect(
      Object.keys(
        (seededRow.details as { after: { countsByListType: Record<string, number> } }).after
          .countsByListType,
      ).length,
    ).toBeGreaterThan(0);

    const newName = uniqueName('audited-renamed');
    await call('PUT', `/api/v1/tenants/${created.tenantId}`, {
      token: admin.accessToken,
      body: { name: newName, contactName: 'Second' },
    });

    await assertAudited(query, {
      action: TENANT_UPDATED_ACTION,
      entityId,
      actorUserId,
      tenantId: null,
      // Spot check required by V-031: the payload halves are the real pre/post state.
      before: { name, contactName: 'First', contactEmail: null, contactPhone: null },
      after: { name: newName, contactName: 'Second', contactEmail: null, contactPhone: null },
    });

    await call('POST', `/api/v1/tenants/${created.tenantId}/remove`, { token: admin.accessToken });
    await assertAudited(query, {
      action: TENANT_REMOVED_ACTION,
      entityId,
      actorUserId,
      tenantId: null,
      before: { name: newName, status: 'active' },
      after: { name: newName, status: 'removed' },
    });

    await call('POST', `/api/v1/tenants/${created.tenantId}/restore`, { token: admin.accessToken });
    await assertAudited(query, {
      action: TENANT_RESTORED_ACTION,
      entityId,
      actorUserId,
      tenantId: null,
      before: { name: newName, status: 'removed' },
      after: { name: newName, status: 'active' },
    });
  });

  it('writes no audit row for an operation that was rejected', async () => {
    const created = await createTenantViaApi(uniqueName('rejected'));

    const denied = await call('PUT', `/api/v1/tenants/${created.tenantId}`, {
      token: stranger.accessToken,
      body: { name: uniqueName('never') },
    });
    expect(denied.status).toBe(403);

    const rows = await findAuditRows(query, {
      action: TENANT_UPDATED_ACTION,
      entityId: String(created.tenantId),
    });
    expect(rows, 'a denied update must not be audited as an update').toHaveLength(0);
  });
});
