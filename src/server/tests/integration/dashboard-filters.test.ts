/**
 * The dashboard framework: shared filters, drill-through, SQL/pure parity and tenant isolation
 * (T-035; AC-022, AC-074, AC-075, AC-076; V-027, V-092, V-093, V-095).
 *
 * THE FIXTURE IS LOADED INTO POSTGRES FROM THE SAME FILE THE UNIT SUITE READS
 * ==========================================================================
 * That is the whole mechanism behind AC-074. `loadMetricFixture()` is called here and in
 * `tests/unit/metric-definitions.test.ts`, and the rows below are INSERTED from what it returns —
 * no literal is retyped. So a fixture edit necessarily moves both sides, and the parity block
 * asserts they moved to the same place. The final test in that block proves the sharing is real by
 * mutating a quote in the database AND in the in-memory copy and re-checking the equality; if the
 * two datasets had drifted apart, that test is where it would show.
 *
 * WHY THE ASSERTIONS ARE ID SETS AND EXACT VALUES, NEVER SHAPES
 * ============================================================
 * A dashboard that returns plausible-looking wrong numbers is the failure mode this domain has.
 * `expect(items).toHaveLength(3)` cannot see a filter that selected the wrong three rows, and
 * `expect(total).toBeGreaterThan(0)` cannot see a cross-tenant sum. Every filter test below
 * asserts the exact set of lead refs, and every aggregate asserts an exact value computed
 * independently of the implementation.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXECUTIVE_AGING_BUCKETS,
  averagePriceGap,
  averageTurnaroundDays,
  boundPremiumTotal,
  conversionRate,
  dashboardFilterSchema,
  effectiveRmUserId,
  executiveAgingBucket,
  executiveAgingBucketSql,
  leadFilterWhere,
  leadToQuoteRate,
  openPipelinePremium,
  quoteToProposalRate,
  quotedPremiumTotal,
  sumMoney,
  dashboardRoutes,
  defaultDrillWidgetRegistry,
  getBrokerPerformance,
  getExecutiveOverview,
  getLossAnalysis,
  getPipelineDashboard,
  getRmPerformance,
  BROKER_WIDGET_KEYS,
  DASHBOARD_SCOPES_BY_KEY,
  EXECUTIVE_WIDGET_KEYS,
  LOSS_WIDGET_KEYS,
  PIPELINE_WIDGET_KEYS,
  RM_WIDGET_KEYS,
  type DashboardActor,
  type DashboardFilter,
  type ExecutiveOverviewDto,
  type PipelineDashboardDto,
} from '../../domains/dashboards/index.js';
import { loadMetricFixture } from '../../domains/dashboards/metrics/fixtures/load.js';
import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database, type TenantId } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('dashboard-filters', probe);

const DRILL = '/api/v1/dashboards/drill';
const LEADS_FILTERED = 'leads.filtered';

const fixture = loadMetricFixture();
const expectedMetrics = fixture.expected;
const OPEN_CATEGORIES = ['open', 'quoted'];

/** Short run token — a long one dominates trigram similarity and false-positives duplicate checks. */
const RUN = `t35-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix} ${RUN}-${nameSequence}`;
}

interface DrillItem {
  readonly id: number;
  readonly leadRef: string;
  readonly premium: number | null;
}

interface DrillResult {
  readonly widgetKey: string;
  readonly items: DrillItem[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/** Which fixture lead each seeded lead is, so tests can talk in fixture keys rather than ids. */
const leadRefOf = (key: string): string => `${RUN}-${key}`;

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds `leads.view` AND `leads.view_all`. */
  let broad: TestUserSession;
  /** Holds `leads.view` only — owns L1..L3 and must never see L4/L5. */
  let restricted: TestUserSession;
  /** Owns L4/L5, so "restricted sees only their own" has something to exclude. */
  let stranger: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  const createdTenants: number[] = [];

  const OWNED_TABLES = [
    // `alerts` and `quote_versions` first: both reference leads/quotes, so they must go before them.
    'alerts',
    'quote_versions',
    'quotes',
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
      "select id::text as id from tenants where name like 't35-%'",
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

  async function seedBroker(
    tenantId: number,
    name: string,
    brokerTypeId: number | null,
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into brokers (tenant_id, name, status, broker_type_id, created_at, updated_at)
       values ($1, $2, 'active', $3, now(), now()) returning id::text as id`,
      [tenantId, name, brokerTypeId],
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
      registerRoutes: (api) => {
        api.route('/', dashboardRoutes({ db }));
      },
    });
  }

  async function call(
    path: string,
    options: { token?: string; tenantId?: number } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    return await harness().request(`http://localhost${path}`, { method: 'GET', headers });
  }

  /** Runs a drill and returns the ordered lead refs it produced. */
  async function drill(
    session: TestUserSession,
    queryString: string,
    tenantId = tenantA,
  ): Promise<DrillResult> {
    const response = await call(`${DRILL}${queryString}`, {
      token: session.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as DrillResult;
  }

  /** The set of fixture keys a drill returned, sorted, so assertions are order-independent. */
  async function drilledKeys(
    session: TestUserSession,
    queryString: string,
    tenantId = tenantA,
  ): Promise<string[]> {
    const result = await drill(session, queryString, tenantId);
    return result.items
      .map((item) => item.leadRef.replace(`${RUN}-`, ''))
      .sort((a, b) => a.localeCompare(b));
  }

  // Reference and dimension fixtures for tenant A.
  let partyTypeA = 0;
  let regionR1 = 0;
  let regionR2 = 0;
  let channelA = 0;
  let productP1 = 0;
  let productP2 = 0;
  let coverP1 = 0;
  let coverP2 = 0;
  let brokerTypeT1 = 0;
  let brokerTypeT2 = 0;
  let brokerB1 = 0;
  let brokerB2 = 0;
  let rmAssignmentA = 0;

  const statusByCategory = new Map<string, number>();
  const leadIdByKey = new Map<string, number>();
  const quoteIdByKey = new Map<string, number>();

  /** Which dimensions each fixture lead carries, chosen so every dimension partitions the corpus. */
  const LEAD_DIMENSIONS: Record<
    string,
    { product: 'P1' | 'P2'; broker: 'B1' | 'B2' | null; region: 'R1' | 'R2'; owner: 'restricted' | 'stranger' }
  > = {
    L1: { product: 'P1', broker: 'B1', region: 'R1', owner: 'restricted' },
    L2: { product: 'P1', broker: 'B2', region: 'R2', owner: 'restricted' },
    L3: { product: 'P2', broker: 'B1', region: 'R1', owner: 'restricted' },
    L4: { product: 'P2', broker: null, region: 'R2', owner: 'stranger' },
    L5: { product: 'P1', broker: 'B2', region: 'R1', owner: 'stranger' },
  };

  async function seedFixtureCorpus(tenantId: number): Promise<void> {
    const partyId = await seedParty(tenantId, `Fixture Client ${RUN}`, partyTypeA);

    for (const lead of fixture.leads) {
      const dims = LEAD_DIMENSIONS[lead.key];
      if (dims === undefined) throw new Error(`fixture lead ${lead.key} has no dimensions mapping`);

      const statusId = statusByCategory.get(lead.reportingCategory);
      if (statusId === undefined) {
        throw new Error(`no seeded status for reporting category ${lead.reportingCategory}`);
      }

      const rows = await query<{ id: string }>(
        `insert into leads
           (tenant_id, party_id, lead_ref, date_received, request_channel_id, broker_id, region_id,
            product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
            next_follow_up_date, source, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'm12', 'normal', $11, $12, 'browser',
                 now(), now())
         returning id::text as id`,
        [
          tenantId,
          partyId,
          leadRefOf(lead.key),
          lead.dateReceived,
          channelA,
          dims.broker === 'B1' ? brokerB1 : dims.broker === 'B2' ? brokerB2 : null,
          dims.region === 'R1' ? regionR1 : regionR2,
          dims.product === 'P1' ? productP1 : productP2,
          dims.product === 'P1' ? coverP1 : coverP2,
          // Money goes to Postgres as a STRING: the driver must not re-widen it through a double.
          lead.estimatedPremium,
          statusId,
          lead.nextFollowUpDate,
        ],
      );
      const leadId = Number(rows[0]?.id);
      leadIdByKey.set(lead.key, leadId);

      const owner = dims.owner === 'restricted' ? restricted : stranger;
      await assignOwner(tenantId, leadId, rmAssignmentA, appUserId(owner));
    }

    // `uq_quotes_current` allows ONE current quote per lead, so only the first quote seeded for a
    // lead carries the marker. Nothing in this suite reads `quotes.is_current` — the current
    // PRICE comes from `quote_versions.is_current`, which is per-quote — but the constraint is
    // real and seeding must respect it rather than working around it.
    const leadsWithCurrentQuote = new Set<string>();

    for (const quote of fixture.quotes) {
      const leadId = leadIdByKey.get(quote.leadKey);
      if (leadId === undefined) throw new Error(`fixture quote ${quote.key} has no lead`);
      const statusId = statusByCategory.get(quote.reportingCategory);
      if (statusId === undefined) {
        throw new Error(`no seeded status for reporting category ${quote.reportingCategory}`);
      }
      const dims = LEAD_DIMENSIONS[quote.leadKey];
      if (dims === undefined) throw new Error(`fixture quote ${quote.key} has no dimensions`);

      const rows = await query<{ id: string }>(
        `insert into quotes
           (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
            prepared_date, sent_date, decision_date, bound_premium, competitor_premium,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
         returning id::text as id`,
        [
          tenantId,
          leadId,
          `${RUN}-${quote.key}`,
          statusId,
          !leadsWithCurrentQuote.has(quote.leadKey),
          dims.product === 'P1' ? productP1 : productP2,
          dims.product === 'P1' ? coverP1 : coverP2,
          quote.preparedDate,
          quote.sentDate,
          quote.decisionDate === null ? null : `${quote.decisionDate}T00:00:00Z`,
          quote.boundPremium,
          quote.competitorPremium,
        ],
      );
      const quoteId = Number(rows[0]?.id);
      quoteIdByKey.set(quote.key, quoteId);
      leadsWithCurrentQuote.add(quote.leadKey);

      await query(
        `insert into quote_versions
           (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
         values ($1, $2, 1, $3, true, now())`,
        [tenantId, quoteId, quote.currentPremium],
      );
    }
  }


  /**
   * The rows T-050's drill scopes need on top of the shared metric fixture.
   *
   * Each one exists to make a scope NON-VACUOUS, and two of them exist specifically to catch the
   * measured contradictions in `drill.queries.ts`:
   *
   *  - the unresolved alert on L4 (a WON lead) is what distinguishes "any lead with an unresolved
   *    alert" — which is what `leads_at_risk` counts — from the reference's open-category-only
   *    at-risk scope. Without it, both predicates return the same rows and the at-risk test is
   *    vacuous under mutation.
   *  - the RESOLVED alert on L3 is what proves resolved alerts are excluded, which the aggregate
   *    also excludes; without it, "unresolved" could be deleted from the predicate undetected.
   *  - L5's lead-level competitor premium is the only thing that makes `loss.price_gap` non-empty;
   *    the shared fixture carries competitor premium on QUOTES, which neither side reads.
   *  - the tenant settings row gives `exec.high_value` a threshold to compare against; with none,
   *    that scope is empty by definition and every assertion on it would pass trivially.
   */
  async function seedDrillCorpusExtras(tenantId: number): Promise<void> {
    const leadId = (key: string): number => {
      const id = leadIdByKey.get(key);
      if (id === undefined) throw new Error(`no seeded lead ${key}`);
      return id;
    };

    await query(
      `insert into tenant_settings
         (tenant_id, currency_code, high_value_threshold, sla_received_to_sent_days,
          created_at, updated_at)
       values ($1, 'BWP', '1000.00', 3, now(), now())`,
      [tenantId],
    );

    // L5 is the tenant's only lost lead; the price-gap scope reads the LEAD's competitor premium.
    await query('update leads set competitor_premium = $2 where tenant_id = $1 and id = $3', [
      tenantId,
      '640.00',
      leadId('L5'),
    ]);

    const alert = async (
      key: string,
      type: string,
      resolvedAt: string | null,
    ): Promise<void> => {
      await query(
        `insert into alerts (tenant_id, type, lead_id, severity, created_at, resolved_at)
         values ($1, $2, $3, 'high', now(), $4)`,
        [tenantId, type, leadId(key), resolvedAt],
      );
    };

    await alert('L1', 'overdue_follow_up', null);
    // L4 is WON and stranger-owned: an unresolved alert on a lead outside the open categories.
    await alert('L4', 'sla_breach', null);
    await alert('L3', 'stalled_lead', new Date().toISOString());
  }


  // -------------------------------------------------------------------------------------------
  // T-050 helpers: the five dashboard payloads, run DIRECTLY so `now` and breadth are both pinned.
  // -------------------------------------------------------------------------------------------

  /** The fixture's own instant, so aging, trends and the resolved period are exact. */
  const NOW = new Date('2026-04-01T00:00:00Z');
  /** The fixture's March window, which is what every date-scoped aggregate below is read over. */
  const MARCH_FILTER: DashboardFilter = dashboardFilterSchema.parse({
    from: '2026-03-01',
    to: '2026-03-31',
  });

  /**
   * A dashboard actor whose BREADTH is set explicitly.
   *
   * `restricted` is the user in both cases: the same person, seen once with `leads.view_all` and
   * once without, so the only thing that moves between the two payloads is the breadth flag.
   */
  function dashActor(canViewAllLeads: boolean): DashboardActor {
    return {
      userId: appUserId(canViewAllLeads ? broad : restricted),
      tenantId: tenantA as TenantId,
      canViewAllLeads,
    };
  }

  function executivePayload(canViewAllLeads: boolean): Promise<ExecutiveOverviewDto> {
    return getExecutiveOverview({ db }, dashActor(canViewAllLeads), MARCH_FILTER, NOW);
  }

  function pipelinePayload(canViewAllLeads: boolean): Promise<PipelineDashboardDto> {
    return getPipelineDashboard({ db }, dashActor(canViewAllLeads), MARCH_FILTER, NOW);
  }

  function kpiValue(
    kpis: readonly { key: string; value: number | null }[],
    key: string,
  ): number | null {
    const found = kpis.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`no KPI '${key}' in payload`);
    return found.value;
  }

  /**
   * Every drill widget key that some widget on some dashboard currently reports a NON-ZERO number
   * against — walked out of the five real payloads rather than listed by hand, so a new widget is
   * covered the day it ships instead of the day someone remembers to add it here.
   */
  async function nonZeroDrillKeys(canViewAllLeads: boolean): Promise<string[]> {
    const actor = dashActor(canViewAllLeads);
    const [executive, pipeline, broker, rm, loss] = await Promise.all([
      getExecutiveOverview({ db }, actor, MARCH_FILTER, NOW),
      getPipelineDashboard({ db }, actor, MARCH_FILTER, NOW),
      getBrokerPerformance({ db }, actor, MARCH_FILTER, NOW),
      getRmPerformance({ db }, actor, MARCH_FILTER, NOW),
      getLossAnalysis({ db }, actor, MARCH_FILTER, NOW),
    ]);

    const keys = new Set<string>();

    /** Any object carrying both a drill key and a number counts as a widget for this purpose. */
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (node === null || typeof node !== 'object') return;

      const record = node as Record<string, unknown>;
      const key = record['drillWidgetKey'];
      if (typeof key === 'string' && key.length > 0) {
        const numbers = Object.entries(record)
          .filter(([name]) => name !== 'drillWidgetKey')
          .map(([, value]) => value)
          .filter((value): value is number => typeof value === 'number');
        if (numbers.some((value) => value !== 0)) keys.add(key);
      }

      for (const value of Object.values(record)) walk(value);
    };

    walk([executive, pipeline, broker, rm, loss]);
    return [...keys].sort((left, right) => left.localeCompare(right));
  }

  /**
   * A Kysely wrapper that records every statement it executes, for the query-BUDGET assertion.
   *
   * Counted, not timed: a per-row lookup is invisible in a duration on a five-lead fixture and
   * obvious in a statement count.
   */
  function countingDb(): {
    db: Kysely<Database>;
    statements: string[];
    destroy: () => Promise<void>;
  } {
    const statements: string[] = [];
    const countingPool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    const counting = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: countingPool }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query.sql);
      },
    });
    return { db: counting, statements, destroy: () => counting.destroy() };
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

    await purgeStaleRunsOfThisSuite();

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');

    broad = await auth.createTestUserWithSession({
      label: 'dash-broad',
      firstName: 'Ada',
      lastName: 'Zulu',
    });
    restricted = await auth.createTestUserWithSession({
      label: 'dash-restricted',
      firstName: 'Bea',
      lastName: 'Yankee',
    });
    stranger = await auth.createTestUserWithSession({
      label: 'dash-stranger',
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
    // NO view_all — the breadth fixture.
    await fixtures.grantDirectPermission(appUserId(restricted), 'leads.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(stranger), 'leads.view', tenantA);

    const rmRole = await fixtures.createRole({ tenantId: tenantA });
    rmAssignmentA = await seedRmSlot(tenantA, rmRole);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp'));
    regionR1 = await seedRef(tenantA, 'region', uniqueName('North'));
    regionR2 = await seedRef(tenantA, 'region', uniqueName('South'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email'));
    productP1 = await seedRef(tenantA, 'product_line', uniqueName('Motor'));
    productP2 = await seedRef(tenantA, 'product_line', uniqueName('Marine'));
    coverP1 = await seedRef(tenantA, 'cover_type', uniqueName('Comp'), { productLineId: productP1 });
    coverP2 = await seedRef(tenantA, 'cover_type', uniqueName('Hull'), { productLineId: productP2 });
    brokerTypeT1 = await seedRef(tenantA, 'broker_type', uniqueName('Tier1'));
    brokerTypeT2 = await seedRef(tenantA, 'broker_type', uniqueName('Tier2'));
    brokerB1 = await seedBroker(tenantA, `B1 Brokers ${RUN}`, brokerTypeT1);
    brokerB2 = await seedBroker(tenantA, `B2 Brokers ${RUN}`, brokerTypeT2);

    for (const category of ['open', 'quoted', 'won', 'lost', 'expired']) {
      statusByCategory.set(
        category,
        await seedRef(tenantA, 'lead_status', uniqueName(`Status ${category}`), {
          reportingCategory: category,
        }),
      );
    }

    await seedFixtureCorpus(tenantA);

    await seedDrillCorpusExtras(tenantA);

    // Tenant B carries a DISTINGUISHABLE marker corpus: one lead whose ref could never be mistaken
    // for a tenant-A row, so an isolation failure is visible rather than merely numerically odd.
    const partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('CorpB'));
    const regionB = await seedRef(tenantB, 'region', uniqueName('EastB'));
    const channelB = await seedRef(tenantB, 'request_channel', uniqueName('EmailB'));
    const productB = await seedRef(tenantB, 'product_line', uniqueName('MotorB'));
    const coverB = await seedRef(tenantB, 'cover_type', uniqueName('CompB'), {
      productLineId: productB,
    });
    const statusB = await seedRef(tenantB, 'lead_status', uniqueName('OpenB'), {
      reportingCategory: 'open',
    });
    const partyB = await seedParty(tenantB, `Tenant B Client ${RUN}`, partyTypeB);
    await query(
      `insert into leads
         (tenant_id, party_id, lead_ref, date_received, request_channel_id, region_id,
          product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
          source, created_at, updated_at)
       values ($1, $2, $3, '2026-03-15', $4, $5, $6, $7, '777777.00', 'm12', 'normal', $8,
               'browser', now(), now())`,
      [tenantB, partyB, `${RUN}-TENANT-B-MARKER`, channelB, regionB, productB, coverB, statusB],
    );
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Data deletion MUST precede `auth.cleanup()`: that call ends the pool these deletes run on,
    // and the deletes swallow their errors, so the reverse order is a SILENT no-op.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    // `db.destroy()` ends the pool it wraps; calling `pool.end()` after it throws "Called end on
    // pool more than once". Same teardown order as leads-list.test.ts.
    await db?.destroy();
  });

  // -------------------------------------------------------------------------------------------
  // The filter contract itself.
  // -------------------------------------------------------------------------------------------

  describe('shared filter parsing', () => {
    it('accepts exactly the eight measured reference parameters', () => {
      const parsed = dashboardFilterSchema.parse({
        from: '2026-03-01',
        to: '2026-03-31',
        productLineId: '7',
        brokerId: '8',
        rmUserId: '9',
        regionId: '10',
        teamOrRmId: '11',
        brokerTypeId: '12',
      });

      expect(parsed).toEqual({
        from: '2026-03-01',
        to: '2026-03-31',
        productLineId: 7,
        brokerId: 8,
        rmUserId: 9,
        regionId: 10,
        teamOrRmId: 11,
        brokerTypeId: 12,
      });
    });

    it('leaves an unsupplied dimension undefined rather than defaulting it to zero', () => {
      const parsed = dashboardFilterSchema.parse({});
      expect(parsed.productLineId).toBeUndefined();
      // A 0 here would be an id that matches nothing and renders an empty dashboard as if real.
      expect(parsed.productLineId).not.toBe(0);
    });

    it('rejects a non-numeric or non-positive id', () => {
      expect(dashboardFilterSchema.safeParse({ brokerId: 'abc' }).success).toBe(false);
      expect(dashboardFilterSchema.safeParse({ brokerId: '0' }).success).toBe(false);
      expect(dashboardFilterSchema.safeParse({ brokerId: '-1' }).success).toBe(false);
    });

    it('rejects a date that is not yyyy-MM-dd', () => {
      expect(dashboardFilterSchema.safeParse({ from: '01/03/2026' }).success).toBe(false);
    });

    /** `filter.TeamOrRmId ?? filter.RmUserId` (LossAnalysisStore.cs:201) — teamOrRmId WINS. */
    it('resolves the RM dimension with teamOrRmId taking precedence over rmUserId', () => {
      expect(effectiveRmUserId({ ...base(), rmUserId: 5 })).toBe(5);
      expect(effectiveRmUserId({ ...base(), teamOrRmId: 9 })).toBe(9);
      expect(effectiveRmUserId({ ...base(), rmUserId: 5, teamOrRmId: 9 })).toBe(9);
      expect(effectiveRmUserId(base())).toBeUndefined();
    });

    function base(): DashboardFilter {
      return dashboardFilterSchema.parse({});
    }
  });

  // -------------------------------------------------------------------------------------------
  // AC-075 / V-093: each dimension narrows to exactly the matching records.
  // -------------------------------------------------------------------------------------------

  describe('filter correctness, one dimension at a time', () => {
    const ALL_KEYS = ['L1', 'L2', 'L3', 'L4', 'L5'];

    it('returns the whole tenant corpus with no filter at all', async () => {
      expect(await drilledKeys(broad, `?widget=${LEADS_FILTERED}`)).toEqual(ALL_KEYS);
    });

    it('narrows by date range to leads received inside it', async () => {
      // L4 is 2026-02-20 and is the only lead outside the March window.
      expect(
        await drilledKeys(broad, `?widget=${LEADS_FILTERED}&from=2026-03-01&to=2026-03-31`),
      ).toEqual(['L1', 'L2', 'L3', 'L5']);
    });

    it('treats both ends of the date range as inclusive', async () => {
      // L1 is 2026-03-02 exactly; a half-open range would drop it.
      expect(
        await drilledKeys(broad, `?widget=${LEADS_FILTERED}&from=2026-03-02&to=2026-03-02`),
      ).toEqual(['L1']);
    });

    it('narrows by product line', async () => {
      expect(
        await drilledKeys(broad, `?widget=${LEADS_FILTERED}&productLineId=${String(productP1)}`),
      ).toEqual(['L1', 'L2', 'L5']);
      expect(
        await drilledKeys(broad, `?widget=${LEADS_FILTERED}&productLineId=${String(productP2)}`),
      ).toEqual(['L3', 'L4']);
    });

    it('narrows by broker, excluding broker-less leads', async () => {
      expect(
        await drilledKeys(broad, `?widget=${LEADS_FILTERED}&brokerId=${String(brokerB1)}`),
      ).toEqual(['L1', 'L3']);
      // L4 has no broker and must not appear under ANY broker filter.
      expect(
        await drilledKeys(broad, `?widget=${LEADS_FILTERED}&brokerId=${String(brokerB2)}`),
      ).toEqual(['L2', 'L5']);
    });

    it('narrows by region', async () => {
      expect(
        await drilledKeys(broad, `?widget=${LEADS_FILTERED}&regionId=${String(regionR1)}`),
      ).toEqual(['L1', 'L3', 'L5']);
    });

    it('narrows by RM through the assignment, not through a lead column', async () => {
      expect(
        await drilledKeys(
          broad,
          `?widget=${LEADS_FILTERED}&rmUserId=${String(appUserId(restricted))}`,
        ),
      ).toEqual(['L1', 'L2', 'L3']);
      expect(
        await drilledKeys(
          broad,
          `?widget=${LEADS_FILTERED}&rmUserId=${String(appUserId(stranger))}`,
        ),
      ).toEqual(['L4', 'L5']);
    });

    it('applies teamOrRmId as the same dimension, overriding rmUserId', async () => {
      const both =
        `?widget=${LEADS_FILTERED}&rmUserId=${String(appUserId(restricted))}` +
        `&teamOrRmId=${String(appUserId(stranger))}`;
      // If rmUserId won instead, this would return L1..L3.
      expect(await drilledKeys(broad, both)).toEqual(['L4', 'L5']);
    });

    it('intersects two dimensions', async () => {
      expect(
        await drilledKeys(
          broad,
          `?widget=${LEADS_FILTERED}&productLineId=${String(productP1)}&regionId=${String(regionR1)}`,
        ),
      ).toEqual(['L1', 'L5']);
    });

    it('intersects a date range with a broker', async () => {
      expect(
        await drilledKeys(
          broad,
          `?widget=${LEADS_FILTERED}&from=2026-03-01&to=2026-03-31&brokerId=${String(brokerB2)}`,
        ),
      ).toEqual(['L2', 'L5']);
    });

    it('intersects three dimensions down to a single lead', async () => {
      expect(
        await drilledKeys(
          broad,
          `?widget=${LEADS_FILTERED}&productLineId=${String(productP1)}` +
            `&regionId=${String(regionR1)}&rmUserId=${String(appUserId(restricted))}`,
        ),
      ).toEqual(['L1']);
    });

    it('returns an empty, well-formed result when the intersection is empty', async () => {
      const result = await drill(
        broad,
        `?widget=${LEADS_FILTERED}&productLineId=${String(productP2)}&regionId=${String(regionR1)}` +
          `&rmUserId=${String(appUserId(stranger))}`,
      );
      expect(result.items).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    /** V-093: "unfiltered totals equal the sum over filter partitions where applicable." */
    it('partitions the corpus exactly across the product-line dimension', async () => {
      const all = await drill(broad, `?widget=${LEADS_FILTERED}`);
      const p1 = await drill(broad, `?widget=${LEADS_FILTERED}&productLineId=${String(productP1)}`);
      const p2 = await drill(broad, `?widget=${LEADS_FILTERED}&productLineId=${String(productP2)}`);
      expect(p1.totalCount + p2.totalCount).toBe(all.totalCount);
    });

    it('partitions the corpus exactly across the region dimension', async () => {
      const all = await drill(broad, `?widget=${LEADS_FILTERED}`);
      const r1 = await drill(broad, `?widget=${LEADS_FILTERED}&regionId=${String(regionR1)}`);
      const r2 = await drill(broad, `?widget=${LEADS_FILTERED}&regionId=${String(regionR2)}`);
      expect(r1.totalCount + r2.totalCount).toBe(all.totalCount);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The SQL predicate builder — including the broker-type dimension the drill does not project.
  // -------------------------------------------------------------------------------------------

  describe('leadFilterPredicates: the dimensions dashboards apply in SQL', () => {
    async function keysMatching(filter: DashboardFilter): Promise<string[]> {
      const where = leadFilterWhere(tenantA as TenantId, filter, 'l');
      const rows = await db
        .selectFrom('leads as l')
        .select('l.lead_ref')
        .where(where)
        .orderBy('l.lead_ref')
        .execute();
      return rows
        .map((row) => row.lead_ref.replace(`${RUN}-`, ''))
        .filter((ref) => ref.startsWith('L'))
        .sort((a, b) => a.localeCompare(b));
    }

    const empty = (): DashboardFilter => dashboardFilterSchema.parse({});

    /**
     * EVERY dimension is exercised against the PREDICATE BUILDER, not only against the drill.
     *
     * These are not duplicates of the drill tests above. The drill routes its filtering through
     * `leadListFilterFrom` -> the leads repository, so it exercises a DIFFERENT code path; the
     * dashboards of T-036/T-037 will aggregate through `leadFilterPredicates` instead. A mutation
     * that broke the RM branch here survived the entire drill suite, because nothing was reaching
     * this branch at all — an aggregate that silently ignored its RM filter would have shipped.
     */
    it('narrows by date range', async () => {
      expect(await keysMatching({ ...empty(), from: '2026-03-01', to: '2026-03-31' })).toEqual([
        'L1',
        'L2',
        'L3',
        'L5',
      ]);
    });

    it('narrows by product line', async () => {
      expect(await keysMatching({ ...empty(), productLineId: productP1 })).toEqual([
        'L1',
        'L2',
        'L5',
      ]);
    });

    it('narrows by broker', async () => {
      expect(await keysMatching({ ...empty(), brokerId: brokerB1 })).toEqual(['L1', 'L3']);
    });

    it('narrows by region', async () => {
      expect(await keysMatching({ ...empty(), regionId: regionR1 })).toEqual(['L1', 'L3', 'L5']);
    });

    it('narrows by RM to that RM alone, not to every assigned lead', async () => {
      expect(await keysMatching({ ...empty(), rmUserId: appUserId(restricted) })).toEqual([
        'L1',
        'L2',
        'L3',
      ]);
      expect(await keysMatching({ ...empty(), rmUserId: appUserId(stranger) })).toEqual([
        'L4',
        'L5',
      ]);
    });

    it('applies teamOrRmId as the RM dimension, taking precedence over rmUserId', async () => {
      expect(
        await keysMatching({
          ...empty(),
          rmUserId: appUserId(restricted),
          teamOrRmId: appUserId(stranger),
        }),
      ).toEqual(['L4', 'L5']);
    });

    it('intersects dimensions rather than unioning them', async () => {
      expect(
        await keysMatching({
          ...empty(),
          productLineId: productP1,
          rmUserId: appUserId(restricted),
        }),
      ).toEqual(['L1', 'L2']);
    });

    it('narrows by broker type through the broker join', async () => {
      expect(await keysMatching({ ...empty(), brokerTypeId: brokerTypeT1 })).toEqual(['L1', 'L3']);
      expect(await keysMatching({ ...empty(), brokerTypeId: brokerTypeT2 })).toEqual(['L2', 'L5']);
    });

    it('excludes broker-less leads from every broker-type filter', async () => {
      const t1 = await keysMatching({ ...empty(), brokerTypeId: brokerTypeT1 });
      const t2 = await keysMatching({ ...empty(), brokerTypeId: brokerTypeT2 });
      // L4 has no broker; it belongs to neither type and must not be silently included by a join.
      expect([...t1, ...t2]).not.toContain('L4');
    });

    it('applies the tenant predicate even when every dimension is unset', async () => {
      // Tenant B's marker lead is invisible through an otherwise-empty filter on tenant A.
      const refs = await db
        .selectFrom('leads as l')
        .select('l.lead_ref')
        .where(leadFilterWhere(tenantA as TenantId, empty(), 'l'))
        .execute();
      expect(refs.map((r) => r.lead_ref)).not.toContain(`${RUN}-TENANT-B-MARKER`);
      expect(refs).toHaveLength(fixture.leads.length);
    });

    it('scopes to the requested tenant, returning nothing for a tenant with no corpus', async () => {
      const rows = await db
        .selectFrom('leads as l')
        .select('l.lead_ref')
        .where(leadFilterWhere(tenantB as TenantId, empty(), 'l'))
        .execute();
      expect(rows.map((r) => r.lead_ref)).toEqual([`${RUN}-TENANT-B-MARKER`]);
    });

    it('agrees with the drill on every dimension the drill also projects', async () => {
      const filter: DashboardFilter = {
        ...empty(),
        productLineId: productP1,
        regionId: regionR1,
      };
      expect(await keysMatching(filter)).toEqual(
        await drilledKeys(
          broad,
          `?widget=${LEADS_FILTERED}&productLineId=${String(productP1)}&regionId=${String(regionR1)}`,
        ),
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-076 / V-095: drill reconciles with its aggregate, under breadth and tenant scope.
  // -------------------------------------------------------------------------------------------

  describe('drill-through reconciles with the aggregate it came from', () => {
    /** The aggregate a dashboard cell would show for a filter: count and premium sum, in SQL. */
    async function aggregate(
      filter: DashboardFilter,
      caller: { callerUserId: number; callerHasViewAll: boolean },
    ): Promise<{ count: number; premium: string }> {
      const where = leadFilterWhere(tenantA as TenantId, filter, 'l');
      let builder = db
        .selectFrom('leads as l')
        .select((eb) => [
          eb.fn.countAll<string>().as('count'),
          // Summed IN SQL against numeric — never by widening each row to a double first.
          eb.fn.coalesce(eb.fn.sum<string>('l.estimated_premium'), eb.val('0')).as('premium'),
        ])
        .where(where);

      if (!caller.callerHasViewAll) {
        builder = builder.where((eb) =>
          eb.exists(
            eb
              .selectFrom('lead_assignments as la')
              .select('la.lead_id')
              .whereRef('la.lead_id', '=', 'l.id')
              .where('la.tenant_id', '=', tenantA as TenantId)
              .where('la.user_id', '=', caller.callerUserId),
          ),
        );
      }

      const row = await builder.executeTakeFirstOrThrow();
      return { count: Number(row.count), premium: String(row.premium) };
    }

    const empty = (): DashboardFilter => dashboardFilterSchema.parse({});

    it('returns exactly the records the unfiltered aggregate counted', async () => {
      const agg = await aggregate(empty(), {
        callerUserId: appUserId(broad),
        callerHasViewAll: true,
      });
      const result = await drill(broad, `?widget=${LEADS_FILTERED}&pageSize=100`);

      expect(result.totalCount).toBe(agg.count);
      expect(result.items).toHaveLength(agg.count);
      // The premium sum of the drilled rows reproduces the aggregate's sum exactly.
      const drilledSum = sumMoney(
        result.items.map((item) => (item.premium === null ? '0.00' : item.premium.toFixed(2))),
      );
      expect(drilledSum).toBe(sumMoney([agg.premium]));
    });

    it('reconciles under a filter as well as unfiltered', async () => {
      const filter: DashboardFilter = { ...empty(), productLineId: productP1 };
      const agg = await aggregate(filter, {
        callerUserId: appUserId(broad),
        callerHasViewAll: true,
      });
      const result = await drill(
        broad,
        `?widget=${LEADS_FILTERED}&productLineId=${String(productP1)}&pageSize=100`,
      );
      expect(result.totalCount).toBe(agg.count);
      expect(result.items).toHaveLength(agg.count);
    });

    /**
     * The breadth case is the one that matters (P-03). A restricted caller's DRILL and their
     * AGGREGATE must narrow together — if breadth were applied only to the drill, the chart would
     * show a number the user could never drill into, and if applied only to the aggregate the
     * drill would leak other users' leads.
     */
    it('narrows both the drill and the aggregate for a caller without view_all', async () => {
      const agg = await aggregate(empty(), {
        callerUserId: appUserId(restricted),
        callerHasViewAll: false,
      });
      const result = await drill(restricted, `?widget=${LEADS_FILTERED}&pageSize=100`);

      expect(agg.count).toBe(3);
      expect(result.totalCount).toBe(agg.count);
      expect(await drilledKeys(restricted, `?widget=${LEADS_FILTERED}&pageSize=100`)).toEqual([
        'L1',
        'L2',
        'L3',
      ]);
    });

    it('never returns a lead the restricted caller does not own, even when filtered to it', async () => {
      // L5 belongs to `stranger`. Asking for it explicitly must still return nothing.
      const result = await drill(
        restricted,
        `?widget=${LEADS_FILTERED}&rmUserId=${String(appUserId(stranger))}`,
      );
      expect(result.items).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    /**
     * `totalCount` is computed under the SAME predicates as the page, not after it. A
     * post-filtered implementation would return the restricted caller's three rows alongside the
     * unrestricted count of five — which a length-only assertion would never notice.
     */
    it('counts under the breadth predicate rather than post-filtering a page', async () => {
      const broadResult = await drill(broad, `?widget=${LEADS_FILTERED}&pageSize=100`);
      const restrictedResult = await drill(restricted, `?widget=${LEADS_FILTERED}&pageSize=100`);
      expect(broadResult.totalCount).toBe(5);
      expect(restrictedResult.totalCount).toBe(3);
      expect(restrictedResult.items).toHaveLength(restrictedResult.totalCount);
    });

    it('pages without repeating or dropping a row', async () => {
      const first = await drill(broad, `?widget=${LEADS_FILTERED}&page=1&pageSize=2`);
      const second = await drill(broad, `?widget=${LEADS_FILTERED}&page=2&pageSize=2`);
      const third = await drill(broad, `?widget=${LEADS_FILTERED}&page=3&pageSize=2`);

      expect(first.totalCount).toBe(5);
      const seen = [...first.items, ...second.items, ...third.items].map((i) => i.id);
      expect(new Set(seen).size).toBe(5);
    });

    it('defaults to page 1 and page size 25', async () => {
      const result = await drill(broad, `?widget=${LEADS_FILTERED}`);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(25);
      expect(result.widgetKey).toBe(LEADS_FILTERED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-022 / V-027: tenant isolation.
  // -------------------------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('returns zero tenant-B rows to a tenant-A drill', async () => {
      const result = await drill(broad, `?widget=${LEADS_FILTERED}&pageSize=100`, tenantA);
      expect(result.items.map((i) => i.leadRef)).not.toContain(`${RUN}-TENANT-B-MARKER`);
      expect(result.totalCount).toBe(5);
    });

    it('returns only tenant-B rows to a tenant-B drill', async () => {
      const result = await drill(broad, `?widget=${LEADS_FILTERED}&pageSize=100`, tenantB);
      expect(result.items.map((i) => i.leadRef)).toEqual([`${RUN}-TENANT-B-MARKER`]);
      expect(result.totalCount).toBe(1);
    });

    it('does not let a tenant-A id leak through a filter aimed at tenant B', async () => {
      // Tenant A's product line id, presented under tenant B: it belongs to another tenant, so it
      // must match nothing rather than reaching across.
      const result = await drill(
        broad,
        `?widget=${LEADS_FILTERED}&productLineId=${String(productP1)}`,
        tenantB,
      );
      expect(result.items).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it('rejects a caller with no membership in the requested tenant', async () => {
      // `restricted` is a member of tenant A only.
      const response = await call(`${DRILL}?widget=${LEADS_FILTERED}`, {
        token: restricted.accessToken,
        tenantId: tenantB,
      });
      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The route contract.
  // -------------------------------------------------------------------------------------------

  describe('drill route contract', () => {
    it('requires authentication', async () => {
      const response = await call(`${DRILL}?widget=${LEADS_FILTERED}`, { tenantId: tenantA });
      expect(response.status).toBe(401);
    });

    /**
     * MEASURED: a missing `X-Tenant-Id` is 403, NOT 400. `lib/tenancy/middleware.ts:11-15` ports
     * `TenantContextMiddleware.cs:50-55`, which deliberately folds missing, malformed, nonexistent
     * and inaccessible tenants into one indistinguishable Forbidden — so a caller cannot probe
     * which tenant ids exist by watching the status code change.
     */
    it('403s rather than 400s when the tenant header is absent, disclosing nothing', async () => {
      const response = await call(`${DRILL}?widget=${LEADS_FILTERED}`, {
        token: broad.accessToken,
      });
      expect(response.status).toBe(403);

      // The same status a real-but-inaccessible tenant gets: the two are not distinguishable.
      const inaccessible = await call(`${DRILL}?widget=${LEADS_FILTERED}`, {
        token: restricted.accessToken,
        tenantId: tenantB,
      });
      expect(inaccessible.status).toBe(403);
    });

    it('403s a caller without leads.view', async () => {
      const noPermission = await auth.createTestUserWithSession({
        label: 'dash-noperm',
        firstName: 'Dee',
        lastName: 'Whisky',
      });
      await addMembership(appUserId(noPermission), tenantA);

      const response = await call(`${DRILL}?widget=${LEADS_FILTERED}`, {
        token: noPermission.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(403);
    });

    /** `DashboardEndpoints.cs:111-117`: a MISSING widget is a 400, not a 404. */
    it('400s when the widget parameter is absent', async () => {
      const response = await call(DRILL, { token: broad.accessToken, tenantId: tenantA });
      expect(response.status).toBe(400);
    });

    it('400s when the widget parameter is blank', async () => {
      const response = await call(`${DRILL}?widget=%20`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(400);
    });

    /** `:129-133`: an UNREGISTERED widget is a 404 carrying `UNKNOWN_WIDGET`. */
    it('404s with UNKNOWN_WIDGET for an unregistered widget key', async () => {
      const response = await call(`${DRILL}?widget=exec.not_a_real_widget`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe('UNKNOWN_WIDGET');
    });

    it('400s on a malformed filter value rather than ignoring it', async () => {
      // Silently dropping an unparseable filter would render an UNFILTERED dashboard that the user
      // believes is filtered — strictly worse than an error.
      const response = await call(`${DRILL}?widget=${LEADS_FILTERED}&brokerId=abc`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-074 / V-092: SQL aggregations equal the pure functions over the SAME fixture.
  // -------------------------------------------------------------------------------------------

  describe('SQL aggregations match the pure metric functions on the shared fixture', () => {
    const FROM = fixture.period.from;
    const TO = fixture.period.to;

    /** Every quote of tenant A joined to its current version and status category. */
    const QUOTE_SOURCE = `
      from quotes q
      join quote_versions qv
        on qv.tenant_id = q.tenant_id and qv.quote_id = q.id and qv.is_current
      join reference_items s on s.tenant_id = q.tenant_id and s.id = q.status_id
      join leads l on l.tenant_id = q.tenant_id and l.id = q.lead_id
     where q.tenant_id = $1
    `;

    it('counts leads received in the period identically', async () => {
      const rows = await query<{ count: string }>(
        `select count(*) as count from leads l
          where l.tenant_id = $1 and l.date_received between $2::date and $3::date`,
        [tenantA, FROM, TO],
      );
      expect(Number(rows[0]?.count)).toBe(expectedMetrics.totalLeadsReceived);
    });

    it('computes the Lead-to-Quote rate identically', async () => {
      const rows = await query<{ eligible: string; with_quote: string }>(
        `select count(*) as eligible,
                count(*) filter (
                  where exists (select 1 from quotes q
                                 where q.tenant_id = l.tenant_id and q.lead_id = l.id)
                ) as with_quote
           from leads l
          where l.tenant_id = $1 and l.date_received between $2::date and $3::date`,
        [tenantA, FROM, TO],
      );
      const eligible = Number(rows[0]?.eligible);
      const withQuote = Number(rows[0]?.with_quote);

      expect(withQuote).toBe(expectedMetrics.leadsWithQuote);
      expect(leadToQuoteRate(withQuote, eligible)).toBe(expectedMetrics.leadToQuoteRate);
    });

    it('computes the Quote-to-Win rate identically, excluding non-decided categories', async () => {
      const rows = await query<{ won: string; lost: string; any_decision: string }>(
        `select count(*) filter (where s.reporting_category = 'won') as won,
                count(*) filter (where s.reporting_category = 'lost') as lost,
                count(*) as any_decision
         ${QUOTE_SOURCE}
           and q.decision_date >= $2::date and q.decision_date < ($3::date + 1)`,
        [tenantA, FROM, TO],
      );
      const won = Number(rows[0]?.won);
      const lost = Number(rows[0]?.lost);

      expect(won).toBe(expectedMetrics.wonQuotes);
      expect(lost).toBe(expectedMetrics.lostQuotes);
      // The expired quote carries a decision date but must not enlarge the denominator.
      expect(Number(rows[0]?.any_decision)).toBeGreaterThan(won + lost);
      expect(conversionRate(won, won + lost)).toBe(expectedMetrics.quoteToWinRate);
    });

    it('computes the Quote-to-Proposal rate identically on the QUOTE denominator', async () => {
      const rows = await query<{ prepared: string; sent: string }>(
        `select count(*) filter (where q.prepared_date between $2::date and $3::date) as prepared,
                count(*) filter (where q.sent_date between $2::date and $3::date) as sent
         ${QUOTE_SOURCE}`,
        [tenantA, FROM, TO],
      );
      const prepared = Number(rows[0]?.prepared);
      const sent = Number(rows[0]?.sent);

      expect(prepared).toBe(expectedMetrics.totalQuotesPrepared);
      expect(sent).toBe(expectedMetrics.quotesSent);
      expect(quoteToProposalRate(sent, prepared)).toBe(expectedMetrics.quoteToProposalRate);
    });

    /**
     * Quoted Premium and Bound Premium are summed AS NUMERIC IN SQL and compared as strings. A
     * `Number(...)` on either side would defeat the point of the test as well as the point of the
     * money typing: 5525.00 survives a double, but the pattern that produced it does not.
     */
    it('sums Quoted Premium identically', async () => {
      const rows = await query<{ total: string }>(
        `select coalesce(sum(qv.quoted_premium), 0)::text as total
         ${QUOTE_SOURCE} and q.prepared_date between $2::date and $3::date`,
        [tenantA, FROM, TO],
      );
      const pure = quotedPremiumTotal(
        fixture.quotes
          .filter((q) => q.preparedDate >= FROM && q.preparedDate <= TO)
          .map((q) => q.currentPremium),
      );

      expect(rows[0]?.total).toBe(expectedMetrics.quotedPremium);
      expect(pure).toBe(rows[0]?.total);
    });

    it('sums Bound Premium identically, including the quoted-premium fallback', async () => {
      const rows = await query<{ total: string }>(
        `select coalesce(sum(coalesce(q.bound_premium, qv.quoted_premium)), 0)::text as total
         ${QUOTE_SOURCE}
           and s.reporting_category = 'won'
           and q.decision_date >= $2::date and q.decision_date < ($3::date + 1)`,
        [tenantA, FROM, TO],
      );
      const pure = boundPremiumTotal(
        fixture.quotes.filter(
          (q) =>
            q.reportingCategory === 'won' &&
            q.decisionDate !== null &&
            q.decisionDate >= FROM &&
            q.decisionDate <= TO,
        ),
      );

      expect(rows[0]?.total).toBe(expectedMetrics.boundPremium);
      expect(pure).toBe(rows[0]?.total);
      // And it is a DIFFERENT number from Quoted Premium — the two are not interchangeable.
      expect(rows[0]?.total).not.toBe(expectedMetrics.quotedPremium);
    });

    it('computes Open Pipeline Premium identically', async () => {
      const quoteRows = await query<{ total: string }>(
        `select coalesce(sum(qv.quoted_premium), 0)::text as total
         ${QUOTE_SOURCE} and s.reporting_category in ('open','quoted')`,
        [tenantA],
      );
      const leadRows = await query<{ total: string }>(
        `select coalesce(sum(l.estimated_premium), 0)::text as total
           from leads l
           join reference_items s on s.tenant_id = l.tenant_id and s.id = l.status_id
          where l.tenant_id = $1
            and s.reporting_category in ('open','quoted')
            and not exists (select 1 from quotes q
                             where q.tenant_id = l.tenant_id and q.lead_id = l.id)`,
        [tenantA],
      );

      expect(quoteRows[0]?.total).toBe(expectedMetrics.openQuotePremium);
      expect(leadRows[0]?.total).toBe(expectedMetrics.openLeadEstimatedPremium);
      expect(
        openPipelinePremium(String(quoteRows[0]?.total), String(leadRows[0]?.total)),
      ).toBe(expectedMetrics.openPipelinePremium);
    });

    it('computes Average Turnaround identically', async () => {
      const rows = await query<{ avg: string | null }>(
        `select avg(q.sent_date - l.date_received)::text as avg
         ${QUOTE_SOURCE}
           and q.sent_date is not null
           and q.sent_date between $2::date and $3::date
           and q.sent_date >= l.date_received`,
        [tenantA, FROM, TO],
      );
      const leadsByKey = new Map(fixture.leads.map((l) => [l.key, l]));
      const pure = averageTurnaroundDays(
        fixture.quotes
          .filter((q) => q.sentDate !== null && q.sentDate >= FROM && q.sentDate <= TO)
          .map((q) => ({
            receivedDate: leadsByKey.get(q.leadKey)?.dateReceived ?? '',
            sentDate: q.sentDate ?? '',
          })),
      );

      expect(pure).toBe(expectedMetrics.averageTurnaroundDays);
      expect(Number(rows[0]?.avg)).toBe(pure);
    });

    /** The canonical fragment is the one the module exports — not a copy retyped in this test. */
    it('buckets open-quote aging identically using the exported SQL fragment', async () => {
      const bucketSql = executiveAgingBucketSql(`($2::date - q.prepared_date)`);
      const rows = await query<{ bucket: string; count: string }>(
        `select ${bucketSql} as bucket, count(*) as count
         ${QUOTE_SOURCE} and s.reporting_category in ('open','quoted')
         group by 1`,
        [tenantA, fixture.today],
      );

      const fromSql: Record<string, number> = Object.fromEntries(
        EXECUTIVE_AGING_BUCKETS.map((b) => [b, 0]),
      );
      for (const row of rows) fromSql[row.bucket] = Number(row.count);

      const fromPure: Record<string, number> = Object.fromEntries(
        EXECUTIVE_AGING_BUCKETS.map((b) => [b, 0]),
      );
      for (const quote of fixture.quotes) {
        if (!OPEN_CATEGORIES.includes(quote.reportingCategory)) continue;
        const age = Math.round(
          (Date.parse(`${fixture.today}T00:00:00Z`) - Date.parse(`${quote.preparedDate}T00:00:00Z`)) /
            86_400_000,
        );
        const bucket = executiveAgingBucket(age);
        fromPure[bucket] = (fromPure[bucket] ?? 0) + 1;
      }

      expect(fromSql).toEqual(expectedMetrics.executiveAgingBuckets);
      expect(fromSql).toEqual(fromPure);
    });

    it('computes the Average Price Gap identically using the documented truncation', async () => {
      const rows = await query<{ gap: string | null }>(
        `select avg(trunc((qv.quoted_premium - q.competitor_premium) / q.competitor_premium, 12))::text
                  as gap
         ${QUOTE_SOURCE} and q.competitor_premium is not null and q.competitor_premium > 0`,
        [tenantA],
      );
      const pure = averagePriceGap(
        fixture.quotes
          .filter((q) => q.competitorPremium !== null)
          .map((q) => ({
            ourPremium: q.currentPremium,
            competitorPremium: q.competitorPremium ?? '0.00',
          })),
      );

      expect(pure).toBe(expectedMetrics.averagePriceGap);
      expect(Number(rows[0]?.gap)).toBe(pure);
    });

    /**
     * V-092'S PROOF THAT THE FIXTURES ARE GENUINELY SHARED.
     *
     * Flip one quote from lost to won in the DATABASE and in the in-memory copy, then recompute
     * both sides. If the two datasets had silently drifted apart — a stale build artifact, a
     * second copy of the JSON, a test that hard-codes what it expects — the two results would stop
     * agreeing here even though every test above still passed.
     */
    it('moves the SQL and pure results identically when the fixture is mutated', async () => {
      const wonStatusId = statusByCategory.get('won');
      const lostQuoteId = quoteIdByKey.get('Q3');

      const baseline = await query<{ won: string }>(
        `select count(*) filter (where s.reporting_category = 'won') as won
         ${QUOTE_SOURCE} and q.decision_date >= $2::date and q.decision_date < ($3::date + 1)`,
        [tenantA, FROM, TO],
      );
      expect(Number(baseline[0]?.won)).toBe(expectedMetrics.wonQuotes);

      try {
        await query('update quotes set status_id = $1 where tenant_id = $2 and id = $3', [
          wonStatusId,
          tenantA,
          lostQuoteId,
        ]);

        const mutatedSql = await query<{ won: string; lost: string }>(
          `select count(*) filter (where s.reporting_category = 'won') as won,
                  count(*) filter (where s.reporting_category = 'lost') as lost
           ${QUOTE_SOURCE} and q.decision_date >= $2::date and q.decision_date < ($3::date + 1)`,
          [tenantA, FROM, TO],
        );

        const mutatedFixture = fixture.quotes.map((q) =>
          q.key === 'Q3' ? { ...q, reportingCategory: 'won' } : q,
        );
        const inRange = (d: string | null): boolean => d !== null && d >= FROM && d <= TO;
        const pureWon = mutatedFixture.filter(
          (q) => q.reportingCategory === 'won' && inRange(q.decisionDate),
        ).length;
        const pureLost = mutatedFixture.filter(
          (q) => q.reportingCategory === 'lost' && inRange(q.decisionDate),
        ).length;

        // Both moved, and both moved to the same place.
        expect(Number(mutatedSql[0]?.won)).toBe(2);
        expect(pureWon).toBe(2);
        expect(Number(mutatedSql[0]?.won)).toBe(pureWon);
        expect(Number(mutatedSql[0]?.lost)).toBe(pureLost);
        expect(conversionRate(pureWon, pureWon + pureLost)).toBe(1);
        expect(conversionRate(pureWon, pureWon + pureLost)).not.toBe(
          expectedMetrics.quoteToWinRate,
        );
      } finally {
        await query('update quotes set status_id = $1 where tenant_id = $2 and id = $3', [
          statusByCategory.get('lost'),
          tenantA,
          lostQuoteId,
        ]);
      }

      const restored = await query<{ won: string }>(
        `select count(*) filter (where s.reporting_category = 'won') as won
         ${QUOTE_SOURCE} and q.decision_date >= $2::date and q.decision_date < ($3::date + 1)`,
        [tenantA, FROM, TO],
      );
      expect(Number(restored[0]?.won)).toBe(expectedMetrics.wonQuotes);
    });
  });
  // -------------------------------------------------------------------------------------------
  // T-050 / AC-076 / V-095: the 31 dashboard widget keys.
  //
  // THE BAR, AND WHY IT IS NOT "totalCount EQUALS THE WIDGET VALUE"
  // ==============================================================
  // Drills return LEAD rows; most widgets count quotes, sum premium or average days, so that
  // equality is not expressible for them. The binding rule is the NON-EMPTY SUPERSET INVARIANT:
  // the drill population contains the lead-projection of the aggregate's population, so a non-zero
  // headline always drills into at least one row and never omits a lead it counted.
  //
  // Exact equality is asserted only where it is meaningful — a lead-count widget whose key no other
  // aggregate shares. Every OTHER key has its documented population asserted exactly, which is the
  // discharge for rule 5: an undocumented-and-untested drill population is how this whole gap
  // survived three implementors and two evaluations.
  // -------------------------------------------------------------------------------------------

  describe('dashboard drill widget keys', () => {
    /** The documented population of every key, as fixture lead keys, for the BROAD caller. */
    const DOCUMENTED_POPULATION: Record<string, string[]> = {
      // --- Executive. NOT date-scoped: `snapshotPredicates` pushes no date, so the population is
      // full and a date-filtered drill would be narrower than its own headline.
      'exec.leads': ['L1', 'L2', 'L3', 'L4', 'L5'],
      'exec.quotes': ['L1', 'L2', 'L4', 'L5'],
      // L5 is a LOST lead carrying an OPEN quote (Q9), and `openPipelineOf` sums that quote. The
      // reference's lead-category-only scope drops L5 — contradiction (b) in drill.queries.ts.
      'exec.open_pipeline': ['L1', 'L2', 'L3', 'L5'],
      // DECIDED, not "won": Q2 is a WON quote on L2, whose own category is `quoted`, and the
      // won-vs-lost TREND carries this same key — contradiction (c).
      'exec.won': ['L2', 'L4', 'L5'],
      'exec.lost': ['L4', 'L5'],
      // L4 is WON and carries an unresolved alert; `leads_at_risk` counts it — contradiction (d).
      'exec.at_risk': ['L1', 'L4'],
      // Open pipeline above the tenant's 1000.00 threshold: L1 (current quote 1200), L2 (2500).
      'exec.high_value': ['L1', 'L2'],

      // --- Pipeline. Also not date-scoped.
      'pipeline.leads': ['L1', 'L2', 'L3', 'L4', 'L5'],
      'pipeline.new_leads': ['L1', 'L2', 'L3', 'L4', 'L5'],
      'pipeline.quoted': ['L1', 'L2', 'L4', 'L5'],
      // Admits `won` as well, because every FUNNEL bar carries this key and the funnel counts
      // PROGRESSION_CATEGORIES (open, quoted, won) — plus L5 for its open quote.
      'pipeline.open_pipeline': ['L1', 'L2', 'L3', 'L4', 'L5'],
      'pipeline.overdue_quotes': ['L1', 'L2', 'L3', 'L4', 'L5'],
      // Serves `proposal_to_win_rate` alone, whose DENOMINATOR is sent quotes: L1 (Q1, Q6),
      // L2 (Q2), L4 (Q3, Q5). L5's only quote is unsent.
      'pipeline.won': ['L1', 'L2', 'L4'],
      'pipeline.lost': ['L5'],
      'pipeline.at_risk': ['L1', 'L4'],

      // --- Broker. Date-scoped (its aggregate loads through `leadFilterWhere`), brokered leads only.
      'broker.leads': ['L1', 'L2', 'L3', 'L5'],
      'broker.quotes': ['L1', 'L2', 'L5'],
      'broker.won': ['L2', 'L5'],
      'broker.lost': ['L5'],
      'broker.overdue': ['L1', 'L2'],

      // --- RM. Date-scoped, all leads.
      'rm.leads': ['L1', 'L2', 'L3', 'L4', 'L5'],
      'rm.quotes': ['L1', 'L2', 'L4', 'L5'],
      'rm.won': ['L2', 'L4', 'L5'],
      'rm.lost': ['L4', 'L5'],
      // WIDER than "overdue": its key is carried by `follow_up_compliance`, whose denominator is
      // open leads with a COMMITTED follow-up — the on-time ones included — contradiction (e).
      // Both fixture commitments happen to be in the past, so the two agree on this corpus; the
      // distinguishing case is asserted separately below.
      'rm.overdue': ['L1', 'L2'],

      // --- Loss. Date-scoped; every non-price-gap key is the whole lost list.
      'loss.count_by_reason': ['L5'],
      'loss.trend_by_reason': ['L5'],
      'loss.by_cover_type': ['L5'],
      'loss.by_broker': ['L5'],
      'loss.by_rm': ['L5'],
      'loss.price_gap': ['L5'],
    };

    /**
     * The EXACT-EQUALITY subset: lead-count widgets whose key no other aggregate shares.
     *
     * `pipeline.lost` is carried only by the funnel's terminal Lost bar, whose value is
     * `lostLeads.length` — a lead count over exactly this population. Everything else on these five
     * dashboards either counts quotes, sums money, averages days, or shares its key.
     */
    const EXACT_EQUALITY_KEYS = ['pipeline.lost'];

    it('registers every widget key the five dashboards emit', () => {
      const registry = defaultDrillWidgetRegistry();
      const emitted = [
        ...Object.values(EXECUTIVE_WIDGET_KEYS),
        ...Object.values(PIPELINE_WIDGET_KEYS),
        ...Object.values(BROKER_WIDGET_KEYS),
        ...Object.values(RM_WIDGET_KEYS),
        ...Object.values(LOSS_WIDGET_KEYS),
      ];

      expect(emitted).toHaveLength(31);
      // Named, not counted: a failure says WHICH chevron 404s.
      expect(emitted.filter((key) => !registry.has(key))).toEqual([]);
      expect(registry.has(LEADS_FILTERED)).toBe(true);
    });

    it('resolves every registered dashboard key over HTTP rather than 404ing', async () => {
      for (const key of Object.keys(DASHBOARD_SCOPES_BY_KEY)) {
        const response = await call(`${DRILL}?widget=${key}`, {
          token: broad.accessToken,
          tenantId: tenantA,
        });
        expect([key, response.status]).toEqual([key, 200]);
      }
    });

    it('returns exactly the documented population for every widget key', async () => {
      for (const key of Object.keys(DASHBOARD_SCOPES_BY_KEY)) {
        const expected = DOCUMENTED_POPULATION[key];
        expect([key, expected]).not.toEqual([key, undefined]);
        const actual = await drilledKeys(broad, `?widget=${key}&pageSize=100`);
        expect([key, actual]).toEqual([key, [...(expected as string[])].sort()]);
      }
    });

    it('counts under the scope predicate rather than post-filtering a page', async () => {
      for (const key of Object.keys(DASHBOARD_SCOPES_BY_KEY)) {
        const expected = DOCUMENTED_POPULATION[key] as string[];
        const result = await drill(broad, `?widget=${key}&pageSize=100`);
        expect([key, result.totalCount]).toEqual([key, expected.length]);
      }
    });

    it('reconciles EXACTLY for the lead-count widgets whose key is unshared', async () => {
      const payload = await pipelinePayload(true);
      const lostBar = payload.stageConversionFunnel.find((bar) => bar.isLost);
      expect(lostBar).toBeDefined();
      expect(EXACT_EQUALITY_KEYS).toContain(lostBar?.drillWidgetKey);

      const result = await drill(broad, `?widget=${lostBar?.drillWidgetKey ?? ''}&pageSize=100`);
      expect(result.totalCount).toBe(lostBar?.reachedCount);
      expect(result.totalCount).toBeGreaterThan(0);
    });

    /**
     * THE INVARIANT ITSELF, over every widget of all five payloads at once.
     *
     * It does not care what a widget means, only that a non-zero headline drills into something.
     * This is the assertion that would have caught the original defect: every one of these keys
     * 404'd, so every widget on every dashboard failed it.
     */
    it('never shows a non-zero number whose drill is empty, on any of the five dashboards', async () => {
      const keys = await nonZeroDrillKeys(true);
      expect(keys.length).toBeGreaterThan(10);

      for (const key of keys) {
        const result = await drill(broad, `?widget=${key}&pageSize=100`);
        expect([key, result.totalCount > 0]).toEqual([key, true]);
      }
    });

    /**
     * The superset direction, pinned on the three leads whose omission the REFERENCE's own scopes
     * would cause. Each is a lead the aggregate counts and the ported predicate would have dropped.
     */
    it('contains the leads the aggregate counted that the reference scope would have dropped', async () => {
      // `openPipelineOf` sums L5's open quote Q9; L5's own category is `lost`.
      expect(await drilledKeys(broad, '?widget=exec.open_pipeline&pageSize=100')).toContain('L5');
      // `won_premium` sums Q2, a won quote on L2, whose own category is `quoted`.
      expect(await drilledKeys(broad, '?widget=exec.won&pageSize=100')).toContain('L2');
      // `leads_at_risk` counts L4's unresolved alert; L4 is WON, not open.
      expect(await drilledKeys(broad, '?widget=exec.at_risk&pageSize=100')).toContain('L4');
    });

    it('excludes resolved alerts from the at-risk scope, exactly as the aggregate does', async () => {
      // L3 carries a RESOLVED alert and nothing else.
      expect(await drilledKeys(broad, '?widget=exec.at_risk&pageSize=100')).not.toContain('L3');
    });

    /**
     * The RM follow-up scope must admit an ON-TIME commitment, because `follow_up_compliance`
     * counts it in its denominator. Asserted by moving L1's commitment into the future for the
     * duration of the check — on the fixture's own dates both commitments are already overdue, so
     * without this the strictly-overdue predicate would be indistinguishable from the right one.
     */
    it('admits an on-time follow-up commitment to the RM scope but not the Broker one', async () => {
      const future = '2099-01-01';
      const original = '2026-04-05';
      await query('update leads set next_follow_up_date = $2 where tenant_id = $1 and id = $3', [
        tenantA,
        future,
        leadIdByKey.get('L1'),
      ]);
      try {
        // RM: compliance's denominator keeps the on-time commitment.
        expect(await drilledKeys(broad, '?widget=rm.overdue&pageSize=100')).toEqual(['L1', 'L2']);
        // Broker: its KPI counts strictly-overdue commitments, and so does its drill.
        expect(await drilledKeys(broad, '?widget=broker.overdue&pageSize=100')).toEqual(['L2']);
      } finally {
        await query('update leads set next_follow_up_date = $2 where tenant_id = $1 and id = $3', [
          tenantA,
          original,
          leadIdByKey.get('L1'),
        ]);
      }
    });

    // -----------------------------------------------------------------------------------------
    // The date rule, asserted in BOTH directions.
    // -----------------------------------------------------------------------------------------

    describe('the date filter reaches exactly the drills whose aggregate is date-scoped', () => {
      const MARCH = 'from=2026-03-01&to=2026-03-31';

      it('leaves Executive and Pipeline drills at full population', async () => {
        // L4 (2026-02-20) is outside March and MUST still be present: the Executive aggregate reads
        // the whole population, so a date-narrowed drill would be shorter than its own headline.
        expect(await drilledKeys(broad, `?widget=exec.leads&${MARCH}&pageSize=100`)).toEqual([
          'L1',
          'L2',
          'L3',
          'L4',
          'L5',
        ]);
        expect(await drilledKeys(broad, `?widget=pipeline.leads&${MARCH}&pageSize=100`)).toEqual([
          'L1',
          'L2',
          'L3',
          'L4',
          'L5',
        ]);
      });

      it('narrows Broker, RM and Loss drills, whose aggregates load through leadFilterWhere', async () => {
        // L4 has no broker, so the broker population never held it — narrow on a date that DOES
        // bite, proving the predicate is present rather than merely harmless here.
        expect(
          await drilledKeys(
            broad,
            '?widget=broker.leads&from=2026-03-10&to=2026-03-31&pageSize=100',
          ),
        ).toEqual(['L3', 'L5']);
        expect(await drilledKeys(broad, `?widget=rm.leads&${MARCH}&pageSize=100`)).toEqual([
          'L1',
          'L2',
          'L3',
          'L5',
        ]);
        expect(
          await drilledKeys(broad, '?widget=loss.count_by_reason&from=2026-03-25&pageSize=100'),
        ).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------------------------
    // BREADTH REACHES THE AGGREGATE, NOT ONLY THE DRILL.
    // -----------------------------------------------------------------------------------------

    describe('breadth narrows the aggregate as well as the drill', () => {
      /**
       * The discriminating corpus, established explicitly rather than assumed: `restricted` owns
       * L1/L2/L3 and `stranger` owns L4/L5, so a restricted view loses L4 and L5 — which between
       * them carry six quotes, the tenant's only won lead, its only lost lead and one of its two
       * unresolved alerts. Every case below is therefore NON-EMPTY and strictly smaller, never the
       * 0-vs-0 that would let a deleted breadth predicate survive.
       */
      it('shows the restricted caller a smaller, non-empty drill on every dashboard', async () => {
        const cases: [string, string[], number][] = [
          ['exec.leads', ['L1', 'L2', 'L3'], 5],
          ['exec.quotes', ['L1', 'L2'], 4],
          ['exec.open_pipeline', ['L1', 'L2', 'L3'], 4],
          ['exec.at_risk', ['L1'], 2],
          ['pipeline.won', ['L1', 'L2'], 3],
          ['broker.leads', ['L1', 'L2', 'L3'], 4],
          ['rm.quotes', ['L1', 'L2'], 4],
        ];

        for (const [key, expected, broadCount] of cases) {
          const keys = await drilledKeys(restricted, `?widget=${key}&pageSize=100`);
          expect([key, keys]).toEqual([key, expected]);
          expect([key, keys.length]).not.toEqual([key, 0]);
          expect([key, keys.length < broadCount]).toEqual([key, true]);
        }
      });

      it('narrows the Executive and Pipeline AGGREGATES, not only their drills', async () => {
        const broadOverview = await executivePayload(true);
        const narrowOverview = await executivePayload(false);

        // Total Leads over the fixture's March window: L1,L2,L3,L5 broad; L1,L2,L3 restricted.
        expect(kpiValue(broadOverview.kpis, 'total_leads')).toBe(4);
        expect(kpiValue(narrowOverview.kpis, 'total_leads')).toBe(3);

        // Total Quotes prepared in March: 8 broad, 6 restricted (L4's and L5's drop out).
        expect(kpiValue(broadOverview.kpis, 'total_quotes')).toBe(8);
        expect(kpiValue(narrowOverview.kpis, 'total_quotes')).toBe(6);

        const broadPipeline = await pipelinePayload(true);
        const narrowPipeline = await pipelinePayload(false);
        expect(kpiValue(broadPipeline.kpis, 'new_leads_this_month')).toBe(4);
        expect(kpiValue(narrowPipeline.kpis, 'new_leads_this_month')).toBe(3);
      });

      it('narrows the Broker, RM and Loss AGGREGATES, not only their drills', async () => {
        const broadBroker = await getBrokerPerformance({ db }, dashActor(true), MARCH_FILTER, NOW);
        const narrowBroker = await getBrokerPerformance({ db }, dashActor(false), MARCH_FILTER, NOW);
        // Quote volume across brokered leads: L1 (3) + L2 (3) + L5 (1) broad; L5 drops out.
        expect(kpiValue(broadBroker.kpis, 'broker_quotes')).toBe(7);
        expect(kpiValue(narrowBroker.kpis, 'broker_quotes')).toBe(6);

        const broadRm = await getRmPerformance({ db }, dashActor(true), MARCH_FILTER, NOW);
        const narrowRm = await getRmPerformance({ db }, dashActor(false), MARCH_FILTER, NOW);
        // Two RMs have activity tenant-wide; a restricted caller sees only their own book.
        expect(kpiValue(broadRm.kpis, 'active_rms')).toBe(2);
        expect(kpiValue(narrowRm.kpis, 'active_rms')).toBe(1);

        const broadLoss = await getLossAnalysis({ db }, dashActor(true), MARCH_FILTER, NOW);
        const narrowLoss = await getLossAnalysis({ db }, dashActor(false), MARCH_FILTER, NOW);
        expect(kpiValue(broadLoss.kpis, 'quotes_lost')).toBe(1);
        expect(kpiValue(narrowLoss.kpis, 'quotes_lost')).toBe(0);
      });

      it('keeps the restricted caller reconciled: every non-zero number still drills non-empty', async () => {
        const keys = await nonZeroDrillKeys(false);
        expect(keys.length).toBeGreaterThan(5);

        for (const key of keys) {
          const result = await drill(restricted, `?widget=${key}&pageSize=100`);
          expect([key, result.totalCount > 0]).toEqual([key, true]);
        }
      });
    });

    // -----------------------------------------------------------------------------------------
    // Tenant isolation and query budget, independently on the scoped drill path.
    // -----------------------------------------------------------------------------------------

    it('returns no tenant-B rows through any dashboard widget key', async () => {
      for (const key of Object.keys(DASHBOARD_SCOPES_BY_KEY)) {
        const result = await drill(broad, `?widget=${key}&pageSize=100`, tenantA);
        expect([key, result.items.map((item) => item.leadRef)]).not.toContain(
          `${RUN}-TENANT-B-MARKER`,
        );
      }
    });

    /**
     * A SET-BASED budget, counted in STATEMENTS rather than timed: a per-row lookup would scale
     * with the corpus, and a duration assertion could not see it on a five-lead fixture.
     */
    it('runs a fixed number of statements regardless of how many leads match', async () => {
      const counted = countingDb();
      try {
        const run = async (widget: string, pageSize = 100): Promise<number> => {
          counted.statements.length = 0;
          const rowQuery = defaultDrillWidgetRegistry().get(widget);
          expect(rowQuery).toBeDefined();
          await (rowQuery as NonNullable<typeof rowQuery>)({
            db: counted.db,
            tenantId: tenantA as TenantId,
            filter: dashboardFilterSchema.parse({}),
            caller: { callerUserId: appUserId(broad), callerHasViewAll: true },
            page: 1,
            pageSize,
            today: '2026-04-01',
          });
          return counted.statements.length;
        };

        // MEASURED: three. `listLeads` runs the count, the page, and ONE set-based accountable-owner
        // read over the whole page's ids. Every scope predicate is a correlated subquery inside the
        // first two, never a follow-up read per lead.
        expect(await run('exec.leads')).toBe(3);
        expect(await run('rm.won')).toBe(3);
        expect(await run('loss.price_gap')).toBe(3);
        // The one scope that needs the tenant high-value threshold pays for exactly one more.
        expect(await run('exec.high_value')).toBe(4);

        // The budget is FIXED, not proportional: five matching rows cost what one does.
        expect(await run('exec.leads', 1)).toBe(3);
      } finally {
        await counted.destroy();
      }
    });
  });

});
