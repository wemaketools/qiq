/**
 * Lead activity timeline, end to end (T-029; AC-022, AC-060; V-027, V-076).
 *
 * Same composed-system harness as `lead-workflow.test.ts`: real sessions, real tenants/partitions,
 * real grants, the real Hono pipeline via `app.request`. Nothing is stubbed.
 *
 * ORDERING IS THE FEATURE, SO ORDERING IS WHAT IS ASSERTED
 * =======================================================
 * A timeline that returns the right entries in the wrong order, or that silently drops one of its
 * four sources, is indistinguishable from a correct one under a shape-only assertion ("an array of
 * seven items"). Every ordering test here therefore seeds KNOWN entries and asserts the EXACT
 * expected sequence, and the merge tests seed entries whose timestamps COLLIDE EXACTLY rather than
 * hoping production never produces a tie.
 *
 * The reference's total order is `(at DESC, typeRank DESC, sourceId DESC)` where typeRank is
 * status=3 > quote_status=2 > follow_up=1 > note=0 (`GetLeadTimelineQueryHandler.cs:149-154`).
 * `sourceId` is the originating row's own database-assigned identity, NOT a second clock — the same
 * reason `listStatusHistory` orders by `id` (T-048). Both tie-break levels are pinned below.
 *
 * DIRECT-SQL SEEDING FOR THE ORDERING CASES, ON PURPOSE
 * ====================================================
 * The API-driven test proves the four sources are really wired to the real writers. The ordering
 * tests seed rows directly so the timestamps are CHOSEN rather than observed: an ordering assertion
 * built on `new Date()` values a handful of milliseconds apart can neither construct a tie nor fail
 * reproducibly when the tie-break is wrong.
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
const title = suiteTitle('timeline', probe);

const BASE = '/api/v1/leads';

interface TimelineEntry {
  readonly type: string;
  readonly at: string;
  readonly actorName: string | null;
  readonly title: string;
  readonly detail: string | null;
  readonly quoteRef: string | null;
}

interface TimelineDto {
  readonly items: TimelineEntry[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/** Deliberately SHORT — a long shared token dominates trigram similarity on party names. */
const RUN = `t029-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix} ${RUN}-${nameSequence}`;
}

function yesterday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds every lead/quote grant in BOTH tenants, including `leads.view_all`. */
  let admin: TestUserSession;
  /** Holds `leads.view` only — NO `leads.view_all`: the breadth-parity fixture. */
  let narrow: TestUserSession;
  /** A tenant-A member holding NO leads grant at all: the 403 fixture. */
  let ungranted: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;

  const createdTenants: number[] = [];

  const OWNED_TABLES = [
    'follow_ups',
    'pricing_approvals',
    'lead_status_history',
    'quote_status_history',
    'quotes',
    'lead_notes',
    'lead_assignments',
    'leads',
    'reference_sequences',
    'business_assignments',
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
      "select id::text as id from tenants where name like 't029-%'",
    ).catch(() => []);
    for (const row of stale) await deleteTenantData(Number(row.id));
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

  async function seedSettings(tenantId: number): Promise<void> {
    await query(
      `insert into tenant_settings
         (tenant_id, currency_code, currency_symbol, max_attachment_mb, high_value_threshold,
          quote_expiry_alert_days, follow_up_overdue_grace_days, aging_amber_days, aging_red_days,
          unassigned_lead_hours, stalled_lead_days, stalled_quote_days, duplicate_check_days,
          lead_ref_format, quote_ref_format, lead_inactivity_expiry_days, pricing_approval_target_days,
          sla_assignment_days, sla_underwriting_days, sla_received_to_sent_days,
          require_pricing_approval_for_high_value, manual_external_ref_enabled,
          expire_lead_when_last_quote_expires, created_at, updated_at)
       values ($1, 'USD', '$', 10, 100000, 7, 2, 5, 10, 24, 7, 7, 30, 'L-{YYYY}-{SEQ:4}',
               'Q-{YYYY}-{SEQ:4}', 60, 3, 2, 3, 5, false, true, false, now(), now())`,
      [tenantId],
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
      isActive?: boolean;
      reportingCategory?: string | null;
      canonicalKey?: string | null;
      productLineId?: number | null;
      isTerminal?: boolean;
    } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          product_line_id, is_terminal, created_at, updated_at)
       values ($1, $2, $3, 0, $4, $5, $6, $7, $8, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        options.isActive ?? true,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.productLineId ?? null,
        options.isTerminal ?? false,
      ],
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

  async function seedRmSlot(tenantId: number, roleId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
       values ($1, 'rm', $2, now(), now()) returning id::text as id`,
      [tenantId, roleId],
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
      leads: { db },
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

  // Reference fixtures, tenant A.
  let partyTypeA = 0;
  let regionA = 0;
  let channelA = 0;
  let productLineA = 0;
  let coverTypeA = 0;
  let partyA = 0;
  let newStatusA = 0;
  let assignedStatusA = 0;
  let quoteDraftStatusA = 0;
  let quoteSentStatusA = 0;
  let rmSlotA = 0;
  let rmRoleId = 0;

  // Tenant B, for the isolation case.
  let partyTypeB = 0;
  let regionB = 0;
  let channelB = 0;
  let productLineB = 0;
  let coverTypeB = 0;
  let partyB = 0;

  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      partyId: partyA,
      isExistingClient: true,
      dateReceived: yesterday(),
      requestChannelId: channelA,
      brokerId: null,
      ownerUserId: appUserId(admin),
      regionId: regionA,
      externalRef: null,
      productLineId: productLineA,
      coverTypeId: coverTypeA,
      sumInsured: null,
      estimatedPremium: null,
      policyTerm: 'm12',
      policyTermOther: null,
      priority: null,
      intakeNotes: null,
      createAnyway: true,
      ...overrides,
    };
  }

  async function createLead(overrides: Record<string, unknown> = {}): Promise<number> {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: validBody(overrides),
    });
    expect(response.status).toBe(201);
    const outcome = (await response.json()) as { lead: { id: number } | null };
    return outcome.lead?.id ?? 0;
  }

  async function createLeadInTenantB(): Promise<number> {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId: tenantB,
      body: {
        partyId: partyB,
        isExistingClient: true,
        dateReceived: yesterday(),
        requestChannelId: channelB,
        brokerId: null,
        ownerUserId: appUserId(admin),
        regionId: regionB,
        externalRef: null,
        productLineId: productLineB,
        coverTypeId: coverTypeB,
        sumInsured: null,
        estimatedPremium: null,
        policyTerm: 'm12',
        policyTermOther: null,
        priority: null,
        intakeNotes: 'tenant B intake note',
        createAnyway: true,
      },
    });
    expect(response.status).toBe(201);
    const outcome = (await response.json()) as { lead: { id: number } | null };
    return outcome.lead?.id ?? 0;
  }

  /** A quote row, for the `quote_status_history` source. */
  async function seedQuote(tenantId: number, leadId: number, statusId: number): Promise<{ id: number; quoteRef: string }> {
    nameSequence += 1;
    const quoteRef = `${RUN}-q${String(nameSequence)}`;
    const rows = await query<{ id: string }>(
      `insert into quotes
         (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
          prepared_date, created_at, updated_at)
       values ($1, $2, $3, $4,
               not exists (select 1 from quotes c
                            where c.tenant_id = $1 and c.lead_id = $2 and c.is_current),
               $5, $6, current_date, now(), now())
       returning id::text as id`,
      [tenantId, leadId, quoteRef, statusId, productLineA, coverTypeA],
    );
    return { id: Number(rows[0]?.id), quoteRef };
  }

  async function seedStatusHistory(values: {
    leadId: number;
    operation: string;
    previousStatusId: number | null;
    newStatusId: number | null;
    actedBy: number | null;
    actedAt: string;
  }): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into lead_status_history
         (tenant_id, lead_id, operation, previous_status_id, new_status_id, acted_by, acted_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id::text as id`,
      [
        tenantA,
        values.leadId,
        values.operation,
        values.previousStatusId,
        values.newStatusId,
        values.actedBy,
        values.actedAt,
      ],
    );
    return Number(rows[0]?.id);
  }

  async function seedQuoteHistory(values: {
    quoteId: number;
    operation: string;
    previousStatusId: number | null;
    newStatusId: number | null;
    actedBy: number | null;
    actedAt: string;
  }): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into quote_status_history
         (tenant_id, quote_id, operation, previous_status_id, new_status_id, acted_by, acted_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id::text as id`,
      [
        tenantA,
        values.quoteId,
        values.operation,
        values.previousStatusId,
        values.newStatusId,
        values.actedBy,
        values.actedAt,
      ],
    );
    return Number(rows[0]?.id);
  }

  async function seedFollowUp(values: {
    leadId: number;
    outcomeNote: string;
    nextFollowUpDate: string | null;
    loggedBy: number | null;
    loggedAt: string;
  }): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into follow_ups
         (tenant_id, lead_id, follow_up_date, outcome_note, next_follow_up_date, logged_by, logged_at)
       values ($1, $2, current_date, $3, $4, $5, $6) returning id::text as id`,
      [tenantA, values.leadId, values.outcomeNote, values.nextFollowUpDate, values.loggedBy, values.loggedAt],
    );
    return Number(rows[0]?.id);
  }

  async function seedNote(values: {
    leadId: number;
    body: string;
    createdBy: number | null;
    createdAt: string;
  }): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into lead_notes (tenant_id, lead_id, body, created_at, created_by)
       values ($1, $2, $3, $4, $5) returning id::text as id`,
      [tenantA, values.leadId, values.body, values.createdAt, values.createdBy],
    );
    return Number(rows[0]?.id);
  }

  async function getTimeline(
    leadId: number,
    options: { session?: TestUserSession; tenantId?: number; page?: number } = {},
  ): Promise<Response> {
    const suffix = options.page === undefined ? '' : `?page=${String(options.page)}`;
    return await call('GET', `${BASE}/${leadId}/timeline${suffix}`, {
      token: (options.session ?? admin).accessToken,
      tenantId: options.tenantId ?? tenantA,
    });
  }

  async function timelineOf(
    leadId: number,
    options: { session?: TestUserSession; page?: number } = {},
  ): Promise<TimelineDto> {
    const response = await getTimeline(leadId, options);
    expect(response.status).toBe(200);
    return (await response.json()) as TimelineDto;
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
    await seedSettings(tenantA);
    await seedSettings(tenantB);

    admin = await auth.createTestUserWithSession({
      label: 'tl-admin',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    narrow = await auth.createTestUserWithSession({
      label: 'tl-narrow',
      firstName: 'Nia',
      lastName: 'Okafor',
    });
    ungranted = await auth.createTestUserWithSession({ label: 'tl-none' });

    for (const session of [admin, narrow, ungranted]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(admin), tenantB);

    for (const permission of [
      'leads.view',
      'leads.view_all',
      'leads.create',
      'leads.update',
      'leads.assign',
      'leads.close',
      'quotes.view',
    ] as const) {
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantA);
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantB);
    }
    // NO `leads.view_all` — the breadth-parity fixture.
    await fixtures.grantDirectPermission(appUserId(narrow), 'leads.view', tenantA);

    rmRoleId = await fixtures.createRole({ tenantId: tenantA });
    await fixtures.assignRole(appUserId(admin), rmRoleId, tenantA);
    rmSlotA = await seedRmSlot(tenantA, rmRoleId);

    const rmRoleB = await fixtures.createRole({ tenantId: tenantB });
    await fixtures.assignRole(appUserId(admin), rmRoleB, tenantB);
    await seedRmSlot(tenantB, rmRoleB);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp A'));
    regionA = await seedRef(tenantA, 'region', uniqueName('North A'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email A'));
    productLineA = await seedRef(tenantA, 'product_line', uniqueName('Motor A'));
    coverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Comp A'), {
      productLineId: productLineA,
    });

    newStatusA = await seedRef(tenantA, 'lead_status', uniqueName('New A'), {
      reportingCategory: 'open',
      canonicalKey: 'new',
    });
    assignedStatusA = await seedRef(tenantA, 'lead_status', uniqueName('Assigned A'), {
      reportingCategory: 'open',
      canonicalKey: 'assigned',
    });
    quoteDraftStatusA = await seedRef(tenantA, 'quote_status', uniqueName('q-draft A'), {
      reportingCategory: 'open',
      canonicalKey: 'draft',
    });
    quoteSentStatusA = await seedRef(tenantA, 'quote_status', uniqueName('q-sent A'), {
      reportingCategory: 'quoted',
      canonicalKey: 'sent',
    });

    partyA = await seedParty(tenantA, `Acme ${RUN}`, partyTypeA);

    partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('Corp B'));
    regionB = await seedRef(tenantB, 'region', uniqueName('North B'));
    channelB = await seedRef(tenantB, 'request_channel', uniqueName('Email B'));
    productLineB = await seedRef(tenantB, 'product_line', uniqueName('Motor B'));
    coverTypeB = await seedRef(tenantB, 'cover_type', uniqueName('Comp B'), {
      productLineId: productLineB,
    });
    await seedRef(tenantB, 'lead_status', uniqueName('New B'), {
      reportingCategory: 'open',
      canonicalKey: 'new',
    });
    partyB = await seedParty(tenantB, `Beta ${RUN}`, partyTypeB);
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();
    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on, and the deletes swallow errors — the reverse order is a SILENT no-op.
    for (const tenantId of createdTenants) await deleteTenantData(tenantId);

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
    await pool?.end().catch(() => undefined);
  }, 120_000);

  describe('source coverage', () => {
    it('merges all four sources — a missing source is a missing entry type', async () => {
      const leadId = await createLead({ intakeNotes: 'called the broker' });

      const assignResponse = await call('POST', `${BASE}/${leadId}/operations/assign`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(admin) }] },
      });
      expect(assignResponse.status).toBe(200);

      const followUpResponse = await call('POST', `${BASE}/${leadId}/operations/log-follow-up`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { followUpDate: null, outcomeNote: 'left voicemail', nextFollowUpDate: null },
      });
      expect(followUpResponse.status).toBe(200);

      const quote = await seedQuote(tenantA, leadId, quoteDraftStatusA);
      await seedQuoteHistory({
        quoteId: quote.id,
        operation: 'send',
        previousStatusId: quoteDraftStatusA,
        newStatusId: quoteSentStatusA,
        actedBy: appUserId(admin),
        actedAt: new Date().toISOString(),
      });

      const timeline = await timelineOf(leadId);
      const types = new Set(timeline.items.map((entry) => entry.type));

      expect(types).toContain('note');
      expect(types).toContain('status');
      expect(types).toContain('follow_up');
      expect(types).toContain('quote_status');
    });

    it('places the intake note last — it is the lead’s oldest activity', async () => {
      const leadId = await createLead({ intakeNotes: 'intake via broker portal' });

      const assignResponse = await call('POST', `${BASE}/${leadId}/operations/assign`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(admin) }] },
      });
      expect(assignResponse.status).toBe(200);

      const timeline = await timelineOf(leadId);
      const last = timeline.items.at(-1);

      expect(last?.type).toBe('note');
      expect(last?.detail).toBe('intake via broker portal');
    });
  });

  describe('ordering', () => {
    /**
     * The cross-source tie-break, constructed rather than hoped for: four entries, one per source,
     * at the IDENTICAL instant. The reference breaks the tie by a fixed per-type rank descending
     * (status > quote_status > follow_up > note), so this sequence is fully determined.
     */
    it('breaks an exact cross-source timestamp tie by the reference’s type rank', async () => {
      const leadId = await createLead();
      const at = '2031-03-04T10:20:30.000Z';
      const quote = await seedQuote(tenantA, leadId, quoteDraftStatusA);

      await seedNote({ leadId, body: 'tie note', createdBy: appUserId(admin), createdAt: at });
      await seedFollowUp({
        leadId,
        outcomeNote: 'tie follow-up',
        nextFollowUpDate: null,
        loggedBy: appUserId(admin),
        loggedAt: at,
      });
      await seedQuoteHistory({
        quoteId: quote.id,
        operation: 'send',
        previousStatusId: quoteDraftStatusA,
        newStatusId: quoteSentStatusA,
        actedBy: appUserId(admin),
        actedAt: at,
      });
      await seedStatusHistory({
        leadId,
        operation: 'assign',
        previousStatusId: newStatusA,
        newStatusId: assignedStatusA,
        actedBy: appUserId(admin),
        actedAt: at,
      });

      const timeline = await timelineOf(leadId);
      const tied = timeline.items.filter((entry) => Date.parse(entry.at) === Date.parse(at));

      expect(tied.map((entry) => entry.type)).toEqual([
        'status',
        'quote_status',
        'follow_up',
        'note',
      ]);
    });

    /**
     * The SAME-TYPE tie-break: two status rows at the identical instant order by the originating
     * row's own database-assigned id, DESCENDING. The application clock cannot separate them, which
     * is exactly why the id is the tie-break and not a second timestamp (T-048).
     */
    it('breaks a same-type, same-timestamp tie by source id descending', async () => {
      const leadId = await createLead();
      const at = '2031-04-05T11:22:33.000Z';

      const firstId = await seedStatusHistory({
        leadId,
        operation: 'assign',
        previousStatusId: newStatusA,
        newStatusId: assignedStatusA,
        actedBy: appUserId(admin),
        actedAt: at,
      });
      const secondId = await seedStatusHistory({
        leadId,
        operation: 'reassign',
        previousStatusId: assignedStatusA,
        newStatusId: assignedStatusA,
        actedBy: appUserId(admin),
        actedAt: at,
      });
      expect(secondId).toBeGreaterThan(firstId);

      const timeline = await timelineOf(leadId);
      const titles = timeline.items
        .filter((entry) => entry.type === 'status')
        .map((entry) => entry.title);

      // The LATER-appended row (higher id) comes first.
      expect(titles).toEqual(['Reassign', 'Assign']);
    });

    /**
     * Sub-second ordering, which a text sort silently gets wrong: `timestamptz::text` trims trailing
     * zeros, so `.000` and `.500` in the same second do not compare as their instants do.
     */
    it('orders sub-second timestamps as instants, not as text', async () => {
      const leadId = await createLead();

      await seedNote({
        leadId,
        body: 'whole second',
        createdBy: appUserId(admin),
        createdAt: '2031-05-06T09:09:09.000Z',
      });
      await seedNote({
        leadId,
        body: 'half second later',
        createdBy: appUserId(admin),
        createdAt: '2031-05-06T09:09:09.500Z',
      });

      const timeline = await timelineOf(leadId);
      const bodies = timeline.items
        .filter((entry) => entry.type === 'note' && entry.detail !== null)
        .map((entry) => entry.detail);

      expect(bodies.slice(0, 2)).toEqual(['half second later', 'whole second']);
    });

    it('returns the whole merge newest first', async () => {
      const leadId = await createLead();

      await seedNote({
        leadId,
        body: 'oldest',
        createdBy: appUserId(admin),
        createdAt: '2031-01-01T00:00:00.000Z',
      });
      await seedFollowUp({
        leadId,
        outcomeNote: 'middle',
        nextFollowUpDate: null,
        loggedBy: appUserId(admin),
        loggedAt: '2031-02-01T00:00:00.000Z',
      });
      await seedStatusHistory({
        leadId,
        operation: 'assign',
        previousStatusId: newStatusA,
        newStatusId: assignedStatusA,
        actedBy: appUserId(admin),
        actedAt: '2031-03-01T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId);

      expect(timeline.items.map((entry) => entry.type)).toEqual(['status', 'follow_up', 'note']);
      for (let index = 0; index < timeline.items.length - 1; index += 1) {
        expect(Date.parse(timeline.items[index]!.at)).toBeGreaterThanOrEqual(
          Date.parse(timeline.items[index + 1]!.at),
        );
      }
    });
  });

  describe('entry projection', () => {
    it('renders a status transition as “Previous → New” under a Title Case operation label', async () => {
      const leadId = await createLead();
      await seedStatusHistory({
        leadId,
        operation: 'log-follow-up',
        previousStatusId: newStatusA,
        newStatusId: assignedStatusA,
        actedBy: appUserId(admin),
        actedAt: '2031-06-01T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId);
      const entry = timeline.items.find((item) => item.type === 'status');
      const newName = await statusNameOf(newStatusA);
      const assignedName = await statusNameOf(assignedStatusA);

      expect(entry?.title).toBe('Log Follow Up');
      expect(entry?.detail).toBe(`${newName} → ${assignedName}`);
      expect(entry?.actorName).toBe('Ada Lovelace');
      expect(entry?.quoteRef).toBeNull();
    });

    it('renders no detail when a status row records no transition', async () => {
      const leadId = await createLead();
      await seedStatusHistory({
        leadId,
        operation: 'log-follow-up',
        previousStatusId: assignedStatusA,
        newStatusId: assignedStatusA,
        actedBy: appUserId(admin),
        actedAt: '2031-06-02T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId);
      const entry = timeline.items.find((item) => item.type === 'status');

      expect(entry?.detail).toBeNull();
    });

    it('renders “Unknown” for a status id that no longer resolves', async () => {
      const leadId = await createLead();
      await seedStatusHistory({
        leadId,
        operation: 'assign',
        previousStatusId: newStatusA,
        // A reference item id that does not exist in this tenant.
        newStatusId: 999_999_999,
        actedBy: appUserId(admin),
        actedAt: '2031-06-03T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId);
      const entry = timeline.items.find((item) => item.type === 'status');
      const newName = await statusNameOf(newStatusA);

      expect(entry?.detail).toBe(`${newName} → Unknown`);
    });

    it('labels quote events with the quote’s own reference, and nothing else with one', async () => {
      const leadId = await createLead();
      const quote = await seedQuote(tenantA, leadId, quoteDraftStatusA);
      await seedQuoteHistory({
        quoteId: quote.id,
        operation: 'send',
        previousStatusId: quoteDraftStatusA,
        newStatusId: quoteSentStatusA,
        actedBy: appUserId(admin),
        actedAt: '2031-06-04T00:00:00.000Z',
      });
      await seedNote({
        leadId,
        body: 'a note',
        createdBy: appUserId(admin),
        createdAt: '2031-06-04T00:00:01.000Z',
      });

      const timeline = await timelineOf(leadId);
      const quoteEntry = timeline.items.find((item) => item.type === 'quote_status');
      const noteEntry = timeline.items.find((item) => item.type === 'note');

      expect(quoteEntry?.quoteRef).toBe(quote.quoteRef);
      expect(quoteEntry?.title).toBe('Send');
      expect(noteEntry?.quoteRef).toBeNull();
    });

    it('appends the next follow-up date to a follow-up detail only when one is set', async () => {
      const leadId = await createLead();
      await seedFollowUp({
        leadId,
        outcomeNote: 'left voicemail',
        nextFollowUpDate: '2031-07-15',
        loggedBy: appUserId(admin),
        loggedAt: '2031-06-05T00:00:01.000Z',
      });
      await seedFollowUp({
        leadId,
        outcomeNote: 'spoke to broker',
        nextFollowUpDate: null,
        loggedBy: appUserId(admin),
        loggedAt: '2031-06-05T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId);
      const entries = timeline.items.filter((item) => item.type === 'follow_up');

      expect(entries.map((entry) => entry.title)).toEqual(['Follow-up logged', 'Follow-up logged']);
      expect(entries[0]?.detail).toBe('left voicemail — Next follow-up: 2031-07-15');
      expect(entries[1]?.detail).toBe('spoke to broker');
    });

    it('renders a null actor when the source row records no acting user', async () => {
      const leadId = await createLead();
      await seedStatusHistory({
        leadId,
        operation: 'expire',
        previousStatusId: null,
        newStatusId: null,
        actedBy: null,
        actedAt: '2031-06-06T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId);
      const entry = timeline.items.find((item) => item.type === 'status');

      expect(entry?.actorName).toBeNull();
    });
  });

  describe('paging', () => {
    it('pages at a fixed size of 50 with a total count over the whole merge', async () => {
      const leadId = await createLead();
      // 60 notes, at strictly decreasing instants so the expected page contents are determined.
      for (let index = 0; index < 60; index += 1) {
        await seedNote({
          leadId,
          body: `note-${String(index).padStart(2, '0')}`,
          createdBy: appUserId(admin),
          createdAt: new Date(Date.UTC(2031, 7, 1, 0, 0, index)).toISOString(),
        });
      }

      const page1 = await timelineOf(leadId, { page: 1 });
      const page2 = await timelineOf(leadId, { page: 2 });

      expect(page1.pageSize).toBe(50);
      expect(page1.page).toBe(1);
      expect(page1.totalCount).toBe(60);
      expect(page1.items).toHaveLength(50);
      expect(page2.page).toBe(2);
      expect(page2.items).toHaveLength(10);

      // Newest first: note-59 heads page 1, note-09 heads page 2, note-00 ends page 2.
      expect(page1.items[0]?.detail).toBe('note-59');
      expect(page2.items[0]?.detail).toBe('note-09');
      expect(page2.items.at(-1)?.detail).toBe('note-00');

      const overlap = page2.items.filter((entry) =>
        page1.items.some((other) => other.detail === entry.detail),
      );
      expect(overlap).toHaveLength(0);
    });

    it('floors a non-positive page to the first page', async () => {
      const leadId = await createLead();
      await seedNote({
        leadId,
        body: 'only note',
        createdBy: appUserId(admin),
        createdAt: '2031-09-01T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId, { page: 0 });

      expect(timeline.page).toBe(1);
      expect(timeline.items[0]?.detail).toBe('only note');
    });

    it('returns an empty page with a real total past the end', async () => {
      const leadId = await createLead();
      await seedNote({
        leadId,
        body: 'only note',
        createdBy: appUserId(admin),
        createdAt: '2031-09-02T00:00:00.000Z',
      });

      const timeline = await timelineOf(leadId, { page: 5 });

      expect(timeline.items).toHaveLength(0);
      expect(timeline.page).toBe(5);
      // The windowed count rides on the returned rows, so an empty page must fall back to a real
      // count rather than reporting the merge as empty.
      expect(timeline.totalCount).toBe(1);
    });

    it('returns an empty timeline for a lead with no activity', async () => {
      const leadId = await createLead();

      const timeline = await timelineOf(leadId);

      expect(timeline.items).toHaveLength(0);
      expect(timeline.totalCount).toBe(0);
      expect(timeline.pageSize).toBe(50);
    });
  });

  describe('tenant isolation and authorization (AC-022, V-027)', () => {
    it('answers 404 for a tenant-B lead requested by a tenant-A caller', async () => {
      const foreignLeadId = await createLeadInTenantB();

      const response = await getTimeline(foreignLeadId, { tenantId: tenantA });

      expect(response.status).toBe(404);
    });

    it('leaks no tenant-B entry into a tenant-A timeline', async () => {
      const foreignLeadId = await createLeadInTenantB();
      const leadId = await createLead({ intakeNotes: 'tenant A intake note' });

      const timeline = await timelineOf(leadId);
      const details = timeline.items.map((entry) => entry.detail);

      expect(foreignLeadId).toBeGreaterThan(0);
      expect(details).not.toContain('tenant B intake note');
      expect(details).toContain('tenant A intake note');
    });

    /**
     * The per-branch `tenant_id` predicates, pinned by CONSTRUCTING the state that discriminates
     * them rather than assuming it cannot arise.
     *
     * `lead_id` is a global identity sequence and none of these tables carries a foreign key to
     * `leads` (they are LIST-partitioned by tenant, see `20260718003200_leads.sql:150-159`), so
     * "another tenant's row cannot share this lead's id" is a property of current id ALLOCATION,
     * not of the schema — nothing stops such a row from existing. Each source below is given a
     * tenant-B twin carrying tenant A's lead id; every one of them must stay invisible. Without
     * these rows the branch predicates are unfalsifiable and the isolation is untested.
     */
    it('ignores another tenant’s rows that carry this lead’s id', async () => {
      const leadId = await createLead({ intakeNotes: 'tenant A note' });
      const quote = await seedQuote(tenantA, leadId, quoteDraftStatusA);
      // A REAL tenant-A quote event, so the quote branch actually emits: a duplicated join shows up
      // as a second copy of this entry, which an empty branch could never reveal.
      await seedQuoteHistory({
        quoteId: quote.id,
        operation: 'send',
        previousStatusId: quoteDraftStatusA,
        newStatusId: quoteSentStatusA,
        actedBy: appUserId(admin),
        actedAt: '2031-10-01T00:00:00.000Z',
      });

      await query(
        `insert into lead_notes (tenant_id, lead_id, body, created_at, created_by)
         values ($1, $2, 'FOREIGN note', now(), null)`,
        [tenantB, leadId],
      );
      await query(
        `insert into follow_ups
           (tenant_id, lead_id, follow_up_date, outcome_note, next_follow_up_date, logged_by, logged_at)
         values ($1, $2, current_date, 'FOREIGN follow-up', null, null, now())`,
        [tenantB, leadId],
      );
      await query(
        `insert into lead_status_history
           (tenant_id, lead_id, operation, previous_status_id, new_status_id, acted_by, acted_at)
         values ($1, $2, 'foreign-op', null, null, null, now())`,
        [tenantB, leadId],
      );

      // A REAL tenant-A transition, whose two status-name lookups are then given colliding
      // tenant-B reference items (same trick, same reason as the quotes collision above): without
      // a tenant predicate the name joins would match a foreign row and duplicate the entry.
      await seedStatusHistory({
        leadId,
        operation: 'assign',
        previousStatusId: newStatusA,
        newStatusId: assignedStatusA,
        actedBy: appUserId(admin),
        actedAt: '2031-10-02T00:00:00.000Z',
      });
      for (const [collidingId, label] of [
        [newStatusA, 'FOREIGN prev'],
        [assignedStatusA, 'FOREIGN new'],
      ] as const) {
        await query(
          `insert into reference_items
             (tenant_id, id, list_type, name, display_order, is_active, is_terminal, created_at, updated_at)
           overriding system value
           values ($1, $2, 'lead_status', $3, 0, true, false, now(), now())`,
          [tenantB, collidingId, `${label} ${RUN}`],
        );
      }
      // The quote branch's own predicate: a tenant-B history row pointing at tenant A's quote.
      await query(
        `insert into quote_status_history
           (tenant_id, quote_id, operation, previous_status_id, new_status_id, acted_by, acted_at)
         values ($1, $2, 'foreign-quote-op', null, null, null, now())`,
        [tenantB, quote.id],
      );

      // The `quotes` JOIN predicates (both the union branch's and the outer `quote_ref` lookup's).
      // Discriminating them needs an id COLLISION across tenants, which the schema permits — the
      // primary key is `(tenant_id, id)`, so the same quote id may legally exist in two tenants —
      // even though the shared identity sequence does not currently produce one. Forced with
      // `overriding system value`, because "the sequence happens not to collide" is an allocation
      // accident, not an isolation guarantee.
      await query(
        `insert into quotes
           (tenant_id, id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
            prepared_date, created_at, updated_at)
         overriding system value
         values ($1, $2, $3, $4, $5, false, $6, $7, current_date, now(), now())`,
        [tenantB, quote.id, leadId, `${RUN}-foreign-q`, quoteDraftStatusA, productLineB, coverTypeB],
      );

      const timeline = await timelineOf(leadId);

      expect(timeline.items.map((entry) => entry.detail)).toContain('tenant A note');
      expect(timeline.items.map((entry) => entry.detail)).not.toContain('FOREIGN note');
      expect(timeline.items.map((entry) => entry.detail)).not.toContain('FOREIGN follow-up');
      expect(timeline.items.map((entry) => entry.title)).not.toContain('Foreign Op');
      expect(timeline.items.map((entry) => entry.title)).not.toContain('Foreign Quote Op');
      // Exactly the two tenant-A entries — the note and the one quote event, neither duplicated.
      expect(timeline.items.filter((entry) => entry.type === 'quote_status')).toHaveLength(1);
      expect(timeline.items.filter((entry) => entry.type === 'status')).toHaveLength(1);
      // The names resolved are tenant A's, not the colliding tenant-B rows'.
      const statusEntry = timeline.items.find((entry) => entry.type === 'status');
      expect(statusEntry?.detail).toBe(
        `${await statusNameOf(newStatusA)} → ${await statusNameOf(assignedStatusA)}`,
      );
      expect(timeline.totalCount).toBe(3);
    });

    it('answers 403 without the leads.view permission', async () => {
      const leadId = await createLead();

      const response = await getTimeline(leadId, { session: ungranted });

      expect(response.status).toBe(403);
    });

    /**
     * Breadth parity with lead DETAIL, which is a LIST-query filter only (human-ruled): a caller
     * holding `leads.view` but not `leads.view_all` reads the timeline of a lead they do not own,
     * exactly as `GET /leads/{id}` lets them read its detail.
     */
    it('serves a lead the caller does not own without leads.view_all, matching lead detail', async () => {
      const leadId = await createLead({ intakeNotes: 'not narrow’s lead' });

      const detailResponse = await call('GET', `${BASE}/${leadId}`, {
        token: narrow.accessToken,
        tenantId: tenantA,
      });
      const timelineResponse = await getTimeline(leadId, { session: narrow });

      expect(detailResponse.status).toBe(200);
      expect(timelineResponse.status).toBe(200);
    });

    it('answers 404 for a non-numeric lead id', async () => {
      const response = await call('GET', `${BASE}/not-a-number/timeline`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(404);
    });
  });

  async function statusNameOf(referenceItemId: number): Promise<string> {
    const rows = await query<{ name: string }>(
      'select r.name from reference_items r where r.id = $1 and r.tenant_id = $2',
      [referenceItemId, tenantA],
    );
    return String(rows[0]?.name);
  }
});
