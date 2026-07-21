/**
 * The Leads list: columns, filters, sort, paging, search and VISIBILITY BREADTH
 * (T-024; AC-022, AC-045; V-027, V-058).
 *
 * Split from `leads-core.test.ts` because the fixture it needs is different in kind: the list tests
 * want a fixed, hand-seeded corpus with known ordering and known ownership, seeded straight into
 * the database rather than created through the API, so that ordering assertions do not depend on
 * creation timing and breadth assertions do not depend on who happened to create what.
 *
 * THE BREADTH MATRIX IS THE POINT OF THIS FILE (AC-045)
 * ====================================================
 * `leads.view_all` is a VISIBILITY-BREADTH permission: it gates no route, it widens a query
 * predicate. That makes it invisible to any route-level permission test — a caller without it gets
 * 200 either way. The only thing that can catch a dropped or inverted breadth predicate is
 * comparing the ROWS two differently-granted callers see over identical data, which is what the
 * matrix below does, including `totalCount` (a post-filtered implementation would return the
 * restricted caller's rows with the unrestricted caller's count).
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('leads-list', probe);

const BASE = '/api/v1/leads';

interface LeadListItemDto {
  readonly id: number;
  readonly leadRef: string;
  readonly partyId: number;
  readonly partyName: string;
  readonly brokerId: number | null;
  readonly brokerName: string | null;
  readonly productLineName: string;
  readonly coverTypeName: string;
  readonly premium: number | null;
  readonly statusName: string;
  readonly priority: string;
  readonly dateReceived: string;
  readonly ageDays: number;
  readonly owner: { userId: number; firstName: string; lastName: string } | null;
  readonly nextFollowUpDate: string | null;
  readonly flags: string[];
}

interface LeadListDto {
  readonly items: LeadListItemDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/** Short, for the same trigram reason documented in leads-core.test.ts. */
const RUN = `t24l-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
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

  /** Holds `leads.view` AND `leads.view_all`: sees every lead in the tenant. */
  let broad: TestUserSession;
  /** Holds `leads.view` ONLY: sees only leads assigned to them. */
  let restricted: TestUserSession;
  /** A third user who owns some leads, so "restricted sees only their own" has something to exclude. */
  let stranger: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  let tenantC = 0;

  const createdTenants: number[] = [];

  const OWNED_TABLES = [
    'lead_notes',
    'lead_assignments',
    'leads',
    'reference_sequences',
    'business_assignments',
    'brokers',
    'parties',
    'reference_items',
    'tenant_settings',
    'audit_log',
    'user_tenants',
  ] as const;

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  async function deleteTenantData(tenantId: number): Promise<void> {
    for (const table of OWNED_TABLES) {
      await query(`delete from ${table} where tenant_id = $1`, [tenantId]).catch(() => undefined);
    }
    await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
  }

  async function purgeStaleRunsOfThisSuite(): Promise<void> {
    const stale = await query<{ id: string }>(
      "select id::text as id from tenants where name like 't24l-%'",
    ).catch(() => []);
    for (const row of stale) {
      await deleteTenantData(Number(row.id));
    }
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
    await query('select create_tenant_partitions($1)', [id]);
    return id;
  }

  async function addMembership(userId: number, tenantId: number): Promise<void> {
    await query('insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())', [
      tenantId,
      userId,
    ]);
  }

  async function seedRef(
    tenantId: number,
    listType: string,
    name: string,
    options: { productLineId?: number | null; reportingCategory?: string | null } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, product_line_id,
          created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, now(), now())
       returning id::text as id`,
      [tenantId, listType, name, options.reportingCategory ?? null, options.productLineId ?? null],
    );
    return Number(rows[0]?.id);
  }

  async function seedParty(tenantId: number, name: string, partyTypeId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, name, partyTypeId],
    );
    return Number(rows[0]?.id);
  }

  async function seedBroker(tenantId: number, name: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into brokers (tenant_id, name, status, created_at, updated_at)
       values ($1, $2, 'active', now(), now()) returning id::text as id`,
      [tenantId, name],
    );
    return Number(rows[0]?.id);
  }

  async function seedRmSlot(tenantId: number, roleId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
       values ($1, 'rm', $2, now(), now()) returning id::text as id`,
      [tenantId, roleId],
    );
    return Number(rows[0]?.id);
  }

  interface SeedLead {
    readonly partyId: number;
    readonly leadRef: string;
    readonly statusId: number;
    readonly productLineId: number;
    readonly coverTypeId: number;
    readonly regionId: number;
    readonly requestChannelId: number;
    readonly brokerId?: number | null;
    readonly estimatedPremium?: number | null;
    readonly dateReceived?: string;
    readonly priority?: string;
    readonly nextFollowUpDate?: string | null;
  }

  async function seedLead(tenantId: number, lead: SeedLead): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into leads
         (tenant_id, party_id, lead_ref, date_received, request_channel_id, broker_id, region_id,
          product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
          next_follow_up_date, source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'm12', $11, $12, $13, 'browser', now(), now())
       returning id::text as id`,
      [
        tenantId,
        lead.partyId,
        lead.leadRef,
        lead.dateReceived ?? '2026-01-15',
        lead.requestChannelId,
        lead.brokerId ?? null,
        lead.regionId,
        lead.productLineId,
        lead.coverTypeId,
        lead.estimatedPremium ?? null,
        lead.priority ?? 'normal',
        lead.statusId,
        lead.nextFollowUpDate ?? null,
      ],
    );
    return Number(rows[0]?.id);
  }

  /** Assigns a lead's accountable owner directly, bypassing the API. */
  async function assignOwner(
    tenantId: number,
    leadId: number,
    businessAssignmentId: number,
    userId: number,
  ): Promise<void> {
    await query(
      `insert into lead_assignments
         (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [tenantId, leadId, businessAssignmentId, userId],
    );
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
      leads: { db },
    });
  }

  async function call(
    method: string,
    path: string,
    options: { token?: string; tenantId?: number } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    return await harness().request(`http://localhost${path}`, { method, headers });
  }

  async function readList(
    session: TestUserSession,
    queryString = '',
    tenantId = tenantA,
  ): Promise<LeadListDto> {
    const response = await call('GET', `${BASE}${queryString}`, {
      token: session.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as LeadListDto;
  }

  // Reference fixtures.
  let partyTypeA = 0;
  let regionA = 0;
  let regionA2 = 0;
  let channelA = 0;
  let channelA2 = 0;
  let productLineA = 0;
  let productLineA2 = 0;
  let coverTypeA = 0;
  let coverTypeA2 = 0;
  let openStatusA = 0;
  let wonStatusA = 0;
  let brokerAcme = 0;
  let brokerZulu = 0;
  let rmAssignmentA = 0;

  // Leads owned by `restricted`.
  let ownedByRestricted: number[] = [];
  // Leads owned by `stranger` — invisible to `restricted`.
  let ownedByStranger: number[] = [];

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

    await purgeStaleRunsOfThisSuite();

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');

    broad = await auth.createTestUserWithSession({
      label: 'list-broad',
      firstName: 'Ada',
      lastName: 'Zulu',
    });
    restricted = await auth.createTestUserWithSession({
      label: 'list-restricted',
      firstName: 'Bea',
      lastName: 'Yankee',
    });
    stranger = await auth.createTestUserWithSession({
      label: 'list-stranger',
      firstName: 'Cal',
      lastName: 'Xray',
    });

    for (const session of [broad, restricted, stranger]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(broad), tenantB);

    await fixtures.grantDirectPermission(appUserId(broad), 'leads.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(broad), 'leads.view_all', tenantA);
    await fixtures.grantDirectPermission(appUserId(broad), 'leads.view', tenantB);
    await fixtures.grantDirectPermission(appUserId(broad), 'leads.view_all', tenantB);
    // NO `leads.view_all` — this is the whole point of this user.
    await fixtures.grantDirectPermission(appUserId(restricted), 'leads.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(stranger), 'leads.view', tenantA);

    const rmRole = await fixtures.createRole({ tenantId: tenantA });
    rmAssignmentA = await seedRmSlot(tenantA, rmRole);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp'));
    regionA = await seedRef(tenantA, 'region', uniqueName('North'));
    regionA2 = await seedRef(tenantA, 'region', uniqueName('South'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email'));
    channelA2 = await seedRef(tenantA, 'request_channel', uniqueName('Phone'));
    productLineA = await seedRef(tenantA, 'product_line', uniqueName('Motor'));
    productLineA2 = await seedRef(tenantA, 'product_line', uniqueName('Marine'));
    coverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Comp'), {
      productLineId: productLineA,
    });
    coverTypeA2 = await seedRef(tenantA, 'cover_type', uniqueName('Hull'), {
      productLineId: productLineA2,
    });
    openStatusA = await seedRef(tenantA, 'lead_status', uniqueName('AAA Open'), {
      reportingCategory: 'open',
    });
    wonStatusA = await seedRef(tenantA, 'lead_status', uniqueName('ZZZ Won'), {
      reportingCategory: 'won',
    });

    brokerAcme = await seedBroker(tenantA, `Acme Brokers ${RUN}`);
    brokerZulu = await seedBroker(tenantA, `Zulu Brokers ${RUN}`);

    const alpha = await seedParty(tenantA, `Alpha Client ${RUN}`, partyTypeA);
    const omega = await seedParty(tenantA, `Omega Client ${RUN}`, partyTypeA);

    // Three leads owned by `restricted`, with deliberately varied sort keys.
    const r1 = await seedLead(tenantA, {
      partyId: alpha,
      leadRef: `${RUN}-R1`,
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      brokerId: brokerAcme,
      estimatedPremium: 1000,
      dateReceived: '2026-03-01',
      priority: 'high',
      nextFollowUpDate: '2026-04-01',
    });
    const r2 = await seedLead(tenantA, {
      partyId: omega,
      leadRef: `${RUN}-R2`,
      statusId: wonStatusA,
      productLineId: productLineA2,
      coverTypeId: coverTypeA2,
      regionId: regionA2,
      requestChannelId: channelA2,
      brokerId: brokerZulu,
      estimatedPremium: 3000,
      dateReceived: '2026-02-01',
    });
    const r3 = await seedLead(tenantA, {
      partyId: alpha,
      leadRef: `${RUN}-R3`,
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      // No broker and no premium: the null-ordering fixtures.
      brokerId: null,
      estimatedPremium: null,
      dateReceived: '2026-01-01',
    });
    ownedByRestricted = [r1, r2, r3];

    // Four leads owned by `stranger`.
    ownedByStranger = [];
    for (let index = 0; index < 4; index += 1) {
      const id = await seedLead(tenantA, {
        partyId: omega,
        leadRef: `${RUN}-S${String(index)}`,
        statusId: openStatusA,
        productLineId: productLineA,
        coverTypeId: coverTypeA,
        regionId: regionA,
        requestChannelId: channelA,
        estimatedPremium: 500,
        dateReceived: '2026-02-15',
      });
      ownedByStranger.push(id);
    }

    for (const id of ownedByRestricted) {
      await assignOwner(tenantA, id, rmAssignmentA, appUserId(restricted));
    }
    for (const id of ownedByStranger) {
      await assignOwner(tenantA, id, rmAssignmentA, appUserId(stranger));
    }

    // Tenant B: one lead that must never appear in a tenant-A response.
    const typeB = await seedRef(tenantB, 'party_type', uniqueName('Corp B'));
    const partyB = await seedParty(tenantB, `Tenant B Client ${RUN}`, typeB);
    const regionB = await seedRef(tenantB, 'region', uniqueName('North B'));
    const channelB = await seedRef(tenantB, 'request_channel', uniqueName('Email B'));
    const lineB = await seedRef(tenantB, 'product_line', uniqueName('Motor B'));
    const coverB = await seedRef(tenantB, 'cover_type', uniqueName('Comp B'), {
      productLineId: lineB,
    });
    const statusB = await seedRef(tenantB, 'lead_status', uniqueName('Open B'), {
      reportingCategory: 'open',
    });
    await seedLead(tenantB, {
      partyId: partyB,
      leadRef: `${RUN}-TENANTB`,
      statusId: statusB,
      productLineId: lineB,
      coverTypeId: coverB,
      regionId: regionB,
      requestChannelId: channelB,
    });

    // TENANT C exists ONLY to make the joined-table tenant predicates falsifiable.
    //
    // `leads.broker_id` carries NO physical foreign key, so a row whose `broker_id` names ANOTHER
    // tenant's broker is a state the schema permits. Seeding it deliberately is the only way to
    // observe whether the brokers LEFT JOIN carries its own `tenant_id` predicate: with the
    // predicate the join misses and `brokerName` is null; without it, tenant A's broker NAME leaks
    // into a tenant-C response. Every other fixture in this suite is tenant-consistent, so nothing
    // else can catch a dropped predicate on a JOINED table.
    //
    // It lives in its own tenant so the tenant-A/B counts the rest of the suite asserts stay put.
    tenantC = await createTenant('tenant-c');
    await addMembership(appUserId(broad), tenantC);
    await fixtures.grantDirectPermission(appUserId(broad), 'leads.view', tenantC);
    await fixtures.grantDirectPermission(appUserId(broad), 'leads.view_all', tenantC);

    const typeC = await seedRef(tenantC, 'party_type', uniqueName('Corp C'));
    const partyC = await seedParty(tenantC, `Tenant C Client ${RUN}`, typeC);
    const regionC = await seedRef(tenantC, 'region', uniqueName('North C'));
    const channelC = await seedRef(tenantC, 'request_channel', uniqueName('Email C'));
    const lineC = await seedRef(tenantC, 'product_line', uniqueName('Motor C'));
    const coverC = await seedRef(tenantC, 'cover_type', uniqueName('Comp C'), {
      productLineId: lineC,
    });
    const statusC = await seedRef(tenantC, 'lead_status', uniqueName('Open C'), {
      reportingCategory: 'open',
    });
    await seedLead(tenantC, {
      partyId: partyC,
      leadRef: `${RUN}-XTENANT-BROKER`,
      statusId: statusC,
      productLineId: lineC,
      coverTypeId: coverC,
      regionId: regionC,
      requestChannelId: channelC,
      // Deliberately CORRUPT: tenant A's broker id on a tenant-C lead.
      brokerId: brokerAcme,
    });
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()` — see leads-core.test.ts for why.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
    await pool?.end().catch(() => undefined);
  });

  /** AC-045 / V-058 — the reason this file exists. */
  describe('visibility breadth (AC-045)', () => {
    it('shows a leads.view_all holder EVERY lead in the tenant', async () => {
      const list = await readList(broad);
      expect(list.totalCount).toBe(7);
    });

    it('shows a caller WITHOUT view_all only the leads assigned to them', async () => {
      const list = await readList(restricted);

      expect(list.totalCount).toBe(3);
      expect(new Set(list.items.map((item) => item.id))).toStrictEqual(new Set(ownedByRestricted));
    });

    it('filters in the QUERY, so totalCount matches the restricted row set', async () => {
      // A post-filtered implementation returns the restricted caller's ROWS with the unrestricted
      // caller's COUNT — which leaks both the existence and the number of other users' leads.
      const list = await readList(restricted);
      expect(list.totalCount).toBe(list.items.length);
    });

    it('never leaks another user’s lead to a restricted caller, even by explicit owner filter', async () => {
      const list = await readList(
        restricted,
        `?ownerUserId=${String(appUserId(stranger))}`,
      );

      // Both predicates apply: assigned-to-me AND assigned-to-stranger. Nothing satisfies both.
      expect(list.totalCount).toBe(0);
      expect(list.items).toHaveLength(0);
    });

    it('lets the My-leads toggle NARROW a view_all holder to their own leads', async () => {
      const all = await readList(broad);
      const mine = await readList(broad, '?myLeads=true');

      expect(all.totalCount).toBe(7);
      // `broad` owns nothing, so the toggle narrows to zero rather than being ignored.
      expect(mine.totalCount).toBe(0);
    });

    it('cannot WIDEN a restricted caller’s view via myLeads=false', async () => {
      const list = await readList(restricted, '?myLeads=false');
      expect(list.totalCount).toBe(3);
    });

    it('paging a restricted caller never exposes another user’s row on a later page', async () => {
      const page2 = await readList(restricted, '?page=2&pageSize=2');

      expect(page2.totalCount).toBe(3);
      expect(page2.items).toHaveLength(1);
      expect(ownedByRestricted).toContain(page2.items[0]?.id);
    });
  });

  describe('tenant isolation (AC-022)', () => {
    it('returns zero tenant-B rows to a tenant-A caller', async () => {
      const list = await readList(broad);
      expect(list.items.every((item) => !item.leadRef.endsWith('TENANTB'))).toBe(true);
    });

    it('counts only tenant-A leads in totalCount', async () => {
      const list = await readList(broad);
      expect(list.totalCount).toBe(7);
    });

    it('returns only tenant-B rows when the same caller switches tenant', async () => {
      const list = await readList(broad, '', tenantB);
      expect(list.totalCount).toBe(1);
      expect(list.items[0]?.leadRef).toBe(`${RUN}-TENANTB`);
    });

    it('does not resolve another tenant’s broker, party or status names', async () => {
      // The joined-table predicates: a dropped `tenant_id` on a JOIN would surface here rather than
      // in a lead-level isolation test.
      const list = await readList(broad, '', tenantB);
      const row = list.items[0];

      expect(row?.partyName).toContain('Tenant B Client');
      expect(row?.brokerName).toBeNull();
    });

    it('does NOT resolve a broker belonging to another tenant, even when the row names one', async () => {
      // See the tenant-C fixture: this is the ONLY test in the suite that can fail if the brokers
      // LEFT JOIN loses its `tenant_id` predicate.
      const list = await readList(broad, '', tenantC);

      expect(list.totalCount).toBe(1);
      expect(list.items[0]?.leadRef).toBe(`${RUN}-XTENANT-BROKER`);
      expect(list.items[0]?.brokerName, 'another tenant’s broker name leaked through the join').toBeNull();
    });

    it('ignores a tenant-A filter id when listing tenant B', async () => {
      const list = await readList(broad, `?productLineId=${String(productLineA)}`, tenantB);
      expect(list.totalCount).toBe(0);
    });
  });

  describe('filters', () => {
    it('filters by a comma-separated status id list', async () => {
      const list = await readList(broad, `?status=${String(wonStatusA)}`);
      expect(list.totalCount).toBe(1);
      expect(list.items[0]?.statusName).toContain('ZZZ Won');
    });

    it('filters by MULTIPLE status ids', async () => {
      const list = await readList(broad, `?status=${String(openStatusA)},${String(wonStatusA)}`);
      expect(list.totalCount).toBe(7);
    });

    it('filters by broker', async () => {
      const list = await readList(broad, `?brokerId=${String(brokerZulu)}`);
      expect(list.totalCount).toBe(1);
    });

    it('filters by product line', async () => {
      const list = await readList(broad, `?productLineId=${String(productLineA2)}`);
      expect(list.totalCount).toBe(1);
    });

    it('filters by region', async () => {
      const list = await readList(broad, `?regionId=${String(regionA2)}`);
      expect(list.totalCount).toBe(1);
    });

    it('filters by request channel', async () => {
      const list = await readList(broad, `?requestChannelId=${String(channelA2)}`);
      expect(list.totalCount).toBe(1);
    });

    it('filters by a date-received range, inclusively at BOTH ends', async () => {
      const list = await readList(broad, '?dateReceivedFrom=2026-02-01&dateReceivedTo=2026-02-01');
      expect(list.totalCount).toBe(1);
      expect(list.items[0]?.dateReceived).toBe('2026-02-01');
    });

    it('filters by owner', async () => {
      const list = await readList(broad, `?ownerUserId=${String(appUserId(stranger))}`);
      expect(list.totalCount).toBe(4);
    });

    it('combines filters conjunctively', async () => {
      const list = await readList(
        broad,
        `?productLineId=${String(productLineA)}&regionId=${String(regionA)}&status=${String(openStatusA)}`,
      );
      expect(list.totalCount).toBe(6);
    });
  });

  describe('search', () => {
    it('matches on lead ref', async () => {
      const list = await readList(broad, `?search=${RUN}-R2`);
      expect(list.totalCount).toBe(1);
    });

    it('matches on party name', async () => {
      const list = await readList(broad, '?search=Omega');
      expect(list.totalCount).toBe(5);
    });

    it('matches on broker name', async () => {
      const list = await readList(broad, '?search=Zulu Brokers');
      expect(list.totalCount).toBe(1);
    });

    it('is case-insensitive', async () => {
      const list = await readList(broad, '?search=omega');
      expect(list.totalCount).toBe(5);
    });

    it('returns an empty page rather than an error for no matches', async () => {
      const list = await readList(broad, '?search=no-such-lead-anywhere');
      expect(list.totalCount).toBe(0);
      expect(list.items).toStrictEqual([]);
    });
  });

  describe('sorting', () => {
    async function refsSortedBy(sort: string): Promise<string[]> {
      const list = await readList(broad, `?sort=${encodeURIComponent(sort)}&pageSize=50`);
      return list.items.map((item) => item.leadRef);
    }

    it('defaults to newest date received first', async () => {
      const list = await readList(broad, '?pageSize=50');
      const dates = list.items.map((item) => item.dateReceived);
      expect([...dates]).toStrictEqual([...dates].sort().reverse());
    });

    it('sorts ascending on a bare key and descending on a `-` prefix', async () => {
      const ascending = await refsSortedBy('lead_ref');
      const descending = await refsSortedBy('-lead_ref');

      expect(ascending).toStrictEqual([...ascending].sort());
      expect(descending).toStrictEqual([...ascending].reverse());
    });

    it('sorts by premium with NULLS LAST in both directions', async () => {
      const ascending = await readList(broad, '?sort=premium&pageSize=50');
      const descending = await readList(broad, '?sort=-premium&pageSize=50');

      expect(ascending.items[ascending.items.length - 1]?.premium).toBeNull();
      expect(descending.items[descending.items.length - 1]?.premium).toBeNull();
    });

    it('sorts by broker with broker-less leads LAST in both directions', async () => {
      const ascending = await readList(broad, '?sort=broker&pageSize=50');
      const descending = await readList(broad, '?sort=-broker&pageSize=50');

      expect(ascending.items[ascending.items.length - 1]?.brokerName).toBeNull();
      expect(descending.items[descending.items.length - 1]?.brokerName).toBeNull();
    });

    it('sorts by party name', async () => {
      const ascending = await refsSortedBy('party');
      expect(ascending[0]).toContain('R1');
    });

    it('sorts by status name', async () => {
      const ascending = await readList(broad, '?sort=status&pageSize=50');
      expect(ascending.items[0]?.statusName).toContain('AAA Open');
    });

    it('sorts by owner with unowned leads LAST', async () => {
      const ascending = await readList(broad, '?sort=owner&pageSize=50');
      // Every seeded lead has an owner here, so the assertion is that it orders rather than errors.
      expect(ascending.items).toHaveLength(7);
      expect(ascending.items[0]?.owner).not.toBeNull();
    });

    it('sorts by next follow-up with nulls LAST', async () => {
      const list = await readList(broad, '?sort=next_follow_up&pageSize=50');
      expect(list.items[0]?.nextFollowUpDate).toBe('2026-04-01');
      expect(list.items[list.items.length - 1]?.nextFollowUpDate).toBeNull();
    });

    it('falls back to the DEFAULT order for an unrecognised sort key, rather than erroring', async () => {
      const bogus = await readList(broad, '?sort=not_a_column&pageSize=50');
      const fallback = await readList(broad, '?pageSize=50');

      expect(bogus.items.map((i) => i.leadRef)).toStrictEqual(fallback.items.map((i) => i.leadRef));
    });

    it('pages a low-cardinality sort WITHOUT repeating or skipping rows', async () => {
      // Status has two distinct values across seven rows: without the lead-id tiebreaker, Postgres
      // may order page 2 differently from page 1 and repeat or drop a row.
      const first = await readList(broad, '?sort=status&page=1&pageSize=3');
      const second = await readList(broad, '?sort=status&page=2&pageSize=3');
      const third = await readList(broad, '?sort=status&page=3&pageSize=3');

      const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });
  });

  describe('paging and projection', () => {
    it('defaults to page 1 with a page size of 25', async () => {
      const list = await readList(broad);
      expect(list.page).toBe(1);
      expect(list.pageSize).toBe(25);
    });

    it('honours an explicit page and page size', async () => {
      const list = await readList(broad, '?page=2&pageSize=3');
      expect(list.page).toBe(2);
      expect(list.pageSize).toBe(3);
      expect(list.items).toHaveLength(3);
    });

    it('reports the FULL total count regardless of page size', async () => {
      const list = await readList(broad, '?page=1&pageSize=2');
      expect(list.totalCount).toBe(7);
      expect(list.items).toHaveLength(2);
    });

    it('returns an empty item list beyond the last page', async () => {
      const list = await readList(broad, '?page=99&pageSize=25');
      expect(list.items).toStrictEqual([]);
      expect(list.totalCount).toBe(7);
    });

    it('projects every list column the Leads screen needs', async () => {
      const list = await readList(broad, `?search=${RUN}-R1`);
      const row = list.items[0];

      expect(row).toMatchObject({
        leadRef: `${RUN}-R1`,
        priority: 'high',
        dateReceived: '2026-03-01',
        premium: 1000,
        nextFollowUpDate: '2026-04-01',
      });
      expect(row?.partyName).toContain('Alpha Client');
      expect(row?.brokerName).toContain('Acme Brokers');
      expect(row?.productLineName).not.toBe('');
      expect(row?.coverTypeName).not.toBe('');
      expect(row?.owner?.userId).toBe(appUserId(restricted));
      // Flags are alert-derived (T-031) and deliberately empty here rather than guessed at.
      expect(row?.flags).toStrictEqual([]);
    });

    it('computes ageDays from the date received', async () => {
      const list = await readList(broad, `?search=${RUN}-R1`);
      const expected = Math.round(
        (Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) -
          Date.parse('2026-03-01T00:00:00Z')) /
          86_400_000,
      );
      expect(list.items[0]?.ageDays).toBe(expected);
    });

    it('emits `totalCount`, NOT `total`', async () => {
      // The SPA and every other list DTO in this port read `totalCount`; `total` would break them.
      const list = await readList(broad);
      expect(list).toHaveProperty('totalCount');
      expect(list).not.toHaveProperty('total');
    });
  });

  describe('permissions', () => {
    it('403s a caller with no leads.view grant', async () => {
      const outsider = await auth.createTestUserWithSession({ label: 'list-outsider' });
      await addMembership(appUserId(outsider), tenantA);

      const response = await call('GET', BASE, {
        token: outsider.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(403);
    });

    it('401s an unauthenticated request', async () => {
      const response = await call('GET', BASE, { tenantId: tenantA });
      expect(response.status).toBe(401);
    });
  });
});
