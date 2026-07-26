/**
 * Report endpoints: the catalog, every catalogued report's print-ready view, the per-report CSVs,
 * tenant isolation, visibility breadth, the permission matrix, the cross-tenant export gate and the
 * audit row (T-040; AC-022, AC-083; V-027, V-106).
 *
 * ASSERTIONS ARE ON VALUES AND BYTES, NOT ON SHAPE
 * ===============================================
 * "200 OK with some sections" is exactly the assertion that cannot distinguish a working report from
 * one that returns the wrong population, or nothing at all. So the fixtures below seed a corpus
 * whose expected ages, buckets, breach counts, premiums and row ORDER are computed here — by hand,
 * from the seed — and asserted literally. If a report returned zero rows, or every row, the value
 * tests die rather than the shape tests passing.
 *
 * EVERY CATALOG KEY IS RENDERED, NOT A REPRESENTATIVE ONE
 * ======================================================
 * `renders every catalogued report` loops over `REPORT_CATALOG` and drives BOTH the view and the CSV
 * for all ten keys. That is deliberate and it is the lesson of the drill-widget failure this
 * codebase already shipped: 31 catalogued keys, one wired, missed by three implementors because
 * every test pointed at the key that worked. A catalog that lists reports nothing can render is the
 * same defect wearing a different name.
 *
 * THE INJECTION FIXTURE IS SEEDED HOSTILE, AND THE OVER-GUARD FIXTURE IS SEEDED NEGATIVE
 * =====================================================================================
 * A guard test whose fixture contains no dangerous value proves nothing, and a guard test with no
 * negative number cannot catch the opposite failure — a guard applied to money, turning `-500` into
 * the text `'-500`. Both fixtures are in the ordinary corpus so they appear in an ordinary report.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { REPORT_CATALOG } from '../../domains/reports/catalog.js';
import { EXPORT_ACTION } from '../../domains/exports/service.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

import type { ReportViewDto } from '../../domains/reports/contracts.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('reports', probe);

const BASE = '/api/v1/reports';

/** THE HOSTILE FIXTURE: a client name that is a live spreadsheet formula (AC-081 on report CSVs). */
const INJECTED_PARTY_NAME = '=HYPERLINK("http://evil","x")';
/** Guarded AND RFC-4180 quoted — it also carries a comma and double quotes, so both defences compose. */
const INJECTED_CSV_GUARDED = '"\'=HYPERLINK(""http://evil"",""x"")"';
/** The byte sequence that must appear nowhere in any report CSV. */
const INJECTED_CSV_UNGUARDED = '"=HYPERLINK(""http://evil"",""x"")"';

/** Short, for the trigram reason documented in leads-core.test.ts. */
const RUN = `t40x-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix} ${RUN}-${nameSequence}`;
}

/** `yyyy-MM-dd` N days before the UTC date the endpoints compute "today" from. */
function daysAgo(days: number): string {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds every report permission AND `leads.view_all`: sees the whole tenant. */
  let broad: TestUserSession;
  /** Holds `reports.view` + `dashboards.view_pipeline` but NOT `leads.view_all`: the breadth fixture. */
  let restricted: TestUserSession;
  /** Holds ONLY `reports.view`: sees an empty catalog and may open nothing. */
  let bare: TestUserSession;
  /** Internal: cross-tenant reporting WITHOUT `global.cross_tenant_export`. */
  let internal: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;

  const createdTenants: number[] = [];

  const OWNED_TABLES = [
    'lead_status_history',
    'lead_assignments',
    'quote_versions',
    'quotes',
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
      "select id::text as id from tenants where name like 't40x-%'",
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

  /** SLA thresholds are seeded EXPLICITLY: the breach counts below are computed against them. */
  async function seedSettings(tenantId: number, currencyCode: string): Promise<void> {
    await query(
      `insert into tenant_settings
         (tenant_id, currency_code, currency_symbol, high_value_threshold,
          sla_assignment_days, sla_underwriting_days, sla_received_to_sent_days,
          created_at, updated_at)
       values ($1, $2, $3, 1000000, 1, 3, 5, now(), now())`,
      [tenantId, currencyCode, currencyCode === 'BWP' ? 'P' : '$'],
    );
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
    options: {
      productLineId?: number | null;
      reportingCategory?: string | null;
      canonicalKey?: string | null;
      isActive?: boolean;
    } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          product_line_id, created_at, updated_at)
       values ($1, $2, $3, 0, $4, $5, $6, $7, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        options.isActive ?? true,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.productLineId ?? null,
      ],
    );
    return Number(rows[0]?.id);
  }

  async function seedParty(tenantId: number, name: string, partyTypeId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into parties
         (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, name, partyTypeId],
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
    readonly estimatedPremium?: number | null;
    readonly dateReceived: string;
    /**
     * How many days ago the ROW was created. Distinct from `dateReceived` on purpose: the
     * reference's Assignment and Received→Sent breach predicates measure from `leads.created_at`,
     * NOT from `date_received` (SlaTurnaroundReportQueryHandler.cs:97-108). Leaving this at "now"
     * made the Received→Sent assertion VACUOUS — every seeded lead was trivially inside the target,
     * so the predicate could have been anything and the test would still have passed.
     */
    readonly createdDaysAgo: number;
  }

  async function seedLead(tenantId: number, lead: SeedLead): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into leads
         (tenant_id, party_id, lead_ref, date_received, request_channel_id, region_id,
          product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
          source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'm12', 'normal', $10, 'browser',
               now() - ($11 || ' days')::interval, now())
       returning id::text as id`,
      [
        tenantId,
        lead.partyId,
        lead.leadRef,
        lead.dateReceived,
        lead.requestChannelId,
        lead.regionId,
        lead.productLineId,
        lead.coverTypeId,
        lead.estimatedPremium ?? null,
        lead.statusId,
        String(lead.createdDaysAgo),
      ],
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

  /** A status-history row, which is the ONLY source of the underwriting entered/exited window. */
  async function seedStatusHistory(
    tenantId: number,
    leadId: number,
    newStatusId: number,
    daysAgoActed: number,
  ): Promise<void> {
    await query(
      `insert into lead_status_history
         (tenant_id, lead_id, new_status_id, operation, acted_at)
       values ($1, $2, $3, 'change-status', now() - ($4 || ' days')::interval)`,
      [tenantId, leadId, newStatusId, String(daysAgoActed)],
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
      // The REAL slot, so this suite exercises the mount in app.ts rather than a private router.
      reports: { db },
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

  async function view(
    session: TestUserSession,
    key: string,
    queryString = '',
    tenantId = tenantA,
  ): Promise<ReportViewDto> {
    const response = await call(`${BASE}/${key}${queryString}`, {
      token: session.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as ReportViewDto;
  }

  async function csv(
    session: TestUserSession,
    key: string,
    queryString = '',
    tenantId = tenantA,
  ): Promise<string> {
    const response = await call(`${BASE}/${key}/csv${queryString}`, {
      token: session.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return new TextDecoder('utf-8').decode(await response.arrayBuffer());
  }

  /** The data rows of a downloaded CSV: everything after the column-header row. */
  function dataLines(text: string, headerPrefix: string): string[] {
    // CRLF, pinned by T-039 to RFC-4180.
    const lines = text.split('\r\n');
    const headerIndex = lines.findIndex((line) => line.startsWith(headerPrefix));
    expect(headerIndex).toBeGreaterThan(0);
    return lines.slice(headerIndex + 1).filter((line) => line !== '');
  }

  function sectionOf(payload: ReportViewDto, key: string): ReportViewDto['sections'][number] {
    const section = payload.sections.find((candidate) => candidate.key === key);
    if (section === undefined) {
      throw new Error(`report ${payload.key} has no section '${key}'`);
    }
    return section;
  }

  // Fixtures.
  let openStatusA = 0;
  let underwritingStatusA = 0;
  let rmAssignmentA = 0;
  let productLineA = 0;

  /** The three tenant-A lead refs, and the ages/buckets computed from the seed, not from the code. */
  const REF_OLD = `${RUN}-L1`; // received 20 days ago -> 15+ days
  const REF_UW = `${RUN}-L2`; // received 10 days ago -> 8-14 days, in underwriting for 10 days
  const REF_INJECTED = `${RUN}-L3`; // received 2 days ago -> 0-3 days, injected party, -500 premium
  const TENANT_B_MARKER = `${RUN}-BLEAD`;

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
    await seedSettings(tenantA, 'BWP');
    await seedSettings(tenantB, 'USD');

    broad = await auth.createTestUserWithSession({
      label: 'rep-broad',
      firstName: 'Ada',
      lastName: 'Zulu',
    });
    restricted = await auth.createTestUserWithSession({
      label: 'rep-restricted',
      firstName: 'Bea',
      lastName: 'Yankee',
    });
    bare = await auth.createTestUserWithSession({
      label: 'rep-bare',
      firstName: 'Cal',
      lastName: 'Xray',
    });
    internal = await auth.createTestUserWithSession({
      label: 'rep-internal',
      firstName: 'Dee',
      lastName: 'Whisky',
    });

    for (const session of [broad, restricted, bare]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(broad), tenantB);

    for (const tenantId of [tenantA, tenantB]) {
      for (const permission of [
        'reports.view',
        'leads.view',
        'leads.view_all',
        'dashboards.view_executive',
        'dashboards.view_pipeline',
        'dashboards.view_broker_performance',
        'dashboards.view_rm_performance',
        'dashboards.view_loss_analysis',
        'alerts.view',
        'tenants.manage_settings',
      ] as const) {
        await fixtures.grantDirectPermission(appUserId(broad), permission, tenantId);
      }
    }
    // The internal report is global-scoped, so its permission is granted at the global scope.
    await fixtures.grantDirectPermission(appUserId(broad), 'global.cross_tenant_reporting', null);
    await fixtures.grantDirectPermission(appUserId(broad), 'global.cross_tenant_export', null);

    // NO `leads.view_all` — the breadth fixture. Pipeline permission only, so the catalog it sees
    // is also the permission-filtering fixture.
    await fixtures.grantDirectPermission(appUserId(restricted), 'reports.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(restricted), 'leads.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(restricted), 'dashboards.view_pipeline', tenantA);

    // `reports.view` and NOTHING else: reaches the endpoints, may open no report.
    await fixtures.grantDirectPermission(appUserId(bare), 'reports.view', tenantA);

    // Internal: may OPEN the cross-tenant report, may not EXPORT it (the FR-65 second gate).
    await fixtures.grantDirectPermission(appUserId(internal), 'global.view_any_tenant', null);
    await fixtures.grantDirectPermission(appUserId(internal), 'reports.view', null);
    await fixtures.grantDirectPermission(
      appUserId(internal),
      'global.cross_tenant_reporting',
      null,
    );

    const rmRole = await fixtures.createRole({ tenantId: tenantA });
    rmAssignmentA = await query<{ id: string }>(
      `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
       values ($1, 'rm', $2, now(), now()) returning id::text as id`,
      [tenantA, rmRole],
    ).then((rows) => Number(rows[0]?.id));

    const partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp'));
    const regionA = await seedRef(tenantA, 'region', uniqueName('North'));
    const channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email'));
    productLineA = await seedRef(tenantA, 'product_line', uniqueName('Motor'));
    // A DISABLED reference value, so the Tenant Configuration report's active-vs-total distinction
    // is exercised by the fixture. Without one, that report's counts would be trivially equal and
    // the assertion vacuous — a disabled value must still be counted in the total, because
    // historical records still carry it (CLAUDE.md).
    await seedRef(tenantA, 'product_line', uniqueName('Retired Marine'), { isActive: false });
    const coverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Comp'), {
      productLineId: productLineA,
    });
    openStatusA = await seedRef(tenantA, 'lead_status', uniqueName('AAA Open'), {
      reportingCategory: 'open',
    });
    underwritingStatusA = await seedRef(tenantA, 'lead_status', uniqueName('Underwriting'), {
      reportingCategory: 'open',
      canonicalKey: 'underwriting',
    });

    const alpha = await seedParty(tenantA, `Alpha Client ${RUN}`, partyTypeA);
    const injected = await seedParty(tenantA, INJECTED_PARTY_NAME, partyTypeA);

    const leadOld = await seedLead(tenantA, {
      partyId: alpha,
      leadRef: REF_OLD,
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      estimatedPremium: 1500,
      dateReceived: daysAgo(20),
      createdDaysAgo: 20,
    });
    const leadUw = await seedLead(tenantA, {
      partyId: alpha,
      leadRef: REF_UW,
      statusId: underwritingStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      estimatedPremium: 2500,
      dateReceived: daysAgo(10),
      createdDaysAgo: 10,
    });
    // NOT assigned to `restricted`: invisible to a caller without `leads.view_all`.
    await seedLead(tenantA, {
      partyId: injected,
      leadRef: REF_INJECTED,
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      // A NEGATIVE premium: the OVER-guard pin, on a real row through the real endpoint.
      estimatedPremium: -500,
      // RECEIVED two days ago but CREATED twenty days ago — a lead re-keyed with a corrected intake
      // date. Deliberate: it is the fixture that distinguishes `date_received` (which the Aging
      // report ages from, putting this row in the 0-3 bucket) from `created_at` (which the SLA
      // Received→Sent breach measures from, counting it as breaching). Seeding them equal would
      // make either predicate substitutable for the other and both assertions vacuous.
      dateReceived: daysAgo(2),
      createdDaysAgo: 20,
    });

    for (const id of [leadOld, leadUw]) {
      await assignOwner(tenantA, id, rmAssignmentA, appUserId(restricted));
    }

    // Entered underwriting 10 days ago; the tenant target is 3, so this is a breach of exactly 10
    // days and the sole underwriting-delay-queue row.
    await seedStatusHistory(tenantA, leadUw, underwritingStatusA, 10);

    // Tenant B's corpus: one lead carrying the marker no tenant-A report may contain.
    const partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('CorpB'));
    const regionB = await seedRef(tenantB, 'region', uniqueName('NorthB'));
    const channelB = await seedRef(tenantB, 'request_channel', uniqueName('EmailB'));
    const productLineB = await seedRef(tenantB, 'product_line', uniqueName('MotorB'));
    const coverTypeB = await seedRef(tenantB, 'cover_type', uniqueName('CompB'), {
      productLineId: productLineB,
    });
    const statusB = await seedRef(tenantB, 'lead_status', uniqueName('OpenB'), {
      reportingCategory: 'open',
    });
    const partyB = await seedParty(tenantB, `${RUN}-BPARTY`, partyTypeB);
    await seedLead(tenantB, {
      partyId: partyB,
      leadRef: TENANT_B_MARKER,
      statusId: statusB,
      productLineId: productLineB,
      coverTypeId: coverTypeB,
      regionId: regionB,
      requestChannelId: channelB,
      estimatedPremium: 9999,
      dateReceived: daysAgo(5),
      createdDaysAgo: 5,
    });
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on, and the deletes swallow their errors, so the reverse order is a SILENT no-op.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
    await pool?.end().catch(() => undefined);
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // The catalog (AC-083, V-106).
  // -------------------------------------------------------------------------------------------

  describe('report catalog', () => {
    it('lists every catalogued report for a caller holding all ten binding permissions', async () => {
      const response = await call(BASE, { token: broad.accessToken, tenantId: tenantA });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { reports: { key: string; name: string }[] };

      expect(body.reports.map((report) => report.key)).toEqual(
        REPORT_CATALOG.map((report) => report.key),
      );
    });

    it('never puts a permission code on the wire', async () => {
      const response = await call(BASE, { token: broad.accessToken, tenantId: tenantA });
      const body = (await response.json()) as { reports: Record<string, unknown>[] };

      for (const card of body.reports) {
        expect(Object.keys(card).sort()).toEqual([
          'audience',
          'description',
          'icon',
          'key',
          'name',
        ]);
      }
    });

    it('narrows the catalog to the reports the caller may actually open', async () => {
      const response = await call(BASE, { token: restricted.accessToken, tenantId: tenantA });
      const body = (await response.json()) as { reports: { key: string }[] };

      // `dashboards.view_pipeline` alone: the three reports bound to it, and nothing else.
      expect(body.reports.map((report) => report.key)).toEqual([
        'pipeline-conversion',
        'sla-turnaround',
        'pipeline-aging',
      ]);
    });

    it('shows an EMPTY catalog to a reports.view holder with no report permissions', async () => {
      const response = await call(BASE, { token: bare.accessToken, tenantId: tenantA });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { reports: unknown[] };

      expect(body.reports).toEqual([]);
    });

    it('requires reports.view at all', async () => {
      // `restricted` holds it; a user without any grant in this tenant does not reach the handler.
      const response = await call(BASE, { token: internal.accessToken, tenantId: tenantA });
      // The Internal user holds `reports.view` globally, so this is 200 — the assertion that
      // matters is that the CATALOG they see is the cross-tenant one only.
      expect(response.status).toBe(200);
      const body = (await response.json()) as { reports: { key: string }[] };
      expect(body.reports.map((report) => report.key)).toEqual(['internal-tenant-overview']);
    });
  });

  // -------------------------------------------------------------------------------------------
  // EVERY catalogued report renders (the anti-"catalog of nothing" test).
  // -------------------------------------------------------------------------------------------

  describe('every catalogued report actually renders', () => {
    it.each(REPORT_CATALOG.map((report) => [report.key, report.name] as const))(
      'renders the print-ready view of %s',
      async (key, name) => {
        const payload = await view(broad, key);

        expect(payload.key).toBe(key);
        expect(payload.name).toBe(name);
        // A report with no sections is a blank page dressed as a success.
        expect(payload.sections.length).toBeGreaterThan(0);
        // Every section carries either KPIs or a table; an empty one renders nothing.
        for (const section of payload.sections) {
          expect(section.kpis.length > 0 || section.table !== null).toBe(true);
        }
        // The FR-65 metadata block, from the shared export metadata builder.
        expect(payload.header.currency).toBe('BWP');
        expect(payload.header.tenantName).toContain(RUN);
        expect(payload.header.dataPeriod).toBe('All time');
        expect(payload.header.filtersEcho).toEqual(['None']);
        expect(payload.header.lastRefreshed).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
      },
    );

    it.each(REPORT_CATALOG.map((report) => [report.key] as const))(
      'renders a non-empty CSV of %s with the metadata header block',
      async (key) => {
        const text = await csv(broad, key);

        expect(text).toContain('Tenant');
        expect(text).toContain('Currency,BWP');
        expect(text).toContain('Data period,All time');
        // RFC-4180 CRLF, pinned by T-039 and inherited rather than re-implemented.
        expect(text).toContain('\r\n');
        expect(text.length).toBeGreaterThan(60);
      },
    );
  });

  // -------------------------------------------------------------------------------------------
  // Exact values: Pipeline Aging (AC-083, V-106).
  // -------------------------------------------------------------------------------------------

  describe('pipeline aging report values', () => {
    it('returns the open leads oldest-first with exact ages, buckets, owners and premiums', async () => {
      const payload = await view(broad, 'pipeline-aging');
      const body = sectionOf(payload, 'aging').table;
      expect(body).not.toBeNull();

      expect(body?.columns.map((column) => column.header)).toEqual([
        'Lead ref',
        'Client',
        'Stage',
        'Age (days)',
        'Age bucket',
        'Owner',
        'Premium',
      ]);

      // Computed from the seed, not from the implementation: received 20 / 10 / 2 days ago.
      expect(body?.rows).toEqual([
        [REF_OLD, `Alpha Client ${RUN}`, expect.any(String), 20, '15+ days', 'Bea Yankee', 1500],
        [REF_UW, `Alpha Client ${RUN}`, expect.any(String), 10, '8-14 days', 'Bea Yankee', 2500],
        [REF_INJECTED, INJECTED_PARTY_NAME, expect.any(String), 2, '0-3 days', null, -500],
      ]);
    });

    it('honours the date filter and echoes the narrowed period in the header', async () => {
      // A window that excludes the 20-day-old lead and includes the other two.
      const payload = await view(
        broad,
        'pipeline-aging',
        `?from=${daysAgo(15)}&to=${daysAgo(1)}`,
      );

      expect(payload.header.dataPeriod).toBe(`${daysAgo(15)} to ${daysAgo(1)}`);
      expect(sectionOf(payload, 'aging').table?.rows.map((row) => row[0])).toEqual([
        REF_UW,
        REF_INJECTED,
      ]);
    });

    it('honours the product-line filter and echoes it', async () => {
      const payload = await view(broad, 'pipeline-aging', `?productLineId=${String(productLineA)}`);

      expect(payload.header.filtersEcho).toEqual([`Product line id: ${String(productLineA)}`]);
      expect(sectionOf(payload, 'aging').table?.rows).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Exact values: SLA / Turnaround.
  // -------------------------------------------------------------------------------------------

  describe('SLA / turnaround report values', () => {
    it('counts the underwriting breach and queues the delayed lead with its exact day count', async () => {
      const payload = await view(broad, 'sla-turnaround');

      const breaches = sectionOf(payload, 'breaches-by-stage').table;
      expect(breaches?.rows).toEqual([
        // No lead sits in the canonical `new` status, so assignment breaches are 0 — asserted
        // rather than ignored, because "0" and "the predicate never matched" look identical.
        ['Assignment', 0, 1],
        ['Underwriting', 1, 3],
        // All three leads are open with no quote, and all are older than the 5-day target.
        ['Received → Sent', 3, 5],
      ]);

      const queue = sectionOf(payload, 'underwriting-delay-queue').table;
      expect(queue?.rows).toEqual([[REF_UW, `Alpha Client ${RUN}`, 'Bea Yankee', 10, 3, 2500]]);
    });

    it('reports the lifecycle metrics as days with null (not zero) where nothing completed a leg', async () => {
      const payload = await view(broad, 'sla-turnaround');
      const metrics = sectionOf(payload, 'sla-metrics').kpis;

      expect(metrics.map((kpi) => kpi.key)).toEqual([
        'received_to_assignment',
        'received_to_quote_prepared',
        'prepared_to_sent',
        'sent_to_decision',
        'underwriting_time',
        'received_to_sent',
      ]);

      // No quotes and no assignment dates in this corpus: every leg is undefined, NOT "0 days".
      // Reporting zero would state that quotes are prepared instantly.
      for (const kpi of metrics) {
        expect(kpi.value).toBeNull();
        expect(kpi.displayValue).toBe('—');
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // Exact values: Tenant Configuration and Internal Tenant Overview.
  // -------------------------------------------------------------------------------------------

  describe('tenant configuration report values', () => {
    it('counts active reference values SEPARATELY from the total, so disabled values stay visible', async () => {
      const payload = await view(broad, 'tenant-configuration');
      const rows = sectionOf(payload, 'reference-lists').table?.rows ?? [];

      // Two product lines seeded, one of them disabled: 1 active of 2 total. A report that counted
      // only active values would show "1" and hide a value historical leads still carry.
      expect(rows).toContainEqual(['product_line', 1, 2]);
      expect(rows).toContainEqual(['lead_status', 2, 2]);
    });

    it('renders the tenant business rules with the seeded SLA thresholds', async () => {
      const payload = await view(broad, 'tenant-configuration');
      const rows = sectionOf(payload, 'business-rules').table?.rows ?? [];

      expect(rows).toContainEqual(['Display currency', 'BWP']);
      expect(rows).toContainEqual(['SLA underwriting (days)', '3']);
      expect(rows).toContainEqual(['SLA assignment (days)', '1']);
      expect(rows).toContainEqual(['High-value threshold', '1,000,000']);
    });
  });

  describe('internal tenant overview report values', () => {
    it('spans tenants with each tenant’s exact lead and quote counts', async () => {
      const payload = await view(broad, 'internal-tenant-overview');
      const rows = sectionOf(payload, 'tenants').table?.rows ?? [];

      const rowA = rows.find((row) => String(row[0]).endsWith('tenant-a'));
      const rowB = rows.find((row) => String(row[0]).endsWith('tenant-b'));

      // [tenant, status, activeUsers, leads, openLeads, quotes]
      expect(rowA?.slice(1)).toEqual(['active', 3, 3, 3, 0]);
      expect(rowB?.slice(1)).toEqual(['active', 1, 1, 1, 0]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // CSV: the shared writer, the shared guard, and parity with the print data (AC-083, AC-081).
  // -------------------------------------------------------------------------------------------

  describe('report CSVs', () => {
    it('emits the primary table of the same composition the print view renders', async () => {
      const payload = await view(broad, 'pipeline-aging');
      const text = await csv(broad, 'pipeline-aging');

      const printed = sectionOf(payload, 'aging').table?.rows ?? [];
      const csvRefs = dataLines(text, 'Lead ref,').map((line) => line.split(',')[0] ?? '');

      expect(csvRefs).toEqual(printed.map((row) => String(row[0])));
      expect(csvRefs).toEqual([REF_OLD, REF_UW, REF_INJECTED]);
    });

    it('applies the SAME filters as the print view', async () => {
      const window = `?from=${daysAgo(15)}&to=${daysAgo(1)}`;
      const text = await csv(broad, 'pipeline-aging', window);

      expect(dataLines(text, 'Lead ref,').map((line) => line.split(',')[0] ?? '')).toEqual([
        REF_UW,
        REF_INJECTED,
      ]);
      expect(text).toContain(`Data period,${daysAgo(15)} to ${daysAgo(1)}`);
    });

    it('guards a client named =HYPERLINK(...) through the SHARED export guard', async () => {
      const text = await csv(broad, 'pipeline-aging');

      expect(text).toContain(INJECTED_CSV_GUARDED);
      // The assertion that dies if the guard is bypassed: `toContain(guarded)` alone would still
      // pass on a partial guard.
      expect(text).not.toContain(INJECTED_CSV_UNGUARDED);
    });

    it('does NOT guard a negative premium, because a number column cannot be a formula', async () => {
      const text = await csv(broad, 'pipeline-aging');
      const injectedLine = dataLines(text, 'Lead ref,').find((line) =>
        line.startsWith(REF_INJECTED),
      );

      // `-500`, not `'-500`. Guarding a typed number cell corrupts money on a reporting surface,
      // which is the OTHER failure the shared guard is pinned against.
      expect(injectedLine).toContain(',-500');
      expect(injectedLine).not.toContain(",'-500");
    });

    it('writes an audit row naming the report, the actor, the tenant and the row count', async () => {
      await csv(broad, 'sla-turnaround');

      const rows = await findAuditRows((sql, params) => auth.query(sql, params ?? []), {
        action: EXPORT_ACTION,
        entityId: 'sla-turnaround',
        tenantId: tenantA,
      });

      expect(rows.length).toBeGreaterThan(0);
      const latest = rows[rows.length - 1];
      expect(latest?.entity_type).toBe('report');
      expect(Number(latest?.actor_user_id)).toBe(appUserId(broad));
      const details = latest?.details as { after?: Record<string, unknown> } | null;
      const after = details?.after ?? {};
      expect(after['rowCount']).toBe(1);
      expect(after['format']).toBe('csv');
      expect((after['filters'] as { report?: string } | undefined)?.report).toBe('sla-turnaround');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation (AC-022, V-027).
  // -------------------------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('never returns tenant-B rows in a tenant-A report view', async () => {
      const payload = await view(broad, 'pipeline-aging');

      expect(JSON.stringify(payload)).not.toContain(TENANT_B_MARKER);
    });

    it('never returns tenant-B rows in a tenant-A report CSV', async () => {
      const text = await csv(broad, 'pipeline-aging');

      expect(text).not.toContain(TENANT_B_MARKER);
    });

    it('returns tenant-B’s own rows under a tenant-B context, with tenant-B currency', async () => {
      const payload = await view(broad, 'pipeline-aging', '', tenantB);

      expect(payload.header.currency).toBe('USD');
      expect(sectionOf(payload, 'aging').table?.rows.map((row) => row[0])).toEqual([
        TENANT_B_MARKER,
      ]);
    });

    it('scopes the tenant configuration report to the active tenant', async () => {
      const payload = await view(broad, 'tenant-configuration', '', tenantB);
      const rows = sectionOf(payload, 'reference-lists').table?.rows ?? [];

      // Tenant B seeded exactly one product line, all active — tenant A's two do not leak in.
      expect(rows).toContainEqual(['product_line', 1, 1]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Visibility breadth (AC-076(c) applied to reports).
  // -------------------------------------------------------------------------------------------

  describe('visibility breadth narrows a report exactly as it narrows a list', () => {
    it('gives a caller without leads.view_all only the leads they are assigned', async () => {
      const payload = await view(restricted, 'pipeline-aging');

      // Two of the three: the unassigned lead is not theirs to see, in a report any more than in a
      // list. A report is a BULK read and would otherwise be the most convenient way around the
      // breadth ruling.
      expect(sectionOf(payload, 'aging').table?.rows.map((row) => row[0])).toEqual([
        REF_OLD,
        REF_UW,
      ]);
    });

    it('narrows the report CSV by the same breadth', async () => {
      const text = await csv(restricted, 'pipeline-aging');

      expect(dataLines(text, 'Lead ref,').map((line) => line.split(',')[0] ?? '')).toEqual([
        REF_OLD,
        REF_UW,
      ]);
      expect(text).not.toContain(REF_INJECTED);
    });

    it('narrows the SLA report population too', async () => {
      const broadView = await view(broad, 'sla-turnaround');
      const narrowView = await view(restricted, 'sla-turnaround');

      const breachesOf = (payload: ReportViewDto): unknown =>
        sectionOf(payload, 'breaches-by-stage').table?.rows[2];

      // Three open unquoted leads for the broad caller; two for the restricted one.
      expect(breachesOf(broadView)).toEqual(['Received → Sent', 3, 5]);
      expect(breachesOf(narrowView)).toEqual(['Received → Sent', 2, 5]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Permission matrix and the cross-tenant export gate (AC-083, AC-084).
  // -------------------------------------------------------------------------------------------

  describe('permission matrix', () => {
    it('403s a report whose binding permission the caller lacks', async () => {
      const response = await call(`${BASE}/loss-analysis`, {
        token: restricted.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe('REPORT_FORBIDDEN');
    });

    it('403s the CSV of a report the caller may not open', async () => {
      const response = await call(`${BASE}/loss-analysis/csv`, {
        token: restricted.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(403);
    });

    it('404s an unknown report key rather than 403ing it', async () => {
      const response = await call(`${BASE}/no-such-report`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe('REPORT_UNKNOWN');
    });

    it('403s every report for a bare reports.view holder', async () => {
      for (const report of REPORT_CATALOG) {
        const response = await call(`${BASE}/${report.key}`, {
          token: bare.accessToken,
          tenantId: tenantA,
        });
        expect(response.status).toBe(403);
      }
    });

    it('401s without a token and 403s without reports.view', async () => {
      expect((await call(BASE, { tenantId: tenantA })).status).toBe(401);
    });

    it('lets an Internal user OPEN the cross-tenant report but not EXPORT it', async () => {
      const viewResponse = await call(`${BASE}/internal-tenant-overview`, {
        token: internal.accessToken,
        tenantId: tenantA,
      });
      expect(viewResponse.status).toBe(200);

      const csvResponse = await call(`${BASE}/internal-tenant-overview/csv`, {
        token: internal.accessToken,
        tenantId: tenantA,
      });
      expect(csvResponse.status).toBe(403);
      const body = (await csvResponse.json()) as { code?: string };
      expect(body.code).toBe('CROSS_TENANT_EXPORT_FORBIDDEN');
    });

    it('lets a holder of global.cross_tenant_export download the cross-tenant CSV', async () => {
      const text = await csv(broad, 'internal-tenant-overview');

      expect(text).toContain(`${RUN}-tenant-a`);
      expect(text).toContain(`${RUN}-tenant-b`);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Residue.
  // -------------------------------------------------------------------------------------------

  it('leaves no rows behind for tenants outside this run', async () => {
    const rows = await query<{ count: string }>(
      "select count(*)::text as count from tenants where name like 't40x-%' and id <> all($1::bigint[])",
      [createdTenants],
    );

    expect(Number(rows[0]?.count)).toBe(0);
  });
});
