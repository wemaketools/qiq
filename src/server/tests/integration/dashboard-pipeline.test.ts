/**
 * The Pipeline & Conversion dashboard endpoint (T-036; AC-022, AC-074, AC-075, AC-077, AC-079;
 * V-027, V-092, V-093, V-094, V-096, V-097, V-100).
 *
 * Port target: `GetPipelineDashboardQueryHandler.cs` + `PipelineDashboardStore.cs`, with the wire
 * shape pinned against the SPA's own `src/ui/src/features/dashboards/pipelineApi.ts`.
 *
 * THE AGING SCHEME THIS ENDPOINT MUST EMIT IS THE **PIPELINE** SIX-BUCKET ONE
 * ==========================================================================
 * `0-3 / 4-7 / 8-14 / 15-30 / 31-60 / 60+` (GetPipelineDashboardQueryHandler.cs:273-284), NOT the
 * Executive Overview's four-bucket `0-3 days .. 15+ days`. Same task owns both dashboards, so the
 * conflation is one keystroke away; the labels are asserted literally and the counterpart scheme is
 * asserted ABSENT.
 *
 * TWO KPIS HERE ARE DELIBERATELY NOT PERIOD-SCOPED, AND THAT IS MEASURED
 * =====================================================================
 * `quote_to_proposal_rate`, `proposal_to_win_rate` and `lead_to_quote_rate` are computed over the
 * WHOLE filtered snapshot, not over the selected date window (`:88-95` takes no range). Only
 * `new_leads_this_month` and `quotes_issued_this_month` are period-scoped. That asymmetry is easy
 * to "fix" into consistency and would silently change three shipped numbers, so it is pinned.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXECUTIVE_AGING_BUCKETS,
  PIPELINE_AGING_BUCKETS,
  dashboardFilterSchema,
  getPipelineDashboard,
  pipelineDashboardRoutes,
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
import {
  seedAlert,
  seedExecPipelineCorpus,
  type CorpusIds,
} from './helpers/exec-pipeline-corpus.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('dashboard-pipeline', probe);

const PIPELINE = '/api/v1/dashboards/pipeline';

const fixture = loadMetricFixture();
const NOW = new Date(`${fixture.today}T00:00:00Z`);
const PERIOD = fixture.period;

const RUN = `t36p-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

const CURRENCY = 'KES';
const HIGH_VALUE_THRESHOLD = '1000.00';
/** Q4 (25 days unsent) breaches it; Q9 (exactly 3 days) does not. */
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
      "select id::text as id from tenants where name like 't36p-%'",
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
        api.route('/', pipelineDashboardRoutes({ db }));
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

  function pipeline(
    filterQuery: Record<string, string> = {},
    tenantId = tenantA,
  ): Promise<PipelineDashboardDto> {
    return getPipelineDashboard(
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

  const PERIOD_QUERY: Record<string, string> = { from: PERIOD.from, to: PERIOD.to };

  function kpi(payload: PipelineDashboardDto, key: string): PipelineDashboardDto['kpis'][number] {
    const found = payload.kpis.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`no pipeline KPI '${key}' in payload`);
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
      label: 'pipe-viewer',
      firstName: 'Eve',
      lastName: 'Victor',
    });
    outsider = await auth.createTestUserWithSession({
      label: 'pipe-outsider',
      firstName: 'Fay',
      lastName: 'Uniform',
    });
    const rmOwner = await auth.createTestUserWithSession({
      label: 'pipe-rm',
      firstName: 'Gil',
      lastName: 'Tango',
    });
    const otherRm = await auth.createTestUserWithSession({
      label: 'pipe-rm2',
      firstName: 'Hal',
      lastName: 'Sierra',
    });

    for (const session of [viewer, outsider, rmOwner, otherRm]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(viewer), tenantB);

    await fixtures.grantDirectPermission(appUserId(viewer), 'dashboards.view_pipeline', tenantA);
    await fixtures.grantDirectPermission(appUserId(viewer), 'dashboards.view_pipeline', tenantB);
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

    // Data deletion MUST precede `auth.cleanup()`; see dashboard-executive.test.ts.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  });

  // -------------------------------------------------------------------------------------------
  // AC-079 / V-100: the wire contract.
  // -------------------------------------------------------------------------------------------

  describe('payload contract', () => {
    it('returns exactly the nine top-level fields the SPA reads', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(Object.keys(payload).sort()).toEqual([
        'agingByStage',
        'atRiskPipeline',
        'currencyCode',
        'immediateActions',
        'kpis',
        'leadVolumeByChannel',
        'pipelineByProductLine',
        'quoteVolumeBySource',
        'stageConversionFunnel',
      ]);
    });

    it('carries no generatedAt field, matching the reference DTO and the SPA interface', async () => {
      expect(await pipeline(PERIOD_QUERY)).not.toHaveProperty('generatedAt');
    });

    it('emits the nine KPI cards in the reference order', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(payload.kpis.map((entry) => entry.key)).toEqual([
        'new_leads_this_month',
        'open_pipeline_value',
        'quote_to_proposal_rate',
        'proposal_to_win_rate',
        'average_quote_age',
        'sla_breaches',
        'quotes_issued_this_month',
        'lead_to_quote_rate',
        'average_lead_age',
      ]);
    });

    it('labels every KPI with its lead-vs-quote basis and render kind', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(
        Object.fromEntries(
          payload.kpis.map((entry) => [entry.key, [entry.leadOrQuote, entry.kind, entry.label]]),
        ),
      ).toEqual({
        new_leads_this_month: ['lead', 'count', 'New Leads This Month'],
        open_pipeline_value: ['quote', 'currency', 'Open Pipeline Value'],
        quote_to_proposal_rate: ['quote', 'percent', 'Quote-to-Proposal Rate'],
        proposal_to_win_rate: ['quote', 'percent', 'Proposal-to-Win Rate'],
        average_quote_age: ['quote', 'days', 'Average Quote Age'],
        sla_breaches: ['quote', 'count', 'SLA Breaches'],
        quotes_issued_this_month: ['quote', 'count', 'Quotes Issued This Month'],
        lead_to_quote_rate: ['lead', 'percent', 'Lead-to-Quote Rate'],
        average_lead_age: ['lead', 'days', 'Average Lead Age'],
      });
    });

    it('reports the tenant display currency', async () => {
      expect((await pipeline(PERIOD_QUERY)).currencyCode).toBe(CURRENCY);
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-074 / V-092: exact KPI values.
  // -------------------------------------------------------------------------------------------

  describe('KPI values', () => {
    /** L1,L2,L3,L5 in March = 4; prior equal-length window holds L4 alone = 1. */
    it('counts LEADS received in the period with its prior-period delta', async () => {
      const card = kpi(await pipeline(PERIOD_QUERY), 'new_leads_this_month');
      expect(card.value).toBe(fixture.expected.totalLeadsReceived);
      expect(card.value).toBe(4);
      expect(card.delta).toBe(3);
      expect(card.isFavorableDelta).toBe(true);
    });

    /** Q1,Q2,Q3,Q4,Q6,Q7,Q8,Q9 = 8; prior holds Q5 = 1. */
    it('counts QUOTES prepared in the period, a different population from New Leads', async () => {
      const card = kpi(await pipeline(PERIOD_QUERY), 'quotes_issued_this_month');
      expect(card.value).toBe(fixture.expected.totalQuotesPrepared);
      expect(card.value).toBe(8);
      expect(card.delta).toBe(7);
    });

    it('agrees with the Executive Overview on Open Pipeline Premium', async () => {
      const card = kpi(await pipeline(PERIOD_QUERY), 'open_pipeline_value');
      expect(card.value).toBe(Number(fixture.expected.openPipelinePremium));
      expect(card.value).toBe(2025);
      expect(card.delta).toBeNull();
    });

    /**
     * NOT period-scoped (measured, `:88-91`): 5 of the 9 snapshot quotes carry a sent date
     * (Q1, Q2, Q3, Q5, Q6). Period-scoping would give 4/8 = 0.5, which is the fixture's
     * `quoteToProposalRate` — asserted here to be DIFFERENT so the scoping cannot silently change.
     */
    it('computes Quote-to-Proposal Rate over the whole snapshot, not the period', async () => {
      const card = kpi(await pipeline(PERIOD_QUERY), 'quote_to_proposal_rate');
      expect(card.value).toBe(5 / 9);
      expect(card.value).not.toBe(fixture.expected.quoteToProposalRate);
    });

    /** Won quotes Q2 and Q5 = 2, over the 5 sent quotes. */
    it('computes Proposal-to-Win Rate over sent quotes', async () => {
      expect(kpi(await pipeline(PERIOD_QUERY), 'proposal_to_win_rate').value).toBe(0.4);
    });

    /** 4 of the 5 snapshot leads carry a quote (L3 does not). */
    it('computes Lead-to-Quote Rate over LEADS across the whole snapshot', async () => {
      expect(kpi(await pipeline(PERIOD_QUERY), 'lead_to_quote_rate').value).toBe(0.8);
    });

    /** Open leads L1 30, L2 27, L3 21 days old at 2026-04-01 -> 78/3. */
    it('averages open LEAD age from date received', async () => {
      const card = kpi(await pipeline(PERIOD_QUERY), 'average_lead_age');
      expect(card.value).toBe(fixture.expected.averageLeadAgeDays);
      expect(card.value).toBe(26);
      expect(card.goodDirection).toBe('lowerIsBetter');
    });

    /** Open quotes that have been SENT: Q1 alone (2026-03-05) -> 27 days. */
    it('averages open QUOTE age from the sent date, excluding unsent quotes', async () => {
      expect(kpi(await pipeline(PERIOD_QUERY), 'average_quote_age').value).toBe(27);
    });

    it('reads SLA breaches from the open alert counts', async () => {
      const card = kpi(await pipeline(PERIOD_QUERY), 'sla_breaches');
      expect(card.value).toBe(1);
      expect(card.goodDirection).toBe('lowerIsBetter');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Funnel, stacks, donuts, heatmap.
  // -------------------------------------------------------------------------------------------

  describe('stage conversion funnel', () => {
    /**
     * Progression leads (open|quoted|won) are L1 new, L3 new, L2 quote_sent, L4 closed_won = 4.
     * "Reached stage S" is cumulative over the lifecycle order: new 4, quote_sent 2, closed_won 1.
     */
    it('reports cumulative reached-stage counts with conversion from the top', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(
        payload.stageConversionFunnel.map((bar) => [
          bar.stageCanonicalKey,
          bar.reachedCount,
          bar.conversionFromTop,
          bar.isLost,
        ]),
      ).toEqual([
        ['new', 4, 1, false],
        ['quote_sent', 2, 0.5, false],
        ['closed_won', 1, 0.25, false],
        ['closed_lost', 1, 0.25, true],
      ]);
    });

    it('renders the terminal Lost bar last and marks it, excluding it from the progression', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const lost = payload.stageConversionFunnel.at(-1);
      expect(lost?.isLost).toBe(true);
      expect(payload.stageConversionFunnel.filter((bar) => bar.isLost)).toHaveLength(1);
      // L5 is the only lost lead and must NOT appear in the progression denominator of 4.
      expect(payload.stageConversionFunnel[0]?.reachedCount).toBe(4);
    });

    it('is monotonically non-increasing across the progression bars', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const progression = payload.stageConversionFunnel.filter((bar) => !bar.isLost);
      for (let index = 1; index < progression.length; index += 1) {
        expect(progression[index]!.reachedCount).toBeLessThanOrEqual(
          progression[index - 1]!.reachedCount,
        );
      }
    });
  });

  describe('pipeline by product line', () => {
    /** Open leads: L1 1200 + L2 2500 on P1, L3 500 on P2. Legend orders by contribution desc. */
    it('orders the product-line legend by open-pipeline contribution', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(payload.pipelineByProductLine.productLines).toEqual([
        corpus.productP1Name,
        corpus.productP2Name,
      ]);
    });

    it('emits six monthly columns ending with the current month', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(payload.pipelineByProductLine.columns.map((column) => column.monthLabel)).toEqual([
        'Nov 2025',
        'Dec 2025',
        'Jan 2026',
        'Feb 2026',
        'Mar 2026',
        'Apr 2026',
      ]);
    });

    /** All three open leads were received in March, so every other column is exactly zero. */
    it('stacks each month open pipeline value by product line', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const march = payload.pipelineByProductLine.columns.find((c) => c.monthLabel === 'Mar 2026');
      expect(march?.segments.map((s) => [s.productLineName, s.value])).toEqual([
        [corpus.productP1Name, 3700],
        [corpus.productP2Name, 500],
      ]);
      expect(march?.monthlyTotal).toBe(4200);

      const april = payload.pipelineByProductLine.columns.find((c) => c.monthLabel === 'Apr 2026');
      expect(april?.monthlyTotal).toBe(0);
      // Every legend entry keeps a segment even when it contributes nothing, so the stacked series
      // stay aligned across columns.
      expect(april?.segments).toHaveLength(2);
    });
  });

  describe('volume donuts', () => {
    /** Quote source = the broker its LEAD came through: B2 4, B1 3, Direct 2 of 9. */
    it('groups QUOTE volume by broker source, labelling unbrokered quotes Direct', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(
        payload.quoteVolumeBySource.slices.map((slice) => [slice.label, slice.count, slice.share]),
      ).toEqual([
        [corpus.brokerB2Name, 4, 0.4444],
        [corpus.brokerB1Name, 3, 0.3333],
        ['Direct', 2, 0.2222],
      ]);
    });

    /** Lead channel: C1 holds L1,L2,L3 and C2 holds L4,L5. */
    it('groups LEAD volume by request channel, a different count from the quote donut', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(
        payload.leadVolumeByChannel.slices.map((slice) => [slice.label, slice.count, slice.share]),
      ).toEqual([
        [corpus.channelC1Name, 3, 0.6],
        [corpus.channelC2Name, 2, 0.4],
      ]);
      // Nine quotes but five leads: conflating the two populations would show 9 here.
      expect(
        payload.leadVolumeByChannel.slices.reduce((total, slice) => total + slice.count, 0),
      ).toBe(5);
    });
  });

  describe('aging by stage heatmap', () => {
    /** THE PIPELINE SIX-BUCKET SCHEME, plus the Total column. */
    it('emits the PIPELINE six-bucket scheme with a Total column', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(payload.agingByStage.buckets).toEqual([...PIPELINE_AGING_BUCKETS, 'Total']);
    });

    it('does NOT emit the Executive four-bucket scheme', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      for (const label of EXECUTIVE_AGING_BUCKETS) {
        expect(payload.agingByStage.buckets).not.toContain(label);
      }
      expect(payload.agingByStage.buckets).toContain('60+');
    });

    /** Open stages only: new and quote_sent. Won/Lost/Expired rows are omitted. */
    it('lists only OPEN lifecycle stages as rows', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(payload.agingByStage.stages.map((stage) => stage.stageCanonicalKey)).toEqual([
        'new',
        'quote_sent',
      ]);
    });

    /** Lead ages at 2026-04-01: L1 30 and L3 21 (both `new`), L2 27 (`quote_sent`) -> all 15-30. */
    it('places each open lead in its age bucket and grades the cell', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const newStage = corpus.statusNameByCategory.get('open');
      const cells = payload.agingByStage.cells.filter((cell) => cell.stageName === newStage);

      expect(cells.map((cell) => [cell.bucket, cell.count, cell.grade])).toEqual([
        ['0-3', 0, 'normal'],
        ['4-7', 0, 'normal'],
        ['8-14', 0, 'normal'],
        ['15-30', 2, 'amber'],
        ['31-60', 0, 'normal'],
        ['60+', 0, 'normal'],
        ['Total', 2, 'normal'],
      ]);
    });

    it('grades an empty cell normal regardless of how hot its bucket is', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const hotEmpty = payload.agingByStage.cells.filter(
        (cell) => cell.bucket === '60+' && cell.count === 0,
      );
      expect(hotEmpty.length).toBeGreaterThan(0);
      for (const cell of hotEmpty) expect(cell.grade).toBe('normal');
    });
  });

  describe('at-risk pipeline', () => {
    /** Open leads carrying open alerts: L2 (2500) then L1 (1200), richest first. */
    it('lists open leads with open alerts, ordered by premium', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(
        payload.atRiskPipeline.map((row) => [row.leadRef, row.premium, row.ageDays]),
      ).toEqual([
        [`${RUN}-L2`, 2500, 27],
        [`${RUN}-L1`, 1200, 30],
      ]);
    });

    /** L2 carries both overdue_follow_up and executive_escalation; the escalation outranks. */
    it('picks the most severe alert type as the row risk reason and action', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const byRef = Object.fromEntries(payload.atRiskPipeline.map((row) => [row.leadRef, row]));
      expect(byRef[`${RUN}-L2`]?.riskReason).toBe('Executive escalation');
      expect(byRef[`${RUN}-L2`]?.suggestedAction).toBe('Executive review');
      expect(byRef[`${RUN}-L1`]?.riskReason).toBe('SLA breach');
      expect(byRef[`${RUN}-L1`]?.suggestedAction).toBe('Escalate to underwriting');
    });

    it('excludes leads whose only alert is resolved, and closed leads entirely', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const refs = payload.atRiskPipeline.map((row) => row.leadRef);
      // L4's stalled_lead alert is resolved AND L4 is won.
      expect(refs).not.toContain(`${RUN}-L4`);
      expect(refs).not.toContain(`${RUN}-L5`);
    });

    it('leaves tenantName null outside Internal cross-tenant mode', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      for (const row of payload.atRiskPipeline) expect(row.tenantName).toBeNull();
    });
  });

  describe('immediate actions', () => {
    /**
     * Q-8 overdue quotes: pre-sent OPEN quotes older than the tenant's prepared-to-sent target.
     * Unsent open quotes at 2026-04-01 are Q4 25d, Q9 3d, Q7 2d, Q8 1d; with a 3-day target only
     * Q4 is STRICTLY over. Q9 sits exactly ON the target and must not count.
     */
    it('counts overdue quotes strictly beyond the tenant SLA target', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      const byCategory = Object.fromEntries(
        payload.immediateActions.map((action) => [action.category, action.count]),
      );
      expect(byCategory['overdue_quotes']).toBe(1);
    });

    it('reports the eight action categories with their alert-derived counts', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(
        payload.immediateActions.map((action) => [action.category, action.count, action.tab]),
      ).toEqual([
        ['overdue_quotes', 1, 'sla'],
        ['pending_pricing_approvals', 0, 'sla'],
        ['exec_escalations', 1, 'escalated'],
        ['sla_breaches', 1, 'sla'],
        ['unassigned_leads', 0, 'all'],
        ['overdue_follow_ups', 1, 'overdue'],
        ['expiring_quotes', 0, 'expiring'],
        ['follow_ups_due_today', 0, 'overdue'],
      ]);
    });

    /** Falsifies the follow-ups-due-today counter, which reads 0 on the untouched corpus. */
    it('counts open leads whose next follow-up falls exactly on today', async () => {
      const leadId = corpus.leadIdByKey.get('L3');
      await query('update leads set next_follow_up_date = $2 where tenant_id = $1 and id = $3', [
        tenantA,
        fixture.today,
        leadId,
      ]);
      try {
        const payload = await pipeline(PERIOD_QUERY);
        const dueToday = payload.immediateActions.find(
          (action) => action.category === 'follow_ups_due_today',
        );
        expect(dueToday?.count).toBe(1);
      } finally {
        await query('update leads set next_follow_up_date = null where tenant_id = $1 and id = $2', [
          tenantA,
          leadId,
        ]);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-075 / V-093: filters.
  // -------------------------------------------------------------------------------------------

  describe('filter application', () => {
    it('narrows every widget by product line', async () => {
      const payload = await pipeline({ ...PERIOD_QUERY, productLineId: String(corpus.productP2) });
      // P2 holds L3 (open, 500) and L4 (won). Open pipeline is L3's estimate alone.
      expect(kpi(payload, 'open_pipeline_value').value).toBe(500);
      expect(payload.pipelineByProductLine.productLines).toEqual([corpus.productP2Name]);
    });

    it('narrows by broker', async () => {
      const payload = await pipeline({ ...PERIOD_QUERY, brokerId: String(corpus.brokerB2) });

      // B2 holds L2 and L5. Open QUOTE premium across them is Q4 100 + Q8 150 + Q9 25 = 275;
      // L2's won Q2 (2500) is not open, and no open lead here lacks a quote, so nothing is added
      // from estimates.
      //
      // THIS IS DELIBERATELY NOT 2500. `open_pipeline_value` sums the premium of OPEN QUOTES, while
      // the at-risk row and the product-line stack below value L2 at its CURRENT quote's 2500. Those
      // are two different measures over two different populations, and asserting the same number for
      // both is exactly the conflation this dashboard must not make.
      expect(kpi(payload, 'open_pipeline_value').value).toBe(275);

      const atRisk = payload.atRiskPipeline;
      expect(atRisk.map((row) => row.leadRef)).toEqual([`${RUN}-L2`]);
      expect(atRisk[0]?.premium).toBe(2500);
    });

    it('narrows by region', async () => {
      const payload = await pipeline({ ...PERIOD_QUERY, regionId: String(corpus.regionR2) });
      // R2 holds L2 and L4.
      expect(kpi(payload, 'new_leads_this_month').value).toBe(1);
    });

    it('narrows by the accountable RM through the assignment slot', async () => {
      const owned = await pipeline({ ...PERIOD_QUERY, rmUserId: String(rmOwnerUserId) });
      expect(kpi(owned, 'new_leads_this_month').value).toBe(3);

      const other = await pipeline({ ...PERIOD_QUERY, rmUserId: String(otherRmUserId) });
      expect(kpi(other, 'new_leads_this_month').value).toBe(1);
      expect(other.atRiskPipeline).toEqual([]);
    });

    /**
     * THE DELIBERATE ERASURE (V-093 second clause; F-036-04).
     *
     * `snapshotPredicates()` applies exactly product line, broker, region and the RM slot — the
     * dimensions the reference's PipelineDashboardStore applies. `brokerTypeId` is BOUND on the
     * route (the SPA's filter bar is shared across five dashboards and a stale selection must not
     * 400) and then goes nowhere. That has to be asserted, not merely commented: an erasure nobody
     * tests reads exactly like one nobody wrote.
     */
    it('accepts brokerTypeId and leaves the payload unchanged, because this dashboard ignores it', async () => {
      const [split] = await query<{ matching: string; total: string }>(
        `select count(*) filter (where b.broker_type_id = $2)::text as matching,
                count(*)::text as total
           from leads l
           left join brokers b on b.tenant_id = l.tenant_id and b.id = l.broker_id
          where l.tenant_id = $1`,
        [tenantA, corpus.brokerTypeT1],
      );
      // Tier 1 selects L1 and L3 of the five leads — a proper, non-empty subset. Were the dimension
      // applied, `new_leads_this_month` would fall from 4 and the funnel would lose whole stages,
      // so this value can distinguish an erased filter from an applied one.
      expect(split).toEqual({ matching: '2', total: '5' });

      const filtered = await pipeline({
        ...PERIOD_QUERY,
        brokerTypeId: String(corpus.brokerTypeT1),
      });
      expect(filtered).toEqual(await pipeline(PERIOD_QUERY));
    });

    it('moves the period-scoped KPIs when the date range moves', async () => {
      const february = await pipeline({ from: '2026-02-01', to: '2026-02-28' });
      expect(kpi(february, 'new_leads_this_month').value).toBe(1);
      expect(kpi(february, 'quotes_issued_this_month').value).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // AC-022 / V-027 / V-096.
  // -------------------------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('never includes another tenant rows in any aggregate', async () => {
      const payload = await pipeline(PERIOD_QUERY);
      expect(kpi(payload, 'new_leads_this_month').value).toBe(4);
      expect(kpi(payload, 'open_pipeline_value').value).toBe(2025);
      for (const row of payload.atRiskPipeline) {
        expect(row.leadRef.startsWith(`${RUN}-`)).toBe(true);
        expect(row.leadRef.startsWith(`${RUN}b-`)).toBe(false);
      }
      // Tenant B's reference data must not appear in tenant A's legend or donuts.
      expect(payload.pipelineByProductLine.productLines).toEqual([
        corpus.productP1Name,
        corpus.productP2Name,
      ]);
    });

    it('scopes the alert-derived widgets per tenant', async () => {
      const payload = await pipeline(PERIOD_QUERY, tenantB);
      expect(payload.atRiskPipeline).toEqual([]);
      expect(kpi(payload, 'sla_breaches').value).toBe(0);
      expect(payload.currencyCode).toBe('GBP');
    });

    it('scopes the aging heatmap stages to the tenant own statuses', async () => {
      const payload = await pipeline(PERIOD_QUERY, tenantB);
      for (const stage of payload.agingByStage.stages) {
        expect(stage.stageName).not.toBe(corpus.statusNameByCategory.get('open'));
      }
    });
  });

  describe('endpoint authorization', () => {
    it('serves the payload to a caller holding dashboards.view_pipeline', async () => {
      const response = await call(PIPELINE, { token: viewer.accessToken, tenantId: tenantA });
      expect(response.status).toBe(200);
      const body = (await response.json()) as PipelineDashboardDto;
      expect(body.currencyCode).toBe(CURRENCY);
      expect(body.kpis).toHaveLength(9);
    });

    it('refuses a caller without the dashboard permission', async () => {
      const response = await call(PIPELINE, { token: outsider.accessToken, tenantId: tenantA });
      expect(response.status).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      expect((await call(PIPELINE, { tenantId: tenantA })).status).toBe(401);
    });

    it('fails closed with no tenant header', async () => {
      const response = await call(PIPELINE, { token: viewer.accessToken });
      expect(response.status).not.toBe(200);
    });

    it('rejects a malformed filter with 400', async () => {
      const response = await call(`${PIPELINE}?regionId=-3`, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(400);
    });
  });

  describe('performance', () => {
    it('builds the whole payload inside the two-second seed-volume budget', async () => {
      const started = Date.now();
      await pipeline(PERIOD_QUERY);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
