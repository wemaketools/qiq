/**
 * Global type-ahead search, end to end (T-038; AC-022, AC-080; V-027, V-101).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/Search/*`, and deliberately the same shape as
 * parties.test.ts: real signed-in sessions, real `tenants`/`user_tenants` rows, real per-tenant
 * partitions, real grants, the real Hono pipeline (auth -> tenant context -> permission resolution
 * -> routes) via `app.request`. Nothing is stubbed, because the properties under test — tenant
 * isolation, the leads/quotes visibility-breadth rule, the four-group grouping, the reference
 * ranking and the per-group limit — are properties of the composed system.
 *
 * WHAT THE FIXTURES DISCRIMINATE, AND WHY THE QUERY TERM IS NOT VACUOUS
 * ====================================================================
 * The primary term is the bare stem `Acme`. It matches a PROPER, non-empty SUBSET of the seed:
 *   - parties: `Acme Insurance <RUN>` matches; `Zenith Holdings <RUN>` does not.
 *   - leads:   the lead whose `lead_ref` starts `ACME<RUN>` (via lead_ref prefix), the lead on the
 *              Acme party (via party-name substring) and the lead whose `external_ref` starts
 *              `ACME<RUN>` (via external_ref prefix) match; the `OTHER<RUN>` lead does not.
 *   - quotes:  only `ACME<RUN>-Q1` (quote_ref prefix) matches; `OTHER<RUN>-Q2` does not.
 *   - brokers: `Acme Brokers <RUN>` matches; `Northwind Brokers <RUN>` does not.
 * Every group therefore has both a hit and a non-hit, and each group's non-hit is asserted absent —
 * an empty group or a group returning everything would both fail.
 *
 * THE QUERY TERMS DELIBERATELY OMIT THE RUN TOKEN. Seeded NAMES carry `<RUN>` so a prior aborted
 * run's rows (purged at start) and other suites' rows never collide; but the SEARCH terms are the
 * bare lexical stems (`Acme`, `Zeta`, `Brokers`, `Solobrand`), because (a) each run creates its own
 * tenants and every query here is tenant-scoped, so within a run tenant A holds only this run's
 * fixtures, and (b) embedding the long shared `<RUN>` token in the query bridged unrelated fixtures
 * through pg_trgm `similarity() >= 0.3` — measured: `Solob<RUN>` scored a match against
 * `Zeta<RUN> A` purely on the shared 12-char suffix. Bare distinctive stems keep cross-fixture
 * similarity well under the threshold, so the exact-count and zero-hit assertions are not vacuous.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('search', probe);

const BASE = '/api/v1/search';

interface SearchLeadDto {
  readonly id: number;
  readonly ref: string;
  readonly partyName: string;
  readonly status: string;
}
interface SearchQuoteDto {
  readonly id: number;
  readonly ref: string;
  readonly leadId: number;
  readonly leadRef: string;
  readonly partyName: string;
  readonly status: string;
}
interface SearchPartyDto {
  readonly id: number;
  readonly name: string;
  readonly type: string;
}
interface SearchBrokerDto {
  readonly id: number;
  readonly name: string;
  readonly tier: string | null;
}
interface GlobalSearchDto {
  readonly leads: SearchLeadDto[];
  readonly quotes: SearchQuoteDto[];
  readonly parties: SearchPartyDto[];
  readonly brokers: SearchBrokerDto[];
}

/** Short, high-entropy run token: keeps trigram similarity between unrelated fixtures low. */
const RUN = `t038${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Member of A and B; leads.view + leads.view_all in both (sees every lead/quote in the tenant). */
  let fullAccess: TestUserSession;
  /** Member of A; leads.view but NOT leads.view_all (sees only the leads/quotes assigned to them). */
  let restricted: TestUserSession;
  /** Member of A with a non-leads grant only: proves the endpoint is gated by leads.view. */
  let outsider: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;

  const createdTenants: number[] = [];

  /** Tables this suite writes into, in dependency order for deletion. */
  const OWNED_TABLES = [
    'lead_assignments',
    'quotes',
    'business_assignments',
    'leads',
    'brokers',
    'parties',
    'reference_items',
    'roles',
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
      "select id::text as id from tenants where name like 't038%'",
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

  async function seedRef(tenantId: number, listType: string, name: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, created_at, updated_at)
       values ($1, $2, $3, 0, true, now(), now())
       returning id::text as id`,
      [tenantId, listType, name],
    );
    return Number(rows[0]?.id);
  }

  async function seedParty(tenantId: number, name: string, partyTypeId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into parties
         (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now())
       returning id::text as id`,
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
      `insert into brokers (tenant_id, name, broker_type_id, status, created_at, updated_at)
       values ($1, $2, $3, 'active', now(), now()) returning id::text as id`,
      [tenantId, name, brokerTypeId],
    );
    return Number(rows[0]?.id);
  }

  interface SeedLead {
    readonly partyId: number;
    readonly leadRef: string;
    readonly externalRef?: string | null;
    readonly statusId: number;
    readonly productLineId: number;
    readonly coverTypeId: number;
    readonly regionId: number;
    readonly requestChannelId: number;
  }

  async function seedLead(tenantId: number, lead: SeedLead): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into leads
         (tenant_id, party_id, lead_ref, external_ref, date_received, request_channel_id,
          region_id, product_line_id, cover_type_id, policy_term, priority, status_id, source,
          created_at, updated_at)
       values ($1, $2, $3, $4, '2026-01-15', $5, $6, $7, $8, 'm12', 'normal', $9, 'browser',
               now(), now())
       returning id::text as id`,
      [
        tenantId,
        lead.partyId,
        lead.leadRef,
        lead.externalRef ?? null,
        lead.requestChannelId,
        lead.regionId,
        lead.productLineId,
        lead.coverTypeId,
        lead.statusId,
      ],
    );
    return Number(rows[0]?.id);
  }

  async function seedQuote(
    tenantId: number,
    leadId: number,
    quoteRef: string,
    statusId: number,
    productLineId: number,
    coverTypeId: number,
    isCurrent: boolean,
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into quotes
         (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
          prepared_date, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now()::date, now(), now())
       returning id::text as id`,
      [tenantId, leadId, quoteRef, statusId, isCurrent, productLineId, coverTypeId],
    );
    return Number(rows[0]?.id);
  }

  /** Assigns `userId` to `leadId` via the tenant's rm business-assignment slot. */
  async function assignLead(tenantId: number, leadId: number, userId: number, rmAssignmentId: number): Promise<void> {
    await query(
      `insert into lead_assignments
         (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [tenantId, leadId, rmAssignmentId, userId],
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
      search: { db },
    });
  }

  async function search(
    q: string,
    options: { session?: TestUserSession; tenantId?: number; raw?: string } = {},
  ): Promise<Response> {
    const session = options.session ?? fullAccess;
    const tenantId = options.tenantId ?? tenantA;
    const headers = new Headers();
    headers.set('authorization', `Bearer ${session.accessToken}`);
    headers.set('x-tenant-id', String(tenantId));
    const qs = options.raw ?? `?q=${encodeURIComponent(q)}`;
    return await harness().request(`http://localhost${BASE}${qs}`, { method: 'GET', headers });
  }

  async function searchOk(
    q: string,
    options: { session?: TestUserSession; tenantId?: number; raw?: string } = {},
  ): Promise<GlobalSearchDto> {
    const response = await search(q, options);
    expect(response.status).toBe(200);
    return (await response.json()) as GlobalSearchDto;
  }

  // Reference fixtures (tenant A).
  let partyTypeA = 0;
  let brokerTypeA = 0;
  let leadStatusA = 0;
  let quoteStatusA = 0;
  let productLineA = 0;
  let coverTypeA = 0;
  let regionA = 0;
  let channelA = 0;
  // Reference fixtures (tenant B).
  let partyTypeB = 0;
  let leadStatusB = 0;
  let quoteStatusB = 0;
  let productLineB = 0;
  let coverTypeB = 0;
  let regionB = 0;
  let channelB = 0;

  // Party fixtures (tenant A).
  let acmeParty = 0;
  let zenithParty = 0;
  // Broker fixtures (tenant A).
  let acmeBroker = 0;
  let northwindBroker = 0;
  // Lead fixtures (tenant A).
  let leadRefHit = 0; // lead_ref starts ACME<RUN>, party = Zenith
  let leadPartyHit = 0; // lead on Acme party, lead_ref LEAD<RUN>-2
  let leadExternalHit = 0; // external_ref starts ACME<RUN>, party = Zenith
  let leadNoMatch = 0; // OTHER<RUN>, party = Zenith
  // Quote fixtures (tenant A).
  let quoteHit = 0; // quote_ref ACME<RUN>-Q1 on leadPartyHit
  let quoteOnUnassignedLead = 0; // quote_ref ACME<RUN>-Q3 on leadRefHit (unassigned to restricted)
  // Tenant B markers.
  let acmePartyB = 0;
  let acmeBrokerB = 0;
  let acmeLeadB = 0;
  // Convention-VIOLATING cross-tenant fixtures (F-023-1 style). Each is a tenant-B row whose only
  // tenant-scoped reference points at a TENANT-A row, so the group's incidental reference_items join
  // no longer filters it — leaving the group's OWN `<primary>.tenant_id` predicate as the sole guard.
  // A tenant-A search for these stems must be empty; if it is not, that predicate was dropped. There
  // is no physical FK on party_id/status_id/lead_id (by convention, like brokers), so the schema
  // permits exactly this state and plain-SQL seeding can construct it.
  let crossPartyB = 0;
  let crossLeadB = 0;
  let crossQuoteB = 0;

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

    fullAccess = await auth.createTestUserWithSession({ label: 'search-full' });
    restricted = await auth.createTestUserWithSession({ label: 'search-restricted' });
    outsider = await auth.createTestUserWithSession({ label: 'search-outsider' });

    await addMembership(appUserId(fullAccess), tenantA);
    await addMembership(appUserId(fullAccess), tenantB);
    await addMembership(appUserId(restricted), tenantA);
    await addMembership(appUserId(outsider), tenantA);

    for (const permission of ['leads.view', 'leads.view_all'] as const) {
      await fixtures.grantDirectPermission(appUserId(fullAccess), permission, tenantA);
      await fixtures.grantDirectPermission(appUserId(fullAccess), permission, tenantB);
    }
    // leads.view only, NO leads.view_all: this user drives the breadth assertions.
    await fixtures.grantDirectPermission(appUserId(restricted), 'leads.view', tenantA);
    // A DIFFERENT permission: proves the endpoint gate checks leads.view, not "any grant".
    await fixtures.grantDirectPermission(appUserId(outsider), 'parties.view', tenantA);

    partyTypeA = await seedRef(tenantA, 'party_type', `Corporate ${RUN}A`);
    brokerTypeA = await seedRef(tenantA, 'broker_type', `Tier1 ${RUN}A`);
    leadStatusA = await seedRef(tenantA, 'lead_status', `New ${RUN}A`);
    quoteStatusA = await seedRef(tenantA, 'quote_status', `Draft ${RUN}A`);
    productLineA = await seedRef(tenantA, 'product_line', `Motor ${RUN}A`);
    coverTypeA = await seedRef(tenantA, 'cover_type', `Comp ${RUN}A`);
    regionA = await seedRef(tenantA, 'region', `North ${RUN}A`);
    channelA = await seedRef(tenantA, 'request_channel', `Email ${RUN}A`);

    partyTypeB = await seedRef(tenantB, 'party_type', `Corporate ${RUN}B`);
    leadStatusB = await seedRef(tenantB, 'lead_status', `New ${RUN}B`);
    quoteStatusB = await seedRef(tenantB, 'quote_status', `Draft ${RUN}B`);
    productLineB = await seedRef(tenantB, 'product_line', `Motor ${RUN}B`);
    coverTypeB = await seedRef(tenantB, 'cover_type', `Comp ${RUN}B`);
    regionB = await seedRef(tenantB, 'region', `North ${RUN}B`);
    channelB = await seedRef(tenantB, 'request_channel', `Email ${RUN}B`);

    acmeParty = await seedParty(tenantA, `Acme Insurance ${RUN}`, partyTypeA);
    zenithParty = await seedParty(tenantA, `Zenith Holdings ${RUN}`, partyTypeA);

    acmeBroker = await seedBroker(tenantA, `Acme Brokers ${RUN}`, brokerTypeA);
    northwindBroker = await seedBroker(tenantA, `Northwind Brokers ${RUN}`, null);

    const commonA = {
      statusId: leadStatusA,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      regionId: regionA,
      requestChannelId: channelA,
    };

    // Insertion order deliberately NOT lead_ref order, so the ranking test proves a sort happened.
    leadPartyHit = await seedLead(tenantA, {
      ...commonA,
      partyId: acmeParty,
      leadRef: `LEAD${RUN}-2`,
    });
    leadRefHit = await seedLead(tenantA, {
      ...commonA,
      partyId: zenithParty,
      leadRef: `ACME${RUN}-1`,
    });
    leadExternalHit = await seedLead(tenantA, {
      ...commonA,
      partyId: zenithParty,
      leadRef: `LEAD${RUN}-3`,
      externalRef: `ACME${RUN}-EXT`,
    });
    leadNoMatch = await seedLead(tenantA, {
      ...commonA,
      partyId: zenithParty,
      leadRef: `OTHER${RUN}-4`,
    });

    quoteHit = await seedQuote(
      tenantA,
      leadPartyHit,
      `ACME${RUN}-Q1`,
      quoteStatusA,
      productLineA,
      coverTypeA,
      true,
    );
    // A non-matching quote, on the same lead, so the quotes group must exclude it.
    await seedQuote(tenantA, leadPartyHit, `OTHER${RUN}-Q2`, quoteStatusA, productLineA, coverTypeA, false);
    // A matching quote on an UNASSIGNED lead: the restricted user must NOT see it.
    quoteOnUnassignedLead = await seedQuote(
      tenantA,
      leadRefHit,
      `ACME${RUN}-Q3`,
      quoteStatusA,
      productLineA,
      coverTypeA,
      true,
    );

    // The restricted user is assigned ONLY to leadPartyHit (and thus its quoteHit).
    const rmRole = Number(
      (
        await query<{ id: string }>(
          `insert into roles (tenant_id, name, is_active, created_at, updated_at)
           values ($1, $2, true, now(), now()) returning id::text as id`,
          [tenantA, `${RUN}-rm-role`],
        )
      )[0]?.id,
    );
    const rmAssignment = Number(
      (
        await query<{ id: string }>(
          `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
           values ($1, 'rm', $2, now(), now()) returning id::text as id`,
          [tenantA, rmRole],
        )
      )[0]?.id,
    );
    await assignLead(tenantA, leadPartyHit, appUserId(restricted), rmAssignment);

    // Tenant B markers — same `Acme<RUN>` term, must never surface for a tenant-A caller.
    acmePartyB = await seedParty(tenantB, `Acme Insurance ${RUN}`, partyTypeB);
    acmeBrokerB = await seedBroker(tenantB, `Acme Brokers ${RUN}`, null);
    acmeLeadB = await seedLead(tenantB, {
      partyId: acmePartyB,
      leadRef: `ACME${RUN}-1`,
      statusId: leadStatusB,
      productLineId: productLineB,
      coverTypeId: coverTypeB,
      regionId: regionB,
      requestChannelId: channelB,
    });
    await seedQuote(tenantB, acmeLeadB, `ACME${RUN}-Q1`, quoteStatusB, productLineB, coverTypeB, true);

    // Cross-tenant corrupt fixtures: tenant-B rows whose tenant-scoped reference points at TENANT A,
    // so the group's reference_items join does not incidentally filter them. Distinct `Zzcross`
    // stems, queried only by their own predicate-pinning tests.
    crossPartyB = await seedParty(tenantB, `Zzcrossparty ${RUN}`, partyTypeA); // type ref is tenant A
    crossLeadB = await seedLead(tenantB, {
      partyId: acmeParty, // party is a TENANT-A party
      leadRef: `ZZCROSSLEAD${RUN}`,
      statusId: leadStatusA, // status ref is tenant A
      productLineId: productLineB,
      coverTypeId: coverTypeB,
      regionId: regionB,
      requestChannelId: channelB,
    });
    crossQuoteB = await seedQuote(
      tenantB,
      leadPartyHit, // lead is a TENANT-A lead
      `ZZCROSSQUOTE${RUN}`,
      quoteStatusA, // status ref is tenant A
      productLineB,
      coverTypeB,
      false,
    );
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on, and every delete swallows its error, so the reverse order is a silent no-op that leaks.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 180_000);

  // -------------------------------------------------------------------------------------------
  // Grouping and DTO shape
  // -------------------------------------------------------------------------------------------

  it('returns the four groups as arrays with the reference field shapes', async () => {
    const result = await searchOk('Acme');

    expect(Object.keys(result).sort()).toEqual(['brokers', 'leads', 'parties', 'quotes']);
    expect(Array.isArray(result.leads)).toBe(true);
    expect(Array.isArray(result.quotes)).toBe(true);
    expect(Array.isArray(result.parties)).toBe(true);
    expect(Array.isArray(result.brokers)).toBe(true);

    const party = result.parties.find((p) => p.id === acmeParty);
    expect(party).toBeDefined();
    expect(Object.keys(party as SearchPartyDto).sort()).toEqual(['id', 'name', 'type']);

    const lead = result.leads.find((l) => l.id === leadRefHit);
    expect(lead).toBeDefined();
    expect(Object.keys(lead as SearchLeadDto).sort()).toEqual(['id', 'partyName', 'ref', 'status']);

    const quote = result.quotes.find((qt) => qt.id === quoteHit);
    expect(quote).toBeDefined();
    expect(Object.keys(quote as SearchQuoteDto).sort()).toEqual(
      ['id', 'leadId', 'leadRef', 'partyName', 'ref', 'status'].sort(),
    );

    const broker = result.brokers.find((b) => b.id === acmeBroker);
    expect(broker).toBeDefined();
    expect(Object.keys(broker as SearchBrokerDto).sort()).toEqual(['id', 'name', 'tier']);
  });

  // -------------------------------------------------------------------------------------------
  // Per-group matching: a hit AND a non-hit in every group
  // -------------------------------------------------------------------------------------------

  it('matches a party by a substring of its name and excludes non-matching parties', async () => {
    const result = await searchOk('Acme');
    const ids = result.parties.map((p) => p.id);
    expect(ids).toContain(acmeParty);
    expect(ids).not.toContain(zenithParty);
  });

  it('matches a party by a MISSPELLED name via the trigram half of the predicate', async () => {
    // ILIKE cannot match this; only similarity(name, q) >= 0.3 can (SearchStore.cs:95-96).
    const result = await searchOk('Acme Insrance');
    expect(result.parties.map((p) => p.id)).toContain(acmeParty);
  });

  it('resolves the party type name into the `type` field', async () => {
    const result = await searchOk('Acme');
    const party = result.parties.find((p) => p.id === acmeParty);
    expect(party?.type).toBe(`Corporate ${RUN}A`);
    expect(party?.name).toBe(`Acme Insurance ${RUN}`);
  });

  it('matches leads by lead_ref prefix, external_ref prefix AND party-name substring', async () => {
    const result = await searchOk('Acme');
    const ids = result.leads.map((l) => l.id);
    expect(ids).toContain(leadRefHit); // lead_ref prefix
    expect(ids).toContain(leadPartyHit); // party-name substring
    expect(ids).toContain(leadExternalHit); // external_ref prefix
    expect(ids).not.toContain(leadNoMatch);
  });

  it('projects the lead ref, resolved party name and resolved status onto each lead hit', async () => {
    const result = await searchOk('Acme');
    const lead = result.leads.find((l) => l.id === leadPartyHit);
    expect(lead?.ref).toBe(`LEAD${RUN}-2`);
    expect(lead?.partyName).toBe(`Acme Insurance ${RUN}`);
    expect(lead?.status).toBe(`New ${RUN}A`);
  });

  it('matches quotes by quote_ref prefix only, and carries the lead id/ref for routing', async () => {
    const result = await searchOk('Acme');
    const quote = result.quotes.find((qt) => qt.id === quoteHit);
    expect(quote).toBeDefined();
    expect(quote?.ref).toBe(`ACME${RUN}-Q1`);
    expect(quote?.leadId).toBe(leadPartyHit);
    expect(quote?.leadRef).toBe(`LEAD${RUN}-2`);
    expect(quote?.partyName).toBe(`Acme Insurance ${RUN}`);
    expect(quote?.status).toBe(`Draft ${RUN}A`);
    // The OTHER<RUN>-Q2 quote on the same lead must NOT appear — quotes do not match on party name.
    expect(result.quotes.map((qt) => qt.ref)).not.toContain(`OTHER${RUN}-Q2`);
  });

  it('matches a broker by name, resolves its tier, and leaves a type-less broker tier null', async () => {
    const result = await searchOk('Brokers');
    const acme = result.brokers.find((b) => b.id === acmeBroker);
    const northwind = result.brokers.find((b) => b.id === northwindBroker);
    expect(acme?.tier).toBe(`Tier1 ${RUN}A`);
    expect(northwind).toBeDefined();
    expect(northwind?.tier).toBeNull();
  });

  it('does not leak a party match into the brokers group or vice versa', async () => {
    const result = await searchOk('Acme');
    // Acme Insurance is a party, Acme Brokers is a broker; each must land only in its own group.
    expect(result.parties.map((p) => p.id)).toContain(acmeParty);
    expect(result.parties.map((p) => p.id)).not.toContain(acmeBroker);
    expect(result.brokers.map((b) => b.id)).toContain(acmeBroker);
    expect(result.brokers.map((b) => b.id)).not.toContain(acmeParty);
  });

  // -------------------------------------------------------------------------------------------
  // Ranking and per-group limit
  // -------------------------------------------------------------------------------------------

  it('orders lead hits by lead_ref ascending (not by insertion order)', async () => {
    const result = await searchOk('Acme');
    const refs = result.leads.map((l) => l.ref);
    // The three matching leads were inserted LEAD-2, ACME-1, LEAD-3; sorted by lead_ref asc the
    // order is ACME-1, LEAD-2, LEAD-3.
    const relevant = refs.filter((r) => r.startsWith('ACME') || r.startsWith('LEAD'));
    expect(relevant).toEqual([`ACME${RUN}-1`, `LEAD${RUN}-2`, `LEAD${RUN}-3`]);
  });

  it('caps each group at the reference default of 5 per type', async () => {
    // Seed SIX matching parties; default limit is 5, so one must be dropped, and the one dropped is
    // the alphabetically-last (order is name asc, so the cap interacts with the ranking).
    const limitType = await seedRef(tenantA, 'party_type', `LimitType ${RUN}`);
    const names = ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => `Zeta${RUN} ${s}`);
    for (const name of names) {
      await seedParty(tenantA, name, limitType);
    }

    const result = await searchOk('Zeta');
    expect(result.parties).toHaveLength(5);
    const returnedNames = result.parties.map((p) => p.name);
    expect(returnedNames).toEqual(names.slice(0, 5));
    expect(returnedNames).not.toContain(`Zeta${RUN} F`);
  });

  it('honours an explicit limitPerType above 1', async () => {
    const result = await searchOk('Zeta', { raw: `?q=Zeta&limitPerType=2` });
    expect(result.parties).toHaveLength(2);
  });

  // -------------------------------------------------------------------------------------------
  // Minimum query length
  // -------------------------------------------------------------------------------------------

  it('returns four empty groups for a query shorter than 2 characters', async () => {
    const result = await searchOk('a');
    expect(result).toEqual({ leads: [], quotes: [], parties: [], brokers: [] });
  });

  it('treats a whitespace-padded 1-char query as below the minimum after trimming', async () => {
    const result = await searchOk('  a  ', { raw: `?q=${encodeURIComponent('  a  ')}` });
    expect(result).toEqual({ leads: [], quotes: [], parties: [], brokers: [] });
  });

  // -------------------------------------------------------------------------------------------
  // Visibility breadth (leads/quotes only; parties/brokers tenant-wide) — V-101
  // -------------------------------------------------------------------------------------------

  it('limits a restricted (no view_all) user to leads/quotes they are assigned to', async () => {
    const result = await searchOk('Acme', { session: restricted });

    const leadIds = result.leads.map((l) => l.id);
    // Assigned -> visible.
    expect(leadIds).toContain(leadPartyHit);
    // Unassigned matching leads -> hidden for this user.
    expect(leadIds).not.toContain(leadRefHit);
    expect(leadIds).not.toContain(leadExternalHit);

    const quoteIds = result.quotes.map((qt) => qt.id);
    expect(quoteIds).toContain(quoteHit); // on the assigned lead
    expect(quoteIds).not.toContain(quoteOnUnassignedLead); // on an unassigned lead
  });

  it('still returns parties and brokers tenant-wide to a restricted user (no breadth rule there)', async () => {
    const result = await searchOk('Acme', { session: restricted });
    expect(result.parties.map((p) => p.id)).toContain(acmeParty);
    expect(result.brokers.map((b) => b.id)).toContain(acmeBroker);
  });

  it('shows the full-access user every matching lead and quote in the tenant', async () => {
    const result = await searchOk('Acme', { session: fullAccess });
    const leadIds = result.leads.map((l) => l.id);
    expect(leadIds).toEqual(expect.arrayContaining([leadRefHit, leadPartyHit, leadExternalHit]));
    expect(result.quotes.map((qt) => qt.id)).toEqual(
      expect.arrayContaining([quoteHit, quoteOnUnassignedLead]),
    );
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation — AC-022 / V-027 / V-101
  // -------------------------------------------------------------------------------------------

  it('never returns another tenant’s rows for the same marker term', async () => {
    const result = await searchOk('Acme', { tenantId: tenantA });

    // Per-GROUP id membership is the precise discriminator. A raw JSON substring check on `"id":N`
    // would be UNSOUND here: identity sequences live on the LIST-partitioned parents, so ids are
    // unique WITHIN a table but a tenant-A quote and a tenant-B broker can share the same integer —
    // asserting the number is absent from the whole payload would fail on a legitimate own-tenant
    // row. So each foreign id is checked against ITS OWN group.
    expect(result.parties.map((p) => p.id)).not.toContain(acmePartyB);
    expect(result.brokers.map((b) => b.id)).not.toContain(acmeBrokerB);
    expect(result.leads.map((l) => l.id)).not.toContain(acmeLeadB);

    // Tenant A must see its OWN Acme rows — proof the query matched at all, so the absence of the
    // tenant-B rows above is isolation working, not the query returning nothing.
    expect(result.parties.map((p) => p.id)).toContain(acmeParty);
    expect(result.brokers.map((b) => b.id)).toContain(acmeBroker);
  });

  it('pins the parties tenant predicate: a tenant-B party with a tenant-A type does not leak', async () => {
    // `crossPartyB` is a tenant-B party whose party_type_id is a TENANT-A ref, so the parties query's
    // `reference_items` join would resolve it — only `parties.tenant_id = A` keeps it out. This test
    // goes red if that predicate is dropped (the reference_items join alone cannot catch it).
    const result = await searchOk('Zzcrossparty', { session: fullAccess, tenantId: tenantA });
    expect(result.parties.map((p) => p.id)).not.toContain(crossPartyB);
    expect(result.parties).toEqual([]);
  });

  it('pins the leads tenant predicate: a tenant-B lead on a tenant-A party does not leak', async () => {
    // `crossLeadB` is a tenant-B lead whose party_id and status_id are TENANT-A rows, so the leads
    // query's party and status joins both resolve — only `leads.tenant_id = A` keeps it out.
    const result = await searchOk('Zzcrosslead', { session: fullAccess, tenantId: tenantA });
    expect(result.leads.map((l) => l.id)).not.toContain(crossLeadB);
    expect(result.leads).toEqual([]);
  });

  it('pins the quotes tenant predicate: a tenant-B quote on a tenant-A lead does not leak', async () => {
    // `crossQuoteB` is a tenant-B quote whose lead_id and status_id are TENANT-A rows, so the quotes
    // query's lead, party and status joins all resolve — only `quotes.tenant_id = A` keeps it out.
    const result = await searchOk('Zzcrossquote', { session: fullAccess, tenantId: tenantA });
    expect(result.quotes.map((qt) => qt.id)).not.toContain(crossQuoteB);
    expect(result.quotes).toEqual([]);
  });

  it('returns zero hits in tenant A for a term that only tenant B data matches', async () => {
    // Seed a tenant-B-only party with a lexically distinct stem absent from tenant A, then query it
    // as a tenant-A user. The query term omits the RUN token on purpose: tenant A holds only this
    // run's own fixtures (each run creates fresh tenants; a prior run's rows are purged at start),
    // so `Solob` cannot collide with another run, and NOT sharing the long RUN token keeps trigram
    // similarity to tenant A's own `Acme`/`Zeta` fixtures well below the 0.3 threshold.
    await seedParty(tenantB, `Solobrand Underwriters ${RUN}`, partyTypeB);
    const result = await searchOk('Solobrand', { tenantId: tenantA });
    expect(result).toEqual({ leads: [], quotes: [], parties: [], brokers: [] });
  });

  it('serves the SAME term to tenant B and returns tenant B rows, proving the isolation is real', async () => {
    const result = await searchOk('Acme', { session: fullAccess, tenantId: tenantB });
    expect(result.parties.map((p) => p.id)).toContain(acmePartyB);
    expect(result.parties.map((p) => p.id)).not.toContain(acmeParty);
    expect(result.brokers.map((b) => b.id)).toContain(acmeBrokerB);
    expect(result.brokers.map((b) => b.id)).not.toContain(acmeBroker);
  });

  // -------------------------------------------------------------------------------------------
  // Endpoint gate
  // -------------------------------------------------------------------------------------------

  it('gates the endpoint on leads.view: a caller without it is forbidden', async () => {
    const response = await search('Acme', { session: outsider });
    expect(response.status).toBe(403);
  });

  it('requires a verified tenant: no X-Tenant-Id is refused', async () => {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${fullAccess.accessToken}`);
    const response = await harness().request(
      `http://localhost${BASE}?q=${encodeURIComponent('Acme')}`,
      { method: 'GET', headers },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
