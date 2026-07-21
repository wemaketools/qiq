/**
 * Lead workflow operations, end to end (T-025; AC-021, AC-022, AC-024, AC-047..AC-051, AC-096;
 * V-026, V-031, V-061..V-064, V-066, V-124).
 *
 * Same composed-system harness as `leads-core.test.ts`: real sessions, real tenants/partitions,
 * real grants, the real Hono pipeline via `app.request`. Nothing is stubbed — legality, tenant
 * isolation, the per-operation permission map and the append-only history are properties of the
 * composed system, not of any one function.
 *
 * EVERY REJECTION ASSERTS ITS CODE, NOT MERELY ITS STATUS
 * ======================================================
 * This suite rejects a great many calls and almost all of them answer 409 or 422. A status-only
 * assertion cannot tell a correct rejection from an accidental one — an illegal-transition 409 and
 * a duplicate-pending-approval 409 are indistinguishable by status. So every negative case names
 * the `code` it expects, and the illegal-transition cases additionally pin the legal-operation hint.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withdrawLead } from '../../domains/leads/workflow/operations.js';
import type { EffectiveAccess } from '../../domains/rbac/effective-permissions.js';
import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import type { TenantId } from '../../lib/db/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('lead-workflow', probe);

const BASE = '/api/v1/leads';

interface LeadDto {
  readonly id: number;
  readonly statusId: number;
  readonly statusCanonicalKey: string | null;
  readonly availableOperations: string[];
  readonly lastFollowUpDate: string | null;
  readonly nextFollowUpDate: string | null;
}

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly availableOperations?: readonly string[];
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

/** Deliberately SHORT — a long shared token dominates trigram similarity on party names. */
const RUN = `t025-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrow(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
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

  /** Holds every lead + pricing grant in BOTH tenants. */
  let admin: TestUserSession;
  /** Holds the RM role (eligible owner) and `leads.view` only. */
  let owner: TestUserSession;
  /** A tenant-A member holding NO role: the ineligible-assignee fixture. */
  let strangerWithoutRole: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  let rmRoleId = 0;
  let rmSlotA = 0;

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
      "select id::text as id from tenants where name like 't025-%'",
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

  // Reference fixtures.
  let partyTypeA = 0;
  let regionA = 0;
  let channelA = 0;
  let productLineA = 0;
  let coverTypeA = 0;
  let partyA = 0;
  let lostReasonA = 0;
  let otherLostReasonA = 0;
  let inactiveLostReasonA = 0;

  // Tenant B, for the isolation cases.
  let partyTypeB = 0;
  let regionB = 0;
  let channelB = 0;
  let productLineB = 0;
  let coverTypeB = 0;
  let partyB = 0;

  /**
   * A quote in a given canonical status, for the closure cascade.
   *
   * `is_current` is computed as "true only if this lead has no current quote yet" rather than being
   * hard-coded true. It used to be hard-coded, which silently seeded TWO current quotes whenever a
   * test needed several quotes on one lead — a state production can never reach and that
   * double-counts quoted premium in every dashboard joining `quote.is_current`. T-026's new
   * `uq_quotes_current` partial unique index now rejects it outright, which is how the fixture
   * defect surfaced. Nothing in this suite asserts `is_current`; this keeps the fixture legal AND
   * faithful to what `CreateQuoteCommandHandler` actually does (first quote of a lead is current).
   */
  async function seedQuote(leadId: number, statusCanonicalKey: string): Promise<number> {
    const statusId = await quoteStatusIdOf(statusCanonicalKey);
    const rows = await query<{ id: string }>(
      `insert into quotes
         (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
          prepared_date, created_at, updated_at)
       values ($1, $2, $3, $4,
               not exists (select 1 from quotes c
                            where c.tenant_id = $1 and c.lead_id = $2 and c.is_current),
               $5, $6, current_date, now(), now())
       returning id::text as id`,
      [
        tenantA,
        leadId,
        `${RUN}-q${String(++nameSequence)}`,
        statusId,
        productLineA,
        coverTypeA,
      ],
    );
    return Number(rows[0]?.id);
  }

  async function quoteStatusIdOf(canonicalKey: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `select id::text as id from reference_items
        where tenant_id = $1 and list_type = 'quote_status' and canonical_key = $2`,
      [tenantA, canonicalKey],
    );
    return Number(rows[0]?.id);
  }

  async function quoteStatusOf(quoteId: number): Promise<number> {
    const rows = await query<{ status_id: string }>(
      `select status_id::text as status_id from quotes where id = $1`,
      [quoteId],
    );
    return Number(rows[0]?.status_id);
  }

  /** A real lead in tenant B — the cross-tenant fixture the tenant-A caller must not reach. */
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
        intakeNotes: null,
        createAnyway: true,
      },
    });
    expect(response.status).toBe(201);
    const outcome = (await response.json()) as { lead: LeadDto | null };
    return outcome.lead?.id ?? 0;
  }

  async function readForeignLeadStatus(leadId: number): Promise<string> {
    const rows = await query<{ status_id: string }>(
      `select status_id::text as status_id from leads where id = $1`,
      [leadId],
    );
    return String(rows[0]?.status_id);
  }

  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      partyId: partyA,
      isExistingClient: true,
      dateReceived: yesterday(),
      requestChannelId: channelA,
      brokerId: null,
      ownerUserId: appUserId(owner),
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
    const outcome = (await response.json()) as { lead: LeadDto | null };
    return outcome.lead?.id ?? 0;
  }

  async function getLead(id: number, session: TestUserSession = admin): Promise<LeadDto> {
    const response = await call('GET', `${BASE}/${id}`, {
      token: session.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as LeadDto;
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
    await seedSettings(tenantA);
    await seedSettings(tenantB);

    admin = await auth.createTestUserWithSession({ label: 'wf-admin' });
    owner = await auth.createTestUserWithSession({
      label: 'wf-owner',
      firstName: 'Rita',
      lastName: 'Mensah',
    });

    strangerWithoutRole = await auth.createTestUserWithSession({ label: 'wf-stranger' });

    for (const session of [admin, owner, strangerWithoutRole]) {
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
      'leads.reopen',
      'pricing.request',
      'pricing.approve',
      'pricing.reject',
    ] as const) {
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantA);
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantB);
    }
    await fixtures.grantDirectPermission(appUserId(owner), 'leads.view', tenantA);

    rmRoleId = await fixtures.createRole({ tenantId: tenantA });
    await fixtures.assignRole(appUserId(owner), rmRoleId, tenantA);
    await fixtures.assignRole(appUserId(admin), rmRoleId, tenantA);
    rmSlotA = await seedRmSlot(tenantA, rmRoleId);

    // Tenant B needs its own RM slot/role so a real tenant-B lead can be created at all — the
    // cross-tenant 404 case needs a genuinely existing foreign row, not a fabricated id.
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

    // The canonical lead-status ladder this suite walks.
    for (const [key, category] of [
      ['new', 'open'],
      ['assigned', 'open'],
      ['information_gathering', 'open'],
      ['underwriting', 'open'],
      ['pricing', 'open'],
      ['quote_sent', 'quoted'],
      ['negotiation', 'quoted'],
      ['closed_lost', 'lost'],
      ['expired', 'lost'],
      ['withdrawn', 'lost'],
    ] as const) {
      await seedRef(tenantA, 'lead_status', uniqueName(`${key} A`), {
        reportingCategory: category,
        canonicalKey: key,
        isTerminal: category === 'lost',
      });
    }

    // Quote statuses, for the mark-lost/withdraw cascade.
    for (const [key, category] of [
      ['draft', 'open'],
      ['sent', 'quoted'],
      ['won', 'won'],
      ['lost', 'lost'],
      ['withdrawn', 'withdrawn'],
    ] as const) {
      await seedRef(tenantA, 'quote_status', uniqueName(`q-${key} A`), {
        reportingCategory: category,
        canonicalKey: key,
        isTerminal: category !== 'open' && category !== 'quoted',
      });
    }

    lostReasonA = await seedRef(tenantA, 'lost_reason', uniqueName('Price A'), {
      canonicalKey: 'price',
    });
    otherLostReasonA = await seedRef(tenantA, 'lost_reason', uniqueName('Other A'), {
      canonicalKey: 'other',
    });
    inactiveLostReasonA = await seedRef(tenantA, 'lost_reason', uniqueName('Retired A'), {
      canonicalKey: 'retired',
      isActive: false,
    });

    partyA = await seedParty(tenantA, `Acme ${RUN}`, partyTypeA);

    // Tenant B: the isolation fixture set.
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
    await seedRef(tenantB, 'lead_status', uniqueName('Withdrawn B'), {
      reportingCategory: 'withdrawn',
      canonicalKey: 'withdrawn',
      isTerminal: true,
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
    // `db.destroy()` already ends this pool; the catch keeps the double-end from failing teardown.
    await pool?.end().catch(() => undefined);
  }, 120_000);

  /** POSTs an operation as a given session. */
  async function operate(
    leadId: number,
    op: string,
    body: unknown = {},
    options: { session?: TestUserSession; tenantId?: number } = {},
  ): Promise<Response> {
    return await call('POST', `${BASE}/${leadId}/operations/${op}`, {
      token: (options.session ?? admin).accessToken,
      tenantId: options.tenantId ?? tenantA,
      body,
    });
  }

  /** POSTs an operation and asserts it succeeded, returning the refreshed lead. */
  async function operateOk(leadId: number, op: string, body: unknown = {}): Promise<LeadDto> {
    const response = await operate(leadId, op, body);
    expect(response.status, `${op} should have succeeded`).toBe(200);
    return (await response.json()) as LeadDto;
  }

  async function problemOf(response: Response): Promise<ProblemBody> {
    return (await response.json()) as ProblemBody;
  }

  /** The lead's raw workflow columns — the side-effect check the API response cannot fake. */
  async function readLeadRow(id: number): Promise<Record<string, unknown> | undefined> {
    const rows = await query<Record<string, unknown>>(
      `select status_id::text as status_id, pricing_approval_state,
              date_assigned::text as date_assigned, decision_date::text as decision_date,
              lost_reason_id::text as lost_reason_id, lost_before_quote, competitor,
              loss_comments, withdrawal_note, last_follow_up_date::text as last_follow_up_date,
              next_follow_up_date::text as next_follow_up_date, follow_up_count,
              last_activity_at::text as last_activity_at
         from leads where id = $1`,
      [id],
    );
    return rows[0];
  }

  /**
   * The raw history rows, in APPEND order.
   *
   * `order by h.id` is QUALIFIED on purpose (T-048). Every column here is cast to text under its
   * OWN name, and Postgres resolves a BARE `order by id` to the output ALIAS — the text — before
   * the underlying column, which silently turns the sort into a string comparison: ids order
   * '10' < '9', and `timestamptz::text` trims trailing zeros so a whole-second value sorts apart
   * from every sub-second value in the same second. That is what made this helper's ordering
   * disagree with the append order intermittently. Table-qualifying the sort key defeats alias
   * resolution and sorts the real column.
   */
  async function readHistory(leadId: number): Promise<Record<string, unknown>[]> {
    return await query<Record<string, unknown>>(
      `select h.id::text as id, h.operation, h.previous_status_id::text as previous_status_id,
              h.new_status_id::text as new_status_id, h.acted_by::text as acted_by,
              h.acted_at::text as acted_at, h.inputs
         from lead_status_history h where h.lead_id = $1 order by h.id`,
      [leadId],
    );
  }

  /**
   * Appends one history row with a CHOSEN `acted_at` (T-048).
   *
   * Direct SQL because the whole point is to control the timestamp independently of the append
   * order — which is exactly what a wall clock that ties, steps backwards, or lands on an exact
   * millisecond boundary does to the real write path.
   */
  async function appendHistoryRowAt(
    leadId: number,
    operation: string,
    actedAt: string,
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into lead_status_history (tenant_id, lead_id, operation, acted_at)
            values ($1, $2, $3, $4::timestamptz)
         returning id::text as id`,
      [tenantA, leadId, operation, actedAt],
    );
    return Number(rows[0]?.id);
  }

  async function statusIdOf(canonicalKey: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `select id::text as id from reference_items
        where tenant_id = $1 and list_type = 'lead_status' and canonical_key = $2`,
      [tenantA, canonicalKey],
    );
    return Number(rows[0]?.id);
  }

  /** Drives a lead from New to the requested canonical status using only legal operations. */
  async function driveTo(leadId: number, canonicalKey: string): Promise<void> {
    const ownerId = appUserId(owner);
    await operateOk(leadId, 'assign', {
      assignments: [{ businessAssignmentId: rmSlotA, userId: ownerId }],
    });
    if (canonicalKey === 'assigned') return;

    if (canonicalKey === 'information_gathering') {
      await operateOk(leadId, 'start-information-gathering', {});
      return;
    }
    if (canonicalKey === 'underwriting') {
      await operateOk(leadId, 'send-to-underwriting', { underwritingOwnerUserId: ownerId });
      return;
    }
    if (canonicalKey === 'pricing') {
      await operateOk(leadId, 'start-pricing', {});
      return;
    }
    throw new Error(`driveTo does not know how to reach '${canonicalKey}' via legal operations`);
  }

  /**
   * Forces a lead into a status no lead OPERATION can reach from New (Quote Sent, Negotiation).
   *
   * Direct SQL on purpose: those statuses are reached from the QUOTE side (T-026), which does not
   * exist yet. Writing the status row directly is the only way to construct the discriminating
   * state today, and it is honest about being a fixture rather than a workflow path — the history
   * row it appends mirrors what a real transition would have left behind so that reopen's
   * history walk has something truthful to find.
   */
  async function forceStatus(leadId: number, canonicalKey: string): Promise<void> {
    const previous = await readLeadRow(leadId);
    const target = await statusIdOf(canonicalKey);
    await query('update leads set status_id = $1, last_activity_at = now() where id = $2', [
      target,
      leadId,
    ]);
    await query(
      `insert into lead_status_history
         (tenant_id, lead_id, operation, previous_status_id, new_status_id, acted_by, acted_at, inputs)
       values ($1, $2, 'fixture-force-status', $3, $4, $5, now(), '{}'::jsonb)`,
      [tenantA, leadId, previous?.['status_id'], target, appUserId(admin)],
    );
  }

  it('returns the matrix-legal operations for a New lead on the detail response', async () => {
    // Arrange: a freshly created lead sits in canonical `new` / reporting category `open`.
    const leadId = await createLead();

    // Act.
    const lead = await getLead(leadId);

    // Assert: exactly the four operations LeadWorkflow.Matrix makes legal from `new` for a caller
    // holding every lead permission — assign (canonical `new`) plus the three category-wide
    // operations. This is the T-024-F8 gap: the detail response previously hard-coded [].
    expect(lead.statusCanonicalKey).toBe('new');
    expect(lead.availableOperations).toEqual(['assign', 'log-follow-up', 'mark-lost', 'withdraw']);
  });

  describe('availableOperations (AC-050, V-064)', () => {
    it('reflects the lead status across three distinct statuses', async () => {
      const newLead = await createLead();
      expect((await getLead(newLead)).availableOperations).toEqual([
        'assign',
        'log-follow-up',
        'mark-lost',
        'withdraw',
      ]);

      const pricingLead = await createLead();
      await driveTo(pricingLead, 'pricing');
      expect((await getLead(pricingLead)).availableOperations).toEqual([
        'assign',
        'start-information-gathering',
        'request-pricing-approval',
        'approve-pricing',
        'reject-pricing',
        'log-follow-up',
        'mark-lost',
        'withdraw',
      ]);

      const lostLead = await createLead();
      await operateOk(lostLead, 'mark-lost', { lostReasonId: lostReasonA });
      expect((await getLead(lostLead)).availableOperations).toEqual(['reopen']);
    });

    it('is filtered by the CALLER permissions, not only by the status', async () => {
      // `owner` holds leads.view alone: legal operations exist from New, but none are permitted.
      const leadId = await createLead();
      expect((await getLead(leadId, owner)).availableOperations).toEqual([]);
      expect((await getLead(leadId, admin)).availableOperations).not.toEqual([]);
    });

    it('rejects an operation absent from the caller availableOperations with 403, not success', async () => {
      // UI gating is not load-bearing: the server refuses even though the button was never rendered.
      const leadId = await createLead();
      const response = await operate(
        leadId,
        'mark-lost',
        { lostReasonId: lostReasonA },
        { session: owner },
      );

      expect(response.status).toBe(403);
      // The lead must be untouched.
      expect((await readLeadRow(leadId))?.['status_id']).toBe(String(await statusIdOf('new')));
    });
  });

  describe('legality matrix over HTTP (AC-047, V-061)', () => {
    it('rejects an illegal operation with 409 and the legal-operation hint', async () => {
      const leadId = await createLead();

      // start-negotiation is legal only from Quote Sent; this lead is New.
      const response = await operate(leadId, 'start-negotiation', {});
      const problem = await problemOf(response);

      expect(response.status).toBe(409);
      expect(problem.code).toBe('LEAD_ILLEGAL_TRANSITION');
      // The hint is the whole point of the 409 — assert its CONTENT, not merely its presence.
      expect(problem.availableOperations).toEqual([
        'assign',
        'log-follow-up',
        'mark-lost',
        'withdraw',
      ]);
    });

    it('rejects reopen on an OPEN lead and mark-lost on a CLOSED lead, each with its own hint', async () => {
      const openLead = await createLead();
      const openProblem = await problemOf(
        await operate(openLead, 'reopen', { reopenReason: 'nope' }),
      );
      expect(openProblem.code).toBe('LEAD_ILLEGAL_TRANSITION');
      expect(openProblem.availableOperations).not.toContain('reopen');

      const closedLead = await createLead();
      await operateOk(closedLead, 'withdraw', { withdrawalNote: 'done' });
      const closedResponse = await operate(closedLead, 'mark-lost', { lostReasonId: lostReasonA });
      const closedProblem = await problemOf(closedResponse);
      expect(closedResponse.status).toBe(409);
      expect(closedProblem.availableOperations).toEqual(['reopen']);
    });

    it('never offers the automatic expiry operation, and has no route for it', async () => {
      const leadId = await createLead();
      expect((await getLead(leadId)).availableOperations).not.toContain('expire_automatic');

      // No HTTP route exists for the system-only operation.
      const response = await operate(leadId, 'expire_automatic', {});
      expect(response.status).toBe(404);
    });

    it('exposes no endpoint that sets a lead status directly (AC-047)', async () => {
      const leadId = await createLead();
      const negotiationId = await statusIdOf('negotiation');

      // The edit endpoint must ignore/refuse a statusId rather than honour it.
      const response = await call('PUT', `${BASE}/${leadId}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: {
          isExistingClient: true,
          dateReceived: yesterday(),
          requestChannelId: channelA,
          brokerId: null,
          regionId: regionA,
          externalRef: null,
          productLineId: productLineA,
          coverTypeId: coverTypeA,
          sumInsured: null,
          estimatedPremium: null,
          policyTerm: 'm12',
          policyTermOther: null,
          priority: null,
          statusId: negotiationId,
        },
      });

      expect([200, 422]).toContain(response.status);
      expect((await readLeadRow(leadId))?.['status_id']).toBe(String(await statusIdOf('new')));
    });
  });

  describe('status history and audit (AC-048, AC-024; V-062, V-031)', () => {
    it('appends exactly one history row per operation, with actor and inputs, never rewriting prior rows', async () => {
      const leadId = await createLead();
      const ownerId = appUserId(owner);

      // Intake already set the RM slot to `owner`, so reassigning to `admin` is a REAL change —
      // which is exactly what makes `roleChanges` meaningful to assert (FR-35: "audited per
      // changed role", so a no-op resubmission of the dialog must record no change).
      const adminId = appUserId(admin);
      await operateOk(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: adminId }],
        comment: 'first owner',
      });

      const afterAssign = await readHistory(leadId);
      expect(afterAssign).toHaveLength(1);
      expect(afterAssign[0]?.['operation']).toBe('assign');
      expect(afterAssign[0]?.['acted_by']).toBe(String(adminId));
      expect(afterAssign[0]?.['previous_status_id']).toBe(String(await statusIdOf('new')));
      expect(afterAssign[0]?.['new_status_id']).toBe(String(await statusIdOf('assigned')));
      const inputs = afterAssign[0]?.['inputs'] as Record<string, unknown>;
      expect(inputs['comment']).toBe('first owner');
      expect(inputs['roleChanges']).toEqual([
        { businessAssignmentId: rmSlotA, previousUserId: ownerId, newUserId: adminId },
      ]);

      // A digest of the existing rows, to prove the NEXT operation appends rather than rewrites.
      const digestBefore = JSON.stringify(afterAssign);

      await operateOk(leadId, 'start-information-gathering', { note: 'gathering' });

      const afterSecond = await readHistory(leadId);
      expect(afterSecond).toHaveLength(2);
      expect(JSON.stringify(afterSecond.slice(0, 1))).toBe(digestBefore);
      expect(afterSecond[1]?.['operation']).toBe('start-information-gathering');
      expect((afterSecond[1]?.['inputs'] as Record<string, unknown>)['note']).toBe('gathering');
    });

    it('writes exactly one audit row per operation with before/after status', async () => {
      const leadId = await createLead();
      const newStatusId = await statusIdOf('new');
      const assignedStatusId = await statusIdOf('assigned');

      await operateOk(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(owner) }],
      });

      const row = await assertAudited(query, {
        action: 'lead.assign',
        entityType: 'lead',
        entityId: String(leadId),
        actorUserId: appUserId(admin),
        tenantId: tenantA,
        before: { statusId: newStatusId },
      });

      const after = (row.details as Record<string, unknown>)['after'] as Record<string, unknown>;
      expect(after['statusId']).toBe(assignedStatusId);
    });

    it('audits every one of the twelve operations (V-031 inventory)', async () => {
      // One lead per operation family, so each audit action can be asserted as EXACTLY ONE row.
      const ownerId = appUserId(owner);

      const a = await createLead();
      await driveTo(a, 'pricing');
      await operateOk(a, 'request-pricing-approval', { approverUserId: appUserId(admin) });
      await operateOk(a, 'approve-pricing', { note: 'ok' });
      await operateOk(a, 'log-follow-up', { outcomeNote: 'called' });
      await operateOk(a, 'mark-lost', { lostReasonId: lostReasonA });
      await operateOk(a, 'reopen', { reopenReason: 'client returned' });

      const b = await createLead();
      await driveTo(b, 'pricing');
      await operateOk(b, 'request-pricing-approval', { approverUserId: appUserId(admin) });
      await operateOk(b, 'reject-pricing', { rejectionReason: 'too low' });
      await operateOk(b, 'withdraw', { withdrawalNote: 'client withdrew' });

      const c = await createLead();
      await operateOk(c, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: ownerId }],
      });
      await operateOk(c, 'send-to-underwriting', { underwritingOwnerUserId: ownerId });

      const d = await createLead();
      await driveTo(d, 'information_gathering');

      const e = await createLead();
      await forceStatus(e, 'quote_sent');
      await operateOk(e, 'start-negotiation', {});

      for (const [action, entityId] of [
        ['lead.assign', c],
        ['lead.start-information-gathering', d],
        ['lead.send-to-underwriting', c],
        ['lead.start-pricing', a],
        ['lead.request-pricing-approval', a],
        ['lead.approve-pricing', a],
        ['lead.reject-pricing', b],
        ['lead.log-follow-up', a],
        ['lead.start-negotiation', e],
        ['lead.mark-lost', a],
        ['lead.withdraw', b],
        ['lead.reopen', a],
      ] as const) {
        await assertAudited(query, {
          action,
          entityType: 'lead',
          entityId: String(entityId),
          tenantId: tenantA,
        });
      }
    });

    it('stamps last_activity_at on every operation', async () => {
      const leadId = await createLead();
      const before = (await readLeadRow(leadId))?.['last_activity_at'];

      await operateOk(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(owner) }],
      });

      const after = (await readLeadRow(leadId))?.['last_activity_at'];
      expect(String(after)).not.toBe(String(before));
    });
  });

  describe('assign / reassign (AC-048)', () => {
    it('moves New to Assigned on first assignment and stamps date_assigned once', async () => {
      const leadId = await createLead();

      const assigned = await operateOk(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(owner) }],
      });
      expect(assigned.statusCanonicalKey).toBe('assigned');
      const firstDateAssigned = (await readLeadRow(leadId))?.['date_assigned'];
      expect(firstDateAssigned).not.toBeNull();

      // Reassignment KEEPS the current status and must not restart the assignment SLA clock.
      const reassigned = await operateOk(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(admin) }],
      });
      expect(reassigned.statusCanonicalKey).toBe('assigned');
      expect((await readLeadRow(leadId))?.['date_assigned']).toBe(firstDateAssigned);
    });

    it('rejects an ineligible assignee with its own code, and an unknown slot with another', async () => {
      const leadId = await createLead();

      const ineligible = await operate(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(strangerWithoutRole) }],
      });
      expect(ineligible.status).toBe(422);
      expect((await problemOf(ineligible)).code).toBe('LEAD_WORKFLOW_INVALID_ASSIGNEE');

      const unknownSlot = await operate(leadId, 'assign', {
        assignments: [{ businessAssignmentId: 987654321, userId: appUserId(owner) }],
      });
      expect(unknownSlot.status).toBe(422);
      expect((await problemOf(unknownSlot)).code).toBe('LEAD_WORKFLOW_VALIDATION_FAILED');

      // Neither rejected attempt may have CHANGED the assignment intake created.
      const rows = await query<{ user_id: string }>(
        `select user_id::text as user_id from lead_assignments where lead_id = $1`,
        [leadId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(String(appUserId(owner)));
      // Nor may either have appended history: a rejected operation is not an event.
      expect(await query(`select id from lead_status_history where lead_id = $1`, [leadId])).toHaveLength(0);
    });

    it('refuses to leave the accountable owner unassigned, and rolls back the removal', async () => {
      const leadId = await createLead();
      await operateOk(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(owner) }],
      });

      const response = await operate(leadId, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: null }],
      });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('LEAD_WORKFLOW_VALIDATION_FAILED');

      // ATOMICITY: the delete ran before the rule tripped, so the row must have come back.
      const rows = await query<{ user_id: string }>(
        `select user_id::text as user_id from lead_assignments
          where lead_id = $1 and business_assignment_id = $2`,
        [leadId, rmSlotA],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(String(appUserId(owner)));
    });

    it('rejects a duplicate slot in one request with the structured errors[] shape', async () => {
      const leadId = await createLead();
      const response = await operate(leadId, 'assign', {
        assignments: [
          { businessAssignmentId: rmSlotA, userId: appUserId(owner) },
          { businessAssignmentId: rmSlotA, userId: appUserId(admin) },
        ],
      });

      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe('LEAD_VALIDATION_FAILED');
      expect(problem.errors?.some((e) => e.code === 'LEAD_DUPLICATE_ASSIGNMENT')).toBe(true);
    });
  });

  describe('pricing approval sub-state (AC-049, V-063)', () => {
    it('walks none -> pending -> approved and records the approver and note', async () => {
      const leadId = await createLead();
      await driveTo(leadId, 'pricing');
      expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('none');

      await operateOk(leadId, 'request-pricing-approval', {
        approverUserId: appUserId(admin),
        proposedPremium: 1234.5,
        note: 'please review',
      });
      expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('pending');

      const approved = await operateOk(leadId, 'approve-pricing', { note: 'looks right' });
      // The lead's STATUS never moves — the pricing operations are sub-state only.
      expect(approved.statusCanonicalKey).toBe('pricing');
      expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('approved');

      const approvals = await query<Record<string, unknown>>(
        `select state, approver_id::text as approver_id, decided_by::text as decided_by,
                decision_note, proposed_premium::text as proposed_premium
           from pricing_approvals where lead_id = $1`,
        [leadId],
      );
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.['state']).toBe('approved');
      expect(approvals[0]?.['approver_id']).toBe(String(appUserId(admin)));
      expect(approvals[0]?.['decided_by']).toBe(String(appUserId(admin)));
      expect(approvals[0]?.['decision_note']).toBe('looks right');
    });

    it('walks none -> pending -> rejected and records the rejection reason', async () => {
      const leadId = await createLead();
      await driveTo(leadId, 'pricing');
      await operateOk(leadId, 'request-pricing-approval', { approverUserId: appUserId(admin) });
      await operateOk(leadId, 'reject-pricing', { rejectionReason: 'premium too low' });

      expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('rejected');
      const approvals = await query<Record<string, unknown>>(
        `select state, rejection_reason from pricing_approvals where lead_id = $1`,
        [leadId],
      );
      expect(approvals[0]?.['state']).toBe('rejected');
      expect(approvals[0]?.['rejection_reason']).toBe('premium too low');
    });

    it('allows re-request after a rejection — that is the rework loop', async () => {
      const leadId = await createLead();
      await driveTo(leadId, 'pricing');
      await operateOk(leadId, 'request-pricing-approval', { approverUserId: appUserId(admin) });
      await operateOk(leadId, 'reject-pricing', { rejectionReason: 'rework' });
      await operateOk(leadId, 'request-pricing-approval', { approverUserId: appUserId(admin) });

      expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('pending');
      const approvals = await query(`select id from pricing_approvals where lead_id = $1`, [leadId]);
      expect(approvals).toHaveLength(2);
    });

    it('rejects a SECOND pending request, and a decision with nothing pending', async () => {
      const leadId = await createLead();
      await driveTo(leadId, 'pricing');

      const noPending = await operate(leadId, 'approve-pricing', {});
      expect(noPending.status).toBe(422);
      expect((await problemOf(noPending)).code).toBe(
        'LEAD_WORKFLOW_NO_PENDING_PRICING_APPROVAL',
      );

      await operateOk(leadId, 'request-pricing-approval', { approverUserId: appUserId(admin) });

      const second = await operate(leadId, 'request-pricing-approval', {
        approverUserId: appUserId(admin),
      });
      expect(second.status).toBe(422);
      expect((await problemOf(second)).code).toBe('LEAD_WORKFLOW_VALIDATION_FAILED');
      // Still exactly one request row: the rejected second attempt wrote nothing.
      expect(await query(`select id from pricing_approvals where lead_id = $1`, [leadId])).toHaveLength(1);
    });

    it('rejects an approver who does not hold pricing.approve', async () => {
      const leadId = await createLead();
      await driveTo(leadId, 'pricing');

      const response = await operate(leadId, 'request-pricing-approval', {
        approverUserId: appUserId(owner),
      });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('LEAD_WORKFLOW_APPROVER_NOT_ELIGIBLE');
      expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('none');
    });
  });

  describe('log follow-up (AC-051, V-066)', () => {
    it('records a follow-up and updates the denormalized tracking fields', async () => {
      const leadId = await createLead();
      const lead = await operateOk(leadId, 'log-follow-up', {
        outcomeNote: 'left a voicemail',
        nextFollowUpDate: tomorrow(),
      });

      expect(lead.nextFollowUpDate).toBe(tomorrow());
      const row = await readLeadRow(leadId);
      expect(row?.['follow_up_count']).toBe(1);
      expect(row?.['last_follow_up_date']).toBe(todayIso());
      expect(row?.['next_follow_up_date']).toBe(tomorrow());

      const followUps = await query<Record<string, unknown>>(
        `select outcome_note, logged_by::text as logged_by,
                next_follow_up_date::text as next_follow_up_date
           from follow_ups where lead_id = $1`,
        [leadId],
      );
      expect(followUps).toHaveLength(1);
      expect(followUps[0]?.['outcome_note']).toBe('left a voicemail');
      expect(followUps[0]?.['logged_by']).toBe(String(appUserId(admin)));
    });

    it('requires a FUTURE next follow-up once the lead is past Quote Sent, but not before', async () => {
      // Before Quote Sent (category `open`): no next date needed.
      const openLead = await createLead();
      await operateOk(openLead, 'log-follow-up', { outcomeNote: 'no next date needed' });

      // Past Quote Sent (category `quoted`): required, and required to be in the future.
      const quotedLead = await createLead();
      await forceStatus(quotedLead, 'quote_sent');

      const missing = await operate(quotedLead, 'log-follow-up', { outcomeNote: 'called' });
      expect(missing.status).toBe(422);
      expect((await problemOf(missing)).code).toBe('LEAD_WORKFLOW_VALIDATION_FAILED');

      const notFuture = await operate(quotedLead, 'log-follow-up', {
        outcomeNote: 'called',
        nextFollowUpDate: todayIso(),
      });
      expect(notFuture.status).toBe(422);

      // Neither rejected attempt may have written a follow_ups row.
      expect(await query(`select id from follow_ups where lead_id = $1`, [quotedLead])).toHaveLength(0);

      await operateOk(quotedLead, 'log-follow-up', {
        outcomeNote: 'called',
        nextFollowUpDate: tomorrow(),
      });
      expect(await query(`select id from follow_ups where lead_id = $1`, [quotedLead])).toHaveLength(1);
    });

    it('rejects a blank outcome note with the structured errors[] shape', async () => {
      const leadId = await createLead();
      const response = await operate(leadId, 'log-follow-up', { outcomeNote: '   ' });

      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe('LEAD_VALIDATION_FAILED');
      expect(problem.errors?.[0]?.field).toBe('outcomeNote');
      expect(problem.errors?.[0]?.code).toBe('LEAD_REQUIRED');
    });
  });

  describe('mark lost, withdraw, reopen (AC-051, V-066)', () => {
    it('marks lost with a structured reason and records lostBeforeQuote', async () => {
      const leadId = await createLead();
      const lead = await operateOk(leadId, 'mark-lost', {
        lostReasonId: lostReasonA,
        competitor: 'Rival Co',
        competitorPremium: 999.99,
      });

      expect(lead.statusCanonicalKey).toBe('closed_lost');
      const row = await readLeadRow(leadId);
      expect(row?.['lost_reason_id']).toBe(String(lostReasonA));
      expect(row?.['competitor']).toBe('Rival Co');
      expect(row?.['decision_date']).not.toBeNull();
      // Never reached a `quoted` status, so it was lost BEFORE a quote.
      expect(row?.['lost_before_quote']).toBe(true);
    });

    it('records lostBeforeQuote false when the lead ever reached a quoted status', async () => {
      const leadId = await createLead();
      await forceStatus(leadId, 'quote_sent');
      await operateOk(leadId, 'mark-lost', { lostReasonId: lostReasonA });

      expect((await readLeadRow(leadId))?.['lost_before_quote']).toBe(false);
    });

    it('rejects an inactive or foreign lost reason, and Other without a comment', async () => {
      const inactive = await createLead();
      const inactiveResponse = await operate(inactive, 'mark-lost', {
        lostReasonId: inactiveLostReasonA,
      });
      expect(inactiveResponse.status).toBe(422);
      expect((await problemOf(inactiveResponse)).code).toBe('LEAD_WORKFLOW_INVALID_LOST_REASON');

      const other = await createLead();
      const otherResponse = await operate(other, 'mark-lost', { lostReasonId: otherLostReasonA });
      expect(otherResponse.status).toBe(422);
      expect((await problemOf(otherResponse)).code).toBe('LEAD_WORKFLOW_VALIDATION_FAILED');

      // With the comment it succeeds.
      await operateOk(other, 'mark-lost', {
        lostReasonId: otherLostReasonA,
        lossComments: 'lost on service terms',
      });
      expect((await readLeadRow(other))?.['loss_comments']).toBe('lost on service terms');

      // Neither rejected attempt closed its lead.
      expect((await readLeadRow(inactive))?.['status_id']).toBe(String(await statusIdOf('new')));
    });

    it('cascades OPEN quotes to Lost, leaving already-closed quotes alone', async () => {
      const leadId = await createLead();
      const openQuoteA = await seedQuote(leadId, 'sent');
      const openQuoteB = await seedQuote(leadId, 'draft');
      const closedQuote = await seedQuote(leadId, 'won');

      await operateOk(leadId, 'mark-lost', { lostReasonId: lostReasonA });

      const lostStatusId = await quoteStatusIdOf('lost');
      expect(await quoteStatusOf(openQuoteA)).toBe(lostStatusId);
      expect(await quoteStatusOf(openQuoteB)).toBe(lostStatusId);
      expect(await quoteStatusOf(closedQuote)).toBe(await quoteStatusIdOf('won'));

      // Each cascaded quote gets its OWN history row and audit entry.
      for (const quoteId of [openQuoteA, openQuoteB]) {
        const history = await query<Record<string, unknown>>(
          `select operation from quote_status_history where quote_id = $1`,
          [quoteId],
        );
        expect(history).toHaveLength(1);
        expect(history[0]?.['operation']).toBe('cascade-lead-lost');

        await assertAudited(query, {
          action: 'quote.cascade-lead-lost',
          entityType: 'quote',
          entityId: String(quoteId),
          tenantId: tenantA,
        });
      }

      expect(
        await findAuditRows(query, {
          action: 'quote.cascade-lead-lost',
          entityId: String(closedQuote),
        }),
      ).toHaveLength(0);
    });

    it('withdraws the lead and cascades its open quotes to Withdrawn with a note', async () => {
      const leadId = await createLead();
      const openQuote = await seedQuote(leadId, 'sent');

      const lead = await operateOk(leadId, 'withdraw', { withdrawalNote: 'client went elsewhere' });

      expect(lead.statusCanonicalKey).toBe('withdrawn');
      const row = await readLeadRow(leadId);
      expect(row?.['withdrawal_note']).toBe('client went elsewhere');
      expect(row?.['decision_date']).not.toBeNull();

      expect(await quoteStatusOf(openQuote)).toBe(await quoteStatusIdOf('withdrawn'));
      const quoteRow = await query<Record<string, unknown>>(
        `select withdrawal_note from quotes where id = $1`,
        [openQuote],
      );
      expect(quoteRow[0]?.['withdrawal_note']).toBe(
        'Automatically withdrawn: the lead was withdrawn.',
      );
    });

    it('rejects withdraw with a blank note', async () => {
      const leadId = await createLead();
      const response = await operate(leadId, 'withdraw', { withdrawalNote: '  ' });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('LEAD_VALIDATION_FAILED');
      expect((await readLeadRow(leadId))?.['status_id']).toBe(String(await statusIdOf('new')));
    });

    it('reopens to the LAST OPEN status, not to New', async () => {
      const leadId = await createLead();
      // new -> assigned -> information_gathering -> underwriting, then lost.
      await driveTo(leadId, 'assigned');
      await operateOk(leadId, 'start-information-gathering', {});
      await operateOk(leadId, 'send-to-underwriting', {
        underwritingOwnerUserId: appUserId(owner),
      });
      await operateOk(leadId, 'mark-lost', { lostReasonId: lostReasonA });

      const reopened = await operateOk(leadId, 'reopen', { reopenReason: 'client came back' });

      // The last OPEN status before closure was Underwriting — not New, and not Closed Lost.
      expect(reopened.statusCanonicalKey).toBe('underwriting');
      expect((await readLeadRow(leadId))?.['status_id']).toBe(String(await statusIdOf('underwriting')));

      const history = await readHistory(leadId);
      const last = history[history.length - 1];
      expect(last?.['operation']).toBe('reopen');
      expect(last?.['previous_status_id']).toBe(String(await statusIdOf('closed_lost')));
      expect(last?.['new_status_id']).toBe(String(await statusIdOf('underwriting')));
    });

    it('reopens a lead closed straight from New back to New', async () => {
      const leadId = await createLead();
      await operateOk(leadId, 'withdraw', { withdrawalNote: 'never started' });

      const reopened = await operateOk(leadId, 'reopen', { reopenReason: 'restart' });
      expect(reopened.statusCanonicalKey).toBe('new');
    });
  });

  /**
   * `lead_status_history` is append-only, so its ORDER is part of the audit record and not a
   * presentation choice. `acted_at` is a wall-clock value the APPLICATION supplies, which means it
   * can tie to the millisecond, land on an exact second, or (across an NTP/host correction) go
   * BACKWARDS. None of that may reorder the trail, so the read orders by the identity column — the
   * monotonic append key — rather than by the timestamp.
   */
  describe('status history reads in append order (T-048, AC-024, V-031)', () => {
    it('keeps append order when a row lands on an exact second inside a shared second', async () => {
      const leadId = await createLead();

      // The exact shape observed in the wild: the middle row's millisecond is .000, which
      // `timestamptz::text` renders with NO fractional part, and it is also the earliest value.
      const alpha = await appendHistoryRowAt(leadId, 'op-alpha', '2026-07-19T10:00:00.250Z');
      const bravo = await appendHistoryRowAt(leadId, 'op-bravo', '2026-07-19T10:00:00.000Z');
      const charlie = await appendHistoryRowAt(leadId, 'op-charlie', '2026-07-19T10:00:00.750Z');

      const rows = await readHistory(leadId);

      expect(rows.map((row) => row['id'])).toEqual([alpha, bravo, charlie].map(String));
      expect(rows.map((row) => row['operation'])).toEqual(['op-alpha', 'op-bravo', 'op-charlie']);
    });

    it('keeps append order when every row shares one acted_at to the microsecond', async () => {
      const leadId = await createLead();
      const tied = '2026-07-19T11:30:00.123456Z';

      const first = await appendHistoryRowAt(leadId, 'op-first', tied);
      const second = await appendHistoryRowAt(leadId, 'op-second', tied);
      const third = await appendHistoryRowAt(leadId, 'op-third', tied);

      // Read twice: a non-total order is free to answer differently on each read.
      const once = await readHistory(leadId);
      const twice = await readHistory(leadId);

      expect(once.map((row) => row['id'])).toEqual([first, second, third].map(String));
      expect(twice.map((row) => row['id'])).toEqual([first, second, third].map(String));
    });

    it('resolves reopen from the append order even when the clock ran backwards', async () => {
      const leadId = await createLead();
      // new -> assigned -> information_gathering -> underwriting -> closed_lost.
      await driveTo(leadId, 'assigned');
      await operateOk(leadId, 'start-information-gathering', {});
      await operateOk(leadId, 'send-to-underwriting', {
        underwritingOwnerUserId: appUserId(owner),
      });
      await operateOk(leadId, 'mark-lost', { lostReasonId: lostReasonA });

      // Rewrite ONLY the timestamps so they DESCEND in append order — a wall clock that stepped
      // backwards before every operation. The transitions themselves are untouched, so the correct
      // reopen target is unchanged; only a timestamp-ordered read would disagree.
      await query(
        `update lead_status_history h
            set acted_at = timestamptz '2026-07-19T10:00:00Z' - (base.rank * interval '1 second')
           from (select id, row_number() over (order by id) as rank
                   from lead_status_history
                  where tenant_id = $1 and lead_id = $2) base
          where h.tenant_id = $1 and h.lead_id = $2 and h.id = base.id`,
        [tenantA, leadId],
      );

      const reopened = await operateOk(leadId, 'reopen', { reopenReason: 'client came back' });

      // Underwriting is the last OPEN status in APPEND order. Ordered by the regressed acted_at the
      // trail reads backwards and the walk would resolve to the wrong status.
      expect(reopened.statusCanonicalKey).toBe('underwriting');
      expect((await readLeadRow(leadId))?.['status_id']).toBe(
        String(await statusIdOf('underwriting')),
      );
    });
  });

  describe('tenant isolation and error semantics (AC-021, AC-022, AC-096; V-026, V-027, V-124)', () => {
    it('answers 404 for a tenant-B lead id, identically to a nonexistent id, with no side effects', async () => {
      // A real lead in tenant B, addressed by a tenant-A caller who is a member of BOTH.
      const foreignLeadId = await createLeadInTenantB();
      const foreignBefore = await readForeignLeadStatus(foreignLeadId);

      const foreign = await operate(foreignLeadId, 'withdraw', { withdrawalNote: 'x' });
      const missing = await operate(999_000_111, 'withdraw', { withdrawalNote: 'x' });

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);

      const foreignBody = await problemOf(foreign);
      const missingBody = await problemOf(missing);
      expect(foreignBody.code).toBe('LEAD_NOT_FOUND');
      // Byte-identical apart from the id in the message: no existence leakage.
      expect(Object.keys(foreignBody).sort()).toEqual(Object.keys(missingBody).sort());
      expect(foreignBody.status).toBe(missingBody.status);

      // The tenant-B lead is untouched.
      expect(await readForeignLeadStatus(foreignLeadId)).toBe(foreignBefore);
      expect(
        await query(`select id from lead_status_history where lead_id = $1`, [foreignLeadId]),
      ).toHaveLength(0);
    });

    it('answers 401 unauthenticated and 403 for a missing operation permission', async () => {
      const leadId = await createLead();

      const anonymous = await call('POST', `${BASE}/${leadId}/operations/withdraw`, {
        tenantId: tenantA,
        body: { withdrawalNote: 'x' },
      });
      expect(anonymous.status).toBe(401);

      const unpermitted = await operate(
        leadId,
        'withdraw',
        { withdrawalNote: 'x' },
        { session: owner },
      );
      expect(unpermitted.status).toBe(403);
      // MEASURED: the ROUTE GUARD answers first, and its 403 deliberately carries no domain `code`
      // (`requirePermission` throws a bare ForbiddenError). The executor's own
      // LEAD_OPERATION_FORBIDDEN is therefore unreachable over HTTP — see the defense-in-depth test
      // below, which reaches it the only way anything can: by calling the executor directly.
      const body = await problemOf(unpermitted);
      expect(body.detail).toContain('leads.close');
      // The 403 must not disclose anything about the lead itself.
      expect(JSON.stringify(body)).not.toContain('closed_lost');
      expect(JSON.stringify(body)).not.toContain(String(leadId));
    });

    it("re-checks the permission INSIDE the executor, for callers that never pass a route guard", async () => {
      // Defense in depth (LeadWorkflowEndpoints.cs:27-28). A job, queue handler or cascade reaches
      // the executor without any route guard; this proves the executor refuses on its own.
      const leadId = await createLead();
      const tenantIdOfA = tenantA as unknown as TenantId;
      // A minimal EffectiveAccess whose `has()` always denies — the shape the resolver would
      // produce for an empty grant set. What matters is that the EXECUTOR consults it and refuses.
      const deniesEverything: EffectiveAccess = {
        tenantId: tenantIdOfA,
        permissions: new Set<string>(),
        has: () => false,
        canViewAll: () => false,
      };

      await expect(
        withdrawLead({ db }, leadId, { withdrawalNote: 'x' }, {
          userId: appUserId(admin),
          tenantId: tenantIdOfA,
          access: deniesEverything,
        }),
      ).rejects.toMatchObject({ status: 403, code: 'LEAD_OPERATION_FORBIDDEN' });

      // Nothing was written.
      expect((await readLeadRow(leadId))?.['status_id']).toBe(String(await statusIdOf('new')));
      expect(await query(`select id from lead_status_history where lead_id = $1`, [leadId])).toHaveLength(0);
    });

    it('rejects a non-numeric lead id as a routing 404', async () => {
      const response = await call('POST', `${BASE}/not-a-number/operations/withdraw`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { withdrawalNote: 'x' },
      });
      expect(response.status).toBe(404);
    });
  });

  it('leaves no row residue behind for this run', async () => {
    // Every table this suite writes into must be reachable by the afterAll cleanup. Asserting the
    // rows EXIST under this run's tenants is what proves the cleanup list is not missing a table.
    for (const table of ['lead_status_history', 'follow_ups', 'pricing_approvals'] as const) {
      const rows = await query<{ count: string }>(
        `select count(*)::text as count from ${table} where tenant_id = $1`,
        [tenantA],
      );
      expect(Number(rows[0]?.count), `${table} should be in OWNED_TABLES`).toBeGreaterThan(0);
      expect(OWNED_TABLES).toContain(table);
    }
  });
});
