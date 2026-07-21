/**
 * The Loss Analysis dashboard endpoint (T-037; AC-022, AC-074, AC-075, AC-078, AC-079;
 * V-027, V-092, V-093, V-094, V-098, V-099, V-100).
 *
 *   GET /api/v1/dashboards/loss-analysis    dashboards.view_loss_analysis
 *
 * WHAT A "LOSS" COUNTS HERE, STATED EXPLICITLY (CLAUDE.md's lead-vs-quote-vs-premium rule)
 * =======================================================================================
 * Measured from `LossAnalysisStore.LostLeadQuery` (:143) and the handler: this dashboard operates on
 * LOST LEADS — leads whose status maps to the `lost` reporting category — not on lost quotes.
 *  - `lost_premium` is PREMIUM: per lead, its current quoted premium if it reached a quote, else its
 *    estimated premium. There is no bound premium on a lost lead.
 *  - `quotes_lost` is a COUNT OF LEADS despite the PRD's label, and the payload marks it
 *    `leadOrQuote: 'lead'` for exactly that reason (the reference's own flag, preserved).
 *  - `avg_price_gap` is a rate over the subset of lost records carrying a comparable competitor
 *    premium, and is marked `quote`.
 * The tests below assert that labelling, not just the numbers, because a card reading "Quotes Lost:
 * 3" over three LEADS is the kind of defect that ships and is believed.
 *
 * DISABLED LOST REASONS MUST STILL RESOLVE (P-04). The corpus retires `Cover gaps` AFTER the lead
 * that used it, so a query that joined only active reference values would silently drop 1000.00 of
 * lost premium and a whole reason bar while every count still looked plausible.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lossAnalysisRoutes, type LossAnalysisDto } from '../../domains/dashboards/index.js';
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
  COMPETITOR_NAME,
  COVER_GAPS_REASON_NAME,
  CURRENCY_CODE,
  EXTENSION_LEADS,
  PRICE_REASON_NAME,
  seedDashboardCorpus,
  type CorpusIds,
} from './helpers/dashboard-corpus.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('dashboard-loss', probe);

const ENDPOINT = '/api/v1/dashboards/loss-analysis';
const RUN = `t37l-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

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
      "select id::text as id from tenants where name like 't37l-%'",
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
        api.route('/', lossAnalysisRoutes({ db }));
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

  async function payload(queryString = ''): Promise<LossAnalysisDto> {
    const response = await call(queryString);
    expect(response.status).toBe(200);
    return (await response.json()) as LossAnalysisDto;
  }

  const card = (dto: LossAnalysisDto, key: string) => {
    const found = dto.kpis.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`no KPI card '${key}' in payload`);
    return found;
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
      label: 'loss-viewer',
      firstName: 'Vee',
      lastName: 'Watcher',
    });
    outsider = await auth.createTestUserWithSession({
      label: 'loss-outsider',
      firstName: 'Otto',
      lastName: 'Sider',
    });
    alice = await auth.createTestUserWithSession({
      label: 'loss-alice',
      firstName: 'Alice',
      lastName: 'Anders',
    });
    bob = await auth.createTestUserWithSession({
      label: 'loss-bob',
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
        'dashboards.view_loss_analysis',
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
    it('answers 403 for a tenant member without dashboards.view_loss_analysis', async () => {
      expect((await call('', { session: outsider })).status).toBe(403);
    });

    it('answers 200 for a caller holding the dashboard permission', async () => {
      expect((await call()).status).toBe(200);
    });
  });

  describe('tenant isolation (AC-022)', () => {
    it('sums only tenant A losses', async () => {
      // L5 25.00 + X1 400.00 + X2 1000.00. Tenant B holds an identical corpus; a leak would double.
      expect(card(await payload(), 'lost_premium').value).toBe(1425);
      expect(card(await payload(), 'quotes_lost').value).toBe(3);
    });

    it('aggregates tenant B on its own rows', async () => {
      const response = await call('', { tenantId: tenantB });
      expect(response.status).toBe(200);
      const dto = (await response.json()) as LossAnalysisDto;
      expect(card(dto, 'lost_premium').value).toBe(1425);
    });
  });

  describe('KPI cards', () => {
    it('carries the tenant display currency', async () => {
      expect((await payload()).currencyCode).toBe(CURRENCY_CODE);
    });

    it('reports Lost Premium as PREMIUM over lost leads: 25 + 400 + 1000 = 1425', async () => {
      const lostPremium = card(await payload(), 'lost_premium');
      expect(lostPremium.value).toBe(1425);
      expect(lostPremium.kind).toBe('currency');
      expect(lostPremium.goodDirection).toBe('lowerIsBetter');
    });

    it('counts Quotes Lost as LEADS and labels the basis honestly', async () => {
      const quotesLost = card(await payload(), 'quotes_lost');
      expect(quotesLost.value).toBe(3);
      expect(quotesLost.kind).toBe('count');
      // The reference's own documented flag: the PRD's label says quotes, the unit is leads.
      expect(quotesLost.leadOrQuote).toBe('lead');
    });

    it('names the modal loss reason as TEXT, with no numeric value', async () => {
      const topReason = card(await payload(), 'top_loss_reason');
      expect(topReason.kind).toBe('text');
      // Price covers L5 and X1; Cover gaps only X2.
      expect(topReason.textValue).toBe(PRICE_REASON_NAME);
      expect(topReason.value).toBeNull();
    });

    it('averages the price gap over only the records with a known competitor premium', async () => {
      // X1 (400-320)/320 = 0.25; X2 (1000-800)/800 = 0.25. L5 carries no competitor premium.
      const gap = card(await payload(), 'avg_price_gap');
      expect(gap.value).toBe(0.25);
      expect(gap.kind).toBe('percent');
      expect(gap.leadOrQuote).toBe('quote');
    });

    it('names the modal competitor', async () => {
      expect(card(await payload(), 'top_competitor').textValue).toBe(COMPETITOR_NAME);
    });

    it('ships NO Win-back Potential card (the explicit PRD 16.0 exclusion)', async () => {
      const dto = await payload();
      expect(dto.kpis.map((entry) => entry.key)).toEqual([
        'lost_premium',
        'quotes_lost',
        'top_loss_reason',
        'avg_price_gap',
        'top_competitor',
      ]);
    });
  });

  describe('lost premium by reason (P-04 resolvability)', () => {
    it('groups by reason descending by amount', async () => {
      const rows = (await payload()).lostPremiumByReason.rows;
      expect(rows.map((entry) => [entry.reasonName, entry.amount])).toEqual([
        [COVER_GAPS_REASON_NAME, 1000],
        [PRICE_REASON_NAME, 425],
      ]);
    });

    it('still resolves a DISABLED lost reason on its historical records', async () => {
      // Proven, not assumed: assert the reference item really is inactive, then assert the name
      // still appears with its full premium.
      const rows = await query<{ is_active: boolean }>(
        'select is_active from reference_items where tenant_id = $1 and id = $2',
        [tenantA, ids.coverGapsReasonId],
      );
      expect(rows[0]?.is_active).toBe(false);

      const reasons = (await payload()).lostPremiumByReason.rows;
      const coverGaps = reasons.find((entry) => entry.reasonName === COVER_GAPS_REASON_NAME);
      expect(coverGaps?.amount).toBe(1000);
    });

    it('takes a lost lead s premium from its CURRENT QUOTE when it has one, else the estimate', async () => {
      // L5 reached a quote (Q9, current premium 25.00) and its estimated premium is 300.00, so
      // 425 = 25 (quoted) + 400 (X1, estimate — it never reached a quote) proves the precedence.
      const rows = (await payload()).lostPremiumByReason.rows;
      expect(rows.find((entry) => entry.reasonName === PRICE_REASON_NAME)?.amount).toBe(425);
    });
  });

  describe('lost premium by product line', () => {
    it('groups by product line descending by amount', async () => {
      const rows = (await payload()).lostPremiumByProductLine.rows;
      // P1 carries L5 (25) and X2 (1000); P2 carries X1 (400).
      expect(rows.map((entry) => entry.amount)).toEqual([1025, 400]);
      expect(rows[0]?.productLineName).toContain('Motor');
      expect(rows[1]?.productLineName).toContain('Marine');
    });
  });

  describe('six-month lost premium trend', () => {
    it('anchors on the filter upper bound and emits six months oldest-first', async () => {
      const trend = (await payload('?to=2026-03-31')).lostPremiumTrend;
      expect(trend.points.map((point) => point.monthLabel)).toEqual([
        'Oct 25',
        'Nov 25',
        'Dec 25',
        'Jan 26',
        'Feb 26',
        'Mar 26',
      ]);
    });

    it('buckets lost premium by DECISION date, not received date', async () => {
      const trend = (await payload('?to=2026-03-31')).lostPremiumTrend;
      // X1 decided 2026-03-22 (400) and X2 2026-03-25 (1000). L5 has no decision date, so its
      // 25.00 appears in the KPI total but in no month of the trend.
      expect(trend.points.map((point) => point.amount)).toEqual([0, 0, 0, 0, 0, 1400]);
    });
  });

  describe('competitor analysis', () => {
    it('ranks competitors by deals lost with their premium and mean price gap', async () => {
      const rows = (await payload()).competitorAnalysis.rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.competitor).toBe(COMPETITOR_NAME);
      expect(rows[0]?.dealsLost).toBe(2);
      expect(rows[0]?.premiumLost).toBe(1400);
      expect(rows[0]?.avgPriceGapPct).toBe(0.25);
    });
  });

  describe('loss commentary', () => {
    it('surfaces the most recently decided losses first, undecided last', async () => {
      const items = (await payload()).lossCommentary.items;
      expect(items.map((item) => item.comment)).toEqual([
        EXTENSION_LEADS[1]?.lossComments,
        EXTENSION_LEADS[0]?.lossComments,
        null,
      ]);
    });

    it('carries each item s reason chip, premium and client', async () => {
      const items = (await payload()).lossCommentary.items;
      expect(items[0]?.lossReasonName).toBe(COVER_GAPS_REASON_NAME);
      expect(items[0]?.lossReasonTone).toBe('danger');
      expect(items[0]?.premium).toBe(1000);
      expect(items[0]?.client).toContain('Corpus Client');
      expect(items[0]?.leadId).toBe(ids.leadIdByKey.get('X2'));
    });
  });

  describe('shared filters (AC-075)', () => {
    it('narrows by product line', async () => {
      const dto = await payload(`?productLineId=${String(ids.productP2)}`);
      expect(card(dto, 'lost_premium').value).toBe(400);
      expect(card(dto, 'quotes_lost').value).toBe(1);
      expect(dto.lostPremiumByReason.rows.map((entry) => entry.reasonName)).toEqual([
        PRICE_REASON_NAME,
      ]);
    });

    it('narrows by broker', async () => {
      // X1 is B1's only lost lead; L5 and X2 carry no broker.
      const dto = await payload(`?brokerId=${String(ids.brokerB1)}`);
      expect(card(dto, 'lost_premium').value).toBe(400);
    });

    it('narrows by region', async () => {
      // R1 holds L5 (25) and X1 (400); X2 is R2.
      const dto = await payload(`?regionId=${String(ids.regionR1)}`);
      expect(card(dto, 'lost_premium').value).toBe(425);
      expect(card(dto, 'top_loss_reason').textValue).toBe(PRICE_REASON_NAME);
    });

    it('narrows by RM owner through the assignment slot', async () => {
      // Alice owns X1 only among the lost leads; Bob owns L5 and X2.
      const dto = await payload(`?teamOrRmId=${String(appUserId(alice))}`);
      expect(card(dto, 'lost_premium').value).toBe(400);
      expect(card(dto, 'quotes_lost').value).toBe(1);
    });

    it('attributes by the rm SLOT: Bob underwrites nothing, but Alice underwriting L4 changes nothing here', async () => {
      // L4 is WON, so it is not a lost lead at all — but the owner predicate runs before the lost
      // filter, and dropping `ba.slot = 'rm'` from owner.ts would let Alice's UNDERWRITING
      // assignment widen her filtered set. Bob's lost leads must stay exactly L5 + X2.
      const dto = await payload(`?rmUserId=${String(appUserId(bob))}`);
      expect(card(dto, 'lost_premium').value).toBe(1025);
      expect(card(dto, 'quotes_lost').value).toBe(2);
    });

    it('narrows by received-date window', async () => {
      const dto = await payload('?from=2026-03-11&to=2026-03-31');
      // X2 (03-12) and L5 (03-20); X1 is 03-10.
      expect(card(dto, 'lost_premium').value).toBe(1025);
    });

    /**
     * THE ONE DELIBERATE ERASURE ON THIS DASHBOARD (V-093 second clause; F-037-1).
     *
     * `lossScopedFilter()` strips `brokerTypeId` before the filter reaches the query, because the
     * reference's LossAnalysisStore carries no broker-type predicate anywhere. The parameter is
     * still BOUND — the SPA's filter bar is shared, and a broker-type selection left over from the
     * RM screen must not 400 — so it has to be accepted AND inert.
     *
     * NOTE this is NOT the same thing as the `rmUserId` / `teamOrRmId` tests above: Loss Analysis
     * DOES apply the RM dimension, through owner.ts's accountable-owner predicate. Only broker type
     * is erased here.
     */
    it('accepts brokerTypeId and leaves the payload unchanged, because this dashboard ignores it', async () => {
      const [split] = await query<{ matching: string; total: string }>(
        `select count(*) filter (where b.broker_type_id = $2)::text as matching,
                count(*)::text as total
           from leads l
           join reference_items s on s.tenant_id = l.tenant_id and s.id = l.status_id
           left join brokers b on b.tenant_id = l.tenant_id and b.id = l.broker_id
          where l.tenant_id = $1 and s.reporting_category = 'lost'`,
        [tenantA, ids.brokerTypeT1],
      );
      // The three lost leads are L5 (no broker), X1 (B1, Tier 1) and X2 (no broker). Tier 1 selects
      // a PROPER, NON-EMPTY subset: were the dimension applied, lost premium would collapse from
      // 1425 to X1's 400 alone, so this filter value can tell an erasure from an application.
      expect(split).toEqual({ matching: '1', total: '3' });

      expect(await payload(`?brokerTypeId=${String(ids.brokerTypeT1)}`)).toEqual(await payload());
    });

    it('returns an empty-but-valid payload when nothing matches', async () => {
      const dto = await payload('?from=2020-01-01&to=2020-12-31');
      expect(card(dto, 'lost_premium').value).toBe(0);
      expect(card(dto, 'quotes_lost').value).toBe(0);
      expect(card(dto, 'top_loss_reason').textValue).toBeNull();
      expect(card(dto, 'avg_price_gap').value).toBeNull();
      expect(dto.lostPremiumByReason.rows).toEqual([]);
      expect(dto.competitorAnalysis.rows).toEqual([]);
      expect(dto.lossCommentary.items).toEqual([]);
      // The trend still renders six zeroed months rather than collapsing to an empty chart.
      expect(dto.lostPremiumTrend.points).toHaveLength(6);
    });
  });

  describe('query budget (AC-079, N-04)', () => {
    it('issues a small fixed set of set-based reads, not one per lost lead', async () => {
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
            api.route('/', lossAnalysisRoutes({ db: countingDb }));
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
      expect(statements).toBeLessThanOrEqual(6);
    });
  });
});
