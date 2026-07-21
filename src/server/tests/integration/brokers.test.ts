/**
 * The broker and broker-contact administration surface, end to end (T-021; AC-022, AC-024, AC-039;
 * V-027, V-050).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/Brokers/BrokerEndpointsTests.cs`, same shape as
 * `reference-data.test.ts`: real signed-in sessions, real `tenants`/`user_tenants` rows, real
 * per-tenant partitions, real grants, the real Hono pipeline (auth -> tenant context -> permission
 * resolution -> routes) via `app.request`. Nothing is stubbed, because the properties under test —
 * tenant isolation and the exactly-one-primary invariant — are properties of the composed system.
 *
 * WHY THE ISOLATION TESTS HERE ARE LOAD-BEARING RATHER THAN BELT-AND-BRACES
 * ========================================================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20). There is no database-level
 * net beneath the tenant predicates in repository.ts, so the ONLY thing standing between tenant A
 * and tenant B on these nine endpoints is application code plus the assertions below. Every
 * endpoint gets an explicit cross-tenant test that checks BOTH the status code AND the absence of a
 * side effect — a 404 that still edited the row would satisfy a status-code-only test.
 *
 * AND WHY THE PRIMARY-CONTACT ASSERTIONS READ THE DATABASE, NOT THE RESPONSE
 * =========================================================================
 * `uq_broker_contacts_primary` (20260718003100_brokers.sql:100-102) makes "at most one primary per
 * broker" a database guarantee, but "at least one whenever contacts exist" is application logic
 * only. A response body echoing `isPrimary: true` proves neither half, so every primary transition
 * below re-reads `broker_contacts` and counts.
 *
 * This suite creates its own tenants (with their own partitions) and seeds its own rows, so it
 * never mutates the shared demo seed and can run alongside the other domain suites.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BROKER_CONTACT_ADDED_ACTION,
  BROKER_CONTACT_REMOVED_ACTION,
  BROKER_CONTACT_SET_PRIMARY_ACTION,
  BROKER_CONTACT_UPDATED_ACTION,
  BROKER_CREATED_ACTION,
  BROKER_DISABLED_ACTION,
  BROKER_UPDATED_ACTION,
} from '../../domains/brokers/service.js';
import { createGrantGraphLoader } from '../../domains/rbac/index.js';
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
const title = suiteTitle('brokers and broker contacts', probe);

const BASE = '/api/v1/brokers';

/** `BrokerSummaryDto` (src/api/.../Brokers/BrokerDto.cs:13). */
interface BrokerSummaryDto {
  readonly id: number;
  readonly name: string;
  readonly brokerTypeId: number | null;
  readonly branch: string | null;
  readonly status: string;
}

/** `BrokerContactDto` (:6). */
interface BrokerContactDto {
  readonly id: number;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isPrimary: boolean;
}

/** `BrokerDetailDto` (:20-21). */
interface BrokerDetailDto extends BrokerSummaryDto {
  readonly contacts: readonly BrokerContactDto[];
}

/** `BrokerListDto` (:33) — note `totalCount`, not `total`. */
interface BrokerListDto {
  readonly items: readonly BrokerSummaryDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

/** A per-test-run marker so concurrent runs and repeated runs never collide on a name. */
const RUN = `t021-${process.pid}-${Date.now()}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix} ${RUN}-${nameSequence}`;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds `brokers.manage` AND `brokers.view` in BOTH tenants, and is a member of both. */
  let manager: TestUserSession;
  /** Holds `brokers.view` in tenant A but NOT `brokers.manage`: the mutation-guard control. */
  let viewer: TestUserSession;
  /** Member of tenant A with NO broker grant at all: the membership-only-list control. */
  let plainMember: TestUserSession;

  let tenantA: number;
  let tenantB: number;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
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
    await query('insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())', [
      tenantId,
      userId,
    ]);
  }

  /** Seeds one `reference_items` row directly, bypassing the API under test. */
  async function seedReferenceItem(
    tenantId: number,
    listType: string,
    name: string,
    isActive = true,
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, is_terminal, created_at, updated_at)
       values ($1, $2, $3, 0, $4, false, now(), now())
       returning id::text as id`,
      [tenantId, listType, name, isActive],
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
      brokers: { db },
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

  /** Creates a broker as the manager, asserting 201, and returns the detail body. */
  async function createBroker(
    tenantId: number,
    body: Record<string, unknown>,
  ): Promise<BrokerDetailDto> {
    const response = await call('POST', BASE, { token: manager.accessToken, tenantId, body });
    expect(response.status, `create broker failed: ${await response.clone().text()}`).toBe(201);
    return (await response.json()) as BrokerDetailDto;
  }

  /** Adds a contact as the manager, asserting 201. */
  async function addContact(
    tenantId: number,
    brokerId: number,
    body: Record<string, unknown>,
  ): Promise<BrokerContactDto> {
    const response = await call('POST', `${BASE}/${brokerId}/contacts`, {
      token: manager.accessToken,
      tenantId,
      body,
    });
    expect(response.status, `add contact failed: ${await response.clone().text()}`).toBe(201);
    return (await response.json()) as BrokerContactDto;
  }

  async function readDetail(tenantId: number, brokerId: number): Promise<BrokerDetailDto> {
    const response = await call('GET', `${BASE}/${brokerId}`, {
      token: manager.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as BrokerDetailDto;
  }

  async function readList(tenantId: number, queryString = ''): Promise<BrokerListDto> {
    const response = await call('GET', `${BASE}${queryString}`, {
      token: manager.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as BrokerListDto;
  }

  /** Reads a broker row straight from the database — the side-effect check the API cannot fake. */
  async function readBrokerRow(id: number): Promise<{
    name: string;
    broker_type_id: string | null;
    branch: string | null;
    status: string;
    tenant_id: string;
  }> {
    const rows = await query<{
      name: string;
      broker_type_id: string | null;
      branch: string | null;
      status: string;
      tenant_id: string;
    }>(
      `select name, broker_type_id::text as broker_type_id, branch, status,
              tenant_id::text as tenant_id
         from brokers where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`broker ${id} not found`);
    return row;
  }

  /** Every contact row of a broker, straight from the database, oldest first. */
  async function readContactRows(
    brokerId: number,
  ): Promise<{ id: number; name: string; email: string | null; phone: string | null; isPrimary: boolean; tenantId: string }[]> {
    const rows = await query<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      is_primary: boolean;
      tenant_id: string;
    }>(
      // `order by c.id` is QUALIFIED: a bare `order by id` resolves to the `id::text as id` output
      // alias and would sort contacts as STRINGS ('10' before '9') rather than numerically (T-048).
      `select c.id::text as id, c.name, c.email, c.phone, c.is_primary, c.tenant_id::text as tenant_id
         from broker_contacts c where c.broker_id = $1 order by c.id`,
      [brokerId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      email: row.email,
      phone: row.phone,
      isPrimary: row.is_primary,
      tenantId: row.tenant_id,
    }));
  }

  /**
   * The AC-039 invariant, asserted against committed rows: a broker with any contacts has EXACTLY
   * one primary. The database's partial unique index already forbids two; only this catches zero.
   */
  async function assertExactlyOnePrimary(brokerId: number): Promise<void> {
    const rows = await readContactRows(brokerId);
    if (rows.length === 0) return;
    const primaries = rows.filter((row) => row.isPrimary);
    expect(
      primaries,
      `broker ${brokerId} has ${String(primaries.length)} primary contacts among ${String(rows.length)}`,
    ).toHaveLength(1);
  }

  // Seeded fixtures, per tenant.
  let brokerTypeA = 0;
  let disabledBrokerTypeA = 0;
  let regionA = 0;
  let brokerTypeB = 0;

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

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');

    manager = await auth.createTestUserWithSession({ label: 'broker-manager' });
    viewer = await auth.createTestUserWithSession({ label: 'broker-viewer' });
    plainMember = await auth.createTestUserWithSession({ label: 'broker-member' });

    await addMembership(appUserId(manager), tenantA);
    await addMembership(appUserId(manager), tenantB);
    await addMembership(appUserId(viewer), tenantA);
    await addMembership(appUserId(plainMember), tenantA);

    for (const tenantId of [tenantA, tenantB]) {
      await fixtures.grantDirectPermission(appUserId(manager), 'brokers.manage', tenantId);
      await fixtures.grantDirectPermission(appUserId(manager), 'brokers.view', tenantId);
    }
    await fixtures.grantDirectPermission(appUserId(viewer), 'brokers.view', tenantA);
    // A DIFFERENT permission: proves the guard checks the required code, not "any grant at all".
    await fixtures.grantDirectPermission(appUserId(plainMember), 'leads.view', tenantA);

    brokerTypeA = await seedReferenceItem(tenantA, 'broker_type', uniqueName('Tier 1 A'));
    disabledBrokerTypeA = await seedReferenceItem(
      tenantA,
      'broker_type',
      uniqueName('Retired tier A'),
      false,
    );
    regionA = await seedReferenceItem(tenantA, 'region', uniqueName('Region A'));
    brokerTypeB = await seedReferenceItem(tenantB, 'broker_type', uniqueName('Tier 1 B'));
  }, 120_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on (tests/helpers/auth.ts), and every delete here swallows its error, so the reverse order
    // is a silent no-op that leaks this suite's tenants and audit rows into the next run.
    // Contacts before brokers before the tenant itself: nothing here relies on cascade, because the
    // by-convention broker_id reference has no physical FK (20260718003100_brokers.sql:12-21).
    for (const tenantId of createdTenants) {
      for (const table of [
        'broker_contacts',
        'brokers',
        'reference_items',
        'audit_log',
        'user_tenants',
      ]) {
        await query(`delete from ${table} where tenant_id = $1`, [tenantId]).catch(
          () => undefined,
        );
      }
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    // `db.destroy()` ends the pool it was constructed with — calling `pool.end()` as well throws
    // "Called end on pool more than once", which is why only one of the two appears here.
    await db?.destroy();
  }, 180_000);

  // ---------------------------------------------------------------------------------------------
  // Broker CRUD contract (AC-039, V-050)
  // ---------------------------------------------------------------------------------------------

  it('creates a broker with type and branch, returning 201, a Location header and empty contacts', async () => {
    const name = uniqueName('Acme Brokers');

    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name, brokerTypeId: brokerTypeA, branch: 'Cape Town' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as BrokerDetailDto;
    expect(body.name).toBe(name);
    expect(body.brokerTypeId).toBe(brokerTypeA);
    expect(body.branch).toBe('Cape Town');
    expect(body.status).toBe('active');
    expect(body.contacts).toEqual([]);
    expect(response.headers.get('location')).toBe(`/api/v1/brokers/${String(body.id)}`);

    // ...and it is readable back through the detail endpoint (the reference asserts this too).
    expect((await readDetail(tenantA, body.id)).name).toBe(name);
  });

  it('creates a broker with no type or branch, persisting nulls rather than rejecting', async () => {
    const created = await createBroker(tenantA, { name: uniqueName('Minimal Brokers') });

    expect(created.brokerTypeId).toBeNull();
    expect(created.branch).toBeNull();
    const row = await readBrokerRow(created.id);
    expect(row.broker_type_id).toBeNull();
    expect(row.branch).toBeNull();
    expect(row.status).toBe('active');
  });

  it('updates a broker name, type and branch and returns the detail with its contacts', async () => {
    const created = await createBroker(tenantA, { name: uniqueName('Before Rename') });
    await addContact(tenantA, created.id, { name: 'Kept Contact' });
    const renamed = uniqueName('After Rename');

    const response = await call('PUT', `${BASE}/${created.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: renamed, brokerTypeId: brokerTypeA, branch: 'Durban' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as BrokerDetailDto;
    expect(body.name).toBe(renamed);
    expect(body.brokerTypeId).toBe(brokerTypeA);
    expect(body.branch).toBe('Durban');
    // The update projection carries contacts — a caller that renames a broker keeps its contacts.
    expect(body.contacts.map((contact) => contact.name)).toEqual(['Kept Contact']);

    const row = await readBrokerRow(created.id);
    expect(row.name).toBe(renamed);
    expect(row.branch).toBe('Durban');
  });

  it('clears the type and branch when the update omits them', async () => {
    const created = await createBroker(tenantA, {
      name: uniqueName('Typed Brokers'),
      brokerTypeId: brokerTypeA,
      branch: 'Pretoria',
    });

    const response = await call('PUT', `${BASE}/${created.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: created.name },
    });

    expect(response.status).toBe(200);
    // UpdateBrokerCommandHandler.cs:57-59 assigns all three fields unconditionally, so an absent
    // optional field CLEARS the stored value rather than preserving it.
    const row = await readBrokerRow(created.id);
    expect(row.broker_type_id).toBeNull();
    expect(row.branch).toBeNull();
  });

  it('returns the picker-safe summary projection from the list, with no contacts', async () => {
    const created = await createBroker(tenantA, { name: uniqueName('Listed Brokers') });
    await addContact(tenantA, created.id, { name: 'Hidden From List' });

    const list = await readList(tenantA, '?pageSize=200');
    const found = list.items.find((item) => item.id === created.id);

    expect(found).toBeDefined();
    expect(Object.keys(found as object).sort()).toEqual([
      'branch',
      'brokerTypeId',
      'id',
      'name',
      'status',
    ]);
  });

  it('answers the list with the {items,totalCount,page,pageSize} envelope and echoes the paging', async () => {
    const list = await readList(tenantA, '?page=1&pageSize=5');

    expect(list.page).toBe(1);
    expect(list.pageSize).toBe(5);
    expect(list.items.length).toBeLessThanOrEqual(5);
    expect(typeof list.totalCount).toBe('number');
    expect(list.totalCount).toBeGreaterThanOrEqual(list.items.length);
  });

  it('defaults to page 1 and pageSize 25 when the query omits them', async () => {
    const list = await readList(tenantA);

    expect(list.page).toBe(1);
    expect(list.pageSize).toBe(25);
  });

  it('orders by name then id and slices by page, counting the whole filtered set', async () => {
    const tenantId = await createTenant('paging');
    await addMembership(appUserId(manager), tenantId);
    await fixtures.grantDirectPermission(appUserId(manager), 'brokers.manage', tenantId);
    await fixtures.grantDirectPermission(appUserId(manager), 'brokers.view', tenantId);

    // Created out of alphabetical order, so an id-ordered implementation would fail this.
    for (const suffix of ['C', 'A', 'B']) {
      await createBroker(tenantId, { name: `Paging ${suffix} ${RUN}` });
    }

    const first = await readList(tenantId, '?page=1&pageSize=2');
    const second = await readList(tenantId, '?page=2&pageSize=2');

    expect(first.items.map((item) => item.name)).toEqual([
      `Paging A ${RUN}`,
      `Paging B ${RUN}`,
    ]);
    expect(second.items.map((item) => item.name)).toEqual([`Paging C ${RUN}`]);
    // totalCount is the size of the FILTERED set, not of the returned page.
    expect(first.totalCount).toBe(3);
    expect(second.totalCount).toBe(3);
  });

  it('filters the list by status, brokerTypeId and a case-insensitive name search', async () => {
    const tenantId = await createTenant('filters');
    await addMembership(appUserId(manager), tenantId);
    await fixtures.grantDirectPermission(appUserId(manager), 'brokers.manage', tenantId);
    await fixtures.grantDirectPermission(appUserId(manager), 'brokers.view', tenantId);
    const typeId = await seedReferenceItem(tenantId, 'broker_type', uniqueName('Filter tier'));

    const typed = await createBroker(tenantId, {
      name: `Zeta Filter ${RUN}`,
      brokerTypeId: typeId,
    });
    const untyped = await createBroker(tenantId, { name: `Omega Filter ${RUN}` });
    await call('POST', `${BASE}/${untyped.id}/disable`, {
      token: manager.accessToken,
      tenantId,
    });

    const active = await readList(tenantId, '?status=active');
    expect(active.items.map((item) => item.id)).toEqual([typed.id]);

    const disabled = await readList(tenantId, '?status=disabled');
    expect(disabled.items.map((item) => item.id)).toEqual([untyped.id]);

    const byType = await readList(tenantId, `?brokerTypeId=${String(typeId)}`);
    expect(byType.items.map((item) => item.id)).toEqual([typed.id]);

    // `BrokerStore.ListAsync` lower-cases both sides (:52-53): 'zeta' matches 'Zeta'.
    const bySearch = await readList(tenantId, '?search=zeta');
    expect(bySearch.items.map((item) => item.id)).toEqual([typed.id]);
    expect(bySearch.totalCount).toBe(1);
  });

  it('keeps a disabled broker out of the active picker while its detail stays resolvable (N-09)', async () => {
    const created = await createBroker(tenantA, { name: uniqueName('Retiring Brokers') });

    const response = await call('POST', `${BASE}/${created.id}/disable`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    // `Results.Ok()` with no value (BrokerEndpoints.cs:83) — an EMPTY body, preserved not modernised.
    expect(await response.text()).toBe('');

    const picker = await readList(tenantA, '?status=active&pageSize=200');
    expect(picker.items.some((item) => item.id === created.id)).toBe(false);

    // ...and the row itself survives, so a historical lead/quote pointing at it still resolves.
    const detail = await readDetail(tenantA, created.id);
    expect(detail.status).toBe('disabled');
    expect(detail.name).toBe(created.name);
  });

  it('treats a repeated disable as idempotent, without a second audit row', async () => {
    const created = await createBroker(tenantA, { name: uniqueName('Twice Disabled') });

    const first = await call('POST', `${BASE}/${created.id}/disable`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });
    const second = await call('POST', `${BASE}/${created.id}/disable`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await readBrokerRow(created.id)).status).toBe('disabled');
    // DisableBrokerCommandHandler.cs:27-30 returns success WITHOUT auditing an already-disabled
    // broker. A retried request therefore cannot inflate the audit trail.
    const rows = await findAuditRows(query, {
      action: BROKER_DISABLED_ACTION,
      entityId: String(created.id),
    });
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------------
  // Broker validation — the reference's exact codes (BrokerEndpoints.cs:123-145)
  // ---------------------------------------------------------------------------------------------

  it('rejects a create with no name as 422 BROKER_VALIDATION_FAILED', async () => {
    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: '' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as ProblemBody;
    expect(body.code).toBe('BROKER_VALIDATION_FAILED');
    expect(body.detail).toContain('BROKER_VALIDATION_FAILED');
  });

  it('rejects a name longer than 200 characters as 422 BROKER_VALIDATION_FAILED', async () => {
    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'x'.repeat(201) },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_VALIDATION_FAILED');
  });

  it('rejects a disabled broker type as 422 BROKER_INVALID_BROKER_TYPE', async () => {
    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Bad type'), brokerTypeId: disabledBrokerTypeA },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as ProblemBody;
    expect(body.code).toBe('BROKER_INVALID_BROKER_TYPE');
    expect(body.detail).toContain('BROKER_INVALID_BROKER_TYPE');
  });

  it('rejects a reference id from the wrong list type as 422 BROKER_INVALID_BROKER_TYPE', async () => {
    // `IsActiveBrokerTypeAsync` (ReferenceDataStore.cs:83-92) pins list_type as well as is_active,
    // so a region id is not silently accepted as a broker type.
    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Wrong list type'), brokerTypeId: regionA },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_INVALID_BROKER_TYPE');
  });

  it("rejects another tenant's broker type as 422 BROKER_INVALID_BROKER_TYPE", async () => {
    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: uniqueName('Foreign type'), brokerTypeId: brokerTypeB },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_INVALID_BROKER_TYPE');
  });

  it('rejects a duplicate name as 409 BROKER_DUPLICATE_NAME, case-insensitively', async () => {
    const name = uniqueName('Duplicate Brokers');
    await createBroker(tenantA, { name });

    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: name.toUpperCase() },
    });

    // 409, NOT the 422 the sibling reference-data mapper uses for its duplicate: measured at
    // BrokerEndpoints.cs:130-134. Each port follows its own reference file rather than a house rule.
    expect(response.status).toBe(409);
    const body = (await response.json()) as ProblemBody;
    expect(body.code).toBe('BROKER_DUPLICATE_NAME');
    expect(body.detail).toContain('BROKER_DUPLICATE_NAME');
  });

  it('lets an update keep its own name but refuses another broker’s name with 409', async () => {
    const first = await createBroker(tenantA, { name: uniqueName('Rename Source') });
    const second = await createBroker(tenantA, { name: uniqueName('Rename Target') });

    const selfRename = await call('PUT', `${BASE}/${first.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: first.name, branch: 'Unchanged name' },
    });
    const collision = await call('PUT', `${BASE}/${first.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: second.name },
    });

    expect(selfRename.status).toBe(200);
    expect(collision.status).toBe(409);
    expect(((await collision.json()) as ProblemBody).code).toBe('BROKER_DUPLICATE_NAME');
    expect((await readBrokerRow(first.id)).name).toBe(first.name);
  });

  it('lets two tenants each own a broker of the same name', async () => {
    const name = `Shared Name ${RUN}`;
    const inA = await createBroker(tenantA, { name });
    const inB = await createBroker(tenantB, { name });

    // uq_brokers_tenant_name is (tenant_id, name): the uniqueness is per tenant, not global.
    expect((await readBrokerRow(inA.id)).tenant_id).toBe(String(tenantA));
    expect((await readBrokerRow(inB.id)).tenant_id).toBe(String(tenantB));
  });

  it('answers 404 BROKER_NOT_FOUND for an id that does not exist', async () => {
    const response = await call('GET', `${BASE}/999999999`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as ProblemBody;
    expect(body.code).toBe('BROKER_NOT_FOUND');
    expect(body.detail).toContain('BROKER_NOT_FOUND');
  });

  it('answers 404 for a non-numeric broker id rather than validating it', async () => {
    // ASP.NET's `{id:long}` constraint means a non-numeric id does not MATCH the route at all.
    const response = await call('GET', `${BASE}/not-a-number`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(404);
  });

  it('rejects an unknown body field rather than silently ignoring it', async () => {
    const response = await call('POST', BASE, {
      token: manager.accessToken,
      tenantId: tenantA,
      // `status` is set exclusively by the disable endpoint; no request shape may carry it.
      body: { name: uniqueName('Smuggled status'), status: 'disabled' },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_VALIDATION_FAILED');
  });

  // ---------------------------------------------------------------------------------------------
  // Broker contacts and the exactly-one-primary invariant (AC-039, V-050)
  // ---------------------------------------------------------------------------------------------

  it("makes a broker's first contact primary even when the caller asks for isPrimary false", async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('First Contact Co') });

    const contact = await addContact(tenantA, broker.id, {
      name: 'Jane First',
      email: 'jane@example.com',
      phone: '+27 21 555 0100',
      isPrimary: false,
    });

    // AddContactCommand.cs:6-10: the invariant wins over the caller's request.
    expect(contact.isPrimary).toBe(true);
    expect(contact.email).toBe('jane@example.com');
    expect(contact.phone).toBe('+27 21 555 0100');
    await assertExactlyOnePrimary(broker.id);
  });

  it('demotes the previous primary when a new contact is added as primary', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Demote On Add Co') });
    const first = await addContact(tenantA, broker.id, { name: 'First' });

    const second = await addContact(tenantA, broker.id, { name: 'Second', isPrimary: true });

    expect(second.isPrimary).toBe(true);
    const rows = await readContactRows(broker.id);
    expect(rows.find((row) => row.id === first.id)?.isPrimary).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.isPrimary).toBe(true);
    await assertExactlyOnePrimary(broker.id);
  });

  it('leaves the existing primary alone when a further contact is added as non-primary', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Keep Primary Co') });
    const first = await addContact(tenantA, broker.id, { name: 'First' });

    const second = await addContact(tenantA, broker.id, { name: 'Second', isPrimary: false });

    expect(second.isPrimary).toBe(false);
    const rows = await readContactRows(broker.id);
    expect(rows.find((row) => row.id === first.id)?.isPrimary).toBe(true);
    await assertExactlyOnePrimary(broker.id);
  });

  it('demotes the existing primary when another contact is promoted via set-primary', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Set Primary Co') });
    const first = await addContact(tenantA, broker.id, { name: 'First' });
    const second = await addContact(tenantA, broker.id, { name: 'Second' });

    const response = await call('POST', `${BASE}/${broker.id}/contacts/${second.id}/set-primary`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as BrokerContactDto).isPrimary).toBe(true);
    const rows = await readContactRows(broker.id);
    expect(rows.find((row) => row.id === first.id)?.isPrimary).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.isPrimary).toBe(true);
    await assertExactlyOnePrimary(broker.id);
  });

  it('treats set-primary on the contact that is already primary as an idempotent no-op', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Idempotent Primary Co') });
    const first = await addContact(tenantA, broker.id, { name: 'First' });

    const response = await call('POST', `${BASE}/${broker.id}/contacts/${first.id}/set-primary`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as BrokerContactDto).isPrimary).toBe(true);
    await assertExactlyOnePrimary(broker.id);
    // SetPrimaryContactCommandHandler.cs:41-44 returns early, so no audit row is written at all.
    const rows = await findAuditRows(query, {
      action: BROKER_CONTACT_SET_PRIMARY_ACTION,
      entityId: String(first.id),
    });
    expect(rows).toHaveLength(0);
  });

  it('promotes the oldest remaining contact when the primary is removed', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Promote On Remove Co') });
    const first = await addContact(tenantA, broker.id, { name: 'First' });
    const second = await addContact(tenantA, broker.id, { name: 'Second' });
    const third = await addContact(tenantA, broker.id, { name: 'Third' });

    const response = await call('DELETE', `${BASE}/${broker.id}/contacts/${first.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    // RemoveContactCommandHandler.cs:58-59: the LOWEST-id remaining contact is promoted, and the
    // delete + promote commit atomically. Read from the database, not the response.
    const rows = await readContactRows(broker.id);
    expect(rows.map((row) => row.id)).toEqual([second.id, third.id]);
    expect(rows.find((row) => row.id === second.id)?.isPrimary).toBe(true);
    expect(rows.find((row) => row.id === third.id)?.isPrimary).toBe(false);
    await assertExactlyOnePrimary(broker.id);
  });

  it('leaves the primary untouched when a non-primary contact is removed', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Remove Secondary Co') });
    const first = await addContact(tenantA, broker.id, { name: 'First' });
    const second = await addContact(tenantA, broker.id, { name: 'Second' });

    const response = await call('DELETE', `${BASE}/${broker.id}/contacts/${second.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    const rows = await readContactRows(broker.id);
    expect(rows.map((row) => row.id)).toEqual([first.id]);
    expect(rows[0]?.isPrimary).toBe(true);
    await assertExactlyOnePrimary(broker.id);
  });

  it('leaves a broker with zero contacts and zero primaries when the last contact is removed', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Last Contact Co') });
    const only = await addContact(tenantA, broker.id, { name: 'Only' });

    const response = await call('DELETE', `${BASE}/${broker.id}/contacts/${only.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    expect(await readContactRows(broker.id)).toEqual([]);
    expect((await readDetail(tenantA, broker.id)).contacts).toEqual([]);
  });

  it('holds exactly one primary through a long sequence of add, promote and remove operations', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Invariant Sequence Co') });

    const a = await addContact(tenantA, broker.id, { name: 'A' });
    await assertExactlyOnePrimary(broker.id);
    const b = await addContact(tenantA, broker.id, { name: 'B', isPrimary: true });
    await assertExactlyOnePrimary(broker.id);
    const c = await addContact(tenantA, broker.id, { name: 'C' });
    await assertExactlyOnePrimary(broker.id);

    for (const target of [a, c, b, a]) {
      const response = await call(
        'POST',
        `${BASE}/${broker.id}/contacts/${target.id}/set-primary`,
        { token: manager.accessToken, tenantId: tenantA },
      );
      expect(response.status).toBe(200);
      await assertExactlyOnePrimary(broker.id);
      const rows = await readContactRows(broker.id);
      expect(rows.find((row) => row.id === target.id)?.isPrimary).toBe(true);
    }

    // `a` is primary here; removing it must promote the next-oldest survivor, not leave zero.
    await call('DELETE', `${BASE}/${broker.id}/contacts/${a.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });
    await assertExactlyOnePrimary(broker.id);
    await call('DELETE', `${BASE}/${broker.id}/contacts/${b.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });
    await assertExactlyOnePrimary(broker.id);

    const remaining = await readContactRows(broker.id);
    expect(remaining.map((row) => row.id)).toEqual([c.id]);
    expect(remaining[0]?.isPrimary).toBe(true);
  });

  it('updates a contact’s name, email and phone without touching its primary flag', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Contact Edit Co') });
    const contact = await addContact(tenantA, broker.id, { name: 'Before', email: 'a@example.com' });

    const response = await call('PUT', `${BASE}/${broker.id}/contacts/${contact.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'After', email: 'b@example.com', phone: '555' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as BrokerContactDto;
    expect(body.name).toBe('After');
    expect(body.email).toBe('b@example.com');
    expect(body.phone).toBe('555');
    // UpdateContactCommand.cs:6: the primary flag is changed ONLY via set-primary.
    expect(body.isPrimary).toBe(true);
    await assertExactlyOnePrimary(broker.id);
  });

  it('rejects a contact update that tries to carry isPrimary', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('No Primary Smuggling Co') });
    const first = await addContact(tenantA, broker.id, { name: 'First' });
    const second = await addContact(tenantA, broker.id, { name: 'Second' });

    const response = await call('PUT', `${BASE}/${broker.id}/contacts/${second.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'Second', isPrimary: true },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_CONTACT_VALIDATION_FAILED');
    const rows = await readContactRows(broker.id);
    expect(rows.find((row) => row.id === first.id)?.isPrimary).toBe(true);
    expect(rows.find((row) => row.id === second.id)?.isPrimary).toBe(false);
  });

  it('rejects a malformed contact email as 422 BROKER_CONTACT_VALIDATION_FAILED', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Bad Email Co') });

    const response = await call('POST', `${BASE}/${broker.id}/contacts`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'Bad Email', email: 'not-an-email' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as ProblemBody;
    expect(body.code).toBe('BROKER_CONTACT_VALIDATION_FAILED');
    expect(body.detail).toContain('BROKER_CONTACT_VALIDATION_FAILED');
    expect(await readContactRows(broker.id)).toEqual([]);
  });

  it('accepts an absent or empty contact email, matching the reference’s conditional rule', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('No Email Co') });

    // `RuleFor(x => x.Email).EmailAddress().When(x => !string.IsNullOrWhiteSpace(x.Email))`
    // (AddContactValidator.cs:10): the format rule does not fire on null/blank.
    const absent = await addContact(tenantA, broker.id, { name: 'No Email' });
    expect(absent.email).toBeNull();

    const blank = await call('POST', `${BASE}/${broker.id}/contacts`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'Blank Email', email: '   ' },
    });
    expect(blank.status).toBe(201);
  });

  it('rejects a contact phone longer than 50 characters as 422 BROKER_CONTACT_VALIDATION_FAILED', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Long Phone Co') });

    const response = await call('POST', `${BASE}/${broker.id}/contacts`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'Long Phone', phone: '0'.repeat(51) },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_CONTACT_VALIDATION_FAILED');
  });

  it('rejects a contact with no name as 422 BROKER_CONTACT_VALIDATION_FAILED', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('No Contact Name Co') });

    const response = await call('POST', `${BASE}/${broker.id}/contacts`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: '' },
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_CONTACT_VALIDATION_FAILED');
  });

  it('answers 404 BROKER_CONTACT_NOT_FOUND for a contact id that does not exist', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Missing Contact Co') });

    const response = await call('DELETE', `${BASE}/${broker.id}/contacts/999999999`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as ProblemBody;
    expect(body.code).toBe('BROKER_CONTACT_NOT_FOUND');
    expect(body.detail).toContain('BROKER_CONTACT_NOT_FOUND');
  });

  it("answers 404 when a contact is addressed under a different broker of the same tenant", async () => {
    const owner = await createBroker(tenantA, { name: uniqueName('Contact Owner Co') });
    const other = await createBroker(tenantA, { name: uniqueName('Contact Stranger Co') });
    const contact = await addContact(tenantA, owner.id, { name: 'Belongs To Owner' });

    // The contact-to-broker association is part of the lookup, not just of the URL: without the
    // `broker_id` predicate this would edit another broker's contact through the wrong path.
    const update = await call('PUT', `${BASE}/${other.id}/contacts/${contact.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'Hijacked' },
    });
    const remove = await call('DELETE', `${BASE}/${other.id}/contacts/${contact.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });
    const promote = await call(
      'POST',
      `${BASE}/${other.id}/contacts/${contact.id}/set-primary`,
      { token: manager.accessToken, tenantId: tenantA },
    );

    expect(update.status).toBe(404);
    expect(((await update.json()) as ProblemBody).code).toBe('BROKER_CONTACT_NOT_FOUND');
    expect(remove.status).toBe(404);
    expect(promote.status).toBe(404);
    const rows = await readContactRows(owner.id);
    expect(rows.map((row) => row.name)).toEqual(['Belongs To Owner']);
  });

  it('answers 404 BROKER_NOT_FOUND when adding a contact to a broker that does not exist', async () => {
    const response = await call('POST', `${BASE}/999999999/contacts`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'Orphan' },
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------------------------
  // Audit (AC-024, V-031)
  // ---------------------------------------------------------------------------------------------

  it('audits broker create, update and disable with before/after payloads', async () => {
    const name = uniqueName('Audited Brokers');
    const created = await createBroker(tenantA, { name });
    const renamed = `${name} Renamed`;

    await call('PUT', `${BASE}/${created.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: renamed, brokerTypeId: brokerTypeA, branch: 'Audited Branch' },
    });
    await call('POST', `${BASE}/${created.id}/disable`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    await assertAudited(query, {
      action: BROKER_CREATED_ACTION,
      entityType: 'broker',
      entityId: String(created.id),
      actorUserId: appUserId(manager),
      tenantId: tenantA,
      before: null,
      after: { name, brokerTypeId: null, branch: null },
    });
    await assertAudited(query, {
      action: BROKER_UPDATED_ACTION,
      entityType: 'broker',
      entityId: String(created.id),
      tenantId: tenantA,
      before: { name, brokerTypeId: null, branch: null },
      after: { name: renamed, brokerTypeId: brokerTypeA, branch: 'Audited Branch' },
    });
    await assertAudited(query, {
      action: BROKER_DISABLED_ACTION,
      entityType: 'broker',
      entityId: String(created.id),
      tenantId: tenantA,
      before: { name: renamed, status: 'active' },
      after: { name: renamed, status: 'disabled' },
    });
  });

  it('audits contact add, update, set-primary and remove', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('Audited Contacts Co') });
    const first = await addContact(tenantA, broker.id, { name: 'Audit First' });
    const second = await addContact(tenantA, broker.id, { name: 'Audit Second' });

    await call('PUT', `${BASE}/${broker.id}/contacts/${second.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
      body: { name: 'Audit Second Renamed', phone: '555' },
    });
    await call('POST', `${BASE}/${broker.id}/contacts/${second.id}/set-primary`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });
    await call('DELETE', `${BASE}/${broker.id}/contacts/${second.id}`, {
      token: manager.accessToken,
      tenantId: tenantA,
    });

    await assertAudited(query, {
      action: BROKER_CONTACT_ADDED_ACTION,
      entityType: 'broker_contact',
      entityId: String(second.id),
      actorUserId: appUserId(manager),
      tenantId: tenantA,
      before: null,
      after: {
        brokerId: broker.id,
        name: 'Audit Second',
        email: null,
        phone: null,
        isPrimary: false,
      },
    });
    await assertAudited(query, {
      action: BROKER_CONTACT_UPDATED_ACTION,
      entityId: String(second.id),
      tenantId: tenantA,
      before: { name: 'Audit Second', email: null, phone: null },
      after: { name: 'Audit Second Renamed', email: null, phone: '555' },
    });
    await assertAudited(query, {
      action: BROKER_CONTACT_SET_PRIMARY_ACTION,
      entityId: String(second.id),
      tenantId: tenantA,
      before: { brokerId: broker.id, primaryContactId: first.id },
      after: { brokerId: broker.id, primaryContactId: second.id },
    });
    await assertAudited(query, {
      action: BROKER_CONTACT_REMOVED_ACTION,
      entityId: String(second.id),
      tenantId: tenantA,
      before: {
        brokerId: broker.id,
        name: 'Audit Second Renamed',
        wasPrimary: true,
      },
      after: { promotedContactId: first.id },
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Permission matrix (BrokerEndpoints.cs:33-42)
  // ---------------------------------------------------------------------------------------------

  it('lets a plain tenant member read the broker list, because it is the picker every screen uses', async () => {
    const created = await createBroker(tenantA, { name: uniqueName('Member Visible Brokers') });

    const response = await call('GET', `${BASE}?pageSize=200`, {
      token: plainMember.accessToken,
      tenantId: tenantA,
    });

    // Membership-only by deliberate 2026-07-13 fix (BrokerEndpoints.cs:29-33): the Broker dropdown
    // appears in every leads filter row, the intake form and every dashboard filter bar. Re-adding
    // a permission here would 403 intake for every non-admin role.
    expect(response.status).toBe(200);
    const body = (await response.json()) as BrokerListDto;
    expect(body.items.some((item) => item.id === created.id)).toBe(true);
  });

  it('refuses the contact-bearing detail read to a plain tenant member with 403', async () => {
    const created = await createBroker(tenantA, { name: uniqueName('Detail Gated Brokers') });

    const response = await call('GET', `${BASE}/${created.id}`, {
      token: plainMember.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(403);
  });

  it('refuses every mutation to a caller holding brokers.view but not brokers.manage', async () => {
    const broker = await createBroker(tenantA, { name: uniqueName('View Only Co') });
    const contact = await addContact(tenantA, broker.id, { name: 'Untouchable' });
    const token = viewer.accessToken;

    const attempts: [string, string, unknown?][] = [
      ['POST', BASE, { name: uniqueName('Forbidden Create') }],
      ['PUT', `${BASE}/${broker.id}`, { name: uniqueName('Forbidden Rename') }],
      ['POST', `${BASE}/${broker.id}/disable`, undefined],
      ['POST', `${BASE}/${broker.id}/contacts`, { name: 'Forbidden Contact' }],
      ['PUT', `${BASE}/${broker.id}/contacts/${contact.id}`, { name: 'Forbidden Edit' }],
      ['DELETE', `${BASE}/${broker.id}/contacts/${contact.id}`, undefined],
      ['POST', `${BASE}/${broker.id}/contacts/${contact.id}/set-primary`, undefined],
    ];

    for (const [method, path, body] of attempts) {
      const response = await call(method, path, {
        token,
        tenantId: tenantA,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path} should be 403`).toBe(403);
    }

    // brokers.view IS enough for the detail read, proving the guard checks the specific code.
    const detail = await call('GET', `${BASE}/${broker.id}`, { token, tenantId: tenantA });
    expect(detail.status).toBe(200);
    // ...and nothing above left a mark.
    const rows = await readContactRows(broker.id);
    expect(rows.map((row) => row.name)).toEqual(['Untouchable']);
    expect((await readBrokerRow(broker.id)).status).toBe('active');
  });

  it('rejects an unauthenticated request before it reaches a handler', async () => {
    const response = await call('GET', BASE, { tenantId: tenantA });

    expect(response.status).toBe(401);
  });

  it('refuses a caller who is not a member of the tenant named in the header', async () => {
    // The T-013 middleware rejects this before any handler runs: `viewer` is a member of tenant A
    // only, so tenant B's id in the header is not a tenant they may act in.
    const response = await call('GET', BASE, {
      token: viewer.accessToken,
      tenantId: tenantB,
    });

    expect(response.status).toBe(403);
  });

  // ---------------------------------------------------------------------------------------------
  // Tenant isolation — one test per endpoint (AC-022, V-027)
  // ---------------------------------------------------------------------------------------------

  it("keeps another tenant's brokers out of the list", async () => {
    const inA = await createBroker(tenantA, { name: uniqueName('Isolation A Broker') });
    const inB = await createBroker(tenantB, { name: uniqueName('Isolation B Broker') });

    const listB = await readList(tenantB, '?pageSize=200');

    expect(listB.items.some((item) => item.id === inA.id)).toBe(false);
    expect(listB.items.some((item) => item.id === inB.id)).toBe(true);
  });

  it("answers 404 for a detail read addressed at another tenant's broker id", async () => {
    const inA = await createBroker(tenantA, { name: uniqueName('Cross Detail Broker') });

    const response = await call('GET', `${BASE}/${inA.id}`, {
      token: manager.accessToken,
      tenantId: tenantB,
    });

    // Indistinguishable from a nonexistent id: existence itself must not leak (N-01).
    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_NOT_FOUND');
  });

  it("refuses to update another tenant's broker, with no side effect", async () => {
    const inA = await createBroker(tenantA, { name: uniqueName('Cross Update Broker') });
    const before = await readBrokerRow(inA.id);

    const response = await call('PUT', `${BASE}/${inA.id}`, {
      token: manager.accessToken,
      tenantId: tenantB,
      body: { name: 'Hijacked', branch: 'Hijacked branch' },
    });

    expect(response.status).toBe(404);
    const after = await readBrokerRow(inA.id);
    expect(after.name).toBe(before.name);
    expect(after.branch).toBe(before.branch);
    expect(after.tenant_id).toBe(String(tenantA));
  });

  it("refuses to disable another tenant's broker, with no side effect", async () => {
    const inA = await createBroker(tenantA, { name: uniqueName('Cross Disable Broker') });

    const response = await call('POST', `${BASE}/${inA.id}/disable`, {
      token: manager.accessToken,
      tenantId: tenantB,
    });

    expect(response.status).toBe(404);
    expect((await readBrokerRow(inA.id)).status).toBe('active');
  });

  it("refuses to add a contact to another tenant's broker, with no side effect", async () => {
    const inA = await createBroker(tenantA, { name: uniqueName('Cross Add Contact Broker') });

    const response = await call('POST', `${BASE}/${inA.id}/contacts`, {
      token: manager.accessToken,
      tenantId: tenantB,
      body: { name: 'Injected Contact' },
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('BROKER_NOT_FOUND');
    expect(await readContactRows(inA.id)).toEqual([]);
  });

  it("refuses to update, remove or promote another tenant's contact, with no side effect", async () => {
    const inA = await createBroker(tenantA, { name: uniqueName('Cross Contact Broker') });
    const first = await addContact(tenantA, inA.id, { name: 'Tenant A First' });
    const second = await addContact(tenantA, inA.id, { name: 'Tenant A Second' });

    const update = await call('PUT', `${BASE}/${inA.id}/contacts/${first.id}`, {
      token: manager.accessToken,
      tenantId: tenantB,
      body: { name: 'Hijacked Contact' },
    });
    const promote = await call(
      'POST',
      `${BASE}/${inA.id}/contacts/${second.id}/set-primary`,
      { token: manager.accessToken, tenantId: tenantB },
    );
    const remove = await call('DELETE', `${BASE}/${inA.id}/contacts/${first.id}`, {
      token: manager.accessToken,
      tenantId: tenantB,
    });

    expect(update.status).toBe(404);
    expect(promote.status).toBe(404);
    expect(remove.status).toBe(404);

    const rows = await readContactRows(inA.id);
    expect(rows.map((row) => row.name)).toEqual(['Tenant A First', 'Tenant A Second']);
    expect(rows.find((row) => row.id === first.id)?.isPrimary).toBe(true);
    expect(rows.every((row) => row.tenantId === String(tenantA))).toBe(true);
  });

  it('writes a created broker into the acting tenant, never the one a hostile body names', async () => {
    const created = await createBroker(tenantB, { name: uniqueName('Written Into B') });

    expect((await readBrokerRow(created.id)).tenant_id).toBe(String(tenantB));
    const listA = await readList(tenantA, '?pageSize=200');
    expect(listA.items.some((item) => item.id === created.id)).toBe(false);
  });

  it('writes a created contact into the acting tenant', async () => {
    const broker = await createBroker(tenantB, { name: uniqueName('Contact Tenant B Co') });
    const contact = await addContact(tenantB, broker.id, { name: 'Tenant B Contact' });

    const rows = await readContactRows(broker.id);
    expect(rows.find((row) => row.id === contact.id)?.tenantId).toBe(String(tenantB));
  });
});
