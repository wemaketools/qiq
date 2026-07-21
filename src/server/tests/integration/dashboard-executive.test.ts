/**
 * The Executive Overview dashboard endpoint (T-036; AC-022, AC-074, AC-075, AC-077, AC-079;
 * V-027, V-092, V-093, V-094, V-096, V-097, V-100).
 *
 * Port target: `GetExecutiveOverviewQueryHandler.cs` + `ExecutiveDashboardStore.cs`, with the wire
 * shape pinned against the SPA's own `src/ui/src/features/dashboards/executiveApi.ts`.
 *
 * EVERY ASSERTION IS AN EXACT VALUE, NEVER A SHAPE
 * ================================================
 * A dashboard that returns plausible-but-wrong numbers is THE failure mode of this domain, and
 * `expect(kpis).toHaveLength(9)` cannot see a KPI that counts leads where it should count quotes.
 * So every number below is hand-computed from `metrics/fixtures/dashboard-metrics.json` and
 * restated in the comment that justifies it, independently of the implementation.
 *
 * THE AGING SCHEME THIS ENDPOINT MUST EMIT IS THE **EXECUTIVE** FOUR-BUCKET ONE
 * ============================================================================
 * `0-3 days / 4-7 days / 8-14 days / 15+ days` (GetExecutiveOverviewQueryHandler.cs:230-233), NOT
 * the Pipeline dashboard's six-bucket `0-3 .. 60+`. T-035 ported both under distinct names
 * precisely because they are easy to conflate, and this task owns BOTH dashboards — so the bucket
 * LABELS are asserted literally here, and `dashboard-pipeline.test.ts` asserts the other scheme,
 * and a cross-check asserts the two are different.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXECUTIVE_AGING_BUCKETS,
  PIPELINE_AGING_BUCKETS,
  dashboardFilterSchema,
  executiveDashboardRoutes,
  getExecutiveOverview,
  type ExecutiveOverviewDto,
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
import {
  seedAlert,
  seedExecPipelineCorpus,
  type CorpusIds,
} from './helpers/exec-pipeline-corpus.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('dashboard-executive', probe);

const EXECUTIVE = '/api/v1/dashboards/executive';

const fixture = loadMetricFixture();

/**
 * The evaluation instant every exact assertion is computed against.
 *
 * Pinned rather than `new Date()`: aging, the trend windows and the "current month" period are all
 * functions of today, so a real clock would make every number below drift daily and the suite would
 * have to assert shapes instead of values — which is precisely what it must not do.
 */
const NOW = new Date(`${fixture.today}T00:00:00Z`);

/** The fixture's own reporting period, which makes the period kind CUSTOM (both ends supplied). */
const PERIOD = fixture.period;

/** Short run token — a long one dominates trigram similarity and false-positives duplicate checks. */
const RUN = `t36e-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

const CURRENCY = 'ZAR';
/** L1 (1200) and L2 (2500) clear it; L3 (500) does not. */
const HIGH_VALUE_THRESHOLD = '1000.00';
const SLA_RECEIVED_TO_SENT_DAYS = 3;

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

  let tenantA = 0;
  let tenantB = 0;
  const createdTenants: number[] = [];

  let corpus: CorpusIds;
  let rmOwnerUserId = 0;
  let otherRmUserId = 0;

  const OWNED_TABLES = [
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
      "select id::text as id from tenants where name like 't36e-%'",
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
        api.route('/', executiveDashboardRoutes({ db }));
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

  /** Runs the service directly, which is the only way to pin `now` and therefore assert exactly. */
  function overview(
    filterQuery: Record<string, string> = {},
    tenantId = tenantA,
  ): Promise<ExecutiveOverviewDto> {
    return getExecutiveOverview(
      { db },
      {
        userId: appUserId(viewer),
        tenantId: tenantId as TenantId,
        // Tenant-wide breadth: every assertion in this suite is about the WHOLE tenant's numbers.
        // T-050 made breadth narrow the aggregate as well as the drill, so a caller without
        // `leads.view_all` now sees only their own leads here — which is asserted separately.
        canViewAllLeads: true,
      },
      dashboardFilterSchema.parse(filterQuery),
      NOW,
    );
  }

  /** The default filter used by most assertions: the fixture's own March window. */
  const PERIOD_QUERY: Record<string, string> = { from: PERIOD.from, to: PERIOD.to };

  function kpi(payload: ExecutiveOverviewDto, key: string): ExecutiveOverviewDto['kpis'][number] {
    const found = payload.kpis.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`no executive KPI '${key}' in payload`);
    return found;
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

    await purgeStaleRunsOfThisSuite();

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');

    viewer = await auth.createTestUserWithSession({
      label: 'exec-viewer',
      firstName: 'Ada',
      lastName: 'Zulu',
    });
    outsider = await auth.createTestUserWithSession({
      label: 'exec-outsider',
      firstName: 'Bea',
      lastName: 'Yankee',
    });
    const rmOwner = await auth.createTestUserWithSession({
      label: 'exec-rm',
      firstName: 'Cal',
      lastName: 'Xray',
    });
    const otherRm = await auth.createTestUserWithSession({
      label: 'exec-rm2',
      firstName: 'Dee',
      lastName: 'Whiskey',
    });

    for (const session of [viewer, outsider, rmOwner, otherRm]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(viewer), tenantB);

    await fixtures.grantDirectPermission(appUserId(viewer), 'dashboards.view_executive', tenantA);
    await fixtures.grantDirectPermission(appUserId(viewer), 'dashboards.view_executive', tenantB);
    // `outsider` deliberately holds NO dashboard permission.
    await fixtures.grantDirectPermission(appUserId(outsider), 'leads.view', tenantA);

    const rmRole = await fixtures.createRole({ tenantId: tenantA });

    corpus = await seedExecPipelineCorpus({
      query,
      tenantId: tenantA,
      runToken: RUN,
      ownerUserIds: { restricted: appUserId(rmOwner), stranger: appUserId(otherRm) },
      rmRoleId: rmRole,
      currencyCode: CURRENCY,
      highValueThreshold: HIGH_VALUE_THRESHOLD,
      slaReceivedToSentDays: SLA_RECEIVED_TO_SENT_DAYS,
    });

    rmOwnerUserId = appUserId(rmOwner);
    otherRmUserId = appUserId(otherRm);

    const leadId = (key: string): number => {
      const id = corpus.leadIdByKey.get(key);
      if (id === undefined) throw new Error(`no seeded lead ${key}`);
      return id;
    };
    const quoteId = (key: string): number => {
      const id = corpus.quoteIdByKey.get(key);
      if (id === undefined) throw new Error(`no seeded quote ${key}`);
      return id;
    };

    // Alerts: two open leads carry open alerts; L4 carries a RESOLVED one that must be invisible.
    await seedAlert({
      query,
      tenantId: tenantA,
      leadId: leadId('L1'),
      quoteId: quoteId('Q1'),
      type: 'sla_breach',
    });
    await seedAlert({ query, tenantId: tenantA, leadId: leadId('L2'), type: 'overdue_follow_up' });
    await seedAlert({
      query,
      tenantId: tenantA,
      leadId: leadId('L2'),
      type: 'executive_escalation',
    });
    await seedAlert({
      query,
      tenantId: tenantA,
      leadId: leadId('L4'),
      type: 'stalled_lead',
      resolved: true,
    });

    // Tenant B carries a corpus whose premiums are unmistakable if they ever leak into tenant A's
    // sums: a 777777.00 lead would move every currency KPI by an amount no rounding could explain.
    const rmRoleB = await fixtures.createRole({ tenantId: tenantB });
    await seedExecPipelineCorpus({
      query,
      tenantId: tenantB,
      runToken: `${RUN}b`,
      ownerUserIds: { restricted: appUserId(viewer), stranger: appUserId(viewer) },
      rmRoleId: rmRoleB,
      currencyCode: 'GBP',
      highValueThreshold: '1.00',
      slaReceivedToSentDays: 1,
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
  // AC-079 / V-100: the wire contract the SPA already consumes.
  // -------------------------------------------------------------------------------------------

  describe('payload contract', () => {
    it('returns exactly the seven top-level fields the SPA reads, and no others', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(Object.keys(payload).sort()).toEqual([
        'currencyCode',
        'highValueOpportunities',
        'kpis',
        'openQuotesAging',
        'pipelineByStage',
        'requiresAttention',
        'wonVsLostTrend',
      ]);
    });

    /**
     * MEASURED CONTRADICTION AGAINST THIS TASK'S OWN SCOPE, ASSERTED SO IT CANNOT DRIFT BACK.
     * T-036's scope names a "generatedAt footer timestamp". No dashboard DTO in the reference
     * carries one (`ExecutiveOverviewDto.cs:76-83`), `GeneratedAt` exists only on export/report
     * metadata, and the SPA's `ExecutiveOverviewDto` declares no such field. Adding it would be an
     * unapproved contract widening (A-3), so its ABSENCE is pinned.
     */
    it('carries no generatedAt field, matching the reference DTO and the SPA interface', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(payload).not.toHaveProperty('generatedAt');
    });

    it('reports the tenant display currency from tenant_settings', async () => {
      expect((await overview(PERIOD_QUERY)).currencyCode).toBe(CURRENCY);
    });

    it('emits the nine KPI cards in the reference order', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(payload.kpis.map((entry) => entry.key)).toEqual([
        'total_quotes',
        'open_pipeline_premium',
        'won_premium',
        'conversion_rate',
        'average_turnaround',
        'quotes_at_risk',
        'total_leads',
        'lead_to_quote_rate',
        'leads_at_risk',
      ]);
    });

    /** CLAUDE.md: every metric must state whether it counts Leads, Quotes or Premium. */
    it('labels every KPI with its lead-vs-quote basis and its render kind', async () => {
      const payload = await overview(PERIOD_QUERY);
      const basis = Object.fromEntries(
        payload.kpis.map((entry) => [entry.key, [entry.leadOrQuote, entry.kind, entry.label]]),
      );

      expect(basis).toEqual({
        total_quotes: ['quote', 'count', 'Total Quotes'],
        open_pipeline_premium: ['quote', 'currency', 'Open Pipeline Premium'],
        won_premium: ['quote', 'currency', 'Won Premium'],
        conversion_rate: ['quote', 'percent', 'Conversion Rate'],
        average_turnaround: ['quote', 'days', 'Avg Turnaround'],
        quotes_at_risk: ['quote', 'count', 'Quotes at Risk'],
        total_leads: ['lead', 'count', 'Total Leads'],
        lead_to_quote_rate: ['lead', 'percent', 'Lead-to-Quote Rate'],
        leads_at_risk: ['lead', 'count', 'Leads at Risk'],
      });
    });

    it('gives every KPI a drill widget key', async () => {
      const payload = await overview(PERIOD_QUERY);
      for (const entry of payload.kpis) {
        expect(entry.drillWidgetKey).toMatch(/^exec\./);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-074 / V-092: exact KPI values over the shared fixture.
  // -------------------------------------------------------------------------------------------

  describe('KPI values', () => {
    /** Q1,Q2,Q3,Q4,Q6,Q7,Q8,Q9 prepared in March = 8. Prior window holds Q5 alone = 1. */
    it('counts QUOTES prepared in the period, with the prior-period delta', async () => {
      const card = kpi(await overview(PERIOD_QUERY), 'total_quotes');
      expect(card.value).toBe(fixture.expected.totalQuotesPrepared);
      expect(card.value).toBe(8);
      expect(card.delta).toBe(7);
      expect(card.goodDirection).toBe('higherIsBetter');
      expect(card.isFavorableDelta).toBe(true);
    });

    /** L1,L2,L3,L5 received in March = 4. L4 (2026-02-20) falls in the prior window = 1. */
    it('counts LEADS received in the period, a different population from Total Quotes', async () => {
      const card = kpi(await overview(PERIOD_QUERY), 'total_leads');
      expect(card.value).toBe(fixture.expected.totalLeadsReceived);
      expect(card.value).toBe(4);
      expect(card.delta).toBe(3);
    });

    /** Open quotes 1200+100+50+150+25 = 1525, plus open lead L3's 500 estimate = 2025.00. */
    it('sums Open Pipeline Premium exactly, and reports no delta for it', async () => {
      const card = kpi(await overview(PERIOD_QUERY), 'open_pipeline_premium');
      expect(card.value).toBe(Number(fixture.expected.openPipelinePremium));
      expect(card.value).toBe(2025);
      // The reference passes `null` as the prior for this card, so the delta must be null — not 0,
      // which would render as "flat" rather than "not comparable".
      expect(card.delta).toBeNull();
      expect(card.isFavorableDelta).toBeNull();
    });

    /** Q2's bound_premium 2400 (NOT its 2500 quoted premium). Q5's 5000 is decided in February. */
    it('reports Won Premium as bound premium over quotes DECIDED in the period', async () => {
      const card = kpi(await overview(PERIOD_QUERY), 'won_premium');
      expect(card.value).toBe(Number(fixture.expected.boundPremium));
      expect(card.value).toBe(2400);
      // Prior window ends 2026-02-28 and therefore contains Q5's 5000.00 decision exactly.
      expect(card.delta).toBe(-2600);
      expect(card.isFavorableDelta).toBe(false);
    });

    /** Q2 won, Q3 lost, both decided in March -> 1/2. Q6 EXPIRED-in-March is not "decided". */
    it('computes Conversion Rate over decided quotes only, excluding expired ones', async () => {
      const card = kpi(await overview(PERIOD_QUERY), 'conversion_rate');
      expect(card.value).toBe(fixture.expected.quoteToWinRate);
      expect(card.value).toBe(0.5);
      // Prior: Q5 won, nothing lost -> 1/1 = 1.0.
      expect(card.delta).toBe(-0.5);
    });

    /** Q1 3, Q2 4, Q3 16, Q6 18 -> 41/4 = 10.25 days. */
    it('averages turnaround over quotes SENT in the period', async () => {
      const card = kpi(await overview(PERIOD_QUERY), 'average_turnaround');
      expect(card.value).toBe(fixture.expected.averageTurnaroundDays);
      expect(card.value).toBe(10.25);
      // Prior holds Q5 alone: received 2026-02-20, sent 2026-02-26 -> 6 days.
      expect(card.delta).toBe(4.25);
      // Turnaround is lowerIsBetter, so a RISE of 4.25 days is unfavourable.
      expect(card.goodDirection).toBe('lowerIsBetter');
      expect(card.isFavorableDelta).toBe(false);
    });

    /** Eligible March leads L1,L2,L3,L5; those with any quote L1,L2,L5 -> 3/4. */
    it('computes Lead-to-Quote Rate over LEADS, counting a multi-quote lead once', async () => {
      const card = kpi(await overview(PERIOD_QUERY), 'lead_to_quote_rate');
      expect(card.value).toBe(fixture.expected.leadToQuoteRate);
      expect(card.value).toBe(0.75);
      // L1 alone carries three quotes (Q1, Q6, Q7); if the numerator counted quotes it would exceed
      // the denominator and this rate would be > 1.
      expect(card.value).toBeLessThanOrEqual(1);
    });

    /** Unresolved alerts sit on L1 and L2; L4's alert is resolved and must not count. */
    it('counts leads and quotes at risk from OPEN alerts only', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(kpi(payload, 'leads_at_risk').value).toBe(2);
      // Only the SLA-breach alert carries a quote id.
      expect(kpi(payload, 'quotes_at_risk').value).toBe(1);
    });

    /**
     * A zero-denominator rate must be null, never 0 — "nothing decided yet" and "we lost every
     * deal" are different facts and the UI renders an em dash for the first.
     */
    it('returns null rather than 0 for a rate whose denominator is empty', async () => {
      const card = kpi(
        await overview({ from: '2020-01-01', to: '2020-01-31' }),
        'conversion_rate',
      );
      expect(card.value).toBeNull();
      expect(card.value).not.toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Charts and tables.
  // -------------------------------------------------------------------------------------------

  describe('pipeline by stage', () => {
    /** Open leads are L1 (new), L3 (new) and L2 (quote_sent): 2 and 1 of 3. */
    it('counts CURRENT open leads per stage in lifecycle order, not cumulatively', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(
        payload.pipelineByStage.map((row) => [row.stageCanonicalKey, row.openCount, row.shareOfOpen]),
      ).toEqual([
        ['new', 2, 0.6667],
        ['quote_sent', 1, 0.3333],
      ]);
    });

    it('names each stage with the tenant-configured status name', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(payload.pipelineByStage[0]?.stageName).toBe(corpus.statusNameByCategory.get('open'));
      expect(payload.pipelineByStage[1]?.stageName).toBe(corpus.statusNameByCategory.get('quoted'));
    });
  });

  describe('open quotes aging', () => {
    /**
     * THE EXECUTIVE FOUR-BUCKET SCHEME. Open quote ages at 2026-04-01, referenced from
     * `sentDate ?? preparedDate`: Q7 2, Q8 1, Q9 3, Q4 25, Q1 27 -> 3 in `0-3 days`, 2 in `15+ days`.
     */
    it('buckets open quotes into the EXECUTIVE four-bucket scheme', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(payload.openQuotesAging.buckets.map((b) => b.bucket)).toEqual([
        ...EXECUTIVE_AGING_BUCKETS,
      ]);
      expect(payload.openQuotesAging.buckets.map((b) => [b.bucket, b.count, b.share])).toEqual([
        ['0-3 days', 3, 0.6],
        ['4-7 days', 0, 0],
        ['8-14 days', 0, 0],
        ['15+ days', 2, 0.4],
      ]);
      expect(payload.openQuotesAging.totalOpenQuotes).toBe(5);
    });

    /** Guards the one conflation this task is uniquely positioned to make. */
    it('does NOT emit the Pipeline dashboard six-bucket scheme', async () => {
      const payload = await overview(PERIOD_QUERY);
      const labels = payload.openQuotesAging.buckets.map((b) => b.bucket);
      expect(labels).not.toEqual([...PIPELINE_AGING_BUCKETS]);
      expect(labels).not.toContain('60+');
      expect(labels).not.toContain('15-30');
      expect(labels).toContain('15+ days');
    });

    it('matches the shared fixture bucket counts computed by the pure function', async () => {
      const payload = await overview(PERIOD_QUERY);
      const counts = Object.fromEntries(
        payload.openQuotesAging.buckets.map((b) => [b.bucket, b.count]),
      );
      expect(counts).toEqual(fixture.expected.executiveAgingBuckets);
    });

    /**
     * A quote ages from when it was SENT, falling back to PREPARED — and the fallback direction is
     * load-bearing.
     *
     * The seeded corpus cannot see this on its own: its only sent open quote is Q1, whose prepared
     * (29 days) and sent (27 days) ages both land in `15+ days`, so either reference date produces
     * the same donut. The discriminating state is therefore CONSTRUCTED here: Q1 is moved so the two
     * dates straddle a bucket boundary. Prepared 2026-03-20 is 12 days old (`8-14 days`); sent
     * 2026-03-30 is 2 days old (`0-3 days`). Only the correct reference date puts it in `0-3 days`.
     */
    it('ages an open quote from its SENT date, not the date it was prepared', async () => {
      const quoteId = corpus.quoteIdByKey.get('Q1');
      await query(
        `update quotes set prepared_date = '2026-03-20', sent_date = '2026-03-30'
          where tenant_id = $1 and id = $2`,
        [tenantA, quoteId],
      );
      try {
        const counts = Object.fromEntries(
          (await overview(PERIOD_QUERY)).openQuotesAging.buckets.map((b) => [b.bucket, b.count]),
        );
        // Q1 joins Q7/Q8/Q9 in the youngest bucket; only Q4 (25 days) remains in `15+ days`.
        expect(counts).toEqual({
          '0-3 days': 4,
          '4-7 days': 0,
          '8-14 days': 0,
          '15+ days': 1,
        });
        // Aging from `prepared` would have produced this instead.
        expect(counts['8-14 days']).not.toBe(1);
      } finally {
        await query(
          `update quotes set prepared_date = '2026-03-03', sent_date = '2026-03-05'
            where tenant_id = $1 and id = $2`,
          [tenantA, quoteId],
        );
      }
    });
  });

  describe('won vs lost trend', () => {
    it('emits eight weekly points and six monthly points', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(payload.wonVsLostTrend.weekly).toHaveLength(8);
      expect(payload.wonVsLostTrend.monthly).toHaveLength(6);
    });

    /** Won 2400 (Q2, bound) in March; lost 800 (Q3, quoted premium) in March; 5000 won in February. */
    it('splits won premium from lost premium by decision month', async () => {
      const payload = await overview(PERIOD_QUERY);
      const monthly = Object.fromEntries(
        payload.wonVsLostTrend.monthly.map((p) => [p.label, [p.wonPremium, p.lostPremium]]),
      );

      expect(monthly['Feb 2026']).toEqual([5000, 0]);
      expect(monthly['Mar 2026']).toEqual([2400, 800]);
      expect(monthly['Apr 2026']).toEqual([0, 0]);
      expect(Object.keys(monthly)).toEqual([
        'Nov 2025',
        'Dec 2025',
        'Jan 2026',
        'Feb 2026',
        'Mar 2026',
        'Apr 2026',
      ]);
    });

    /** Weekly windows end on today and step back seven days at a time. */
    it('buckets the same decisions into the weekly series', async () => {
      const payload = await overview(PERIOD_QUERY);
      const weekly = Object.fromEntries(
        payload.wonVsLostTrend.weekly.map((p) => [p.label, [p.wonPremium, p.lostPremium]]),
      );

      expect(Object.keys(weekly)).toEqual([
        'Feb 11',
        'Feb 18',
        'Feb 25',
        'Mar 4',
        'Mar 11',
        'Mar 18',
        'Mar 25',
        'Apr 1',
      ]);
      // Q5 decided 2026-02-28 lands in the 2026-02-26..2026-03-04 window.
      expect(weekly['Mar 4']).toEqual([5000, 0]);
      // Q2 (won, 2026-03-15) and Q3 (lost, 2026-03-18) both land in 2026-03-12..2026-03-18.
      expect(weekly['Mar 18']).toEqual([2400, 800]);
    });

    /** Won uses `bound ?? quoted`; lost uses the QUOTED premium, since nothing was bound. */
    it('reports won premium from the bound amount and lost premium from the quoted amount', async () => {
      const payload = await overview(PERIOD_QUERY);
      const march = payload.wonVsLostTrend.monthly.find((p) => p.label === 'Mar 2026');
      // Q2's quoted premium is 2500 and its bound premium is 2400; reporting 2500 would overstate.
      expect(march?.wonPremium).toBe(2400);
      expect(march?.wonPremium).not.toBe(2500);
      expect(march?.lostPremium).toBe(800);
    });
  });

  describe('high value opportunities', () => {
    /** Open leads by premium: L2 2500 (current quote), L1 1200 (current quote), L3 500 (estimate). */
    it('lists open leads above the tenant threshold, richest first', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(payload.highValueOpportunities.map((row) => [row.leadRef, row.premium])).toEqual([
        [`${RUN}-L2`, 2500],
        [`${RUN}-L1`, 1200],
      ]);
    });

    it('flags a high-value row that also carries an open alert', async () => {
      const payload = await overview(PERIOD_QUERY);
      const byRef = Object.fromEntries(
        payload.highValueOpportunities.map((row) => [row.leadRef, row]),
      );
      // Both L1 and L2 carry open alerts in this corpus.
      expect(byRef[`${RUN}-L1`]?.riskFlag).toBe(true);
      expect(byRef[`${RUN}-L2`]?.riskFlag).toBe(true);
    });

    it('carries the stage, owner and broker context each row is drilled from', async () => {
      const payload = await overview(PERIOD_QUERY);
      const row = payload.highValueOpportunities.find((entry) => entry.leadRef === `${RUN}-L1`);
      expect(row?.stageReportingCategory).toBe('open');
      expect(row?.stageName).toBe(corpus.statusNameByCategory.get('open'));
      expect(row?.brokerName).toBe(corpus.brokerB1Name);
      expect(row?.productLineName).toBe(corpus.productP1Name);
      expect(row?.ownerName).toBe('Cal Xray');
      expect(row?.nextFollowUpDate).toBe('2026-04-05');
    });

    /**
     * A tenant with no configured threshold has no high-value CLASSIFICATION at all — distinct
     * from a threshold of zero, which would promote every open lead onto the executive's table.
     */
    it('returns an empty table when the tenant has no high-value threshold', async () => {
      await query('update tenant_settings set high_value_threshold = null where tenant_id = $1', [
        tenantA,
      ]);
      try {
        expect((await overview(PERIOD_QUERY)).highValueOpportunities).toEqual([]);
      } finally {
        await query('update tenant_settings set high_value_threshold = $2 where tenant_id = $1', [
          tenantA,
          HIGH_VALUE_THRESHOLD,
        ]);
      }
    });

    /** STRICTLY greater than: a lead exactly at the threshold is not high value. */
    it('excludes a lead whose premium exactly equals the threshold', async () => {
      await query('update tenant_settings set high_value_threshold = $2 where tenant_id = $1', [
        tenantA,
        '1200.00',
      ]);
      try {
        const payload = await overview(PERIOD_QUERY);
        expect(payload.highValueOpportunities.map((row) => row.leadRef)).toEqual([`${RUN}-L2`]);
      } finally {
        await query('update tenant_settings set high_value_threshold = $2 where tenant_id = $1', [
          tenantA,
          HIGH_VALUE_THRESHOLD,
        ]);
      }
    });
  });

  describe('requires attention panel', () => {
    /** Consumes the T-033 alert summary categories rather than re-deriving alert rules. */
    it('reports the five alert summary categories with their open counts', async () => {
      const payload = await overview(PERIOD_QUERY);
      expect(
        payload.requiresAttention.map((row) => [row.category, row.count, row.tab]),
      ).toEqual([
        ['escalated', 1, 'escalated'],
        // L4's stalled_lead alert is RESOLVED, so this card reads zero.
        ['stalled', 0, null],
        ['overdue', 1, 'overdue'],
        ['expiring', 0, 'expiring'],
        ['sla', 1, 'sla'],
      ]);
    });

    it('carries each category definition for the panel subtitle', async () => {
      const payload = await overview(PERIOD_QUERY);
      const escalated = payload.requiresAttention.find((row) => row.category === 'escalated');
      expect(escalated?.name).toBe('Escalated');
      expect(escalated?.definition).toBe('High-value & stalled');
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-075 / V-093: the shared filter narrows the aggregate.
  // -------------------------------------------------------------------------------------------

  describe('filter application', () => {
    /** P1 carries L1, L2, L5; only L1 and L2 are open, so the open-pipeline sum drops L3's 500. */
    it('narrows every widget by product line', async () => {
      const payload = await overview({ ...PERIOD_QUERY, productLineId: String(corpus.productP1) });
      // L1 1200 (Q1) + L2 2500 (Q2) as open quotes... open quotes on P1 leads are
      // Q1 1200, Q4 100, Q7 50, Q8 150, Q9 25 = 1525; L3 (the only quote-less open lead) is P2.
      expect(kpi(payload, 'open_pipeline_premium').value).toBe(1525);
      expect(payload.pipelineByStage.map((row) => row.stageCanonicalKey)).toEqual([
        'new',
        'quote_sent',
      ]);
    });

    /** P2 carries L3 (open, no quote, 500 estimate) and L4 (won). */
    it('narrows to a product line whose open pipeline is estimate-only', async () => {
      const payload = await overview({ ...PERIOD_QUERY, productLineId: String(corpus.productP2) });
      expect(kpi(payload, 'open_pipeline_premium').value).toBe(500);
      expect(kpi(payload, 'total_leads').value).toBe(1);
    });

    /** B1 carries L1 and L3. */
    it('narrows by broker, excluding broker-less leads', async () => {
      const payload = await overview({ ...PERIOD_QUERY, brokerId: String(corpus.brokerB1) });
      expect(kpi(payload, 'total_leads').value).toBe(2);
      expect(
        payload.highValueOpportunities.map((row) => row.leadRef),
      ).toEqual([`${RUN}-L1`]);
    });

    /** R1 carries L1, L3, L5. */
    it('narrows by region', async () => {
      const payload = await overview({ ...PERIOD_QUERY, regionId: String(corpus.regionR1) });
      expect(kpi(payload, 'total_leads').value).toBe(3);
    });

    /** The RM dimension is an ASSIGNMENT to the tenant's `rm` slot, not a column on the lead. */
    it('narrows by the accountable RM through the assignment slot', async () => {
      const owned = await overview({ ...PERIOD_QUERY, rmUserId: String(rmOwnerUserId) });
      // rmOwner holds L1, L2, L3 -> three received in March.
      expect(kpi(owned, 'total_leads').value).toBe(3);

      const other = await overview({ ...PERIOD_QUERY, rmUserId: String(otherRmUserId) });
      // otherRm holds L4 (February) and L5 (March).
      expect(kpi(other, 'total_leads').value).toBe(1);
      expect(other.highValueOpportunities).toEqual([]);
    });

    /**
     * THE RM DIMENSION IS THE `rm` SLOT, NOT "any assignment on the lead".
     *
     * The seeded corpus cannot falsify this: it configures only an `rm` slot, so relaxing the slot
     * predicate changes nothing. The discriminating state is CONSTRUCTED — an `underwriter` slot is
     * configured, an underwriter is assigned to L3, and L3's RM row is then re-inserted so the
     * UNDERWRITER row carries the LOWER id. The owner lateral orders by id, so a slot predicate that
     * admitted both slots would now resolve L3's accountable owner to the underwriter.
     *
     * A lead's underwriter is not its RM. Counting an underwriter's leads under an RM filter would
     * inflate that RM's apparent pipeline with work they are not accountable for.
     */
    it('resolves the accountable owner from the rm SLOT, never from an underwriter assignment', async () => {
      const leadId = corpus.leadIdByKey.get('L3');
      const underwriterUserId = appUserId(outsider);

      const uwRole = await fixtures.createRole({ tenantId: tenantA });
      const uwSlotRows = await query<{ id: string }>(
        `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
         values ($1, 'underwriter', $2, now(), now()) returning id::text as id`,
        [tenantA, uwRole],
      );
      const uwSlotId = Number(uwSlotRows[0]?.id);

      await query(
        `insert into lead_assignments
           (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())`,
        [tenantA, leadId, uwSlotId, underwriterUserId],
      );
      // Re-insert L3's RM row so the underwriter row now has the LOWER id.
      await query(
        'delete from lead_assignments where tenant_id = $1 and lead_id = $2 and business_assignment_id = $3',
        [tenantA, leadId, corpus.rmAssignmentId],
      );
      await query(
        `insert into lead_assignments
           (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())`,
        [tenantA, leadId, corpus.rmAssignmentId, rmOwnerUserId],
      );

      try {
        // Filtering by the UNDERWRITER must match nothing: they are not accountable for any lead.
        const byUnderwriter = await overview({
          ...PERIOD_QUERY,
          rmUserId: String(underwriterUserId),
        });
        expect(kpi(byUnderwriter, 'total_leads').value).toBe(0);

        // And L3 must still be counted under its actual RM.
        const byRm = await overview({ ...PERIOD_QUERY, rmUserId: String(rmOwnerUserId) });
        expect(kpi(byRm, 'total_leads').value).toBe(3);
      } finally {
        await query(
          'delete from lead_assignments where tenant_id = $1 and business_assignment_id = $2',
          [tenantA, uwSlotId],
        );
        await query('delete from business_assignments where tenant_id = $1 and id = $2', [
          tenantA,
          uwSlotId,
        ]);
      }
    });

    /** Moving the window must move the numbers; a filter that changed nothing would be inert. */
    it('changes the period-scoped KPIs when the date range moves', async () => {
      const march = await overview(PERIOD_QUERY);
      const february = await overview({ from: '2026-02-01', to: '2026-02-28' });
      expect(kpi(march, 'total_leads').value).toBe(4);
      expect(kpi(february, 'total_leads').value).toBe(1);
      expect(kpi(february, 'won_premium').value).toBe(5000);
    });

    /** An unfiltered call defaults the period to the calendar month containing `today`. */
    it('defaults the period to the current calendar month when no range is supplied', async () => {
      const payload = await overview({});
      // April 2026 contains no fixture activity at all; March is the prior month.
      expect(kpi(payload, 'total_leads').value).toBe(0);
      expect(kpi(payload, 'total_leads').delta).toBe(-4);
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-022 / V-027 / V-096: tenant isolation and permission binding.
  // -------------------------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('never includes another tenant rows in any aggregate', async () => {
      const payload = await overview(PERIOD_QUERY);
      // Tenant B holds an identical corpus. If isolation failed every count would double.
      expect(kpi(payload, 'total_leads').value).toBe(4);
      expect(kpi(payload, 'total_quotes').value).toBe(8);
      expect(kpi(payload, 'open_pipeline_premium').value).toBe(2025);
      for (const row of payload.highValueOpportunities) {
        expect(row.leadRef.startsWith(`${RUN}-`)).toBe(true);
        expect(row.leadRef.startsWith(`${RUN}b-`)).toBe(false);
      }
    });

    it('reports each tenant own display currency for the same caller', async () => {
      expect((await overview(PERIOD_QUERY, tenantA)).currencyCode).toBe(CURRENCY);
      expect((await overview(PERIOD_QUERY, tenantB)).currencyCode).toBe('GBP');
    });

    it('scopes the alert-derived panels per tenant', async () => {
      // Tenant B was seeded with no alerts at all.
      const payload = await overview(PERIOD_QUERY, tenantB);
      expect(payload.requiresAttention.every((row) => row.count === 0)).toBe(true);
      expect(kpi(payload, 'leads_at_risk').value).toBe(0);
    });
  });

  describe('endpoint authorization', () => {
    it('serves the payload to a caller holding dashboards.view_executive', async () => {
      const response = await call(EXECUTIVE, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as ExecutiveOverviewDto;
      expect(body.currencyCode).toBe(CURRENCY);
      expect(body.kpis).toHaveLength(9);
    });

    it('refuses a caller without the dashboard permission', async () => {
      const response = await call(EXECUTIVE, {
        token: outsider.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      expect((await call(EXECUTIVE, { tenantId: tenantA })).status).toBe(401);
    });

    it('fails closed with no tenant header rather than aggregating unscoped', async () => {
      const response = await call(EXECUTIVE, { token: viewer.accessToken });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(200);
    });

    it('rejects a malformed filter with 400 rather than silently ignoring it', async () => {
      const response = await call(`${EXECUTIVE}?brokerId=abc`, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(400);
    });

    it('accepts all eight measured filter parameters on the wire', async () => {
      const params = new URLSearchParams({
        from: PERIOD.from,
        to: PERIOD.to,
        productLineId: String(corpus.productP1),
        brokerId: String(corpus.brokerB1),
        rmUserId: String(rmOwnerUserId),
        regionId: String(corpus.regionR1),
        teamOrRmId: String(rmOwnerUserId),
        brokerTypeId: String(corpus.brokerTypeT1),
      });
      const response = await call(`${EXECUTIVE}?${params.toString()}`, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(200);
    });

    /**
     * ACCEPTED IS ONLY HALF OF IT (V-093 second clause; F-036-04).
     *
     * The test above proves `brokerTypeId` does not 400. It cannot prove the parameter is INERT —
     * and inert is what `snapshotPredicates()` in snapshot.ts deliberately makes it, because the
     * reference's ExecutiveDashboardStore applies exactly product line, broker and region. Without
     * an unchanged-assertion, an erasure that was FORGOTTEN looks identical to one that was chosen.
     *
     * The value is proven DISCRIMINATING first: `toEqual` over the whole payload passes vacuously if
     * the chosen broker type happens to match every lead.
     */
    it('leaves the whole payload UNCHANGED by brokerTypeId, which this dashboard deliberately does not apply', async () => {
      const [split] = await query<{ matching: string; total: string }>(
        `select count(*) filter (where b.broker_type_id = $2)::text as matching,
                count(*)::text as total
           from leads l
           left join brokers b on b.tenant_id = l.tenant_id and b.id = l.broker_id
          where l.tenant_id = $1`,
        [tenantA, corpus.brokerTypeT1],
      );
      // B1 (Tier 1) carries L1 and L3; B2 (Tier 2) carries L2 and L5; L4 carries no broker at all.
      // A proper, non-empty subset — applying the dimension would move every population KPI.
      expect(split).toEqual({ matching: '2', total: '5' });

      const filtered = await overview({
        ...PERIOD_QUERY,
        brokerTypeId: String(corpus.brokerTypeT1),
      });
      expect(filtered).toEqual(await overview(PERIOD_QUERY));
    });
  });

  // -------------------------------------------------------------------------------------------
  // N-04: the informal performance budget.
  // -------------------------------------------------------------------------------------------

  describe('performance', () => {
    it('builds the whole payload inside the two-second seed-volume budget', async () => {
      const started = Date.now();
      await overview(PERIOD_QUERY);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
