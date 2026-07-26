/**
 * The Alerts Center HTTP surface (T-033; AC-022, AC-070; V-027, V-087).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/Alerts/AlertEndpointsTests.cs`, and the same shape as
 * `business-rules.test.ts`: real signed-in sessions, real tenants and partitions, real grants, the
 * real Hono pipeline (auth -> tenant context -> permission resolution -> routes) through
 * `app.request`. Nothing is stubbed, because tenant isolation and permission enforcement are
 * properties of the composed system.
 *
 * ALERT ROWS ARE INSERTED DIRECTLY, NOT PRODUCED BY THE SWEEP
 * ==========================================================
 * This suite is about the READ surface, so the fixtures write `alerts` rows with known types,
 * premiums and owners rather than running reconciliation. That makes every expected count, sum and
 * page independently computable from the fixture table — an endpoint cannot pass by agreeing with
 * the rules module, and a change to the rules cannot silently change what this suite asserts.
 * (`alert-evaluation.test.ts` covers the other direction.)
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { ALERT_CATEGORIES, ALERT_TABS } from '../../domains/alerts/index.js';
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
const title = suiteTitle('alerts center endpoints', probe);

const RUN = `t033ep-${process.pid}-${Date.now()}`;

interface AlertListItem {
  readonly id: number;
  readonly type: string;
  readonly severity: string;
  readonly createdAt: string;
  readonly leadId: number;
  readonly leadRef: string;
  readonly quoteId: number | null;
  readonly quoteRef: string | null;
  readonly clientName: string;
  readonly productLineName: string;
  readonly brokerName: string | null;
  readonly premiumAtRisk: number | null;
  readonly stage: string;
  readonly priority: string;
  readonly ownerUserId: number | null;
  readonly ownerName: string | null;
}

interface AlertListBody {
  readonly items: AlertListItem[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly tabCounts: Record<string, number>;
}

interface AlertSummaryBody {
  readonly categories: { category: string; name: string; definition: string; tab: string | null; count: number }[];
  readonly rollup: { premiumAtRisk: number; quoteCount: number };
}

/**
 * Tenant A's fixture alerts, written out so every expectation below is arithmetic on THIS table.
 *
 * `lead` names a seeded lead; `premium` is the alert row's own `premium_at_risk`. The premiums are
 * chosen so the de-duplicated rollup differs from a naive sum across rows: `overdue-lead` carries
 * THREE alerts at 1000.00, and a rollup that summed rows would report 3000.00 for that lead alone.
 */
const FIXTURE_ALERTS = [
  { type: 'overdue_follow_up', lead: 'overdue', quote: null, severity: 'warning', premium: '1000.00' },
  { type: 'stalled_lead', lead: 'overdue', quote: null, severity: 'warning', premium: '1000.00' },
  { type: 'sla_breach', lead: 'overdue', quote: null, severity: 'critical', premium: '1000.00' },
  { type: 'executive_escalation', lead: 'escalated', quote: null, severity: 'critical', premium: '5000.00' },
  { type: 'high_value_stalled', lead: 'escalated', quote: null, severity: 'critical', premium: '5000.00' },
  { type: 'quote_expiring', lead: 'quoted', quote: 'q1', severity: 'warning', premium: '250.50' },
  { type: 'quote_expired', lead: 'quoted', quote: 'q2', severity: 'critical', premium: '749.50' },
  { type: 'awaiting_underwriting', lead: 'other', quote: null, severity: 'warning', premium: null },
  { type: 'pending_pricing_approval', lead: 'other', quote: null, severity: 'warning', premium: null },
  { type: 'stalled_quote', lead: 'quoted', quote: 'q1', severity: 'warning', premium: '250.50' },
] as const;

/** Distinct (lead, quote) items: overdue(1000) + escalated(5000) + q1(250.50) + q2(749.50) + other(null). */
const EXPECTED_ROLLUP_PREMIUM = 1000 + 5000 + 250.5 + 749.5;
/** Of those distinct items, the ones carrying a quote_id: q1 and q2. */
const EXPECTED_ROLLUP_QUOTE_COUNT = 2;

/** Card counts, summed by hand from FIXTURE_ALERTS over each card's constituent types. */
const EXPECTED_CARD_COUNTS: Record<string, number> = {
  escalated: 2, // executive_escalation + high_value_stalled
  stalled: 2, // stalled_lead + stalled_quote
  overdue: 1, // overdue_follow_up
  expiring: 2, // quote_expiring + quote_expired
  sla: 3, // sla_breach + awaiting_underwriting + pending_pricing_approval
};

const EXPECTED_TAB_COUNTS: Record<string, number> = {
  all: 10,
  escalated: 2,
  overdue: 1,
  expiring: 2,
  sla: 3,
};

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds `alerts.view` in both tenants. */
  let viewer: TestUserSession;
  /** Same tenant, ALSO holds `alerts.view`: proves the badge is per user, not per tenant. */
  let colleague: TestUserSession;
  /** Member of tenant A with a DIFFERENT alerts permission: the permission-matrix control. */
  let unprivileged: TestUserSession;
  /** The RM assigned to tenant A's `overdue` lead — the ownerUserId filter's subject. */
  let owner: TestUserSession;

  let tenantA: number;
  let tenantB: number;
  let leadsA: Record<string, number> = {};
  let leadsB: Record<string, number> = {};
  let alertIdsA: number[] = [];

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) throw new Error(`fixture user ${session.email} has no users row`);
    return Number(session.appUserId);
  }

  async function insertReturningId(sql: string, params: unknown[]): Promise<number> {
    const rows = await query<{ id: string }>(sql, params);
    return Number(rows[0]?.id);
  }

  async function createTenant(label: string): Promise<number> {
    const id = await insertReturningId(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-${label}`],
    );
    createdTenants.push(id);
    await query('select create_tenant_partitions($1)', [id]);
    await query(
      `insert into tenant_settings (tenant_id, created_at, updated_at) values ($1, now(), now())`,
      [id],
    );
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
    options: { reportingCategory?: string; canonicalKey?: string; productLineId?: number } = {},
  ): Promise<number> {
    return await insertReturningId(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          product_line_id, created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, $6, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.productLineId ?? null,
      ],
    );
  }

  /**
   * Seeds one tenant's leads/quotes/broker and the alert rows in FIXTURE_ALERTS. `marker` makes
   * every human-readable value distinguishable per tenant, which is what the isolation assertions
   * look for.
   */
  async function seedTenant(
    tenantId: number,
    marker: string,
    options: { assignOwner?: number } = {},
  ): Promise<{ leads: Record<string, number>; alertIds: number[] }> {
    const partyType = await seedRef(tenantId, 'party_type', `${marker}-type`);
    const productLine = await seedRef(tenantId, 'product_line', `${marker}-ProductLine`);
    const otherProductLine = await seedRef(tenantId, 'product_line', `${marker}-OtherLine`);
    const coverType = await seedRef(tenantId, 'cover_type', `${marker}-Cover`, {
      productLineId: productLine,
    });
    const region = await seedRef(tenantId, 'region', `${marker}-Region`);
    const otherRegion = await seedRef(tenantId, 'region', `${marker}-OtherRegion`);
    const channel = await seedRef(tenantId, 'request_channel', `${marker}-Channel`);
    const stage = await seedRef(tenantId, 'lead_status', `${marker}-Stage`, {
      reportingCategory: 'open',
      canonicalKey: 'assigned',
    });
    const quoteStatus = await seedRef(tenantId, 'quote_status', `${marker}-QuoteSent`, {
      reportingCategory: 'quoted',
      canonicalKey: 'sent',
    });

    const party = await insertReturningId(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, `${marker}-Client`, partyType],
    );

    const broker = await insertReturningId(
      `insert into brokers (tenant_id, name, status, created_at, updated_at)
       values ($1, $2, 'active', now(), now()) returning id::text as id`,
      [tenantId, `${marker}-Broker`],
    );

    async function seedLead(label: string, overrides: {
      productLineId?: number;
      regionId?: number;
      priority?: string;
      brokerId?: number | null;
    } = {}): Promise<number> {
      return await insertReturningId(
        `insert into leads
           (tenant_id, party_id, lead_ref, date_received, request_channel_id, broker_id, region_id,
            product_line_id, cover_type_id, policy_term, priority, status_id, source,
            created_at, updated_at)
         values ($1, $2, $3, now()::date, $4, $5, $6, $7, $8, 'm12', $9, $10, 'browser', now(), now())
         returning id::text as id`,
        [
          tenantId,
          party,
          `${marker}-${label}`,
          channel,
          overrides.brokerId === undefined ? broker : overrides.brokerId,
          overrides.regionId ?? region,
          overrides.productLineId ?? productLine,
          coverType,
          overrides.priority ?? 'normal',
          stage,
        ],
      );
    }

    const leads: Record<string, number> = {
      overdue: await seedLead('overdue', { priority: 'high' }),
      escalated: await seedLead('escalated', {
        productLineId: otherProductLine,
        regionId: otherRegion,
      }),
      quoted: await seedLead('quoted'),
      other: await seedLead('other', { brokerId: null }),
    };

    const quotes: Record<string, number> = {};
    for (const [index, label] of ['q1', 'q2'].entries()) {
      quotes[label] = await insertReturningId(
        `insert into quotes
           (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
            prepared_date, created_at, updated_at)
         values ($1, $2, $3, $4, $7, $5, $6, now()::date, now(), now())
         returning id::text as id`,
        // Only ONE quote per lead may be current (a partial unique index enforces it), so the
        // second is a superseded revision — which is also a more realistic fixture: an expired
        // older quote alongside a current one.
        [tenantId, leads.quoted, `${marker}-${label}`, quoteStatus, productLine, coverType, index === 0],
      );
    }

    if (options.assignOwner !== undefined) {
      // Two fixed slots per tenant, one role each (`uq_business_assignments_tenant_slot`); the RM
      // slot is the one the queue's accountable-owner projection reads.
      const role = await insertReturningId(
        `insert into roles (tenant_id, name, is_active, created_at, updated_at)
         values ($1, $2, true, now(), now()) returning id`,
        [tenantId, `${marker}-RM-role`],
      );
      const businessAssignment = await insertReturningId(
        `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
         values ($1, 'rm', $2, now(), now()) returning id::text as id`,
        [tenantId, role],
      );
      await query(
        `insert into lead_assignments
           (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())`,
        [tenantId, leads.overdue, businessAssignment, options.assignOwner],
      );
    }

    const alertIds: number[] = [];
    // Distinct created_at per row, ascending with the fixture order, so `order by created_at desc`
    // has a KNOWN answer and paging assertions are deterministic.
    let minutes = 0;
    for (const alert of FIXTURE_ALERTS) {
      minutes += 1;
      alertIds.push(
        await insertReturningId(
          `insert into alerts
             (tenant_id, type, lead_id, quote_id, severity, premium_at_risk, created_at)
           values ($1, $2, $3, $4, $5, $6::numeric, now() - make_interval(mins => $7))
           returning id::text as id`,
          [
            tenantId,
            alert.type,
            leads[alert.lead],
            alert.quote === null ? null : quotes[alert.quote],
            alert.severity,
            alert.premium,
            FIXTURE_ALERTS.length - minutes,
          ],
        ),
      );
    }

    return { leads, alertIds };
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
      alerts: { db },
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
    return await harness().request(`http://localhost/api/v1${path}`, { method, headers });
  }

  async function getJson<T>(
    path: string,
    session: TestUserSession,
    tenantId: number,
  ): Promise<T> {
    const response = await call('GET', path, { token: session.accessToken, tenantId });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    config = loadConfig({
      APP_ENV: 'local',
      LOG_LEVEL: 'error',
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

    viewer = await auth.createTestUserWithSession({ label: 'alerts-viewer' });
    colleague = await auth.createTestUserWithSession({ label: 'alerts-colleague' });
    unprivileged = await auth.createTestUserWithSession({ label: 'alerts-nogrant' });
    owner = await auth.createTestUserWithSession({ label: 'alerts-owner' });

    for (const session of [viewer, colleague, unprivileged, owner]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(viewer), tenantB);

    await fixtures.grantDirectPermission(appUserId(viewer), 'alerts.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(viewer), 'alerts.view', tenantB);
    await fixtures.grantDirectPermission(appUserId(colleague), 'alerts.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(owner), 'alerts.view', tenantA);
    // A DIFFERENT alerts permission: proves the guard checks the required code, not "any grant".
    await fixtures.grantDirectPermission(appUserId(unprivileged), 'alerts.resolve', tenantA);

    const seededA = await seedTenant(tenantA, `${RUN}-A`, { assignOwner: appUserId(owner) });
    leadsA = seededA.leads;
    alertIdsA = seededA.alertIds;
    leadsB = (await seedTenant(tenantB, `${RUN}-B`)).leads;
  }, 300_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Data deletion MUST precede `auth.cleanup()`, which ends the pool these deletes run on.
    for (const tenantId of createdTenants) {
      for (const table of [
        'alerts',
        'user_alert_views',
        'lead_assignments',
        'business_assignments',
        'roles',
        'quotes',
        'leads',
        'parties',
        'brokers',
        'reference_items',
        'tenant_settings',
        'audit_log',
        'user_tenants',
      ]) {
        await query(`delete from ${table} where tenant_id = $1`, [tenantId]).catch(() => undefined);
      }
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // GET /alerts/summary
  // ---------------------------------------------------------------------------------------------

  it('returns the five category cards in display order with counts off the fixture table', async () => {
    const summary = await getJson<AlertSummaryBody>('/alerts/summary', viewer, tenantA);

    expect(summary.categories.map((card) => card.category)).toEqual(
      ALERT_CATEGORIES.map((category) => category.key),
    );
    expect(
      Object.fromEntries(summary.categories.map((card) => [card.category, card.count])),
    ).toEqual(EXPECTED_CARD_COUNTS);
  });

  it('carries each card s name, definition and tab — with the Stalled card s tab null', async () => {
    const summary = await getJson<AlertSummaryBody>('/alerts/summary', viewer, tenantA);
    const stalled = summary.categories.find((card) => card.category === 'stalled');

    expect(stalled).toEqual({
      category: 'stalled',
      name: 'Stalled',
      definition: 'No activity 7+ days',
      // Measured: PRD 18.2 names five cards but only four tabs. Null here, and the SPA's
      // CATEGORY_TO_TAB maps 'stalled' to null to match.
      tab: null,
      count: 2,
    });
    expect(summary.categories.filter((card) => card.tab === null)).toHaveLength(1);
  });

  it('rolls premium at risk up over DISTINCT lead/quote items, not over alert rows', async () => {
    const summary = await getJson<AlertSummaryBody>('/alerts/summary', viewer, tenantA);

    // The `overdue` lead carries three alerts at 1000.00 each. A rollup that summed rows would
    // report 9000.00; the de-duplicated answer is 7000.00.
    expect(summary.rollup.premiumAtRisk).toBe(EXPECTED_ROLLUP_PREMIUM);
    expect(summary.rollup.premiumAtRisk).not.toBe(9000);
    expect(summary.rollup.quoteCount).toBe(EXPECTED_ROLLUP_QUOTE_COUNT);
  });

  it('excludes resolved alerts from the cards and the rollup', async () => {
    const target = alertIdsA[0];
    await query(
      `update alerts set resolved_at = now(), resolved_reason = 'rule_cleared'
        where tenant_id = $1 and id = $2`,
      [tenantA, target],
    );

    const summary = await getJson<AlertSummaryBody>('/alerts/summary', viewer, tenantA);
    // The resolved row was `overdue_follow_up`, the Overdue card's only member.
    expect(summary.categories.find((card) => card.category === 'overdue')?.count).toBe(0);

    await query('update alerts set resolved_at = null, resolved_reason = null where tenant_id = $1 and id = $2', [
      tenantA,
      target,
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // GET /alerts
  // ---------------------------------------------------------------------------------------------

  it('returns every open alert with the preserved queue-row contract', async () => {
    const body = await getJson<AlertListBody>('/alerts', viewer, tenantA);

    expect(body.totalCount).toBe(FIXTURE_ALERTS.length);
    expect(body.items).toHaveLength(FIXTURE_ALERTS.length);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);

    const row = body.items.find((item) => item.type === 'quote_expiring');
    expect(row).toBeDefined();
    // Field-for-field with the SPA's AlertListItemDto: an added or missing key is a contract break.
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'brokerName',
        'clientName',
        'createdAt',
        'id',
        'leadId',
        'leadRef',
        'ownerName',
        'ownerUserId',
        'premiumAtRisk',
        'priority',
        'productLineName',
        'quoteId',
        'quoteRef',
        'severity',
        'stage',
        'type',
      ].sort(),
    );

    expect(row).toMatchObject({
      severity: 'warning',
      leadId: leadsA.quoted,
      clientName: `${RUN}-A-Client`,
      productLineName: `${RUN}-A-ProductLine`,
      brokerName: `${RUN}-A-Broker`,
      stage: `${RUN}-A-Stage`,
      priority: 'normal',
      // numeric(18,2) crosses to a JSON number exactly once, at the wire boundary.
      premiumAtRisk: 250.5,
    });
    expect(row?.quoteRef).toBe(`${RUN}-A-q1`);
  });

  it('renders a lead-level alert with a null quote and a null broker where there is none', async () => {
    const body = await getJson<AlertListBody>('/alerts', viewer, tenantA);
    const row = body.items.find((item) => item.type === 'awaiting_underwriting');

    expect(row).toMatchObject({ quoteId: null, quoteRef: null, brokerName: null, premiumAtRisk: null });
  });

  it('resolves the accountable RM as ownerUserId/ownerName, and null when unassigned', async () => {
    const body = await getJson<AlertListBody>('/alerts', viewer, tenantA);

    // Read the stored name rather than assuming the fixture's, so this asserts the endpoint's
    // "First Last" composition against the row it actually projected.
    const stored = (
      await query<{ first_name: string; last_name: string }>(
        'select first_name, last_name from users where id = $1',
        [appUserId(owner)],
      )
    )[0];

    const owned = body.items.find((item) => item.leadId === leadsA.overdue);
    expect(owned?.ownerUserId).toBe(appUserId(owner));
    expect(owned?.ownerName).toBe(`${String(stored?.first_name)} ${String(stored?.last_name)}`);

    const unowned = body.items.find((item) => item.leadId === leadsA.escalated);
    expect(unowned?.ownerUserId).toBeNull();
    expect(unowned?.ownerName).toBeNull();
  });

  it('returns counts for ALL five tabs on every response', async () => {
    const body = await getJson<AlertListBody>('/alerts', viewer, tenantA);

    expect(Object.keys(body.tabCounts).sort()).toEqual([...ALERT_TABS].sort());
    expect(body.tabCounts).toEqual(EXPECTED_TAB_COUNTS);
  });

  it.each([
    ['escalated', ['executive_escalation', 'high_value_stalled']],
    ['overdue', ['overdue_follow_up']],
    ['expiring', ['quote_expired', 'quote_expiring']],
    ['sla', ['awaiting_underwriting', 'pending_pricing_approval', 'sla_breach']],
  ])('the %s tab returns exactly its constituent alert types', async (tab, expectedTypes) => {
    const body = await getJson<AlertListBody>(`/alerts?tab=${tab}`, viewer, tenantA);

    expect(body.items.map((item) => item.type).sort()).toEqual(expectedTypes);
    expect(body.totalCount).toBe(expectedTypes.length);
  });

  it('the all tab returns every type, and an unknown tab degrades to it rather than erroring', async () => {
    const all = await getJson<AlertListBody>('/alerts?tab=all', viewer, tenantA);
    expect(all.totalCount).toBe(FIXTURE_ALERTS.length);

    // A stale deep-link must not 4xx the Alerts Center; the reference maps anything unrecognized to
    // "every type".
    const unknown = await getJson<AlertListBody>('/alerts?tab=not-a-tab', viewer, tenantA);
    expect(unknown.totalCount).toBe(FIXTURE_ALERTS.length);
  });

  it('filters by product line, region, priority and owner — each narrowing to a known subset', async () => {
    const productLineId = (
      await query<{ id: string }>(
        `select id::text as id from reference_items
          where tenant_id = $1 and list_type = 'product_line' and name = $2`,
        [tenantA, `${RUN}-A-OtherLine`],
      )
    )[0]?.id;
    const regionId = (
      await query<{ id: string }>(
        `select id::text as id from reference_items
          where tenant_id = $1 and list_type = 'region' and name = $2`,
        [tenantA, `${RUN}-A-OtherRegion`],
      )
    )[0]?.id;

    // Only the `escalated` lead carries the other product line / region: 2 alerts.
    const byProductLine = await getJson<AlertListBody>(
      `/alerts?productLineId=${String(productLineId)}`,
      viewer,
      tenantA,
    );
    expect(byProductLine.totalCount).toBe(2);
    expect(new Set(byProductLine.items.map((item) => item.leadId))).toEqual(
      new Set([leadsA.escalated]),
    );

    const byRegion = await getJson<AlertListBody>(
      `/alerts?regionId=${String(regionId)}`,
      viewer,
      tenantA,
    );
    expect(byRegion.totalCount).toBe(2);

    // Only the `overdue` lead is high priority: 3 alerts.
    const byPriority = await getJson<AlertListBody>('/alerts?priority=high', viewer, tenantA);
    expect(byPriority.totalCount).toBe(3);
    expect(new Set(byPriority.items.map((item) => item.leadId))).toEqual(new Set([leadsA.overdue]));

    // Only the `overdue` lead has an RM assignment.
    const byOwner = await getJson<AlertListBody>(
      `/alerts?ownerUserId=${String(appUserId(owner))}`,
      viewer,
      tenantA,
    );
    expect(byOwner.totalCount).toBe(3);
    expect(new Set(byOwner.items.map((item) => item.leadId))).toEqual(new Set([leadsA.overdue]));
  });

  it('combines a tab with a filter rather than letting either win', async () => {
    const body = await getJson<AlertListBody>('/alerts?tab=sla&priority=high', viewer, tenantA);

    // sla tab -> 3 types; priority=high -> the overdue lead only; the intersection is sla_breach.
    expect(body.items.map((item) => item.type)).toEqual(['sla_breach']);
    expect(body.totalCount).toBe(1);
  });

  it('pages with a stable newest-first order, and totalCount describes the whole filtered set', async () => {
    const first = await getJson<AlertListBody>('/alerts?page=1&pageSize=4', viewer, tenantA);
    const second = await getJson<AlertListBody>('/alerts?page=2&pageSize=4', viewer, tenantA);
    const third = await getJson<AlertListBody>('/alerts?page=3&pageSize=4', viewer, tenantA);

    expect(first.items).toHaveLength(4);
    expect(second.items).toHaveLength(4);
    expect(third.items).toHaveLength(2);
    // totalCount is the FILTERED total, not the page length.
    expect(first.totalCount).toBe(FIXTURE_ALERTS.length);

    const paged = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    // No row repeated and none skipped across the three pages.
    expect(new Set(paged).size).toBe(FIXTURE_ALERTS.length);

    // Newest first: the fixture wrote ascending created_at in FIXTURE_ALERTS order, so the queue is
    // that list reversed.
    const createdAts = paged.map((id) => id);
    expect(createdAts).toEqual([...alertIdsA].reverse());
  });

  it('rejects nothing but still bounds pageSize, so one request cannot ask for the whole table', async () => {
    const body = await getJson<AlertListBody>('/alerts?pageSize=100000', viewer, tenantA);
    expect(body.pageSize).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // Badge (AC-070)
  // ---------------------------------------------------------------------------------------------

  it('reports zero for a user who has never opened the Alerts Center', async () => {
    // Measured: a first-time user sees a clean badge, NOT a count of every historical alert.
    const badge = await getJson<{ count: number }>('/alerts/badge', colleague, tenantA);
    expect(badge.count).toBe(0);
  });

  it('counts alerts created since the visit, and the reset returns 204 and clears it', async () => {
    const reset = await call('POST', '/alerts/badge/reset', {
      token: viewer.accessToken,
      tenantId: tenantA,
    });
    expect(reset.status).toBe(204);
    expect(await reset.text()).toBe('');

    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantA)).count).toBe(0);

    const newAlert = await insertReturningId(
      `insert into alerts (tenant_id, type, lead_id, severity, created_at)
       values ($1, 'stalled_lead', $2, 'warning', now()) returning id::text as id`,
      [tenantA, leadsA.other],
    );

    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantA)).count).toBe(1);

    // Visiting again clears it back to zero.
    await call('POST', '/alerts/badge/reset', { token: viewer.accessToken, tenantId: tenantA });
    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantA)).count).toBe(0);

    await query('delete from alerts where tenant_id = $1 and id = $2', [tenantA, newAlert]);
  });

  it('keeps the badge per user: one colleague s visit does not clear another s', async () => {
    await call('POST', '/alerts/badge/reset', { token: viewer.accessToken, tenantId: tenantA });
    await call('POST', '/alerts/badge/reset', { token: colleague.accessToken, tenantId: tenantA });

    const created = await insertReturningId(
      `insert into alerts (tenant_id, type, lead_id, severity, created_at)
       values ($1, 'stalled_lead', $2, 'warning', now()) returning id::text as id`,
      [tenantA, leadsA.other],
    );

    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantA)).count).toBe(1);
    expect((await getJson<{ count: number }>('/alerts/badge', colleague, tenantA)).count).toBe(1);

    // Only the viewer visits.
    await call('POST', '/alerts/badge/reset', { token: viewer.accessToken, tenantId: tenantA });

    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantA)).count).toBe(0);
    // The colleague's badge is untouched — one row per (tenant, user).
    expect((await getJson<{ count: number }>('/alerts/badge', colleague, tenantA)).count).toBe(1);

    await query('delete from alerts where tenant_id = $1 and id = $2', [tenantA, created]);
  });

  it('keeps the badge per tenant: resetting in tenant A leaves the same user s tenant B badge', async () => {
    await call('POST', '/alerts/badge/reset', { token: viewer.accessToken, tenantId: tenantB });

    // THE DISCRIMINATOR: an alert raised in tenant A AFTER the tenant-B visit. A badge query
    // missing its tenant predicate would count this and report 1 for tenant B — and every other
    // assertion in this suite would still pass, because nothing else creates cross-tenant activity
    // in the window between a reset and a read.
    const noiseInA = await insertReturningId(
      `insert into alerts (tenant_id, type, lead_id, severity, created_at)
       values ($1, 'stalled_lead', $2, 'warning', now()) returning id::text as id`,
      [tenantA, leadsA.other],
    );
    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantB)).count).toBe(0);
    await query('delete from alerts where tenant_id = $1 and id = $2', [tenantA, noiseInA]);

    const createdB = await insertReturningId(
      `insert into alerts (tenant_id, type, lead_id, severity, created_at)
       values ($1, 'stalled_lead', $2, 'warning', now()) returning id::text as id`,
      [tenantB, leadsB.other],
    );

    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantB)).count).toBe(1);

    await call('POST', '/alerts/badge/reset', { token: viewer.accessToken, tenantId: tenantA });

    // The tenant-B badge survives a tenant-A visit.
    expect((await getJson<{ count: number }>('/alerts/badge', viewer, tenantB)).count).toBe(1);

    await query('delete from alerts where tenant_id = $1 and id = $2', [tenantB, createdB]);
  });

  it('stores exactly one user_alert_views row per user per tenant, however often reset is called', async () => {
    for (let i = 0; i < 3; i += 1) {
      await call('POST', '/alerts/badge/reset', { token: viewer.accessToken, tenantId: tenantA });
    }

    const rows = await query<{ count: string }>(
      'select count(*)::text as count from user_alert_views where tenant_id = $1 and user_id = $2',
      [tenantA, appUserId(viewer)],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // AC-022: tenant isolation
  // ---------------------------------------------------------------------------------------------

  it.each(['/alerts/summary', '/alerts', '/alerts/badge'])(
    '%s returns zero tenant-B rows to a tenant-A caller',
    async (path) => {
      const response = await call('GET', path, { token: viewer.accessToken, tenantId: tenantA });
      expect(response.status).toBe(200);
      const raw = await response.text();

      // Every tenant-B fixture value carries the `-B-` marker; none may appear in a tenant-A body.
      expect(raw).not.toContain(`${RUN}-B-`);
    },
  );

  it('scopes the queue to the addressed tenant, row for row', async () => {
    const a = await getJson<AlertListBody>('/alerts', viewer, tenantA);
    const b = await getJson<AlertListBody>('/alerts', viewer, tenantB);

    const tenantALeadIds = new Set(Object.values(leadsA));
    const tenantBLeadIds = new Set(Object.values(leadsB));

    expect(a.items.every((item) => tenantALeadIds.has(item.leadId))).toBe(true);
    expect(a.items.some((item) => tenantBLeadIds.has(item.leadId))).toBe(false);
    expect(b.items.every((item) => tenantBLeadIds.has(item.leadId))).toBe(true);
    expect(b.items.some((item) => tenantALeadIds.has(item.leadId))).toBe(false);

    // Both tenants hold the same fixture set, so an unscoped query would return double.
    expect(a.totalCount).toBe(FIXTURE_ALERTS.length);
    expect(b.totalCount).toBe(FIXTURE_ALERTS.length);
  });

  it('aggregates only the addressed tenant s alerts', async () => {
    const a = await getJson<AlertSummaryBody>('/alerts/summary', viewer, tenantA);
    const b = await getJson<AlertSummaryBody>('/alerts/summary', viewer, tenantB);

    // Identical fixtures per tenant: an unscoped aggregate would double every card and the rollup.
    expect(a.rollup.premiumAtRisk).toBe(EXPECTED_ROLLUP_PREMIUM);
    expect(b.rollup.premiumAtRisk).toBe(EXPECTED_ROLLUP_PREMIUM);
    expect(
      Object.fromEntries(a.categories.map((card) => [card.category, card.count])),
    ).toEqual(EXPECTED_CARD_COUNTS);
  });

  it('filtering by another tenant s reference id returns nothing rather than that tenant s rows', async () => {
    const tenantBProductLine = (
      await query<{ id: string }>(
        `select id::text as id from reference_items
          where tenant_id = $1 and list_type = 'product_line' and name = $2`,
        [tenantB, `${RUN}-B-ProductLine`],
      )
    )[0]?.id;

    const body = await getJson<AlertListBody>(
      `/alerts?productLineId=${String(tenantBProductLine)}`,
      viewer,
      tenantA,
    );

    expect(body.items).toEqual([]);
    expect(body.totalCount).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Permission matrix
  // ---------------------------------------------------------------------------------------------

  it.each([
    ['GET', '/alerts/summary'],
    ['GET', '/alerts'],
    ['GET', '/alerts/badge'],
    ['POST', '/alerts/badge/reset'],
  ])('%s %s requires alerts.view', async (method, path) => {
    const allowed = await call(method, path, { token: viewer.accessToken, tenantId: tenantA });
    expect([200, 204]).toContain(allowed.status);

    // The control holds `alerts.resolve`, NOT `alerts.view`: a grant is not a grant of everything.
    const denied = await call(method, path, {
      token: unprivileged.accessToken,
      tenantId: tenantA,
    });
    expect(denied.status).toBe(403);
  });

  it.each([
    ['GET', '/alerts/summary'],
    ['GET', '/alerts'],
    ['GET', '/alerts/badge'],
    ['POST', '/alerts/badge/reset'],
  ])('%s %s rejects an unauthenticated caller', async (method, path) => {
    const response = await call(method, path, { tenantId: tenantA });
    expect(response.status).toBe(401);
  });

  it.each([
    ['GET', '/alerts/summary'],
    ['GET', '/alerts'],
    ['GET', '/alerts/badge'],
  ])('%s %s refuses to run without a tenant header', async (method, path) => {
    // `/alerts` is not a global route, so it must fail CLOSED rather than querying unscoped.
    // MEASURED: the T-013 middleware answers 403 for a missing tenant on a tenant-scoped route,
    // not 400 — the request is well-formed, it is the tenant context that is absent.
    const response = await call(method, path, { token: viewer.accessToken });
    expect(response.status).toBe(403);
  });

  it('denies a caller whose grant is in a different tenant', async () => {
    // `colleague` holds alerts.view in tenant A only, and is not a member of tenant B.
    const response = await call('GET', '/alerts', {
      token: colleague.accessToken,
      tenantId: tenantB,
    });
    expect([403, 404]).toContain(response.status);
  });
});
