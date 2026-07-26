/**
 * The Parties surface, end to end (T-023; AC-022, AC-024, AC-041; V-027, V-053).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/Parties/*` and `Leads/PartyLeadsTests.cs`, and
 * deliberately the same shape as reference-data.test.ts: real signed-in sessions, real
 * `tenants`/`user_tenants` rows, real per-tenant partitions, real grants, the real Hono pipeline
 * (auth -> tenant context -> permission resolution -> routes) via `app.request`. Nothing is
 * stubbed, because the properties under test — tenant isolation, the permission matrix and the
 * NON-BLOCKING duplicate warning — are properties of the composed system.
 *
 * WHY THE ISOLATION TESTS HERE ARE LOAD-BEARING RATHER THAN BELT-AND-BRACES
 * ========================================================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20). There is no database-level
 * net beneath the tenant predicates in repository.ts, so the ONLY thing standing between tenant A
 * and tenant B on these five endpoints is application code plus the assertions below. Every
 * endpoint gets an explicit cross-tenant test, and every MUTATING one checks BOTH the status code
 * AND the absence of a side effect — a 404 that still edited the row would satisfy a
 * status-code-only test.
 *
 * The leads card gets the same scrutiny twice over, because it is the one query in this domain the
 * `forTenant` helper cannot cover: it joins six tables in raw SQL, each with its own hand-written
 * `tenant_id` predicate. `does not resolve another tenant's broker/status/owner` is the test that
 * catches a dropped predicate on a JOINED table, which a party-level isolation test would not.
 *
 * This suite creates its own tenants (with their own partitions) and seeds its own parties, leads
 * and reference rows, so it never mutates the shared demo seed and can run alongside the other
 * domain suites.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PARTY_CREATED_ACTION,
  PARTY_UPDATED_ACTION,
} from '../../domains/parties/service.js';
import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('parties', probe);

const BASE = '/api/v1/parties';

interface PartyDto {
  readonly id: number;
  readonly name: string;
  readonly partyTypeId: number;
  readonly segmentId: number | null;
  readonly industryId: number | null;
  readonly regionId: number | null;
  readonly isStrategic: boolean;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly lastActivityAt: string | null;
  readonly openLeadsCount: number;
  readonly totalLeadsCount: number;
}

interface PartyListDto {
  readonly items: PartyDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

interface PartyWarningDto {
  readonly code: string;
  readonly matches: { id: number; name: string }[];
}

interface PartyMutationResultDto {
  readonly party: PartyDto;
  readonly warnings: PartyWarningDto[];
}

interface LeadCardDto {
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

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

/** A per-test-run marker so concurrent runs and repeated runs never collide on a name. */
/**
 * Deliberately SHORT, because duplicate detection here is trigram similarity over the whole name.
 *
 * The original token (`t023-<pid>-<ms>`, ~23 chars) was longer than the names under test, so every
 * fixture in a run shared a dominant block of trigrams: two utterly unrelated names scored 0.410
 * against each other — just over the 0.4 warning threshold — purely on the shared suffix, versus
 * 0.000 on the names alone. The "no near-duplicate" tests were therefore riding the threshold and
 * failed as soon as one more party fixture existed (measured, while adding the F-023-1 test). A
 * short high-entropy token restores the margin: unrelated names now score ~0.22-0.25 while the
 * genuine "Acme Insurance Ltd" vs "Acme Insurance Limited" pair scores 0.73. The `t023-` prefix is
 * load-bearing and must stay — the suite's stale-fixture purge keys on it.
 */
const RUN = `t023-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
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

  /** Holds parties.view/create/update in BOTH tenants and is a member of both. */
  let admin: TestUserSession;
  /** Member of tenant A with `parties.view` ONLY: proves view does not imply write. */
  let viewer: TestUserSession;
  /** Member of tenant A with NO parties grant at all: the permission-matrix control. */
  let plainMember: TestUserSession;

  let tenantA: number;
  let tenantB: number;

  const createdTenants: number[] = [];

  /** Tables this suite writes into, in dependency order for deletion. */
  const OWNED_TABLES = [
    'lead_assignments',
    'business_assignments',
    'leads',
    'brokers',
    'parties',
    'reference_items',
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

  /**
   * Deletes anything left behind by a PREVIOUS, ABORTED run of this suite (tenants are named with
   * the `t023-` prefix), before this run seeds anything.
   *
   * This is not tidiness — it is required for other suites to be correct. `afterAll` cleans up on a
   * normal exit, but a run killed mid-flight (CI timeout, Ctrl-C) leaves this suite's `party` audit
   * rows behind, and `tenants.test.ts` counts `audit_log where entity_id = $1` WITHOUT filtering
   * `entity_type` — so a leftover party audit row whose entity id happens to equal a tenant id under
   * test makes THAT suite fail, in a file whose author has no way to see why. Observed exactly that
   * way during T-023. Flagged to the orchestrator as a latent weakness in tenants.test.ts's
   * assertion; guarded from this side regardless, because this suite owns the rows it leaves.
   */
  async function purgeStaleRunsOfThisSuite(): Promise<void> {
    const stale = await query<{ id: string }>(
      "select id::text as id from tenants where name like 't023-%'",
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
    // Partitions before any seeded row, so this suite's rows land in the tenant's OWN partition
    // rather than the DEFAULT safety net — the same ordering tenant creation itself enforces.
    await query('select create_tenant_partitions($1)', [id]);
    return id;
  }

  async function addMembership(userId: number, tenantId: number): Promise<void> {
    await query('insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())', [
      tenantId,
      userId,
    ]);
  }

  /** Seeds one `reference_items` row directly, bypassing the API under test. */
  async function seedRef(
    tenantId: number,
    listType: string,
    name: string,
    options: { isActive?: boolean; reportingCategory?: string | null } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category,
          created_at, updated_at)
       values ($1, $2, $3, 0, $4, $5, now(), now())
       returning id::text as id`,
      [tenantId, listType, name, options.isActive ?? true, options.reportingCategory ?? null],
    );
    return Number(rows[0]?.id);
  }

  interface SeedParty {
    readonly name: string;
    readonly partyTypeId: number;
    readonly segmentId?: number | null;
    readonly industryId?: number | null;
    readonly regionId?: number | null;
    readonly isStrategic?: boolean;
    readonly lastActivityAt?: string | null;
  }

  /** Seeds one `parties` row directly, bypassing the API under test. */
  async function seedParty(tenantId: number, party: SeedParty): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into parties
         (tenant_id, name, party_type_id, segment_id, industry_id, region_id, is_strategic,
          last_activity_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       returning id::text as id`,
      [
        tenantId,
        party.name,
        party.partyTypeId,
        party.segmentId ?? null,
        party.industryId ?? null,
        party.regionId ?? null,
        party.isStrategic ?? false,
        party.lastActivityAt ?? null,
      ],
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

  async function seedBroker(tenantId: number, name: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into brokers (tenant_id, name, status, created_at, updated_at)
       values ($1, $2, 'active', now(), now()) returning id::text as id`,
      [tenantId, name],
    );
    return Number(rows[0]?.id);
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
      parties: { db },
    });
  }

  async function call(
    method: string,
    path: string,
    options: { token?: string; tenantId?: number; body?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    return await harness().request(`http://localhost${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  /** GET the list as the admin, asserting 200. */
  async function readList(tenantId: number, queryString = ''): Promise<PartyListDto> {
    const response = await call('GET', `${BASE}${queryString}`, {
      token: admin.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as PartyListDto;
  }

  /** Reads a row straight from the database — the side-effect check the API cannot fake. */
  async function readPartyRow(id: number): Promise<{
    name: string;
    party_type_id: string;
    segment_id: string | null;
    region_id: string | null;
    is_strategic: boolean;
    contact_email: string | null;
    contact_phone: string | null;
    tenant_id: string;
  }> {
    const rows = await query<{
      name: string;
      party_type_id: string;
      segment_id: string | null;
      region_id: string | null;
      is_strategic: boolean;
      contact_email: string | null;
      contact_phone: string | null;
      tenant_id: string;
    }>(
      `select name, party_type_id::text as party_type_id, segment_id::text as segment_id,
              region_id::text as region_id, is_strategic, contact_email, contact_phone,
              tenant_id::text as tenant_id
         from parties where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`party ${id} not found`);
    return row;
  }

  /** A body that satisfies every shape rule, so a test can vary exactly one field. */
  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: uniqueName('Valid Party'),
      partyTypeId: partyTypeA,
      segmentId: null,
      industryId: null,
      regionId: null,
      isStrategic: false,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      ...overrides,
    };
  }

  // Seeded reference fixtures, per tenant.
  let partyTypeA = 0;
  let partyTypeB = 0;
  let disabledPartyTypeA = 0;
  let segmentA = 0;
  let industryA = 0;
  let regionA = 0;
  let regionB = 0;
  let channelA = 0;
  let channelB = 0;
  let productLineA = 0;
  let productLineB = 0;
  let coverTypeA = 0;
  let coverTypeB = 0;
  let openStatusA = 0;
  let wonStatusA = 0;
  let openStatusB = 0;

  // Seeded party fixtures.
  let acmeA = 0;
  let zenithA = 0;
  let tenantBParty = 0;
  let brokerA = 0;

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

    admin = await auth.createTestUserWithSession({ label: 'parties-admin' });
    viewer = await auth.createTestUserWithSession({
      label: 'parties-viewer',
      firstName: 'Rita',
      lastName: 'Mensah',
    });
    plainMember = await auth.createTestUserWithSession({ label: 'parties-member' });

    await addMembership(appUserId(admin), tenantA);
    await addMembership(appUserId(admin), tenantB);
    await addMembership(appUserId(viewer), tenantA);
    await addMembership(appUserId(plainMember), tenantA);

    for (const permission of ['parties.view', 'parties.create', 'parties.update'] as const) {
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantA);
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantB);
    }
    // View ONLY, and deliberately NOT `leads.view`: this user is what proves the leads card is
    // gated by `parties.view` (LeadEndpoints.cs:40) rather than by the leads permission.
    await fixtures.grantDirectPermission(appUserId(viewer), 'parties.view', tenantA);
    // A DIFFERENT permission: proves the guard checks the required code, not "any grant at all".
    await fixtures.grantDirectPermission(appUserId(plainMember), 'leads.view', tenantA);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corporate A'));
    partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('Corporate B'));
    disabledPartyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Retired type A'), {
      isActive: false,
    });
    segmentA = await seedRef(tenantA, 'party_segment', uniqueName('Enterprise A'));
    industryA = await seedRef(tenantA, 'industry', uniqueName('Mining A'));
    regionA = await seedRef(tenantA, 'region', uniqueName('North A'));
    regionB = await seedRef(tenantB, 'region', uniqueName('North B'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email A'));
    channelB = await seedRef(tenantB, 'request_channel', uniqueName('Email B'));
    productLineA = await seedRef(tenantA, 'product_line', uniqueName('Motor A'));
    productLineB = await seedRef(tenantB, 'product_line', uniqueName('Motor B'));
    coverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Comprehensive A'));
    coverTypeB = await seedRef(tenantB, 'cover_type', uniqueName('Comprehensive B'));
    openStatusA = await seedRef(tenantA, 'lead_status', uniqueName('New A'), {
      reportingCategory: 'open',
    });
    wonStatusA = await seedRef(tenantA, 'lead_status', uniqueName('Won A'), {
      reportingCategory: 'won',
    });
    openStatusB = await seedRef(tenantB, 'lead_status', uniqueName('New B'), {
      reportingCategory: 'open',
    });

    brokerA = await seedBroker(tenantA, uniqueName('Broker A'));

    acmeA = await seedParty(tenantA, {
      name: `Acme Insurance Ltd ${RUN}`,
      partyTypeId: partyTypeA,
      segmentId: segmentA,
      industryId: industryA,
      regionId: regionA,
      isStrategic: true,
      lastActivityAt: '2026-02-01T00:00:00Z',
    });
    zenithA = await seedParty(tenantA, {
      name: `Zenith Holdings ${RUN}`,
      partyTypeId: partyTypeA,
    });
    tenantBParty = await seedParty(tenantB, {
      name: `Tenant B Only Party ${RUN}`,
      partyTypeId: partyTypeB,
    });
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on (tests/helpers/auth.ts), and every delete here swallows its error, so the reverse order
    // is a silent no-op that leaks this suite's tenants and audit rows into the next run.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 180_000);

  // -------------------------------------------------------------------------------------------
  // Contract: DTO and envelope shapes
  // -------------------------------------------------------------------------------------------

  it('returns the reference PartyDto shape, field for field', async () => {
    const response = await call('GET', `${BASE}/${acmeA}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    const party = (await response.json()) as PartyDto;

    expect(Object.keys(party).sort()).toEqual(
      [
        'contactEmail',
        'contactName',
        'contactPhone',
        'id',
        'industryId',
        'isStrategic',
        'lastActivityAt',
        'name',
        'openLeadsCount',
        'partyTypeId',
        'regionId',
        'segmentId',
        'totalLeadsCount',
      ].sort(),
    );
  });

  it('returns the reference PartyListDto envelope with totalCount, not total', async () => {
    const list = await readList(tenantA);

    // The task file described this envelope as `{items,page,pageSize,total}`; the reference
    // (PartyListDto.cs:67) and the SPA (partiesApi.ts) both say `totalCount`. Pinned so a future
    // "cleanup" cannot silently break the existing grid's paging.
    expect(Object.keys(list).sort()).toEqual(['items', 'page', 'pageSize', 'totalCount']);
    expect(list.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('defaults to page 1 and page size 25 when neither is supplied', async () => {
    const list = await readList(tenantA);
    expect(list.page).toBe(1);
    expect(list.pageSize).toBe(25);
  });

  it('floors a non-positive page and page size at the reference defaults', async () => {
    // ListPartiesQueryHandler.cs:21-22: `Page < 1 ? 1`, `PageSize < 1 ? 25`.
    const list = await readList(tenantA, '?page=0&pageSize=0');
    expect(list.page).toBe(1);
    expect(list.pageSize).toBe(25);
  });

  // -------------------------------------------------------------------------------------------
  // List: paging, sorting, search, filters
  // -------------------------------------------------------------------------------------------

  it('pages server-side, and totalCount counts the whole filtered set rather than the page', async () => {
    const list = await readList(tenantA, '?pageSize=1&page=1');

    expect(list.items).toHaveLength(1);
    expect(list.pageSize).toBe(1);
    expect(list.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('returns disjoint pages, so a paged client sees every row exactly once', async () => {
    const first = await readList(tenantA, '?pageSize=1&page=1');
    const second = await readList(tenantA, '?pageSize=1&page=2');

    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  });

  it('sorts by name ascending by default', async () => {
    const list = await readList(tenantA, '?pageSize=100');
    const names = list.items.map((item) => item.name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('reverses the order for the `-` descending prefix', async () => {
    const ascending = await readList(tenantA, '?pageSize=100&sort=name');
    const descending = await readList(tenantA, '?pageSize=100&sort=-name');

    expect(descending.items.map((item) => item.id)).toEqual(
      [...ascending.items].reverse().map((item) => item.id),
    );
  });

  it('falls back to the default name ordering for an unrecognized sort field, not an error', async () => {
    // SortSpec.cs documents this: "an unrecognized field is deliberately not an error", so a stale
    // bookmark still returns a sane list rather than a 400.
    const nonsense = await readList(tenantA, '?pageSize=100&sort=drop_table');
    const byName = await readList(tenantA, '?pageSize=100&sort=name');

    expect(nonsense.items.map((item) => item.id)).toEqual(byName.items.map((item) => item.id));
  });

  it('sorts nullable columns with the value-less rows LAST in both directions', async () => {
    // PartyStore.cs:157 leads with `OrderBy(p => p.SegmentId == null)` before applying direction,
    // so a null segment sorts last ascending AND descending — not Postgres's direction-dependent
    // default. `zenithA` has no segment; `acmeA` does.
    for (const sort of ['segment', '-segment']) {
      const list = await readList(tenantA, `?pageSize=100&sort=${sort}`);
      const ids = list.items.map((item) => item.id);
      expect(ids.indexOf(acmeA)).toBeLessThan(ids.indexOf(zenithA));
    }
  });

  it('finds a party by a substring of its name', async () => {
    const list = await readList(tenantA, `?search=${encodeURIComponent('Acme Insurance')}`);
    expect(list.items.map((item) => item.id)).toContain(acmeA);
  });

  it('finds a party by a MISSPELLED name, via the trigram half of the search predicate', async () => {
    // The ILIKE half cannot match this; only `similarity(name, $1) >= 0.3` can (PartyStore.cs:69-75).
    // This is the assertion that fails if the trigram branch is dropped as "redundant".
    const list = await readList(tenantA, `?search=${encodeURIComponent('Acme Insurnce Ltd')}`);
    expect(list.items.map((item) => item.id)).toContain(acmeA);
  });

  it('excludes non-matching parties from a search rather than merely reordering them', async () => {
    const list = await readList(tenantA, `?search=${encodeURIComponent('Acme Insurance')}`);
    expect(list.items.map((item) => item.id)).not.toContain(zenithA);
  });

  it('filters by party type, segment, industry, region and strategic', async () => {
    for (const [name, queryString, expected] of [
      ['segmentId', `?segmentId=${segmentA}`, acmeA],
      ['industryId', `?industryId=${industryA}`, acmeA],
      ['regionId', `?regionId=${regionA}`, acmeA],
      ['strategic', '?strategic=true', acmeA],
    ] as const) {
      const list = await readList(tenantA, `${queryString}&pageSize=100`);
      expect(list.items.map((item) => item.id), `filter ${name}`).toContain(expected);
      expect(list.items.map((item) => item.id), `filter ${name}`).not.toContain(zenithA);
    }
  });

  it('treats strategic=false as a real filter rather than as "no filter"', async () => {
    const list = await readList(tenantA, '?strategic=false&pageSize=100');
    expect(list.items.map((item) => item.id)).toContain(zenithA);
    expect(list.items.map((item) => item.id)).not.toContain(acmeA);
  });

  it('ignores an unparseable filter value instead of rejecting the request', async () => {
    // ASP.NET's binder binds NULL for a `long?` that will not parse, so the reference lists
    // everything rather than 400ing (schemas.ts documents the ported behaviour). A hand-edited URL
    // must not become an error page.
    const list = await readList(tenantA, '?partyTypeId=abc&pageSize=100');
    expect(list.items.map((item) => item.id)).toContain(acmeA);
  });

  // -------------------------------------------------------------------------------------------
  // Lead-count overlay on the list
  // -------------------------------------------------------------------------------------------

  it('overlays open and total lead counts, counting only open/quoted categories as open', async () => {
    const party = await seedParty(tenantA, {
      name: uniqueName('Counted Party'),
      partyTypeId: partyTypeA,
    });
    const common = {
      partyId: party,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
    };
    await seedLead(tenantA, { ...common, leadRef: uniqueName('L-open-1'), statusId: openStatusA });
    await seedLead(tenantA, { ...common, leadRef: uniqueName('L-open-2'), statusId: openStatusA });
    await seedLead(tenantA, { ...common, leadRef: uniqueName('L-won-1'), statusId: wonStatusA });

    const list = await readList(tenantA, '?pageSize=100');
    const row = list.items.find((item) => item.id === party);

    expect(row?.openLeadsCount).toBe(2);
    expect(row?.totalLeadsCount).toBe(3);
  });

  it('reports zero counts for a party with no leads rather than omitting the fields', async () => {
    const list = await readList(tenantA, '?pageSize=100');
    const row = list.items.find((item) => item.id === zenithA);

    expect(row?.openLeadsCount).toBe(0);
    expect(row?.totalLeadsCount).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Create: success, envelope, audit
  // -------------------------------------------------------------------------------------------

  it('creates a party, answering 201 with a Location header and the mutation envelope', async () => {
    const name = uniqueName('Created Party');
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name, regionId: regionA, isStrategic: true }),
    });

    expect(response.status).toBe(201);
    const result = (await response.json()) as PartyMutationResultDto;

    expect(response.headers.get('location')).toBe(`/api/v1/parties/${result.party.id}`);
    expect(Object.keys(result).sort()).toEqual(['party', 'warnings']);
    expect(result.party.name).toBe(name);
    expect(result.party.isStrategic).toBe(true);
    expect(result.party.regionId).toBe(regionA);

    const row = await readPartyRow(result.party.id);
    expect(row.tenant_id).toBe(String(tenantA));
  });

  it('trims the persisted name, as the reference Name.Trim() does', async () => {
    const bare = uniqueName('Trimmed Party');
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: `   ${bare}   ` }),
    });

    expect(response.status).toBe(201);
    const result = (await response.json()) as PartyMutationResultDto;
    expect(result.party.name).toBe(bare);
    expect((await readPartyRow(result.party.id)).name).toBe(bare);
  });

  it('defaults isStrategic to false when the flag is absent or explicitly null', async () => {
    for (const isStrategic of [undefined, null]) {
      const body = validBody();
      if (isStrategic === undefined) delete body['isStrategic'];
      else body['isStrategic'] = null;

      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body,
      });
      expect(response.status).toBe(201);
      const result = (await response.json()) as PartyMutationResultDto;
      expect(result.party.isStrategic).toBe(false);
    }
  });

  it('audits the creation with the actor, the tenant and an after snapshot', async () => {
    const name = uniqueName('Audited Create');
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name }),
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as PartyMutationResultDto;

    const row = await assertAudited(query, {
      action: PARTY_CREATED_ACTION,
      entityType: 'party',
      entityId: String(result.party.id),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
    });

    expect((row.details as Record<string, unknown>)['before']).toBeNull();
    expect((row.details as Record<string, Record<string, unknown>>)['after']?.['name']).toBe(name);
  });

  // -------------------------------------------------------------------------------------------
  // THE DUPLICATE-NAME WARNING — non-blocking (AC-041, spec FR-28)
  // -------------------------------------------------------------------------------------------

  it('warns about a near-duplicate name AND still creates the party', async () => {
    // V-053's named scenario: seeded 'Acme Insurance Ltd', creating 'Acme Insurance Limited'.
    // BOTH halves are asserted, and the second is the one that matters: a warning that blocked the
    // create would be a behaviour change, and a status-code-only test would not notice.
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: `Acme Insurance Limited ${RUN}` }),
    });

    expect(response.status).toBe(201);
    const result = (await response.json()) as PartyMutationResultDto;

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('DUPLICATE_NAME');
    expect(result.warnings[0]?.matches.map((match) => match.id)).toContain(acmeA);
    expect(result.warnings[0]?.matches.map((match) => match.name)).toContain(
      `Acme Insurance Ltd ${RUN}`,
    );

    // The row is REALLY there — proof the warning did not roll the write back.
    const row = await readPartyRow(result.party.id);
    expect(row.name).toBe(`Acme Insurance Limited ${RUN}`);
  });

  it('never lists the newly created party as a duplicate of itself', async () => {
    // `excludeId: party.Id` (CreatePartyCommandHandler.cs:90). Without it EVERY create would warn,
    // since a row is always perfectly similar to itself.
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: uniqueName('Utterly Distinct Name') }),
    });

    expect(response.status).toBe(201);
    const result = (await response.json()) as PartyMutationResultDto;
    expect(result.warnings).toEqual([]);
  });

  it('emits no warning at all for a name with no near-duplicate', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: uniqueName('Qwertzuiop Xylophone') }),
    });

    expect(response.status).toBe(201);
    expect(((await response.json()) as PartyMutationResultDto).warnings).toEqual([]);
  });

  it('does not warn about a near-duplicate that belongs to ANOTHER tenant', async () => {
    // A warning naming another tenant's party would leak both its existence and its name.
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: `Tenant B Only Party ${RUN}` }),
    });

    expect(response.status).toBe(201);
    const result = (await response.json()) as PartyMutationResultDto;
    expect(result.warnings.flatMap((warning) => warning.matches.map((m) => m.id))).not.toContain(
      tenantBParty,
    );
  });

  it('warns on an UPDATE that renames a party into a near-duplicate, and still saves it', async () => {
    const party = await seedParty(tenantA, {
      name: uniqueName('Renamed Party'),
      partyTypeId: partyTypeA,
    });
    const newName = `Acme Insurance Company ${RUN}`;

    const response = await call('PUT', `${BASE}/${party}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: newName }),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as PartyMutationResultDto;
    expect(result.warnings[0]?.code).toBe('DUPLICATE_NAME');
    expect((await readPartyRow(party)).name).toBe(newName);
  });

  // -------------------------------------------------------------------------------------------
  // Validation catalog (V-053)
  // -------------------------------------------------------------------------------------------

  it('rejects a create with no name as 422 PARTY_VALIDATION_FAILED', async () => {
    const body = validBody();
    delete body['name'];

    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body,
    });

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemBody;
    // The CODE, not merely the status: a 422 carrying the wrong code is a contract break a
    // status-only assertion would pass.
    expect(problem.code).toBe('PARTY_VALIDATION_FAILED');
    expect(problem.detail).toContain('PARTY_VALIDATION_FAILED');
    expect(problem.errors?.some((error) => error.field === 'name')).toBe(true);
  });

  it('rejects a whitespace-only name, which is not the same check as a missing one', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: '    ' }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_VALIDATION_FAILED');
  });

  it('rejects a name longer than 200 characters and accepts one of exactly 200', async () => {
    const tooLong = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: 'x'.repeat(201) }),
    });
    expect(tooLong.status).toBe(422);
    expect(((await tooLong.json()) as ProblemBody).code).toBe('PARTY_VALIDATION_FAILED');

    const atLimit = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: `y${'z'.repeat(199)}` }),
    });
    expect(atLimit.status).toBe(201);
  });

  it('rejects an invalid contact email with a field-level error', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ contactEmail: 'not-an-email' }),
    });

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemBody;
    expect(problem.code).toBe('PARTY_VALIDATION_FAILED');
    expect(problem.errors?.some((error) => error.field === 'contactEmail')).toBe(true);
  });

  it('rejects an invalid contact phone with a field-level error', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ contactPhone: 'call-me-maybe' }),
    });

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemBody;
    expect(problem.code).toBe('PARTY_VALIDATION_FAILED');
    expect(problem.errors?.some((error) => error.field === 'contactPhone')).toBe(true);
  });

  it('accepts the contact formats the reference lenient patterns allow', async () => {
    // PartyContactValidation.cs:16 — `^[+]?[0-9()\-.\s]{7,20}$`, 7-20 chars, local or E.164-ish.
    for (const contactPhone of ['+27 11 555 1234', '(011) 555-1234', '0115551234']) {
      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ contactPhone, contactEmail: 'ops@example.com' }),
      });
      expect(response.status, `phone ${contactPhone}`).toBe(201);
    }
  });

  it('accepts a blank contact email/phone, because the reference When() guard skips whitespace', async () => {
    // `.When(x => !string.IsNullOrWhiteSpace(...))` — "   " never reaches the format rule and is
    // VALID in the reference. `z.string().email()` would have rejected it, turning a currently-200
    // SPA request into a 422.
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ contactEmail: '   ', contactPhone: '  ' }),
    });

    expect(response.status).toBe(201);
  });

  it('rejects an unknown body field rather than silently ignoring it', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ tenantId: 99_999 }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_VALIDATION_FAILED');
  });

  it('rejects an inactive party type with the specific PARTY_INVALID_PARTY_TYPE code', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ partyTypeId: disabledPartyTypeA }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_INVALID_PARTY_TYPE');
  });

  it('gives ANOTHER TENANT’s reference id the same 422 code as an inactive one, never a distinct answer', async () => {
    // PartyErrors.cs:5-17: a distinguishable answer for "exists, but is another tenant's" is a
    // cross-tenant existence oracle (N-01). Both must be PARTY_INVALID_PARTY_TYPE.
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ partyTypeId: partyTypeB }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_INVALID_PARTY_TYPE');
  });

  it('rejects a foreign-tenant segment, industry and region with their own specific codes', async () => {
    for (const [field, value, code] of [
      ['segmentId', partyTypeB, 'PARTY_INVALID_SEGMENT'],
      ['industryId', partyTypeB, 'PARTY_INVALID_INDUSTRY'],
      ['regionId', regionB, 'PARTY_INVALID_REGION'],
    ] as const) {
      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ [field]: value }),
      });

      expect(response.status, field).toBe(422);
      expect(((await response.json()) as ProblemBody).code, field).toBe(code);
    }
  });

  it('accepts a null region, which is optional by design (Q-9)', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ regionId: null }),
    });

    expect(response.status).toBe(201);
  });

  it('reports the SEGMENT when both the segment and the region are invalid', async () => {
    // The guard ORDER is observable (CreatePartyCommandHandler.cs:47-63) and is preserved.
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ segmentId: partyTypeB, regionId: regionB }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_INVALID_SEGMENT');
  });

  it('writes no row when validation fails', async () => {
    const name = uniqueName('Never Persisted');
    const before = await query<{ count: string }>('select count(*)::text as count from parties');

    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name, contactEmail: 'nope' }),
    });
    expect(response.status).toBe(422);

    const after = await query<{ count: string }>('select count(*)::text as count from parties');
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  // -------------------------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------------------------

  it('updates a party and returns the mutation envelope, not a bare PartyDto', async () => {
    const party = await seedParty(tenantA, {
      name: uniqueName('Before Edit'),
      partyTypeId: partyTypeA,
    });
    const newName = uniqueName('After Edit');

    const response = await call('PUT', `${BASE}/${party}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: newName, isStrategic: true, contactEmail: 'ops@example.com' }),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as PartyMutationResultDto;
    expect(Object.keys(result).sort()).toEqual(['party', 'warnings']);
    expect(result.party.name).toBe(newName);

    const row = await readPartyRow(party);
    expect(row.name).toBe(newName);
    expect(row.is_strategic).toBe(true);
    expect(row.contact_email).toBe('ops@example.com');
  });

  it('audits the update with a before/after diff', async () => {
    const originalName = uniqueName('Audited Before');
    const party = await seedParty(tenantA, { name: originalName, partyTypeId: partyTypeA });
    const newName = uniqueName('Audited After');

    const response = await call('PUT', `${BASE}/${party}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: newName }),
    });
    expect(response.status).toBe(200);

    const row = await assertAudited(query, {
      action: PARTY_UPDATED_ACTION,
      entityType: 'party',
      entityId: String(party),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
    });

    const details = row.details as Record<string, Record<string, unknown>>;
    expect(details['before']?.['name']).toBe(originalName);
    expect(details['after']?.['name']).toBe(newName);
  });

  it('answers 404 for an unknown party id on both detail and update', async () => {
    const missing = 999_999_999;

    const detail = await call('GET', `${BASE}/${missing}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(detail.status).toBe(404);
    expect(((await detail.json()) as ProblemBody).code).toBe('PARTY_NOT_FOUND');

    const update = await call('PUT', `${BASE}/${missing}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody(),
    });
    expect(update.status).toBe(404);
    expect(((await update.json()) as ProblemBody).code).toBe('PARTY_NOT_FOUND');
  });

  it('answers 404 for a non-numeric id, as the {id:long} route constraint does', async () => {
    const response = await call('GET', `${BASE}/not-a-number`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(404);
  });

  it('answers 404 rather than 422 when editing an unknown party with an invalid body', async () => {
    // The existence check precedes the reference-value guards (UpdatePartyCommandHandler.cs:39-45),
    // and the order is observable.
    const response = await call('PUT', `${BASE}/999999999`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ partyTypeId: disabledPartyTypeA }),
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_NOT_FOUND');
  });

  // -------------------------------------------------------------------------------------------
  // The leads card (GET /parties/{id}/leads)
  // -------------------------------------------------------------------------------------------

  it('returns the party leads card with the reference LeadListItemDto shape', async () => {
    const party = await seedParty(tenantA, {
      name: uniqueName('Card Party'),
      partyTypeId: partyTypeA,
    });
    await seedLead(tenantA, {
      partyId: party,
      leadRef: uniqueName('L-card'),
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      brokerId: brokerA,
      estimatedPremium: 12_500.5,
      dateReceived: '2026-03-01',
      nextFollowUpDate: '2026-03-10',
    });

    const response = await call('GET', `${BASE}/${party}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    const leads = (await response.json()) as LeadCardDto[];

    expect(leads).toHaveLength(1);
    const lead = leads[0] as LeadCardDto;
    expect(Object.keys(lead).sort()).toEqual(
      [
        'ageDays',
        'brokerId',
        'brokerName',
        'coverTypeName',
        'dateReceived',
        'flags',
        'id',
        'leadRef',
        'nextFollowUpDate',
        'owner',
        'partyId',
        'partyName',
        'premium',
        'priority',
        'productLineName',
        'statusName',
      ].sort(),
    );

    // Names are RESOLVED, not ids echoed back: the card renders these directly.
    expect(lead.brokerId).toBe(brokerA);
    expect(lead.brokerName).toContain('Broker A');
    expect(lead.productLineName).toContain('Motor A');
    expect(lead.coverTypeName).toContain('Comprehensive A');
    expect(lead.statusName).toContain('New A');
    expect(lead.premium).toBe(12_500.5);
    expect(lead.dateReceived).toBe('2026-03-01');
    expect(lead.nextFollowUpDate).toBe('2026-03-10');
    // Flags come from alert evaluation, which is not this task's scope — the reference emits an
    // empty list here too (LeadDto.cs:149-153), so an empty list is the CORRECT answer, not a stub.
    expect(lead.flags).toEqual([]);
  });

  it('includes a lead with no broker and no owner rather than dropping it from the card', async () => {
    // The broker and owner joins are LEFT joins; making either an inner join would silently hide
    // every unassigned lead from the card, which is the failure this pins.
    const party = await seedParty(tenantA, {
      name: uniqueName('Bare Lead Party'),
      partyTypeId: partyTypeA,
    });
    await seedLead(tenantA, {
      partyId: party,
      leadRef: uniqueName('L-bare'),
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      brokerId: null,
    });

    const response = await call('GET', `${BASE}/${party}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    const leads = (await response.json()) as LeadCardDto[];

    expect(leads).toHaveLength(1);
    expect(leads[0]?.brokerId).toBeNull();
    expect(leads[0]?.brokerName).toBeNull();
    expect(leads[0]?.owner).toBeNull();
    expect(leads[0]?.premium).toBeNull();
  });

  it('does not leak another tenant’s broker name when a lead points at a foreign broker', async () => {
    // Guards the `b.tenant_id = ${tenantId}` predicate on the brokers LEFT JOIN (F-023-1).
    //
    // That predicate looked untestable: ids are globally unique because identity sequences live on
    // the partitioned parent, so a tenant-A lead's broker_id "cannot" match a tenant-B broker. But
    // `leads.broker_id` carries NO physical FK (brokers migration: "by convention, no FK"), so the
    // schema permits exactly the state the predicate defends against — and plain SQL, which is how
    // these fixtures seed everything, can construct it. Without the predicate this endpoint returns
    // the OTHER tenant's broker name. The globally-unique-id argument only ever covered
    // convention-respecting data; the predicate exists for convention-violating data.
    const foreignBroker = await seedBroker(tenantB, uniqueName('Foreign Broker B'));
    const foreignBrokerName = (
      await query<{ name: string }>('select name from brokers where tenant_id = $1 and id = $2', [
        tenantB,
        foreignBroker,
      ])
    )[0]?.name;
    expect(foreignBrokerName, 'fixture must have produced a named tenant-B broker').toBeTruthy();

    const party = await seedParty(tenantA, {
      name: uniqueName('Foreign Broker Ref Co'),
      partyTypeId: partyTypeA,
    });
    await seedLead(tenantA, {
      partyId: party,
      leadRef: uniqueName('LD-FOREIGN'),
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
      brokerId: foreignBroker, // deliberately corrupt: tenant-B id on a tenant-A lead
    });

    const response = await call('GET', `${BASE}/${party}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const leads = JSON.parse(body) as LeadCardDto[];

    // The lead itself must still be listed — the join is LEFT, so a corrupt reference must not make
    // the tenant's own lead vanish from its own card.
    expect(leads).toHaveLength(1);
    expect(leads[0]?.brokerName, 'resolved a broker across the tenant boundary').toBeNull();
    // Belt and braces on the raw payload: no part of the foreign name may appear anywhere.
    expect(body).not.toContain(foreignBrokerName);
  });

  it('resolves the owner from the rm business-assignment slot', async () => {
    const party = await seedParty(tenantA, {
      name: uniqueName('Owned Lead Party'),
      partyTypeId: partyTypeA,
    });
    const leadId = await seedLead(tenantA, {
      partyId: party,
      leadRef: uniqueName('L-owned'),
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
    });

    const role = await fixtures.createRole({ tenantId: tenantA });
    const assignmentRows = await query<{ id: string }>(
      `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
       values ($1, $2, 'rm', now(), now()) returning id::text as id`,
      [tenantA, role],
    );
    await query(
      `insert into lead_assignments
         (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [tenantA, leadId, Number(assignmentRows[0]?.id), appUserId(viewer)],
    );

    const response = await call('GET', `${BASE}/${party}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    const leads = (await response.json()) as LeadCardDto[];

    expect(leads[0]?.owner).toEqual({
      userId: appUserId(viewer),
      firstName: 'Rita',
      lastName: 'Mensah',
    });
  });

  it('orders the card newest-received first', async () => {
    const party = await seedParty(tenantA, {
      name: uniqueName('Ordered Card Party'),
      partyTypeId: partyTypeA,
    });
    const common = {
      partyId: party,
      statusId: openStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
    };
    await seedLead(tenantA, { ...common, leadRef: uniqueName('L-old'), dateReceived: '2026-01-01' });
    await seedLead(tenantA, { ...common, leadRef: uniqueName('L-new'), dateReceived: '2026-06-01' });

    const response = await call('GET', `${BASE}/${party}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    const leads = (await response.json()) as LeadCardDto[];

    expect(leads.map((lead) => lead.dateReceived)).toEqual(['2026-06-01', '2026-01-01']);
  });

  it('returns an empty card for a party with no leads', async () => {
    const response = await call('GET', `${BASE}/${zenithA}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('gates the leads card on parties.view, not leads.view', async () => {
    // `viewer` holds `parties.view` and NOT `leads.view`; `plainMember` holds `leads.view` and NOT
    // `parties.view`. The reference gates this route on Parties.View (LeadEndpoints.cs:40), so the
    // first must pass and the second must not.
    const allowed = await call('GET', `${BASE}/${zenithA}/leads`, {
      token: viewer.accessToken,
      tenantId: tenantA,
    });
    expect(allowed.status).toBe(200);

    const denied = await call('GET', `${BASE}/${zenithA}/leads`, {
      token: plainMember.accessToken,
      tenantId: tenantA,
    });
    expect(denied.status).toBe(403);
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation (AC-022, V-027) — one test per endpoint
  // -------------------------------------------------------------------------------------------

  it('never returns another tenant’s parties in the list', async () => {
    const list = await readList(tenantA, '?pageSize=100');

    expect(list.items.map((item) => item.id)).not.toContain(tenantBParty);

    // Stronger than an id/name denylist, and deliberately so: EVERY returned row is looked up in
    // the database and required to live in tenant A. A name denylist would be defeated by this
    // suite's own tenant-A party that deliberately copies a tenant-B name (the duplicate-warning
    // isolation test), and would not notice a leak of a party the test did not know to name.
    for (const item of list.items) {
      expect(
        (await readPartyRow(item.id)).tenant_id,
        `party ${item.id} (${item.name}) leaked from another tenant`,
      ).toBe(String(tenantA));
    }
  });

  it('does not let a tenant-A search reach a tenant-B party by name', async () => {
    const list = await readList(tenantA, `?search=${encodeURIComponent('Tenant B Only Party')}`);
    expect(list.items.map((item) => item.id)).not.toContain(tenantBParty);
  });

  it('counts only the caller’s tenant in totalCount', async () => {
    const listA = await readList(tenantA, '?pageSize=100');
    const listB = await readList(tenantB, '?pageSize=100');

    expect(listA.items.every((item) => item.id !== tenantBParty)).toBe(true);
    expect(listA.totalCount).toBe(listA.items.length);
    expect(listB.totalCount).toBe(listB.items.length);
  });

  it('answers 404 for a cross-tenant party id on detail (N-01)', async () => {
    const response = await call('GET', `${BASE}/${tenantBParty}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_NOT_FOUND');
  });

  it('answers 404 for a cross-tenant party id on the leads card', async () => {
    const response = await call('GET', `${BASE}/${tenantBParty}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_NOT_FOUND');
  });

  it('answers 404 for a cross-tenant update AND leaves the row untouched', async () => {
    const before = await readPartyRow(tenantBParty);

    const response = await call('PUT', `${BASE}/${tenantBParty}`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody({ name: 'Hijacked Name' }),
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as ProblemBody).code).toBe('PARTY_NOT_FOUND');

    // The side-effect half: a 404 that still edited the row would pass a status-only test.
    const after = await readPartyRow(tenantBParty);
    expect(after.name).toBe(before.name);
    expect(after.tenant_id).toBe(String(tenantB));
  });

  it('writes a created party into the header tenant, not one named in the body', async () => {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantB,
      body: {
        name: uniqueName('Tenant B Create'),
        partyTypeId: partyTypeB,
        segmentId: null,
        industryId: null,
        regionId: null,
        isStrategic: false,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
      },
    });

    expect(response.status).toBe(201);
    const result = (await response.json()) as PartyMutationResultDto;
    expect((await readPartyRow(result.party.id)).tenant_id).toBe(String(tenantB));

    // And it is invisible from tenant A.
    const listA = await readList(tenantA, '?pageSize=100');
    expect(listA.items.map((item) => item.id)).not.toContain(result.party.id);
  });

  it('does not resolve another tenant’s joined rows on the leads card', async () => {
    // The card's raw SQL carries a hand-written tenant predicate on EVERY joined alias. This seeds
    // a tenant-B lead against a tenant-B party and proves tenant A's card cannot see it — the case
    // that catches a dropped predicate on a JOINED table rather than on `leads` itself.
    await seedLead(tenantB, {
      partyId: tenantBParty,
      leadRef: uniqueName('L-tenant-b'),
      statusId: openStatusB,
      productLineId: productLineB,
      coverTypeId: coverTypeB,
      regionId: regionB,
      requestChannelId: channelB,
    });

    const bCard = await call('GET', `${BASE}/${tenantBParty}/leads`, {
      token: admin.accessToken,
      tenantId: tenantB,
    });
    expect(bCard.status).toBe(200);
    expect((await bCard.json()) as LeadCardDto[]).toHaveLength(1);

    // Same id, tenant A context: 404, not that lead.
    const aCard = await call('GET', `${BASE}/${tenantBParty}/leads`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });
    expect(aCard.status).toBe(404);
  });

  it('does not count another tenant’s leads in a party’s lead counts', async () => {
    const listB = await readList(tenantB, '?pageSize=100');
    const row = listB.items.find((item) => item.id === tenantBParty);

    // Tenant B's party has exactly the one lead seeded above; tenant A's many leads must not leak
    // into its counts even though the counting query joins reference_items.
    expect(row?.totalLeadsCount).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // Permission matrix
  // -------------------------------------------------------------------------------------------

  it('denies every parties route to a tenant member with no parties grant', async () => {
    for (const [method, path, body] of [
      ['GET', BASE, undefined],
      ['GET', `${BASE}/${acmeA}`, undefined],
      ['GET', `${BASE}/${acmeA}/leads`, undefined],
      ['POST', BASE, validBody()],
      ['PUT', `${BASE}/${acmeA}`, validBody()],
    ] as const) {
      const response = await call(method, path, {
        token: plainMember.accessToken,
        tenantId: tenantA,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lets parties.view read but not write — view does not imply create or update', async () => {
    const read = await call('GET', BASE, { token: viewer.accessToken, tenantId: tenantA });
    expect(read.status).toBe(200);

    const create = await call('POST', BASE, {
      token: viewer.accessToken,
      tenantId: tenantA,
      body: validBody(),
    });
    expect(create.status).toBe(403);

    const update = await call('PUT', `${BASE}/${acmeA}`, {
      token: viewer.accessToken,
      tenantId: tenantA,
      body: validBody(),
    });
    expect(update.status).toBe(403);
  });

  it('does not honour a grant held in a DIFFERENT tenant', async () => {
    // `viewer` holds parties.view in tenant A only and is not a member of tenant B.
    const response = await call('GET', BASE, { token: viewer.accessToken, tenantId: tenantB });
    expect([403, 404]).toContain(response.status);
  });

  it('requires authentication', async () => {
    const response = await call('GET', BASE, { tenantId: tenantA });
    expect(response.status).toBe(401);
  });

  it('requires a tenant header, because /parties is tenant-scoped and not global', async () => {
    // 403, NOT 400 — and that is the deliberate house contract, not a quirk of this route.
    // lib/tenancy/middleware.ts:11-31 records that a missing OR malformed `X-Tenant-Id` folds into
    // the same 403 the reference's TenantContextMiddleware.cs:50-55 emits, so that a client cannot
    // distinguish "no header" from "not your tenant" and use the difference as a probe (N-01).
    const response = await call('GET', BASE, { token: admin.accessToken });
    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------------------------
  // No deletion (P-05, AC-041)
  // -------------------------------------------------------------------------------------------

  it('exposes NO delete route for a party', async () => {
    // P-05/PRD 12.9: parties are corrected via Edit only, because leads reference parties and a
    // deleted party would orphan a lead's client name. Asserted as a route-table property: the
    // fully-permissioned admin must not be able to delete, and the answer must be "no such route"
    // rather than "forbidden".
    const response = await call('DELETE', `${BASE}/${acmeA}`, {
      token: admin.accessToken,
      tenantId: tenantA,
    });

    expect(response.status).toBe(404);

    // And the party is still there.
    expect((await readPartyRow(acmeA)).name).toBe(`Acme Insurance Ltd ${RUN}`);
  });
});
