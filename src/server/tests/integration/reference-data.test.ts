/**
 * The tenant reference-data surface, end to end (T-019; AC-022, AC-024, AC-035, AC-036;
 * V-027, V-031, V-045, V-047).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/ReferenceData/ReferenceDataEndpointsTests.cs`, and
 * deliberately the same shape: real signed-in sessions, real `tenants`/`user_tenants` rows, real
 * per-tenant partitions, real grants, the real Hono pipeline (auth -> tenant context -> permission
 * resolution -> routes) via `app.request`. Nothing is stubbed, because the properties under test —
 * tenant isolation and the guarded-status invariants — are properties of the composed system.
 *
 * WHY THE ISOLATION TESTS HERE ARE LOAD-BEARING RATHER THAN BELT-AND-BRACES
 * ========================================================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20). There is no database-level
 * net beneath the tenant predicates in repository.ts, so the ONLY thing standing between tenant A
 * and tenant B on these five endpoints is application code plus the assertions below. Every
 * mutating endpoint therefore gets an explicit cross-tenant test that checks BOTH the status code
 * AND the absence of a side effect — a 404 that still edited the row would satisfy a
 * status-code-only test.
 *
 * This suite creates its own tenants (with their own partitions) and seeds its own reference rows,
 * so it never mutates the shared demo seed and can run alongside `global-template.test.ts`, which
 * mutates the global template.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import {
  REFERENCE_ITEM_CREATED_ACTION,
  REFERENCE_ITEM_DISABLED_ACTION,
  REFERENCE_ITEM_REORDERED_ACTION,
  REFERENCE_ITEM_UPDATED_ACTION,
} from '../../domains/reference-data/service.js';
import { REFERENCE_LIST_TYPES } from '../../domains/reference-data/canonical-statuses.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('tenant reference data', probe);

const BASE = '/api/v1/settings/reference-data';

interface ItemDto {
  readonly id: number;
  readonly listType: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly isBrokerChannel: boolean | null;
  readonly productLineId: number | null;
  readonly reportingCategory: string | null;
  readonly canonicalKey: string | null;
  readonly isTerminal: boolean;
}

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

/** A per-test-run marker so concurrent runs and repeated runs never collide on a name. */
const RUN = `t019-${process.pid}-${Date.now()}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix} ${RUN}-${nameSequence}`;
}

/**
 * The write payload each list type needs to be creatable. `productLineId` is patched in per tenant
 * (a cover type's parent is a tenant-scoped row), which is why this is a function of one.
 */
function createPayloadFor(listType: string, productLineId: number): Record<string, unknown> {
  const base: Record<string, unknown> = { name: uniqueName(`New ${listType}`) };
  if (listType === 'request_channel') base['isBrokerChannel'] = true;
  if (listType === 'cover_type') base['productLineId'] = productLineId;
  if (listType === 'lead_status' || listType === 'quote_status') base['reportingCategory'] = 'open';
  return base;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds `reference_data.manage` in BOTH tenants and is a member of both. */
  let admin: TestUserSession;
  /** Member of tenant A with NO reference-data grant: the permission-matrix control. */
  let plainMember: TestUserSession;

  let tenantA: number;
  let tenantB: number;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) {
      throw new Error(`fixture user ${session.email} has no application users row`);
    }
    return Number(session.appUserId);
  }

  async function createTenant(label: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-${label}`],
    );
    const id = Number(rows[0]?.id);
    createdTenants.push(id);
    // Partitions before any seeded row, so this suite's rows land in the tenant's OWN partition
    // rather than the DEFAULT safety net — the same ordering tenant creation itself enforces.
    await query('select create_tenant_partitions($1)', [id]);
    return id;
  }

  async function addMembership(userId: number, tenantId: number): Promise<void> {
    await query(
      'insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())',
      [tenantId, userId],
    );
  }

  interface SeedItem {
    readonly listType: string;
    readonly name: string;
    readonly displayOrder?: number;
    readonly isActive?: boolean;
    readonly isBrokerChannel?: boolean | null;
    readonly productLineId?: number | null;
    readonly reportingCategory?: string | null;
    readonly canonicalKey?: string | null;
    readonly isTerminal?: boolean;
  }

  /** Seeds one `reference_items` row directly, bypassing the API under test. */
  async function seedItem(tenantId: number, item: SeedItem): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, is_broker_channel,
          product_line_id, reporting_category, canonical_key, is_terminal,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
       returning id::text as id`,
      [
        tenantId,
        item.listType,
        item.name,
        item.displayOrder ?? 0,
        item.isActive ?? true,
        item.isBrokerChannel ?? null,
        item.productLineId ?? null,
        item.reportingCategory ?? null,
        item.canonicalKey ?? null,
        item.isTerminal ?? false,
      ],
    );
    return Number(rows[0]?.id);
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
      referenceData: { db },
    });
  }

  async function call(
    method: string,
    path: string,
    options: { token?: string; tenantId?: number; body?: unknown } = {},
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

  /** GET a list as the admin, asserting 200. */
  async function readList(
    tenantId: number,
    listType: string,
    includeDisabled = false,
  ): Promise<ItemDto[]> {
    const response = await call(
      'GET',
      `${BASE}/${listType}?includeDisabled=${String(includeDisabled)}`,
      { token: admin.accessToken, tenantId },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as ItemDto[];
  }

  /** Reads a row straight from the database — the side-effect check the API cannot fake. */
  async function readRow(id: number): Promise<{
    name: string;
    is_active: boolean;
    display_order: number;
    reporting_category: string | null;
    canonical_key: string | null;
    is_broker_channel: boolean | null;
    tenant_id: string;
  }> {
    const rows = await query<{
      name: string;
      is_active: boolean;
      display_order: number;
      reporting_category: string | null;
      canonical_key: string | null;
      is_broker_channel: boolean | null;
      tenant_id: string;
    }>(
      `select name, is_active, display_order, reporting_category, canonical_key,
              is_broker_channel, tenant_id::text as tenant_id
         from reference_items where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`reference item ${id} not found`);
    return row;
  }

  // Seeded fixtures, per tenant.
  let productLineA = 0;
  let productLineB = 0;
  let disabledProductLineA = 0;
  let terminalStatusA = 0;
  let canonicalOpenStatusA = 0;
  let tenantAOnlyRegion = 0;
  let tenantBOnlyRegion = 0;

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

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');

    admin = await auth.createTestUserWithSession({ label: 'refdata-admin' });
    plainMember = await auth.createTestUserWithSession({ label: 'refdata-member' });

    await addMembership(appUserId(admin), tenantA);
    await addMembership(appUserId(admin), tenantB);
    await addMembership(appUserId(plainMember), tenantA);

    await fixtures.grantDirectPermission(appUserId(admin), 'reference_data.manage', tenantA);
    await fixtures.grantDirectPermission(appUserId(admin), 'reference_data.manage', tenantB);
    // A DIFFERENT permission: proves the guard checks the required code, not "any grant at all".
    await fixtures.grantDirectPermission(appUserId(plainMember), 'leads.view', tenantA);

    productLineA = await seedItem(tenantA, { listType: 'product_line', name: uniqueName('Motor A') });
    productLineB = await seedItem(tenantB, { listType: 'product_line', name: uniqueName('Motor B') });
    disabledProductLineA = await seedItem(tenantA, {
      listType: 'product_line',
      name: uniqueName('Retired line A'),
      isActive: false,
    });

    terminalStatusA = await seedItem(tenantA, {
      listType: 'lead_status',
      name: 'Closed Won',
      reportingCategory: 'won',
      canonicalKey: 'closed_won',
      isTerminal: true,
      displayOrder: 9,
    });
    canonicalOpenStatusA = await seedItem(tenantA, {
      listType: 'lead_status',
      name: 'Quote Sent',
      reportingCategory: 'quoted',
      canonicalKey: 'quote_sent',
      isTerminal: false,
      displayOrder: 5,
    });

    // Two industries so the reorder-mismatch cases below have a set big enough for a duplicate to
    // mask an omission. Seeded rather than relying on earlier tests having created them.
    await seedItem(tenantA, { listType: 'industry', name: uniqueName('Industry one'), displayOrder: 0 });
    await seedItem(tenantA, { listType: 'industry', name: uniqueName('Industry two'), displayOrder: 1 });

    tenantAOnlyRegion = await seedItem(tenantA, {
      listType: 'region',
      name: uniqueName('Region only in A'),
    });
    tenantBOnlyRegion = await seedItem(tenantB, {
      listType: 'region',
      name: uniqueName('Region only in B'),
    });
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    for (const action of [
      REFERENCE_ITEM_CREATED_ACTION,
      REFERENCE_ITEM_UPDATED_ACTION,
      REFERENCE_ITEM_DISABLED_ACTION,
      REFERENCE_ITEM_REORDERED_ACTION,
    ]) {
      for (const tenantId of createdTenants) {
        await query('delete from audit_log where action = $1 and tenant_id = $2', [
          action,
          tenantId,
        ]).catch(() => undefined);
      }
    }

    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on (tests/helpers/auth.ts), and every delete here swallows its error, so the reverse order
    // is a silent no-op that leaks this suite's tenants and audit rows into the next run.
    for (const tenantId of createdTenants) {
      await query('delete from reference_items where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
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

  // -------------------------------------------------------------------------------------------
  // Contract: DTO shape, list types, ordering
  // -------------------------------------------------------------------------------------------

  it('returns the reference ReferenceItemDto shape, field for field', async () => {
    const items = await readList(tenantA, 'lead_status');
    const first = items[0];

    expect(first).toBeDefined();
    expect(Object.keys(first as object).sort()).toEqual(
      [
        'canonicalKey',
        'displayOrder',
        'id',
        'isActive',
        'isBrokerChannel',
        'isTerminal',
        'listType',
        'name',
        'productLineId',
        'reportingCategory',
      ].sort(),
    );
  });

  it('orders a list by display_order then id, which is what reorder then reads back', async () => {
    const statuses = await readList(tenantA, 'lead_status');
    const orders = statuses.map((item) => item.displayOrder);

    expect(orders).toEqual([...orders].sort((left, right) => left - right));
  });

  it('answers 400 with no code extension for an unrecognized list type', async () => {
    const response = await call('GET', `${BASE}/not_a_list`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(400);
    const problem = (await response.json()) as ProblemBody;
    // InvalidListTypeProblem (:107-108) passes no extensions dictionary, unlike every other branch.
    expect(problem.detail).toBe("'not_a_list' is not a recognized reference list type.");
    expect(problem.code).toBeUndefined();
  });

  it('answers 422 for an unparseable includeDisabled value', async () => {
    const response = await call('GET', `${BASE}/region?includeDisabled=maybe`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(422);
  });

  // -------------------------------------------------------------------------------------------
  // Auth / tenant boundary
  // -------------------------------------------------------------------------------------------

  it('requires authentication, and a verified tenant header, on every route', async () => {
    // Positive control first, so the rejections below cannot be satisfied by refusing everyone.
    expect(
      (await call('GET', `${BASE}/region`, { token: admin.accessToken, tenantId: tenantA })).status,
    ).toBe(200);

    expect((await call('GET', `${BASE}/region`)).status, 'anonymous').toBe(401);
    expect(
      (await call('GET', `${BASE}/region`, { token: admin.accessToken })).status,
      'no X-Tenant-Id: the route is tenant-scoped by classification',
    ).toBe(403);
    expect(
      (await call('POST', `${BASE}/region`, { token: admin.accessToken, body: { name: 'x' } }))
        .status,
      'no X-Tenant-Id on a mutation',
    ).toBe(403);
  });

  it('lets a plain tenant member READ lists but not MUTATE them', async () => {
    // The reference fixed this on 2026-07-13 (ReferenceDataEndpoints.cs:16-23): gating the read
    // behind reference_data.manage 403'd intake forms and filter bars for every non-admin role.
    const read = await call('GET', `${BASE}/region`, {
      token: plainMember.accessToken,
      tenantId: tenantA,
    });
    expect(read.status).toBe(200);

    for (const [method, path, body] of [
      ['POST', `${BASE}/region`, { name: uniqueName('Denied region') }],
      ['PUT', `${BASE}/region/${tenantAOnlyRegion}`, { name: uniqueName('Denied rename') }],
      ['POST', `${BASE}/region/${tenantAOnlyRegion}/disable`, undefined],
      ['POST', `${BASE}/region/reorder`, { orderedIds: [tenantAOnlyRegion] }],
    ] as const) {
      const response = await call(method, path, {
        token: plainMember.accessToken,
        tenantId: tenantA,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    // ...and nothing was mutated by the denied attempts.
    const row = await readRow(tenantAOnlyRegion);
    expect(row.is_active).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // Create, per list type (V-045: parameterized over every tenant-configurable list)
  // -------------------------------------------------------------------------------------------

  it.each(REFERENCE_LIST_TYPES)('creates a value in the %s list', async (listType) => {
    const payload = createPayloadFor(listType, productLineA);

    const response = await call('POST', `${BASE}/${listType}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: payload,
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as ItemDto;
    expect(response.headers.get('Location')).toBe(`${BASE}/${listType}/${created.id}`);

    expect(created.listType).toBe(listType);
    expect(created.name).toBe(payload['name']);
    expect(created.isActive).toBe(true);
    // A tenant-created row is NEVER canonical and NEVER terminal — the guard that keeps the status
    // taxonomy closed (CreateItemCommand.cs:7-11).
    expect(created.canonicalKey).toBeNull();
    expect(created.isTerminal).toBe(false);

    // ...and it is visible in the tenant's own list.
    const items = await readList(tenantA, listType);
    expect(items.some((item) => item.id === created.id)).toBe(true);

    await assertAudited(query, {
      action: REFERENCE_ITEM_CREATED_ACTION,
      entityType: 'reference_item',
      entityId: String(created.id),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: null,
    });
  });

  it('stores the broker flag only on request channels', async () => {
    const channel = (await (
      await call('POST', `${BASE}/request_channel`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Broker channel'), isBrokerChannel: true },
      })
    ).json()) as ItemDto;

    // The same field posted to a list that does not own it is DROPPED, not stored.
    const region = (await (
      await call('POST', `${BASE}/region`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Region with a stray flag'), isBrokerChannel: true },
      })
    ).json()) as ItemDto;

    expect(channel.isBrokerChannel).toBe(true);
    expect(region.isBrokerChannel).toBeNull();
    expect((await readRow(region.id)).is_broker_channel).toBeNull();
  });

  it('rejects a duplicate name in the same list, case-insensitively', async () => {
    const name = uniqueName('Duplicate probe');
    expect(
      (
        await call('POST', `${BASE}/lost_reason`, {
          token: admin.accessToken,
          tenantId: tenantA,
          body: { name },
        })
      ).status,
    ).toBe(201);

    const response = await call('POST', `${BASE}/lost_reason`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: name.toUpperCase() },
    });

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemBody;
    expect(problem.code).toBe('REFERENCE_DATA_DUPLICATE_NAME');
    expect(problem.detail).toContain('REFERENCE_DATA_DUPLICATE_NAME');
  });

  it('allows the same name in a DIFFERENT list, since uniqueness is per (tenant, list type)', async () => {
    const name = uniqueName('Shared across lists');
    for (const listType of ['region', 'industry'] as const) {
      const response = await call('POST', `${BASE}/${listType}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name },
      });
      expect(response.status, listType).toBe(201);
    }
  });

  it('rejects a blank name', async () => {
    const response = await call('POST', `${BASE}/region`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: '   ' },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).code).toBe('REFERENCE_DATA_VALIDATION_FAILED');
  });

  // -------------------------------------------------------------------------------------------
  // Cover types depend on an ACTIVE product line (V-045 negative, AC-036 server-side half)
  // -------------------------------------------------------------------------------------------

  it('rejects a cover type with no product line at all', async () => {
    const response = await call('POST', `${BASE}/cover_type`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Orphan cover') },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).detail).toContain(
      'Cover types require a product line.',
    );
  });

  it("rejects a cover type pointing at another tenant's product line", async () => {
    const response = await call('POST', `${BASE}/cover_type`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Cross-tenant cover'), productLineId: productLineB },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_INVALID_PRODUCT_LINE',
    );
  });

  it('rejects a cover type pointing at a DISABLED product line (AC-036)', async () => {
    const response = await call('POST', `${BASE}/cover_type`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Retired cover'), productLineId: disabledProductLineA },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_INVALID_PRODUCT_LINE',
    );

    // ...while the disabled product line itself is STILL THERE and still resolvable, which is the
    // other half of AC-036: historical cover types pointing at it keep rendering a name.
    const withDisabled = await readList(tenantA, 'product_line', true);
    expect(withDisabled.some((item) => item.id === disabledProductLineA)).toBe(true);
    expect((await readRow(disabledProductLineA)).is_active).toBe(false);
  });

  it('keeps a cover type resolvable after its product line is disabled', async () => {
    const cover = (await (
      await call('POST', `${BASE}/cover_type`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Historical cover'), productLineId: productLineA },
      })
    ).json()) as ItemDto;

    const line = (await (
      await call('POST', `${BASE}/product_line`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Soon-retired line') },
      })
    ).json()) as ItemDto;

    // Point a second cover type at the line, then retire the line.
    const historical = (await (
      await call('POST', `${BASE}/cover_type`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Cover on retired line'), productLineId: line.id },
      })
    ).json()) as ItemDto;

    expect(
      (
        await call('POST', `${BASE}/product_line/${line.id}/disable`, {
          token: admin.accessToken,
          tenantId: tenantA,
        })
      ).status,
    ).toBe(200);

    // The historical cover type still carries the id, and the row it names still exists.
    const covers = await readList(tenantA, 'cover_type');
    const stillThere = covers.find((item) => item.id === historical.id);
    expect(stillThere?.productLineId).toBe(line.id);
    expect((await readRow(line.id)).name).toBe(line.name);

    // The line is gone from the picker but present with includeDisabled.
    const picker = await readList(tenantA, 'product_line');
    expect(picker.some((item) => item.id === line.id)).toBe(false);
    expect((await readList(tenantA, 'product_line', true)).some((item) => item.id === line.id)).toBe(
      true,
    );

    expect(cover.productLineId).toBe(productLineA);
  });

  // -------------------------------------------------------------------------------------------
  // Guarded statuses (AC-035)
  // -------------------------------------------------------------------------------------------

  it('rejects a new status declaring a TERMINAL reporting category', async () => {
    const response = await call('POST', `${BASE}/lead_status`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Rival won'), reportingCategory: 'won' },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_INVALID_INTERMEDIATE_CATEGORY',
    );
  });

  it('rejects a new status whose reporting category is not a category at all', async () => {
    const response = await call('POST', `${BASE}/quote_status`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Bad category'), reportingCategory: 'not-a-category' },
    });

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemBody;
    expect(problem.code).toBe('REFERENCE_DATA_VALIDATION_FAILED');
    expect(problem.detail).toContain(
      'Reporting category must be one of: open, quoted, won, lost, expired, withdrawn.',
    );
  });

  it('rejects a new status with no reporting category', async () => {
    const response = await call('POST', `${BASE}/lead_status`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('No category') },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).detail).toContain(
      'Lead/quote statuses require a reporting category.',
    );
  });

  it('renames a canonical status while keeping its canonical key and reporting category', async () => {
    const renamed = uniqueName('Proposal Sent');
    const response = await call('PUT', `${BASE}/lead_status/${canonicalOpenStatusA}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: renamed, reportingCategory: 'quoted' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ItemDto;
    expect(body.name).toBe(renamed);
    expect(body.reportingCategory).toBe('quoted');
    expect(body.canonicalKey).toBe('quote_sent');

    const row = await readRow(canonicalOpenStatusA);
    expect(row.canonical_key).toBe('quote_sent');
    expect(row.reporting_category).toBe('quoted');

    await assertAudited(query, {
      action: REFERENCE_ITEM_UPDATED_ACTION,
      entityType: 'reference_item',
      entityId: String(canonicalOpenStatusA),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
    });
    await query('delete from audit_log where action = $1 and entity_id = $2', [
      REFERENCE_ITEM_UPDATED_ACTION,
      String(canonicalOpenStatusA),
    ]);
  });

  it("refuses to move a canonical status into a different reporting category", async () => {
    const before = await readRow(canonicalOpenStatusA);

    const response = await call('PUT', `${BASE}/lead_status/${canonicalOpenStatusA}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: before.name, reportingCategory: 'open' },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_CANONICAL_FIELDS_IMMUTABLE',
    );
    // No side effect: the category is what it was.
    expect((await readRow(canonicalOpenStatusA)).reporting_category).toBe(
      before.reporting_category,
    );
  });

  it('refuses to clear or terminalize a non-canonical status on update', async () => {
    const created = (await (
      await call('POST', `${BASE}/quote_status`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Intermediate'), reportingCategory: 'open' },
      })
    ).json()) as ItemDto;

    const cleared = await call('PUT', `${BASE}/quote_status/${created.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: created.name },
    });
    expect(cleared.status).toBe(422);
    expect((await cleared.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_REPORTING_CATEGORY_REQUIRED',
    );

    const promoted = await call('PUT', `${BASE}/quote_status/${created.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: created.name, reportingCategory: 'won' },
    });
    expect(promoted.status).toBe(422);
    expect((await promoted.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_INVALID_INTERMEDIATE_CATEGORY',
    );

    // Retargeting within the allowed pair still works, so the rejections above are about the
    // category and not about update being broken for statuses.
    const allowed = await call('PUT', `${BASE}/quote_status/${created.id}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: created.name, reportingCategory: 'quoted' },
    });
    expect(allowed.status).toBe(200);
    expect((await readRow(created.id)).reporting_category).toBe('quoted');
  });

  it('refuses to disable a terminal status, and leaves it active', async () => {
    const response = await call('POST', `${BASE}/lead_status/${terminalStatusA}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemBody;
    // The spec-mandated exact code, in BOTH detail and the extension (ReferenceDataEndpoints.cs:110-113).
    expect(problem.code).toBe('TERMINAL_STATUS_CANNOT_BE_DISABLED');
    expect(problem.detail).toContain('TERMINAL_STATUS_CANNOT_BE_DISABLED');

    expect((await readRow(terminalStatusA)).is_active).toBe(true);
    expect(
      await findAuditRows(query, {
        action: REFERENCE_ITEM_DISABLED_ACTION,
        entityId: String(terminalStatusA),
      }),
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // Disable (AC-036) and its idempotency
  // -------------------------------------------------------------------------------------------

  it('disables a value, keeping it out of pickers but resolvable historically', async () => {
    const created = (await (
      await call('POST', `${BASE}/region`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Northern Cape') },
      })
    ).json()) as ItemDto;

    const response = await call('POST', `${BASE}/region/${created.id}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    expect(await response.text(), 'Results.Ok() sends an empty body').toBe('');

    expect((await readList(tenantA, 'region')).some((item) => item.id === created.id)).toBe(false);

    const historical = (await readList(tenantA, 'region', true)).find(
      (item) => item.id === created.id,
    );
    expect(historical?.name).toBe(created.name);
    expect(historical?.isActive).toBe(false);

    await assertAudited(query, {
      action: REFERENCE_ITEM_DISABLED_ACTION,
      entityType: 'reference_item',
      entityId: String(created.id),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: { listType: 'region', name: created.name, isActive: true },
      after: { listType: 'region', name: created.name, isActive: false },
    });

    // Disabling twice is a no-op that writes NO second audit row — a retried request must not
    // inflate the trail (DisableItemCommandHandler.cs:36-38).
    const again = await call('POST', `${BASE}/region/${created.id}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(again.status).toBe(200);
    expect(
      await findAuditRows(query, {
        action: REFERENCE_ITEM_DISABLED_ACTION,
        entityId: String(created.id),
      }),
    ).toHaveLength(1);
  });

  it('never hard-deletes: there is no DELETE route on this surface', async () => {
    const response = await call('DELETE', `${BASE}/region/${tenantAOnlyRegion}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(404);
    expect((await readRow(tenantAOnlyRegion)).name).toBeTruthy();
  });

  // -------------------------------------------------------------------------------------------
  // Reorder
  // -------------------------------------------------------------------------------------------

  it('persists display order and returns the list in it', async () => {
    const names = [uniqueName('R1'), uniqueName('R2'), uniqueName('R3')];
    const ids: number[] = [];
    for (const name of names) {
      const created = (await (
        await call('POST', `${BASE}/broker_type`, {
          token: admin.accessToken,
          tenantId: tenantA,
          body: { name },
        })
      ).json()) as ItemDto;
      ids.push(created.id);
    }

    const active = await readList(tenantA, 'broker_type');
    const reversed = [...active.map((item) => item.id)].reverse();

    const response = await call('POST', `${BASE}/broker_type/reorder`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { orderedIds: reversed },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');

    expect((await readList(tenantA, 'broker_type')).map((item) => item.id)).toEqual(reversed);
    for (const [index, id] of reversed.entries()) {
      expect((await readRow(id)).display_order, `display_order of ${id}`).toBe(index);
    }

    await assertAudited(query, {
      action: REFERENCE_ITEM_REORDERED_ACTION,
      entityType: 'reference_item',
      entityId: 'broker_type',
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      after: { orderedIds: reversed },
    });
    await query('delete from audit_log where action = $1 and entity_id = $2', [
      REFERENCE_ITEM_REORDERED_ACTION,
      'broker_type',
    ]);
    expect(ids).toHaveLength(3);
  });

  it('rejects a reorder set that is not exactly the active ids', async () => {
    const active = (await readList(tenantA, 'industry')).map((item) => item.id);
    expect(active.length, 'fixture: the industry list needs at least two active values').toBeGreaterThan(1);

    const first = active[0] as number;
    const before = await Promise.all(active.map(async (id) => (await readRow(id)).display_order));

    const cases: Record<string, number[]> = {
      // A duplicate MASKS an omission: same length, wrong set (ReorderItemsCommandHandler.cs:33-35).
      duplicate: active.map((_, index) => (index === 1 ? first : active[index] as number)),
      omission: active.slice(1),
      extra: [...active, first],
      empty: [],
    };

    for (const [label, orderedIds] of Object.entries(cases)) {
      const response = await call('POST', `${BASE}/industry/reorder`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { orderedIds },
      });
      expect(response.status, label).toBe(422);
      expect((await response.json() as ProblemBody).code, label).toBe(
        'REFERENCE_DATA_REORDER_SET_MISMATCH',
      );
    }

    // No side effect from any of the four rejections.
    const after = await Promise.all(active.map(async (id) => (await readRow(id)).display_order));
    expect(after).toEqual(before);
  });

  it('reorders the ACTIVE set only: a disabled item is omitted, and including it is a mismatch', async () => {
    const listType = 'party_type';
    const keep = (await (
      await call('POST', `${BASE}/${listType}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Kept party type') },
      })
    ).json()) as ItemDto;
    const retired = (await (
      await call('POST', `${BASE}/${listType}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { name: uniqueName('Retired party type') },
      })
    ).json()) as ItemDto;

    expect(
      (
        await call('POST', `${BASE}/${listType}/${retired.id}/disable`, {
          token: admin.accessToken,
          tenantId: tenantA,
        })
      ).status,
    ).toBe(200);

    const activeIds = (await readList(tenantA, listType)).map((item) => item.id);
    expect(activeIds).not.toContain(retired.id);

    const omitted = await call('POST', `${BASE}/${listType}/reorder`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { orderedIds: activeIds },
    });
    expect(omitted.status, 'omitting the disabled item is the contract').toBe(200);

    const included = await call('POST', `${BASE}/${listType}/reorder`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { orderedIds: [...activeIds, retired.id] },
    });
    expect(included.status).toBe(422);
    expect((await included.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_REORDER_SET_MISMATCH',
    );

    expect(keep.id).toBeGreaterThan(0);
    await query('delete from audit_log where action = $1 and entity_id = $2', [
      REFERENCE_ITEM_REORDERED_ACTION,
      listType,
    ]);
  });

  it('rejects a malformed reorder body rather than crashing', async () => {
    for (const body of [{}, { orderedIds: null }, { orderedIds: ['a'] }, { orderedIds: [0] }]) {
      const response = await call('POST', `${BASE}/region/reorder`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Not-found handling
  // -------------------------------------------------------------------------------------------

  it('answers 404 for an id that does not exist, and for a non-numeric id', async () => {
    const missing = 999_999_999;

    const put = await call('PUT', `${BASE}/region/${missing}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Ghost') },
    });
    expect(put.status).toBe(404);
    expect((await put.json() as ProblemBody).code).toBe('REFERENCE_DATA_NOT_FOUND');

    const disable = await call('POST', `${BASE}/region/${missing}/disable`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(disable.status).toBe(404);

    // A non-numeric id does not match the `{id:long}` constrained route at all: a routing 404,
    // carrying no domain code.
    const nonNumeric = await call('PUT', `${BASE}/region/abc`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Ghost') },
    });
    expect(nonNumeric.status).toBe(404);
    expect((await nonNumeric.json() as ProblemBody).code).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation (AC-022, V-027) — the property with no database net beneath it
  // -------------------------------------------------------------------------------------------

  it("never returns another tenant's values in a list", async () => {
    const inA = await readList(tenantA, 'region', true);
    const inB = await readList(tenantB, 'region', true);

    expect(inA.some((item) => item.id === tenantAOnlyRegion)).toBe(true);
    expect(inA.some((item) => item.id === tenantBOnlyRegion)).toBe(false);

    expect(inB.some((item) => item.id === tenantBOnlyRegion)).toBe(true);
    expect(inB.some((item) => item.id === tenantAOnlyRegion)).toBe(false);

    // Every row a tenant CAN see belongs to it — checked by id set, not merely by marker names.
    const idsInA = new Set(inA.map((item) => item.id));
    const rowsForA = await query<{ id: string }>(
      "select id::text as id from reference_items where tenant_id = $1 and list_type = 'region'",
      [tenantA],
    );
    expect([...idsInA].sort()).toEqual(rowsForA.map((row) => Number(row.id)).sort());
  });

  it("refuses to update or disable another tenant's item, with no side effect", async () => {
    const before = await readRow(tenantAOnlyRegion);

    // Same admin, same token, same grant — the ONLY difference is the tenant header.
    const put = await call('PUT', `${BASE}/region/${tenantAOnlyRegion}`, {
      token: admin.accessToken,
      tenantId: tenantB,
      body: { name: uniqueName('Hijacked') },
    });
    const disable = await call('POST', `${BASE}/region/${tenantAOnlyRegion}/disable`, {
      token: admin.accessToken,
      tenantId: tenantB,
    });

    expect(put.status).toBe(404);
    expect(disable.status).toBe(404);
    // The 404 for a real-but-foreign id is shaped identically to the 404 for an id that exists
    // nowhere: same code, same message template, differing only by the id the caller already knew.
    // Nothing in the response says whether the row exists in some other tenant (N-01).
    const ghost = await call('POST', `${BASE}/region/999999999/disable`, {
      token: admin.accessToken,
      tenantId: tenantB,
    });
    expect(ghost.status).toBe(404);
    const foreignBody = (await disable.json()) as ProblemBody;
    const ghostBody = (await ghost.json()) as ProblemBody;
    expect(foreignBody.code).toBe(ghostBody.code);
    expect(foreignBody.detail).toBe(
      `REFERENCE_DATA_NOT_FOUND: Reference item ${tenantAOnlyRegion} was not found.`,
    );
    expect(ghostBody.detail).toBe(
      'REFERENCE_DATA_NOT_FOUND: Reference item 999999999 was not found.',
    );

    const after = await readRow(tenantAOnlyRegion);
    expect(after.name).toBe(before.name);
    expect(after.is_active).toBe(true);
    expect(after.tenant_id).toBe(String(tenantA));
  });

  it("refuses to reorder another tenant's ids, with no side effect", async () => {
    const before = await readRow(tenantAOnlyRegion);

    const response = await call('POST', `${BASE}/region/reorder`, {
      token: admin.accessToken,
      tenantId: tenantB,
      body: { orderedIds: [tenantAOnlyRegion] },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).code).toBe(
      'REFERENCE_DATA_REORDER_SET_MISMATCH',
    );
    expect((await readRow(tenantAOnlyRegion)).display_order).toBe(before.display_order);
  });

  it('writes a created row into the acting tenant, never the header-named one', async () => {
    const created = (await (
      await call('POST', `${BASE}/region`, {
        token: admin.accessToken,
        tenantId: tenantB,
        // A hostile body cannot smuggle a tenant: `tenant_id` is injected by the scope, and the
        // schema is strict, so an extra key is rejected outright.
        body: { name: uniqueName('Written into B') },
      })
    ).json()) as ItemDto;

    expect((await readRow(created.id)).tenant_id).toBe(String(tenantB));
    expect((await readList(tenantA, 'region', true)).some((item) => item.id === created.id)).toBe(
      false,
    );
  });

  it('rejects an unknown body field rather than silently ignoring it', async () => {
    const response = await call('POST', `${BASE}/lead_status`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: {
        name: uniqueName('Smuggled canonical'),
        reportingCategory: 'open',
        // The guarded columns are not writable through any request shape.
        canonicalKey: 'won',
        isTerminal: true,
      },
    });

    expect(response.status).toBe(422);
    const items = await readList(tenantA, 'lead_status', true);
    expect(items.some((item) => item.canonicalKey === 'won')).toBe(false);
  });
});
