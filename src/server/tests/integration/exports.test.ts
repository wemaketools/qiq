/**
 * Export endpoints: filter parity, formula-injection guarding on real seeded data, header
 * metadata, valid XLSX, the documented size limit, tenant isolation, visibility breadth, the
 * Internal-only cross-tenant gate and the audit row
 * (T-039; AC-022, AC-024, AC-081, AC-082, AC-084; V-027, V-031, V-103, V-104, V-108).
 *
 * EVERY ASSERTION IS ON THE DOWNLOADED BYTES, NOT ON THE RESPONSE SHAPE
 * ====================================================================
 * A 200 with a Content-Disposition header cannot distinguish a correct export from one that emits
 * an empty table, the wrong tenant's rows, or an unguarded `=HYPERLINK(...)` cell. So each test
 * below decodes the response body — as CSV text, or by re-parsing the workbook through exceljs —
 * and asserts the literal cells. If the writers emitted nothing, every test here fails.
 *
 * THE INJECTION FIXTURE IS SEEDED HOSTILE ON PURPOSE (V-103)
 * =========================================================
 * A guard test whose fixture contains no dangerous value proves nothing at all. `INJECTED_PARTY`
 * below is a party whose NAME is a live formula payload, and it is seeded into tenant A's ordinary
 * corpus so it appears in the ordinary leads and parties exports rather than in a special one.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { EXPORT_ACTION, EXPORT_TOO_LARGE_CODE } from '../../domains/exports/service.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('exports', probe);

const BASE = '/api/v1/exports';

/** THE HOSTILE FIXTURE. A party name that is a live spreadsheet formula (V-103, AC-081). */
const INJECTED_PARTY_NAME = '=HYPERLINK("http://evil","x")';
/**
 * How that payload must appear in the CSV: GUARDED (leading single quote) and then RFC-4180 quoted,
 * because it also contains double quotes and a comma. Both defences compose on this one cell.
 */
const INJECTED_PARTY_CSV_GUARDED = '"\'=HYPERLINK(""http://evil"",""x"")"';
/** The same cell WITHOUT the guard — the byte sequence that must appear nowhere in any export. */
const INJECTED_PARTY_CSV_UNGUARDED = '"=HYPERLINK(""http://evil"",""x"")"';
/** A second payload exercising a different trigger character AND the RFC-4180 quoting interaction. */
const INJECTED_BROKER_NAME = '@SUM(1+1),Evil "Brokers"';

/** Short, for the trigram reason documented in leads-core.test.ts. */
const RUN = `t39x-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
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

  /** Holds every export permission AND `leads.view_all`: sees the whole tenant. */
  let broad: TestUserSession;
  /** Holds the export permissions but NOT `leads.view_all`: sees only leads assigned to them. */
  let restricted: TestUserSession;
  /** An Internal user reaching tenant C by `global.view_any_tenant`, without the export grant. */
  let internal: TestUserSession;

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
      "select id::text as id from tenants where name like 't39x-%'",
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

  /** The export's Currency metadata line is read from here, so every tenant needs settings. */
  async function seedSettings(tenantId: number, currencyCode: string): Promise<void> {
    await query(
      `insert into tenant_settings (tenant_id, currency_code, currency_symbol, created_at, updated_at)
       values ($1, $2, $3, now(), now())`,
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

  async function seedParty(
    tenantId: number,
    name: string,
    partyTypeId: number,
    options: { segmentId?: number; industryId?: number; regionId?: number } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into parties
         (tenant_id, name, party_type_id, segment_id, industry_id, region_id, is_strategic,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, false, now(), now()) returning id::text as id`,
      [
        tenantId,
        name,
        partyTypeId,
        options.segmentId ?? null,
        options.industryId ?? null,
        options.regionId ?? null,
      ],
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
  }

  async function seedLead(tenantId: number, lead: SeedLead): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into leads
         (tenant_id, party_id, lead_ref, date_received, request_channel_id, broker_id, region_id,
          product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
          source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'm12', 'normal', $11, 'browser', now(), now())
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
        lead.statusId,
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

  function harness(options: { maxRows?: number } = {}): ApiApp {
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
      exports: options.maxRows === undefined ? { db } : { db, maxRows: options.maxRows },
    });
  }

  async function call(
    path: string,
    options: { token?: string; tenantId?: number; maxRows?: number } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    const app = options.maxRows === undefined ? harness() : harness({ maxRows: options.maxRows });
    return await app.request(`http://localhost${path}`, {
      method: 'GET',
      headers,
    });
  }

  /** Downloads an export and returns its decoded CSV text. */
  async function downloadCsv(
    session: TestUserSession,
    path: string,
    tenantId = tenantA,
  ): Promise<string> {
    const response = await call(path, { token: session.accessToken, tenantId });
    expect(response.status).toBe(200);
    return new TextDecoder('utf-8').decode(await response.arrayBuffer());
  }

  /** The data rows of a downloaded CSV, i.e. everything after the header row. */
  function dataLines(csv: string, headerPrefix: string): string[] {
    const lines = csv.split('\r\n');
    const headerIndex = lines.findIndex((line) => line.startsWith(headerPrefix));
    expect(headerIndex).toBeGreaterThan(0);
    return lines.slice(headerIndex + 1).filter((line) => line !== '');
  }

  /** The `Lead ref` column of each exported lead row. */
  function exportedLeadRefs(csv: string): string[] {
    return dataLines(csv, 'Lead ref,').map((line) => line.split(',')[0] ?? '');
  }

  async function parseWorkbook(bytes: ArrayBuffer): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const sheet = workbook.getWorksheet(1);
    if (sheet === undefined) throw new Error('workbook has no worksheet');
    return sheet;
  }

  // Fixtures.
  let partyTypeA = 0;
  let segmentA = 0;
  let industryA = 0;
  let regionA = 0;
  let regionA2 = 0;
  let channelA = 0;
  let productLineA = 0;
  let productLineA2 = 0;
  let coverTypeA = 0;
  let coverTypeA2 = 0;
  let openStatusA = 0;
  let rmAssignmentA = 0;
  let injectedPartyA = 0;

  /** Leads owned by `restricted` — the only ones a caller without `leads.view_all` may export. */
  let ownedByRestricted: string[] = [];
  /** Leads owned by nobody `restricted` knows. */
  let ownedByStranger: string[] = [];
  /** The lead on the injected party, in product line A2 (the filter fixture). */
  let injectedLeadRef = '';
  /** Tenant B's marker, which must never appear in a tenant-A export. */
  const TENANT_B_MARKER = `${RUN}-BLEAD`;

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
    tenantC = await createTenant('tenant-c');
    await seedSettings(tenantA, 'BWP');
    await seedSettings(tenantB, 'USD');
    await seedSettings(tenantC, 'USD');

    broad = await auth.createTestUserWithSession({
      label: 'exp-broad',
      firstName: 'Ada',
      lastName: 'Zulu',
    });
    restricted = await auth.createTestUserWithSession({
      label: 'exp-restricted',
      firstName: 'Bea',
      lastName: 'Yankee',
    });
    internal = await auth.createTestUserWithSession({
      label: 'exp-internal',
      firstName: 'Cal',
      lastName: 'Xray',
    });

    for (const session of [broad, restricted]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(broad), tenantB);

    for (const tenantId of [tenantA, tenantB]) {
      await fixtures.grantDirectPermission(appUserId(broad), 'leads.view', tenantId);
      await fixtures.grantDirectPermission(appUserId(broad), 'leads.view_all', tenantId);
      await fixtures.grantDirectPermission(appUserId(broad), 'leads.export', tenantId);
      await fixtures.grantDirectPermission(appUserId(broad), 'parties.export', tenantId);
    }
    // NO `leads.view_all` — the breadth fixture.
    await fixtures.grantDirectPermission(appUserId(restricted), 'leads.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(restricted), 'leads.export', tenantA);
    await fixtures.grantDirectPermission(appUserId(restricted), 'parties.export', tenantA);

    // The Internal user reaches tenant C with NO membership, via the global cross-tenant grant.
    await fixtures.grantDirectPermission(appUserId(internal), 'global.view_any_tenant', null);
    await fixtures.grantDirectPermission(appUserId(internal), 'leads.export', null);
    await fixtures.grantDirectPermission(appUserId(internal), 'parties.export', null);
    await fixtures.grantDirectPermission(appUserId(internal), 'leads.view', null);

    const rmRole = await fixtures.createRole({ tenantId: tenantA });
    rmAssignmentA = await seedRmSlot(tenantA, rmRole);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp'));
    segmentA = await seedRef(tenantA, 'party_segment', uniqueName('Enterprise'));
    industryA = await seedRef(tenantA, 'industry', uniqueName('Mining'));
    regionA = await seedRef(tenantA, 'region', uniqueName('North'));
    regionA2 = await seedRef(tenantA, 'region', uniqueName('South'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email'));
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

    const brokerAcme = await seedBroker(tenantA, `Acme Brokers ${RUN}`);
    // The hostile broker: a payload that ALSO contains a comma and double quotes, so the guard and
    // the RFC-4180 escaping have to compose correctly on one real exported cell.
    const brokerEvil = await seedBroker(tenantA, INJECTED_BROKER_NAME);

    const alpha = await seedParty(tenantA, `Alpha Client ${RUN}`, partyTypeA, {
      segmentId: segmentA,
      industryId: industryA,
      regionId: regionA,
    });
    injectedPartyA = await seedParty(tenantA, INJECTED_PARTY_NAME, partyTypeA, {
      segmentId: segmentA,
      industryId: industryA,
      regionId: regionA,
    });

    // Two leads owned by `restricted`, one of them on the INJECTED party and in product line A2.
    injectedLeadRef = `${RUN}-R1`;
    const r1 = await seedLead(tenantA, {
      partyId: injectedPartyA,
      leadRef: injectedLeadRef,
      statusId: openStatusA,
      productLineId: productLineA2,
      coverTypeId: coverTypeA2,
      regionId: regionA2,
      requestChannelId: channelA,
      brokerId: brokerEvil,
      // A NEGATIVE premium: the over-guard pin, on a real row through the real endpoint.
      estimatedPremium: -500,
      dateReceived: '2026-03-01',
    });
    const r2 = await seedLead(tenantA, {
      partyId: alpha,
      leadRef: `${RUN}-R2`,
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      brokerId: brokerAcme,
      estimatedPremium: 1500,
      dateReceived: '2026-02-01',
    });
    ownedByRestricted = [injectedLeadRef, `${RUN}-R2`];

    // Two leads assigned to nobody: invisible to `restricted`, visible to `broad`.
    ownedByStranger = [];
    for (let index = 0; index < 2; index += 1) {
      const ref = `${RUN}-S${String(index)}`;
      await seedLead(tenantA, {
        partyId: alpha,
        leadRef: ref,
        statusId: openStatusA,
        productLineId: productLineA,
        coverTypeId: coverTypeA,
        regionId: regionA,
        requestChannelId: channelA,
        estimatedPremium: 500,
        dateReceived: '2026-02-15',
      });
      ownedByStranger.push(ref);
    }

    for (const id of [r1, r2]) {
      await assignOwner(tenantA, id, rmAssignmentA, appUserId(restricted));
    }

    // Tenant B's corpus: one lead and one party carrying the marker no tenant-A export may contain.
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
    // `db.destroy()` already ends this pool; the catch is the established pattern here.
    await pool?.end().catch(() => undefined);
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // Formula injection on real seeded data (AC-081, V-103).
  // -------------------------------------------------------------------------------------------

  describe('formula-injection guarding on exported bytes (AC-081, V-103)', () => {
    it('guards a seeded party named =HYPERLINK(...) in the leads CSV', async () => {
      const csv = await downloadCsv(broad, `${BASE}/leads`);

      // The GUARDED form is present...
      expect(csv).toContain(INJECTED_PARTY_CSV_GUARDED);
      // ...and the UNGUARDED form appears nowhere in the file. This is the assertion that dies when
      // the guard is removed: `toContain(guarded)` alone would still pass on a partial guard.
      expect(csv).not.toContain(INJECTED_PARTY_CSV_UNGUARDED);
    });

    it('guards the same party in the parties CSV', async () => {
      const csv = await downloadCsv(broad, `${BASE}/parties`);

      expect(csv).toContain(INJECTED_PARTY_CSV_GUARDED);
      expect(csv).not.toContain(INJECTED_PARTY_CSV_UNGUARDED);
    });

    it('guards AND RFC-4180 quotes a broker name that is both a payload and comma/quote laden', async () => {
      const csv = await downloadCsv(broad, `${BASE}/leads`);

      // Guard prefix inside the quoted field, and the embedded double quotes doubled.
      expect(csv).toContain('"\'@SUM(1+1),Evil ""Brokers"""');
    });

    it('guards the payload in the XLSX workbook too, as a String cell and not a formula', async () => {
      const response = await call(`${BASE}/leads?format=xlsx`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(200);
      const sheet = await parseWorkbook(await response.arrayBuffer());

      const values: string[] = [];
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          if (typeof cell.value === 'string') values.push(cell.value);
          expect(cell.formula).toBeUndefined();
        });
      });

      expect(values).toContain(`'${INJECTED_PARTY_NAME}`);
      expect(values).not.toContain(INJECTED_PARTY_NAME);
    });

    it('does NOT corrupt a legitimate negative premium (the over-guard direction)', async () => {
      const csv = await downloadCsv(broad, `${BASE}/leads`);
      const injectedRow = dataLines(csv, 'Lead ref,').find((line) =>
        line.startsWith(injectedLeadRef),
      );

      // Premium is column 6, but the party/broker cells are quoted and contain commas, so assert on
      // the bare token rather than by splitting: `-500` unquoted and unprefixed.
      expect(injectedRow).toContain(',-500,');
      expect(injectedRow).not.toContain("'-500");
    });
  });

  // -------------------------------------------------------------------------------------------
  // Filters, metadata, formats (AC-082, V-104).
  // -------------------------------------------------------------------------------------------

  describe('list exports honor the active filters (AC-082, V-104)', () => {
    it('exports every visible lead when no filter is applied', async () => {
      const refs = exportedLeadRefs(await downloadCsv(broad, `${BASE}/leads`));

      expect(new Set(refs)).toEqual(new Set([...ownedByRestricted, ...ownedByStranger]));
    });

    it('narrows to exactly the rows matching a product-line filter', async () => {
      const refs = exportedLeadRefs(
        await downloadCsv(broad, `${BASE}/leads?productLineId=${String(productLineA2)}`),
      );

      expect(refs).toEqual([injectedLeadRef]);
    });

    it('matches the LIST endpoint row-for-row under the same filters', async () => {
      // The strongest available parity assertion: the export and the list must agree on the id set
      // for identical filters, or "the export honors the active filters" is unverifiable.
      const listResponse = await call(`/api/v1/leads?regionId=${String(regionA)}&pageSize=100`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });
      expect(listResponse.status).toBe(200);
      const list = (await listResponse.json()) as { items: { leadRef: string }[] };

      const refs = exportedLeadRefs(
        await downloadCsv(broad, `${BASE}/leads?regionId=${String(regionA)}`),
      );

      expect(new Set(refs)).toEqual(new Set(list.items.map((item) => item.leadRef)));
      expect(refs).toHaveLength(list.items.length);
    });

    it('applies the search filter identically to the list', async () => {
      const refs = exportedLeadRefs(await downloadCsv(broad, `${BASE}/leads?search=${RUN}-R2`));

      expect(refs).toEqual([`${RUN}-R2`]);
    });

    it('narrows the parties export by segment', async () => {
      const csv = await downloadCsv(
        broad,
        `${BASE}/parties?segmentId=${String(segmentA)}&search=Alpha`,
      );

      const lines = dataLines(csv, 'Name,');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`Alpha Client ${RUN}`);
    });
  });

  describe('export metadata header block (AC-082, V-104)', () => {
    it('carries tenant, report name, period and currency', async () => {
      const csv = await downloadCsv(
        broad,
        `${BASE}/leads?dateReceivedFrom=2026-01-01&dateReceivedTo=2026-12-31`,
      );
      const lines = csv.split('\r\n');

      expect(lines[0]).toBe('Report,Leads export');
      expect(lines[1]).toBe(`Tenant,${RUN}-tenant-a`);
      expect(lines[2]).toMatch(/^Generated at,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
      expect(lines[3]).toBe('Data period,2026-01-01 to 2026-12-31');
      expect(lines[4]).toBe('Currency,BWP');
      expect(lines[5]).toMatch(/^Last refreshed,/);
    });

    it('reports "All time" and echoes "None" when no filter is active', async () => {
      const csv = await downloadCsv(broad, `${BASE}/leads`);

      expect(csv).toContain('Data period,All time');
      expect(csv).toContain('Filter,None');
    });

    it('echoes the active filters so the saved file is self-describing', async () => {
      const csv = await downloadCsv(
        broad,
        `${BASE}/leads?productLineId=${String(productLineA2)}&search=zzz`,
      );

      expect(csv).toContain(`Filter,Product line id: ${String(productLineA2)}`);
      expect(csv).toContain('Filter,Search: zzz');
    });

    it('uses the requesting tenant’s own currency, not another tenant’s', async () => {
      const csv = await downloadCsv(broad, `${BASE}/leads`, tenantB);

      expect(csv).toContain('Currency,USD');
    });
  });

  describe('content negotiation and download headers (AC-082)', () => {
    it('defaults to CSV with an attachment disposition and a descriptive filename', async () => {
      const response = await call(`${BASE}/leads`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment; filename="t39x-[a-z0-9-]*tenant-a-leads-\d{8}\.csv"$/,
      );
    });

    it('returns a valid XLSX workbook for ?format=xlsx', async () => {
      const response = await call(`${BASE}/leads?format=xlsx`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(response.headers.get('content-disposition')).toContain('.xlsx"');

      const sheet = await parseWorkbook(await response.arrayBuffer());
      expect(sheet.getCell('A1').value).toBe('Report');
      expect(sheet.getCell('B1').value).toBe('Leads export');
      expect(sheet.getCell('B5').value).toBe('BWP');
      // The data table: the header row's first caption, wherever the metadata block ends.
      const headers: unknown[] = [];
      sheet.eachRow((row) => headers.push(row.getCell(1).value));
      expect(headers).toContain('Lead ref');
    });

    it('falls back to CSV for an unrecognised format rather than erroring', async () => {
      const response = await call(`${BASE}/leads?format=pdf`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    });
  });

  // -------------------------------------------------------------------------------------------
  // The documented synchronous size limit (AC-082, Q-18, V-104).
  // -------------------------------------------------------------------------------------------

  describe('the documented synchronous export limit (AC-082, Q-18)', () => {
    it('rejects an over-limit export with the documented error and NO file', async () => {
      // Four visible leads against a cap of 2.
      const response = await call(`${BASE}/leads`, {
        token: broad.accessToken,
        tenantId: tenantA,
        maxRows: 2,
      });

      expect(response.status).toBe(400);
      const problem = (await response.json()) as { code?: string; detail?: string };
      expect(problem.code).toBe(EXPORT_TOO_LARGE_CODE);
      expect(problem.detail).toContain('exceeds the synchronous export limit');
      // A truncated FILE is the failure this criterion exists to prevent.
      expect(response.headers.get('content-disposition')).toBeNull();
    });

    it('succeeds when the filtered set fits inside the limit', async () => {
      const response = await call(`${BASE}/leads?productLineId=${String(productLineA2)}`, {
        token: broad.accessToken,
        tenantId: tenantA,
        maxRows: 2,
      });

      expect(response.status).toBe(200);
      expect(exportedLeadRefs(new TextDecoder().decode(await response.arrayBuffer()))).toEqual([
        injectedLeadRef,
      ]);
    });

    it('applies the limit to the parties export as well', async () => {
      const response = await call(`${BASE}/parties`, {
        token: broad.accessToken,
        tenantId: tenantA,
        maxRows: 1,
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code?: string }).code).toBe(EXPORT_TOO_LARGE_CODE);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Visibility breadth and tenant isolation (AC-022, AC-076(c), V-027).
  // -------------------------------------------------------------------------------------------

  describe('visibility breadth (AC-076(c))', () => {
    it('exports only the caller’s own leads without leads.view_all', async () => {
      const refs = exportedLeadRefs(await downloadCsv(restricted, `${BASE}/leads`));

      expect(new Set(refs)).toEqual(new Set(ownedByRestricted));
      for (const ref of ownedByStranger) {
        expect(refs).not.toContain(ref);
      }
    });

    it('exports every tenant lead with leads.view_all, so the export is not the way around it', async () => {
      const refs = exportedLeadRefs(await downloadCsv(broad, `${BASE}/leads`));

      expect(refs.length).toBeGreaterThan(
        exportedLeadRefs(await downloadCsv(restricted, `${BASE}/leads`)).length,
      );
    });

    it('applies the same breadth to the dashboard export', async () => {
      const refs = exportedLeadRefs(
        await downloadCsv(restricted, `${BASE}/dashboard?widget=leads.filtered`),
      );

      expect(new Set(refs)).toEqual(new Set(ownedByRestricted));
    });
  });

  describe('tenant isolation (AC-022, V-027)', () => {
    it('never leaks tenant B rows into a tenant A leads export', async () => {
      const csv = await downloadCsv(broad, `${BASE}/leads`);

      expect(csv).not.toContain(TENANT_B_MARKER);
      expect(csv).not.toContain('9999');
    });

    it('never leaks tenant B parties into a tenant A parties export', async () => {
      const csv = await downloadCsv(broad, `${BASE}/parties`);

      expect(csv).not.toContain(`${RUN}-BPARTY`);
    });

    it('never leaks tenant A rows into a tenant B export', async () => {
      const csv = await downloadCsv(broad, `${BASE}/leads`, tenantB);

      expect(exportedLeadRefs(csv)).toEqual([TENANT_B_MARKER]);
      expect(csv).not.toContain(INJECTED_PARTY_NAME);
      expect(csv).not.toContain(`'${INJECTED_PARTY_NAME}`);
    });

    it('403s a tenant the caller has no access to at all', async () => {
      const response = await call(`${BASE}/leads`, {
        token: restricted.accessToken,
        tenantId: tenantB,
      });

      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Dashboard export (AC-082).
  // -------------------------------------------------------------------------------------------

  describe('dashboard export', () => {
    it('exports the drill population for a widget under the active dashboard filter', async () => {
      const refs = exportedLeadRefs(
        await downloadCsv(broad, `${BASE}/dashboard?widget=leads.filtered`),
      );

      expect(new Set(refs)).toEqual(new Set([...ownedByRestricted, ...ownedByStranger]));
    });

    it('honors the dashboard filter bar', async () => {
      const refs = exportedLeadRefs(
        await downloadCsv(
          broad,
          `${BASE}/dashboard?widget=leads.filtered&productLineId=${String(productLineA2)}`,
        ),
      );

      expect(refs).toEqual([injectedLeadRef]);
    });

    it('names the report after the widget and echoes it as a filter', async () => {
      const csv = await downloadCsv(broad, `${BASE}/dashboard?widget=leads.filtered`);

      expect(csv).toContain('Report,Dashboard export (leads.filtered)');
      expect(csv).toContain('Filter,Widget: leads.filtered');
    });

    it('404s an unregistered widget key, and 400s a missing one', async () => {
      const unknown = await call(`${BASE}/dashboard?widget=no.such.widget`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });
      expect(unknown.status).toBe(404);

      const missing = await call(`${BASE}/dashboard`, {
        token: broad.accessToken,
        tenantId: tenantA,
      });
      expect(missing.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Permissions, the cross-tenant gate and the audit row (AC-024, AC-084; V-031, V-108).
  // -------------------------------------------------------------------------------------------

  describe('export permissions', () => {
    it('403s a caller without leads.export', async () => {
      const stranger = await auth.createTestUserWithSession({ label: 'exp-nogrant' });
      await addMembership(appUserId(stranger), tenantA);
      await fixtures.grantDirectPermission(appUserId(stranger), 'leads.view', tenantA);

      const response = await call(`${BASE}/leads`, {
        token: stranger.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(403);
    });

    it('403s a caller without parties.export', async () => {
      const stranger = await auth.createTestUserWithSession({ label: 'exp-nopgrant' });
      await addMembership(appUserId(stranger), tenantA);
      await fixtures.grantDirectPermission(appUserId(stranger), 'leads.export', tenantA);

      const response = await call(`${BASE}/parties`, {
        token: stranger.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(403);
    });

    it('401s an unauthenticated caller', async () => {
      const response = await call(`${BASE}/leads`, { tenantId: tenantA });

      expect(response.status).toBe(401);
    });
  });

  describe('cross-tenant exports are Internal-only and audited (AC-084, V-108)', () => {
    it('403s an Internal cross-tenant caller WITHOUT global.cross_tenant_export, returning no file', async () => {
      const response = await call(`${BASE}/leads`, {
        token: internal.accessToken,
        tenantId: tenantC,
      });

      expect(response.status).toBe(403);
      const problem = (await response.json()) as { code?: string };
      expect(problem.code).toBe('CROSS_TENANT_EXPORT_FORBIDDEN');
      expect(response.headers.get('content-disposition')).toBeNull();
    });

    it('allows the export once the explicit grant is held, and audits the scope and actor', async () => {
      await fixtures.grantDirectPermission(
        appUserId(internal),
        'global.cross_tenant_export',
        null,
      );

      const response = await call(`${BASE}/leads`, {
        token: internal.accessToken,
        tenantId: tenantC,
      });

      expect(response.status).toBe(200);

      const rows = await findAuditRows(query, {
        action: EXPORT_ACTION,
        entityId: 'leads',
        tenantId: tenantC,
      });
      expect(rows).toHaveLength(1);
      const details = rows[0]?.details as { after?: Record<string, unknown> };
      expect(details.after?.crossTenant).toBe(true);
      expect(rows[0]?.actor_user_id).toBe(String(appUserId(internal)));
    });

    it('a membership-based export is NOT flagged cross-tenant', async () => {
      await downloadCsv(broad, `${BASE}/parties`);

      const rows = await findAuditRows(query, {
        action: EXPORT_ACTION,
        entityId: 'parties',
        tenantId: tenantA,
      });
      const latest = rows[rows.length - 1];
      const details = latest?.details as { after?: Record<string, unknown> };
      expect(details.after?.crossTenant).toBe(false);
    });
  });

  describe('every export writes exactly one audit row (AC-024, V-031)', () => {
    it('audits a dashboard export with the actor, tenant, format, row count and filters', async () => {
      // Earlier tests in this file have already exported this widget, and `assertAudited` insists
      // on EXACTLY ONE row — which is the property worth asserting (a double-write is the classic
      // retry bug). So clear this tenant's export rows first, export once, and assert one row.
      await query("delete from audit_log where tenant_id = $1 and action = 'export'", [tenantA]);

      await downloadCsv(broad, `${BASE}/dashboard?widget=leads.filtered`);

      await assertAudited(query, {
        action: EXPORT_ACTION,
        entityType: 'dashboard',
        entityId: 'leads-filtered',
        actorUserId: appUserId(broad),
        tenantId: tenantA,
      });

      const rows = await findAuditRows(query, {
        action: EXPORT_ACTION,
        entityId: 'leads-filtered',
        tenantId: tenantA,
      });
      const details = rows[0]?.details as { after?: Record<string, unknown> };
      expect(details.after?.format).toBe('csv');
      expect(details.after?.rowCount).toBe(4);
      expect((details.after?.filters as { widgetKey?: string }).widgetKey).toBe('leads.filtered');
    });

    it('records the xlsx format when Excel is negotiated', async () => {
      const response = await call(`${BASE}/dashboard?widget=leads.filtered&format=xlsx`, {
        token: restricted.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(200);

      const rows = await findAuditRows(query, {
        action: EXPORT_ACTION,
        entityId: 'leads-filtered',
        tenantId: tenantA,
      });
      const latest = rows[rows.length - 1];
      const details = latest?.details as { after?: Record<string, unknown> };
      expect(details.after?.format).toBe('xlsx');
      expect(details.after?.rowCount).toBe(2);
    });

    it('does NOT write an audit row for a rejected export', async () => {
      const before = await findAuditRows(query, {
        action: EXPORT_ACTION,
        entityId: 'leads',
        tenantId: tenantA,
      });

      const response = await call(`${BASE}/leads`, {
        token: broad.accessToken,
        tenantId: tenantA,
        maxRows: 1,
      });
      expect(response.status).toBe(400);

      const after = await findAuditRows(query, {
        action: EXPORT_ACTION,
        entityId: 'leads',
        tenantId: tenantA,
      });
      expect(after).toHaveLength(before.length);
    });
  });
});
