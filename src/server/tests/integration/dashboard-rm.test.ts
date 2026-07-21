/**
 * The RM Performance dashboard endpoint (T-037; AC-022, AC-074, AC-075, AC-078, AC-079;
 * V-027, V-092, V-093, V-094, V-098, V-099, V-100).
 *
 *   GET /api/v1/dashboards/rm-performance    dashboards.view_rm_performance
 *
 * THE SLA QUESTION, MEASURED AND SETTLED HERE
 * ===========================================
 * T-035 derived an SLA grading with three states (`on_track` / `breached` / `unknown`) and recorded
 * `unknown` as an addition that reached no wire. This dashboard is where it would have surfaced —
 * and the reference's wire has NO SLA STATUS AT ALL. `TurnaroundRmRowDto` (:69-74) carries
 * `AvgTurnaroundDays: double?` plus `BeyondTarget: bool`, computed as
 * `AvgTurnaroundDays is not null && AvgTurnaroundDays.Value > slaTarget`
 * (GetRmPerformanceQueryHandler.cs:291). So an RM with no sent quote renders as
 * `avgTurnaroundDays: null, beyondTarget: false` — the UI shows an em dash and no breach marker,
 * NOT a third state. The tests below pin exactly that, and the tri-state `slaStatus()` helper stays
 * an internal metric with no wire consumer. See rm.service.ts for the full note.
 *
 * Every assertion is an exact hand-computed value over the corpus in `helpers/dashboard-corpus.ts`.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rmPerformanceRoutes, type RmPerformanceDto } from '../../domains/dashboards/index.js';
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
  CURRENCY_CODE,
  SLA_TARGET_DAYS,
  seedDashboardCorpus,
  type CorpusIds,
} from './helpers/dashboard-corpus.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('dashboard-rm', probe);

const ENDPOINT = '/api/v1/dashboards/rm-performance';
const RUN = `t37r-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

const ALICE_NAME = 'Alice Anders';
const BOB_NAME = 'Bob Brown';

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  let viewer: TestUserSession;
  let outsider: TestUserSession;
  let alice: TestUserSession;
  let bob: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  const createdTenants: number[] = [];
  let ids: CorpusIds;

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
      "select id::text as id from tenants where name like 't37r-%'",
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
        api.route('/', rmPerformanceRoutes({ db }));
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

  async function payload(queryString = ''): Promise<RmPerformanceDto> {
    const response = await call(queryString);
    expect(response.status).toBe(200);
    return (await response.json()) as RmPerformanceDto;
  }

  const kpi = (dto: RmPerformanceDto, key: string): number | null => {
    const card = dto.kpis.find((entry) => entry.key === key);
    if (card === undefined) throw new Error(`no KPI card '${key}' in payload`);
    return card.value;
  };

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

    viewer = await auth.createTestUserWithSession({
      label: 'rm-viewer',
      firstName: 'Vee',
      lastName: 'Watcher',
    });
    outsider = await auth.createTestUserWithSession({
      label: 'rm-outsider',
      firstName: 'Otto',
      lastName: 'Sider',
    });
    alice = await auth.createTestUserWithSession({
      label: 'rm-alice',
      firstName: 'Alice',
      lastName: 'Anders',
    });
    bob = await auth.createTestUserWithSession({
      label: 'rm-bob',
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
        'dashboards.view_rm_performance',
        tenantId,
      );
    }
    // T-050: breadth narrows the AGGREGATE as well as the drill, so a caller asserting tenant-wide
    // dashboard numbers must hold `leads.view_all`. The restricted case has its own coverage.
    for (const tenantId of [tenantA, tenantB]) {
      await fixtures.grantDirectPermission(appUserId(viewer), 'leads.view_all', tenantId);
    }
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

    const rmRoleB = await fixtures.createRole({ tenantId: tenantB });
    const uwRoleB = await fixtures.createRole({ tenantId: tenantB });
    await seedDashboardCorpus({
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

    // Deletion BEFORE `auth.cleanup()`: that call ends the pool these deletes run on.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  });

  describe('authorization', () => {
    it('answers 403 for a tenant member without dashboards.view_rm_performance', async () => {
      expect((await call('', { session: outsider })).status).toBe(403);
    });

    it('answers 200 for a caller holding the dashboard permission', async () => {
      expect((await call()).status).toBe(200);
    });
  });

  describe('tenant isolation (AC-022)', () => {
    it('names only tenant A RMs', async () => {
      const dto = await payload();
      expect(dto.topRms.map((entry) => entry.rmName).sort()).toEqual([ALICE_NAME, BOB_NAME]);
    });

    it('aggregates tenant B on its own data, matching its own identical corpus', async () => {
      const response = await call('', { tenantId: tenantB });
      expect(response.status).toBe(200);
      const dto = (await response.json()) as RmPerformanceDto;
      // Tenant B assigns BOTH slots to one user, so it has one RM — a tenant-A leak would show up
      // as extra RMs and a doubled premium.
      expect(dto.topRms).toHaveLength(1);
      expect(kpi(dto, 'won_premium_ytd')).toBe(7400);
    });
  });

  describe('KPI cards', () => {
    it('carries the tenant display currency', async () => {
      expect((await payload()).currencyCode).toBe(CURRENCY_CODE);
    });

    it('reports 2 active RMs and 2 active brokers', async () => {
      const dto = await payload();
      expect(kpi(dto, 'active_rms')).toBe(2);
      expect(kpi(dto, 'active_brokers')).toBe(2);
    });

    it('sums Won Premium over BOUND premium of won quotes: 2400 + 5000 = 7400', async () => {
      expect(kpi(await payload(), 'won_premium_ytd')).toBe(7400);
    });

    it('computes RM conversion as won/decided QUOTES = 2/3', async () => {
      expect(kpi(await payload(), 'rm_conversion_rate')).toBe(2 / 3);
    });

    it('computes broker conversion over the per-broker rollup = 2/3', async () => {
      expect(kpi(await payload(), 'broker_conversion_rate')).toBe(2 / 3);
    });

    it('computes follow-up compliance as on-time/required open commitments = 0/2', async () => {
      // L1 (2026-04-05) and L2 (2026-03-28) are the two open leads carrying a commitment; both
      // dates are in the past, so neither is on time.
      expect(kpi(await payload(), 'follow_up_compliance')).toBe(0);
    });

    it('labels the lead-vs-quote basis honestly per card (FR-54)', async () => {
      const dto = await payload();
      expect(dto.kpis.find((entry) => entry.key === 'won_premium_ytd')?.leadOrQuote).toBe('quote');
      expect(dto.kpis.find((entry) => entry.key === 'follow_up_compliance')?.leadOrQuote).toBe('lead');
      expect(dto.kpis.find((entry) => entry.key === 'active_rms')?.drillWidgetKey).toBe('rm.leads');
    });
  });

  describe('Top RMs and Top Brokers', () => {
    it('ranks RMs by won premium descending: Bob 5000 then Alice 2400', async () => {
      const dto = await payload();
      expect(dto.topRms.map((entry) => [entry.rmName, entry.wonPremium])).toEqual([
        [BOB_NAME, 5000],
        [ALICE_NAME, 2400],
      ]);
    });

    it('carries each RM quote volume and conversion: Alice 6 quotes at 1/1, Bob 3 at 1/2', async () => {
      const dto = await payload();
      const byName = new Map(dto.topRms.map((entry) => [entry.rmName, entry]));
      expect(byName.get(ALICE_NAME)?.quoteVolume).toBe(6);
      expect(byName.get(ALICE_NAME)?.conversionRate).toBe(1);
      expect(byName.get(BOB_NAME)?.quoteVolume).toBe(3);
      expect(byName.get(BOB_NAME)?.conversionRate).toBe(0.5);
    });

    it('ranks brokers by won premium descending', async () => {
      const dto = await payload();
      expect(dto.topBrokers.map((entry) => [entry.brokerId, entry.wonPremium])).toEqual([
        [ids.brokerB2, 7400],
        [ids.brokerB1, 0],
      ]);
    });
  });

  describe('broker matrix (shared with the Broker dashboard)', () => {
    it('splits on the same medians and classifies the same quadrants', async () => {
      const dto = await payload();
      expect(dto.brokerMatrix.volumeSplit).toBe(4);
      expect(dto.brokerMatrix.conversionSplit).toBe(2 / 3);
      const points = new Map(dto.brokerMatrix.points.map((point) => [point.brokerId, point]));
      expect(points.get(ids.brokerB2)?.quadrant).toBe('high-high');
      expect(points.get(ids.brokerB1)?.quadrant).toBe('low-low');
    });
  });

  describe('turnaround by RM and the SLA target', () => {
    it('publishes the tenant SLA target as the dashed marker value', async () => {
      expect((await payload()).turnaroundByRm.slaTargetDays).toBe(SLA_TARGET_DAYS);
    });

    it('orders RMs slowest first: Bob 11 days, then Alice 25/3', async () => {
      const rows = (await payload()).turnaroundByRm.rows;
      expect(rows.map((entry) => [entry.rmName, entry.avgTurnaroundDays])).toEqual([
        [BOB_NAME, 11],
        [ALICE_NAME, 25 / 3],
      ]);
    });

    it('flags beyondTarget for turnaround STRICTLY greater than the target', async () => {
      const rows = (await payload()).turnaroundByRm.rows;
      expect(rows.every((entry) => entry.beyondTarget)).toBe(true);
    });

    it('renders an RM with no sent quote as null turnaround and beyondTarget FALSE, not a third state', async () => {
      // Narrowing to product P2 leaves Alice owning only X1 (lost, no quotes at all) and Bob
      // owning L3 (no quotes) and L4 (Q3, Q5 — both sent). So Alice has no turnaround to grade.
      const rows = (await payload(`?productLineId=${String(ids.productP2)}`)).turnaroundByRm.rows;
      const aliceRow = rows.find((entry) => entry.rmName === ALICE_NAME);
      expect(aliceRow?.avgTurnaroundDays).toBeNull();
      expect(aliceRow?.beyondTarget).toBe(false);
      expect(Object.keys(aliceRow ?? {})).not.toContain('slaStatus');
    });
  });

  describe('performance watchlist', () => {
    it('orders the most-at-risk RM first, not alphabetically', async () => {
      // Medians over the two active RMs: conversion 0.75, volume 4.5, won premium 3700.
      // Bob converts 0.5 (< median) on volume 3 (< median) -> review relationship (severity 4).
      // Alice converts 1 (>= median) on volume 6 (>= median) but is over the SLA -> deepen
      // engagement (severity 2).
      const dto = await payload();
      expect(dto.watchlist.map((entry) => entry.name)).toEqual([BOB_NAME, ALICE_NAME]);
      expect(dto.watchlist[0]?.suggestedAction.label).toBe('Review relationship');
      expect(dto.watchlist[0]?.suggestedAction.tone).toBe('neutral');
      expect(dto.watchlist[1]?.suggestedAction.label).toBe('Deepen engagement');
      expect(dto.watchlist[1]?.suggestedAction.tone).toBe('accent');
    });

    it('carries each row s own metrics and drill key', async () => {
      const dto = await payload();
      const aliceRow = dto.watchlist.find((entry) => entry.name === ALICE_NAME);
      expect(aliceRow?.quoteVolume).toBe(6);
      expect(aliceRow?.wonPremium).toBe(2400);
      expect(aliceRow?.overdueFollowUps).toBe(2);
      expect(aliceRow?.avgTurnaroundDays).toBe(25 / 3);
      expect(aliceRow?.drillWidgetKey).toBe('rm.leads');
    });
  });

  describe('leadership insights', () => {
    it('emits the five insights in stable type order over a populated tenant', async () => {
      const dto = await payload();
      expect(dto.insights.map((entry) => entry.type)).toEqual([
        'topPerformingBroker',
        'underperformingRm',
        'turnaroundAtRisk',
        'followUpCompliance',
        'largestPremiumOpportunity',
      ]);
    });

    it('names the weakest converter and states the SLA breach in the narrative', async () => {
      const dto = await payload();
      const underperformer = dto.insights.find((entry) => entry.type === 'underperformingRm');
      expect(underperformer?.headline).toBe(`Underperforming RM: ${BOB_NAME}`);
      const turnaround = dto.insights.find((entry) => entry.type === 'turnaroundAtRisk');
      expect(turnaround?.narrative).toBe(
        `${BOB_NAME} averages 11.0 days to quote, over the 3.0-day SLA target.`,
      );
    });

    it('reports the largest open pipeline in the tenant currency', async () => {
      const dto = await payload();
      // Alice: L1 current quoted 1200 + L2 current quoted 2500 = 3700 of open pipeline.
      expect(dto.insights.find((entry) => entry.type === 'largestPremiumOpportunity')?.narrative).toBe(
        `${ALICE_NAME} is working ${CURRENCY_CODE} 3,700 of open pipeline premium.`,
      );
    });
  });

  describe('shared filters (AC-075)', () => {
    it('narrows to one RM via teamOrRmId, the field the RM filter bar actually sends', async () => {
      const dto = await payload(`?teamOrRmId=${String(appUserId(alice))}`);
      expect(dto.topRms.map((entry) => entry.rmName)).toEqual([ALICE_NAME]);
      expect(kpi(dto, 'won_premium_ytd')).toBe(2400);
      expect(kpi(dto, 'active_rms')).toBe(1);
    });

    it('honors rmUserId as the same dimension under the other name', async () => {
      const dto = await payload(`?rmUserId=${String(appUserId(bob))}`);
      expect(dto.topRms.map((entry) => entry.rmName)).toEqual([BOB_NAME]);
      expect(kpi(dto, 'won_premium_ytd')).toBe(5000);
    });

    it('attributes by the rm SLOT, not by any assignment: Alice underwrites L4 but does not own it', async () => {
      // Proven, not assumed: assert the underwriting assignment really exists, then assert that
      // filtering by Alice still excludes L4 and its 5000.00 of won premium. This is the ONLY case
      // in the corpus where "assigned to" and "accountable for" disagree, and without it the
      // `ba.slot = 'rm'` condition in owner.ts is an undetectable deletion.
      const assignments = await query<{ slot: string }>(
        `select ba.slot
           from lead_assignments la
           join business_assignments ba on ba.tenant_id = la.tenant_id and ba.id = la.business_assignment_id
          where la.tenant_id = $1 and la.lead_id = $2 and la.user_id = $3`,
        [tenantA, ids.leadIdByKey.get('L4'), appUserId(alice)],
      );
      expect(assignments.map((entry) => entry.slot)).toEqual(['underwriter']);

      const dto = await payload(`?teamOrRmId=${String(appUserId(alice))}`);
      expect(kpi(dto, 'won_premium_ytd')).toBe(2400);
      expect(dto.topRms.map((entry) => entry.rmName)).toEqual([ALICE_NAME]);
    });

    it('lets teamOrRmId WIN when both RM fields are present', async () => {
      const dto = await payload(
        `?rmUserId=${String(appUserId(bob))}&teamOrRmId=${String(appUserId(alice))}`,
      );
      expect(dto.topRms.map((entry) => entry.rmName)).toEqual([ALICE_NAME]);
    });

    it('narrows the whole dashboard by broker TYPE, the RM-only filter dimension', async () => {
      // Tier 2 is B2 alone, so only B2-brokered leads (L2, L4) survive.
      const dto = await payload(`?brokerTypeId=${String(ids.brokerTypeT2)}`);
      expect(dto.topBrokers.map((entry) => entry.brokerId)).toEqual([ids.brokerB2]);
      expect(kpi(dto, 'won_premium_ytd')).toBe(7400);
      expect(kpi(dto, 'active_brokers')).toBe(1);
      // The per-RM VOLUMES are what prove the unbrokered leads are gone rather than merely
      // unranked: Bob keeps L4's two quotes and does NOT pick up L5's Q9, and Alice keeps L2's
      // three. A broker-type filter that let unbrokered leads through would read Bob at 3.
      expect(dto.topRms.map((entry) => [entry.rmName, entry.quoteVolume])).toEqual([
        [BOB_NAME, 2],
        [ALICE_NAME, 3],
      ]);
    });

    it('excludes unbrokered leads entirely when a broker type is selected', async () => {
      // Tier 1 is B1 (leads L1, L3, X1). L5 and X2 carry no broker at all and must not appear.
      const dto = await payload(`?brokerTypeId=${String(ids.brokerTypeT1)}`);
      expect(kpi(dto, 'won_premium_ytd')).toBe(0);
      expect(dto.topRms.map((entry) => entry.rmName).sort()).toEqual([ALICE_NAME, BOB_NAME]);
    });

    it('narrows by received-date window on the LEAD date', async () => {
      const dto = await payload('?from=2026-03-01&to=2026-03-09');
      // L1, L2 only (L3 is 03-11, L4 02-20, L5 03-20, X1 03-10, X2 03-12) — both Alice's.
      expect(dto.topRms.map((entry) => entry.rmName)).toEqual([ALICE_NAME]);
      expect(kpi(dto, 'won_premium_ytd')).toBe(2400);
    });

    it('returns an empty-but-valid payload when nothing matches', async () => {
      const dto = await payload('?from=2020-01-01&to=2020-12-31');
      expect(kpi(dto, 'active_rms')).toBe(0);
      expect(kpi(dto, 'rm_conversion_rate')).toBeNull();
      expect(kpi(dto, 'follow_up_compliance')).toBeNull();
      expect(dto.topRms).toEqual([]);
      expect(dto.watchlist).toEqual([]);
      expect(dto.turnaroundByRm.rows).toEqual([]);
      // The panel still speaks rather than rendering blank.
      expect(dto.insights.map((entry) => entry.type)).toEqual(['followUpCompliance']);
      expect(dto.insights[0]?.narrative).toBe('No follow-ups were due in this period.');
    });
  });

  describe('query budget (AC-079, N-04)', () => {
    it('issues a small fixed set of set-based reads, not one per RM or lead', async () => {
      let statements = 0;
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
            api.route('/', rmPerformanceRoutes({ db: countingDb }));
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
