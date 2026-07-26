/**
 * The Broker Performance dashboard endpoint (T-037; AC-022, AC-074, AC-075, AC-078, AC-079;
 * V-027, V-092, V-093, V-094, V-098, V-099, V-100).
 *
 *   GET /api/v1/dashboards/broker-performance    dashboards.view_broker_performance
 *
 * EVERY ASSERTION BELOW IS AN EXACT VALUE, HAND-COMPUTED FROM THE SHARED FIXTURE
 * =============================================================================
 * A dashboard that returns plausible-but-wrong numbers is the failure mode this domain has, and
 * `expect(rows).toHaveLength(2)` cannot see it. The expectations here are derived in the comment
 * blocks beside them from the corpus in `helpers/dashboard-corpus.ts`, independently of the
 * implementation — so if the service and the arithmetic disagree, this suite says which.
 *
 * WHAT THE REFERENCE COUNTS, MEASURED AND PRESERVED (see broker.service.ts for the full list):
 *  - only leads that CARRY A BROKER are in scope at all (`lead.BrokerId != null`);
 *  - a broker's quotes are every quote of its leads, with NO quote-date predicate — the date window
 *    filters `leads.date_received` only;
 *  - the table lists EVERY broker including zero-volume ones; the matrix and the ranking plot only
 *    brokers with quote volume.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  brokerPerformanceRoutes,
  type BrokerPerformanceDto,
} from '../../domains/dashboards/index.js';
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
import {
  B1_BRANCH,
  B1_CONTACT,
  B2_BRANCH,
  CURRENCY_CODE,
  PRICE_REASON_NAME,
  TIER1_NAME,
  TIER2_NAME,
  seedDashboardCorpus,
  type CorpusIds,
} from './helpers/dashboard-corpus.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('dashboard-broker', probe);

const ENDPOINT = '/api/v1/dashboards/broker-performance';

/** Short run token — a long one dominates trigram similarity in the duplicate checks. */
const RUN = `t37b-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds the broker-performance permission in both tenants. */
  let viewer: TestUserSession;
  /** Holds `leads.view` but NOT `dashboards.view_broker_performance`. */
  let outsider: TestUserSession;
  let alice: TestUserSession;
  let bob: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  const createdTenants: number[] = [];
  let ids: CorpusIds;
  /** Tenant B's ids, used only as FOREIGN filter values a stale filter bar could still submit. */
  let idsB: CorpusIds;

  const OWNED_TABLES = [
    'quote_versions',
    'quotes',
    'lead_notes',
    'lead_assignments',
    'leads',
    'reference_sequences',
    'business_assignments',
    'broker_contacts',
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
      "select id::text as id from tenants where name like 't37b-%'",
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
        api.route('/', brokerPerformanceRoutes({ db }));
      },
    });
  }

  async function call(
    queryString = '',
    options: { session?: TestUserSession; tenantId?: number } = {},
  ): Promise<Response> {
    const session = options.session ?? viewer;
    const headers = new Headers();
    headers.set('authorization', `Bearer ${session.accessToken}`);
    headers.set('x-tenant-id', String(options.tenantId ?? tenantA));
    return await harness().request(`http://localhost${ENDPOINT}${queryString}`, {
      method: 'GET',
      headers,
    });
  }

  async function payload(queryString = ''): Promise<BrokerPerformanceDto> {
    const response = await call(queryString);
    expect(response.status).toBe(200);
    return (await response.json()) as BrokerPerformanceDto;
  }

  const kpi = (dto: BrokerPerformanceDto, key: string): number | null => {
    const card = dto.kpis.find((entry) => entry.key === key);
    if (card === undefined) throw new Error(`no KPI card '${key}' in payload`);
    return card.value;
  };

  const row = (dto: BrokerPerformanceDto, brokerId: number) => {
    const found = dto.table.find((entry) => entry.brokerId === brokerId);
    if (found === undefined) throw new Error(`broker ${String(brokerId)} missing from table`);
    return found;
  };

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

    viewer = await auth.createTestUserWithSession({
      label: 'brk-viewer',
      firstName: 'Vee',
      lastName: 'Watcher',
    });
    outsider = await auth.createTestUserWithSession({
      label: 'brk-outsider',
      firstName: 'Otto',
      lastName: 'Sider',
    });
    alice = await auth.createTestUserWithSession({
      label: 'brk-alice',
      firstName: 'Alice',
      lastName: 'Anders',
    });
    bob = await auth.createTestUserWithSession({
      label: 'brk-bob',
      firstName: 'Bob',
      lastName: 'Brown',
    });

    for (const session of [viewer, outsider, alice, bob]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(viewer), tenantB);

    for (const tenantId of [tenantA, tenantB]) {
      await fixtures.grantDirectPermission(
        appUserId(viewer),
        'dashboards.view_broker_performance',
        tenantId,
      );
    }
    // T-050: breadth narrows the AGGREGATE as well as the drill, so a caller asserting tenant-wide
    // dashboard numbers must hold `leads.view_all`. The restricted case has its own coverage.
    for (const tenantId of [tenantA, tenantB]) {
      await fixtures.grantDirectPermission(appUserId(viewer), 'leads.view_all', tenantId);
    }
    // The negative case: a real member with a lead permission but not THIS dashboard's.
    await fixtures.grantDirectPermission(appUserId(outsider), 'leads.view', tenantA);

    const rmRoleA = await fixtures.createRole({ tenantId: tenantA });
    const uwRoleA = await fixtures.createRole({ tenantId: tenantA });
    ids = await seedDashboardCorpus({
      query,
      tenantId: tenantA,
      run: RUN,
      rmRoleId: rmRoleA,
      underwriterRoleId: uwRoleA,
      aliceUserId: appUserId(alice),
      bobUserId: appUserId(bob),
    });

    // Tenant B carries a corpus that would be UNMISTAKABLE if it leaked: one broker whose single
    // won quote is worth more than tenant A's entire book.
    const rmRoleB = await fixtures.createRole({ tenantId: tenantB });
    const uwRoleB = await fixtures.createRole({ tenantId: tenantB });
    idsB = await seedDashboardCorpus({
      query,
      tenantId: tenantB,
      run: `${RUN}-B`,
      rmRoleId: rmRoleB,
      underwriterRoleId: uwRoleB,
      aliceUserId: appUserId(viewer),
      bobUserId: appUserId(viewer),
    });
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
    await db?.destroy();
  });

  // -------------------------------------------------------------------------------------------
  // Authorization and tenant scope.
  // -------------------------------------------------------------------------------------------

  describe('authorization', () => {
    it('answers 403 for a tenant member without dashboards.view_broker_performance', async () => {
      const response = await call('', { session: outsider });
      expect(response.status).toBe(403);
    });

    it('answers 200 for a caller holding the dashboard permission', async () => {
      const response = await call();
      expect(response.status).toBe(200);
    });

    it('answers 400 for a malformed filter rather than silently ignoring it', async () => {
      const response = await call('?productLineId=abc');
      expect(response.status).toBe(400);
    });
  });

  describe('tenant isolation (AC-022)', () => {
    it('returns only tenant A brokers, with none of tenant B in the table', async () => {
      const dto = await payload();
      const brokerIds = dto.table.map((entry) => entry.brokerId).sort((a, b) => a - b);
      expect(brokerIds).toEqual([ids.brokerB1, ids.brokerB2].sort((a, b) => a - b));
    });

    it('aggregates tenant B independently — the same query on tenant B never sums tenant A', async () => {
      const response = await call('', { tenantId: tenantB });
      expect(response.status).toBe(200);
      const dto = (await response.json()) as BrokerPerformanceDto;

      // Tenant B was seeded with the SAME corpus shape, so the aggregate must equal tenant A's
      // exactly — not double it, which is what a missing tenant predicate would produce.
      expect(kpi(dto, 'broker_quotes')).toBe(8);
      expect(kpi(dto, 'won_via_brokers')).toBe(7400);
      expect(dto.table.map((entry) => entry.brokerId)).not.toContain(ids.brokerB1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // KPI parity (AC-074, AC-078).
  // -------------------------------------------------------------------------------------------

  describe('KPI cards', () => {
    it('carries the tenant display currency (NFR-08/A-3)', async () => {
      expect((await payload()).currencyCode).toBe(CURRENCY_CODE);
    });

    it('reports 2 active brokers — both have period activity', async () => {
      expect(kpi(await payload(), 'active_brokers')).toBe(2);
    });

    it('counts 8 broker QUOTES: B1 has Q1/Q6/Q7, B2 has Q2/Q4/Q8/Q3/Q5', async () => {
      expect(kpi(await payload(), 'broker_quotes')).toBe(8);
    });

    it('computes broker conversion as won/decided QUOTES = 2/3 (Q2+Q5 won, Q3 lost)', async () => {
      expect(kpi(await payload(), 'broker_conversion')).toBe(2 / 3);
    });

    it('sums Won via Brokers as BOUND premium 2400 + 5000 = 7400', async () => {
      expect(kpi(await payload(), 'won_via_brokers')).toBe(7400);
    });

    it('averages turnaround over every sent broker quote: (3+18+4+16+6)/5 = 9.4', async () => {
      expect(kpi(await payload(), 'avg_turnaround')).toBe(9.4);
    });

    it('counts 2 overdue follow-ups: L1 (open) and L2 (quoted), both past their commitment', async () => {
      expect(kpi(await payload(), 'overdue_follow_ups')).toBe(2);
    });

    it('does NOT count a LOST lead as an overdue follow-up, even with a long-past commitment', async () => {
      // Proven, not assumed: X1 is lost AND carries a follow-up date in the past. Chasing a lead
      // we already lost is not outstanding work, so the count must stay 2 (L1 and L2) rather than
      // rising to 3 — which is exactly what dropping the open-category condition would produce.
      const rows = await query<{ reporting_category: string; next_follow_up_date: string }>(
        `select s.reporting_category, l.next_follow_up_date::text as next_follow_up_date
           from leads l
           join reference_items s on s.tenant_id = l.tenant_id and s.id = l.status_id
          where l.tenant_id = $1 and l.id = $2`,
        [tenantA, ids.leadIdByKey.get('X1')],
      );
      expect(rows[0]?.reporting_category).toBe('lost');
      expect(rows[0]?.next_follow_up_date).toBe('2026-03-18');

      expect(kpi(await payload(), 'overdue_follow_ups')).toBe(2);
      expect(row(await payload(), ids.brokerB1).overdueFollowUps).toBe(1);
    });

    it('labels each card with its lead-vs-quote basis and drill widget key (FR-54)', async () => {
      const dto = await payload();
      const conversion = dto.kpis.find((entry) => entry.key === 'broker_conversion');
      expect(conversion?.label).toBe('Broker Conversion');
      expect(conversion?.leadOrQuote).toBe('quote');
      expect(conversion?.kind).toBe('percent');
      expect(conversion?.drillWidgetKey).toBe('broker.won');

      const overdue = dto.kpis.find((entry) => entry.key === 'overdue_follow_ups');
      expect(overdue?.leadOrQuote).toBe('lead');
      expect(overdue?.goodDirection).toBe('lowerIsBetter');
      expect(overdue?.drillWidgetKey).toBe('broker.overdue');
    });

    it('carries null deltas — no prior-period baseline is derived for this dashboard', async () => {
      const dto = await payload();
      expect(dto.kpis.every((entry) => entry.delta === null)).toBe(true);
      expect(dto.kpis.every((entry) => entry.isFavorableDelta === null)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Rankings, matrix and table (AC-078).
  // -------------------------------------------------------------------------------------------

  describe('Top Brokers ranking', () => {
    it('ranks by quote volume descending and omits zero-volume brokers', async () => {
      const dto = await payload();
      expect(dto.topBrokers.map((entry) => [entry.brokerId, entry.quoteVolume])).toEqual([
        [ids.brokerB2, 5],
        [ids.brokerB1, 3],
      ]);
    });

    it('carries each broker s own conversion, null where nothing has been decided', async () => {
      const dto = await payload();
      expect(dto.topBrokers[0]?.conversionRate).toBe(2 / 3);
      expect(dto.topBrokers[1]?.conversionRate).toBeNull();
    });
  });

  describe('performance matrix', () => {
    it('splits the axes on the median of the plotted brokers: volume 4, conversion 2/3', async () => {
      const dto = await payload();
      expect(dto.matrix.volumeSplit).toBe(4);
      expect(dto.matrix.conversionSplit).toBe(2 / 3);
    });

    it('classifies B2 high-high (on both splits) and B1 low-low (undecided conversion is low)', async () => {
      const dto = await payload();
      const points = new Map(dto.matrix.points.map((point) => [point.brokerId, point]));
      expect(points.get(ids.brokerB2)?.quadrant).toBe('high-high');
      expect(points.get(ids.brokerB1)?.quadrant).toBe('low-low');
    });

    it('sizes each bubble by won premium', async () => {
      const dto = await payload();
      const points = new Map(dto.matrix.points.map((point) => [point.brokerId, point]));
      expect(points.get(ids.brokerB2)?.wonPremium).toBe(7400);
      expect(points.get(ids.brokerB1)?.wonPremium).toBe(0);
    });
  });

  describe('broker table', () => {
    it('ranks every partner by volume descending', async () => {
      const dto = await payload();
      expect(dto.table.map((entry) => entry.brokerId)).toEqual([ids.brokerB2, ids.brokerB1]);
    });

    it('carries B1 metadata: tier, branch and PRIMARY contact (never the secondary)', async () => {
      const b1 = row(await payload(), ids.brokerB1);
      expect(b1.tierName).toBe(TIER1_NAME);
      expect(b1.branch).toBe(B1_BRANCH);
      expect(b1.primaryContactName).toBe(B1_CONTACT);
    });

    it('leaves primaryContactName null for a broker with no contacts', async () => {
      const b2 = row(await payload(), ids.brokerB2);
      expect(b2.tierName).toBe(TIER2_NAME);
      expect(b2.branch).toBe(B2_BRANCH);
      expect(b2.primaryContactName).toBeNull();
    });

    it('computes B1 metrics: 3 quotes, null conversion, 0 won, 10.5 day TAT, 1 overdue', async () => {
      const b1 = row(await payload(), ids.brokerB1);
      expect(b1.quoteVolume).toBe(3);
      expect(b1.conversionRate).toBeNull();
      expect(b1.wonPremium).toBe(0);
      // Q1: 2026-03-02 -> 2026-03-05 = 3; Q6: -> 2026-03-20 = 18; Q7 unsent. (3+18)/2.
      expect(b1.avgTurnaroundDays).toBe(10.5);
      expect(b1.overdueFollowUps).toBe(1);
    });

    it('computes B2 metrics: 5 quotes, 2/3 conversion, 7400 won, 26/3 day TAT, 1 overdue', async () => {
      const b2 = row(await payload(), ids.brokerB2);
      expect(b2.quoteVolume).toBe(5);
      expect(b2.conversionRate).toBe(2 / 3);
      expect(b2.wonPremium).toBe(7400);
      // Q2 4 days, Q3 16 days, Q5 6 days.
      expect(b2.avgTurnaroundDays).toBe(26 / 3);
      expect(b2.overdueFollowUps).toBe(1);
    });

    it('reports the modal lost reason of the broker s own lost leads, and null when it has none', async () => {
      const dto = await payload();
      expect(row(dto, ids.brokerB1).topLossReason).toBe(PRICE_REASON_NAME);
      expect(row(dto, ids.brokerB2).topLossReason).toBeNull();
    });

    it('drills each row to the broker leads widget', async () => {
      expect(row(await payload(), ids.brokerB1).drillWidgetKey).toBe('broker.leads');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Filters (AC-075) — applied in the query, asserted by exact value.
  // -------------------------------------------------------------------------------------------

  describe('shared filters', () => {
    it('narrows the whole payload to one broker when brokerId is set', async () => {
      const dto = await payload(`?brokerId=${String(ids.brokerB1)}`);
      expect(dto.table.map((entry) => entry.brokerId)).toEqual([ids.brokerB1]);
      expect(kpi(dto, 'broker_quotes')).toBe(3);
      expect(kpi(dto, 'won_via_brokers')).toBe(0);
      expect(kpi(dto, 'active_brokers')).toBe(1);
    });

    it('narrows by product line: P2 leaves only L3/X1 (B1, no quotes) and L4 (B2, Q3+Q5)', async () => {
      const dto = await payload(`?productLineId=${String(ids.productP2)}`);
      expect(kpi(dto, 'broker_quotes')).toBe(2);
      // Q5 won, Q3 lost.
      expect(kpi(dto, 'broker_conversion')).toBe(0.5);
      expect(kpi(dto, 'won_via_brokers')).toBe(5000);
      expect(row(dto, ids.brokerB1).quoteVolume).toBe(0);
      expect(row(dto, ids.brokerB2).quoteVolume).toBe(2);
    });

    it('narrows by region: R2 leaves only L2 and L4, both on B2', async () => {
      const dto = await payload(`?regionId=${String(ids.regionR2)}`);
      expect(row(dto, ids.brokerB1).quoteVolume).toBe(0);
      expect(row(dto, ids.brokerB2).quoteVolume).toBe(5);
      expect(kpi(dto, 'overdue_follow_ups')).toBe(1);
    });

    it('narrows by received-date window, on the LEAD date and not the quote date', async () => {
      // L1 (03-02), L2 (03-05) and L3 (03-11) only; L4 is 2026-02-20 and X1 is 03-10.
      const dto = await payload('?from=2026-03-01&to=2026-03-09');
      // B1 keeps L1 (Q1,Q6,Q7); B2 keeps L2 (Q2,Q4,Q8). L4's Q5, prepared in February, is gone
      // with its LEAD, not on its own date.
      expect(row(dto, ids.brokerB1).quoteVolume).toBe(3);
      expect(row(dto, ids.brokerB2).quoteVolume).toBe(3);
      expect(kpi(dto, 'won_via_brokers')).toBe(2400);
    });

    it('combines two dimensions conjunctively rather than widening', async () => {
      const dto = await payload(
        `?productLineId=${String(ids.productP2)}&regionId=${String(ids.regionR1)}`,
      );
      // P2 AND R1 = L3 and X1, both B1, neither with a quote.
      expect(kpi(dto, 'broker_quotes')).toBe(0);
      expect(kpi(dto, 'won_via_brokers')).toBe(0);
      expect(row(dto, ids.brokerB1).topLossReason).toBe(PRICE_REASON_NAME);
    });

    it('returns an empty-but-valid payload when a filter matches nothing', async () => {
      const dto = await payload('?from=2020-01-01&to=2020-12-31');
      expect(kpi(dto, 'broker_quotes')).toBe(0);
      expect(kpi(dto, 'active_brokers')).toBe(0);
      expect(kpi(dto, 'broker_conversion')).toBeNull();
      expect(kpi(dto, 'avg_turnaround')).toBeNull();
      expect(dto.topBrokers).toEqual([]);
      expect(dto.matrix.points).toEqual([]);
      // The table is a partner ROSTER, so both brokers still appear at zero volume.
      expect(dto.table).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Deliberate filter ERASURES (AC-075 / V-093 second clause; F-037-1).
  // -------------------------------------------------------------------------------------------

  /**
   * WHY THESE TESTS EXIST AND WHAT THEY ARE NOT.
   *
   * `brokerScopedFilter()` in broker.service.ts strips `brokerTypeId`, `rmUserId` and `teamOrRmId`
   * out of the filter before it reaches the query, because the reference's BrokerPerformanceStore
   * applies none of the three. All eight parameters are still BOUND, because the SPA's filter bar is
   * shared across five dashboards and a selection left over from the RM screen must not 400.
   *
   * An erasure that is only READ as deliberate is indistinguishable from one that was forgotten, so
   * each of the three is asserted here as BOTH accepted (no 400) AND inert (byte-identical payload).
   * Deleting a line from `brokerScopedFilter` would make one of these tests fail immediately.
   *
   * EACH TEST FIRST PROVES ITS FILTER VALUE IS DISCRIMINATING.
   * `toEqual(unfiltered)` passes vacuously if the chosen id happens to match every in-scope lead (or
   * none, on a dashboard whose table is a roster that survives an empty population). So each test
   * queries the corpus directly and pins that the value selects a PROPER, NON-EMPTY subset of the
   * broker-carrying leads — i.e. that the number would MOVE if the dimension were applied.
   */
  describe('deliberate filter erasures — accepted and inert (V-093)', () => {
    it('accepts brokerTypeId and leaves the payload unchanged, on this dashboard that ignores it', async () => {
      const [split] = await query<{ matching: string; total: string }>(
        `select count(*) filter (where b.broker_type_id = $2)::text as matching,
                count(*)::text as total
           from leads l
           join brokers b on b.tenant_id = l.tenant_id and b.id = l.broker_id
          where l.tenant_id = $1`,
        [tenantA, ids.brokerTypeT1],
      );
      // B1 (Tier 1) carries L1/L3/X1; B2 (Tier 2) carries L2/L4. A proper non-empty subset: were
      // the dimension applied, B2 would vanish from the aggregate entirely.
      expect(split).toEqual({ matching: '3', total: '5' });

      expect(await payload(`?brokerTypeId=${String(ids.brokerTypeT1)}`)).toEqual(await payload());
    });

    it('accepts rmUserId and leaves the payload unchanged, on this dashboard that ignores it', async () => {
      const [split] = await query<{ matching: string; total: string }>(
        `select count(distinct l.id) filter (where a.user_id = $2)::text as matching,
                count(distinct l.id)::text as total
           from leads l
           left join lead_assignments a on a.tenant_id = l.tenant_id and a.lead_id = l.id
          where l.tenant_id = $1 and l.broker_id is not null`,
        [tenantA, appUserId(bob)],
      );
      // Bob is assigned to L3 and L4 among the five broker-carrying leads. Were the dimension
      // applied, B1's quote volume would fall from 3 to 0 and B2's from 5 to 2.
      expect(split).toEqual({ matching: '2', total: '5' });

      expect(await payload(`?rmUserId=${String(appUserId(bob))}`)).toEqual(await payload());
    });

    it('accepts teamOrRmId and leaves the payload unchanged, on this dashboard that ignores it', async () => {
      // BOB, NOT ALICE, AND THE REASON IS THE WHOLE POINT OF THIS TEST.
      //
      // The shared RM predicate matches ANY assignment, not just the `rm` slot. Alice is the `rm`
      // on L1/L2/X1 and the UNDERWRITER on L4, so filtering by Alice would drop only L3 — a lead
      // with no quotes, no loss and no overdue follow-up, whose removal moves NOTHING in this
      // payload. `toEqual(unfiltered)` would then pass whether or not the erasure existed.
      // Measured, not assumed: deleting `teamOrRmId: undefined` from `brokerScopedFilter` left an
      // Alice-valued version of this test GREEN. Bob's set does move the numbers.
      const [split] = await query<{ rm_slot: string; any_slot: string; total: string }>(
        `select count(distinct l.id) filter (where a.user_id = $2 and ba.slot = 'rm')::text as rm_slot,
                count(distinct l.id) filter (where a.user_id = $2)::text as any_slot,
                count(distinct l.id)::text as total
           from leads l
           left join lead_assignments a on a.tenant_id = l.tenant_id and a.lead_id = l.id
           left join business_assignments ba
                  on ba.tenant_id = a.tenant_id and ba.id = a.business_assignment_id
          where l.tenant_id = $1 and l.broker_id is not null`,
        [tenantA, appUserId(bob)],
      );
      // Bob holds L3 and L4 and underwrites nothing, so both definitions of ownership agree on a
      // proper, non-empty subset: were the dimension applied, B1 would fall to 0 quotes and B2 to 2.
      expect(split).toEqual({ rm_slot: '2', any_slot: '2', total: '5' });

      expect(await payload(`?teamOrRmId=${String(appUserId(bob))}`)).toEqual(await payload());
    });

    it('does not 400 on a stale FOREIGN value of an erased dimension, and still returns tenant A unchanged', async () => {
      // The exact shape a shared filter bar produces after a tenant switch: an id that exists, but
      // in another tenant. It must neither error nor reach across the tenant boundary.
      const unfiltered = await payload();
      const params = new URLSearchParams({
        brokerTypeId: String(idsB.brokerTypeT1),
        rmUserId: String(appUserId(viewer)),
        teamOrRmId: String(appUserId(viewer)),
      });
      expect(await payload(`?${params.toString()}`)).toEqual(unfiltered);
    });
  });

  describe('query budget (AC-079, N-04)', () => {
    /**
     * COUNTS STATEMENTS, NOT MILLISECONDS.
     *
     * "Responds in under 2 s" passes on a small corpus even when the implementation issues one
     * query per broker, so it cannot see the N+1 that AC-079 actually forbids. Counting the
     * statements Kysely executes CAN: the corpus has 2 brokers, 7 leads and 9 quotes, so any
     * per-row pattern blows a fixed budget immediately, whatever the machine's speed.
     */
    it('issues a small fixed set of set-based reads, not one per broker or lead', async () => {
      let statements = 0;
      // Its OWN pool: `destroy()` ends the pool it wraps, and the suite's `db` must survive this.
      const countingDb = new Kysely<Database>({
        dialect: new PostgresDialect({ pool: new pg.Pool(poolerPoolConfig(stack.dbUrl)) }),
        log: (event) => {
          if (event.level === 'query') statements += 1;
        },
      });

      try {
        const app = buildApp({
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
            api.route('/', brokerPerformanceRoutes({ db: countingDb }));
          },
        });

        const headers = new Headers();
        headers.set('authorization', `Bearer ${viewer.accessToken}`);
        headers.set('x-tenant-id', String(tenantA));
        const response = await app.request(`http://localhost${ENDPOINT}`, { method: 'GET', headers });
        expect(response.status).toBe(200);
      } finally {
        await countingDb.destroy();
      }

      expect(statements).toBeGreaterThan(0);
      expect(statements).toBeLessThanOrEqual(8);
    });
  });
});
