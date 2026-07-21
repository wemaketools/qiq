/**
 * Quotes end to end: creation, versioning, the seven operations, the cascades, the closed-record
 * correction path and the high-value pricing gate (T-026; AC-021, AC-022, AC-024, AC-049, AC-050,
 * AC-052..AC-055, AC-096; V-026, V-027, V-031, V-063, V-064, V-067..V-070, V-124).
 *
 * Same composed-system harness as `lead-workflow.test.ts`: real sessions, real tenants/partitions,
 * real grants, the real Hono pipeline via `app.request`. Nothing is stubbed — legality, tenant
 * isolation, the per-operation permission map, the version invariant and the append-only history
 * are properties of the composed system, not of any one function.
 *
 * EVERY REJECTION ASSERTS ITS CODE, NOT MERELY ITS STATUS
 * ======================================================
 * This suite rejects a great many calls and almost all of them answer 409 or 422. A status-only
 * assertion cannot tell a correct rejection from an accidental one — an illegal-transition 409, a
 * draft-only-edit 409 and a closed-lead-create 409 are indistinguishable by status, and so are a
 * missing valid-until 422 and the pricing gate's 422. So every negative case names the `code` it
 * expects, and the illegal-transition cases additionally pin the legal-operation hint.
 *
 * THE PRICING GATE'S "NOTHING PERSISTS" IS ASSERTED AS THREE ABSENCES, NOT AS A STATUS
 * ===================================================================================
 * AC-049/V-063 require that a gated Send changes nothing. A 422 alone would also be returned by an
 * implementation that wrote the quote's sent_date and then rolled back only partially, so the gate
 * test digests the quote row, counts the history rows and counts the audit rows before and after.
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
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('quote-workflow', probe);

const LEADS = '/api/v1/leads';
const QUOTES = '/api/v1/quotes';

interface QuoteVersionDto {
  readonly id: number;
  readonly versionNo: number;
  readonly quotedPremium: number;
  readonly termsNotes: string | null;
  readonly revisionNote: string | null;
  readonly isCurrent: boolean;
}

interface QuoteDto {
  readonly id: number;
  readonly quoteRef: string;
  readonly leadId: number;
  readonly statusId: number;
  readonly statusCanonicalKey: string | null;
  readonly isCurrent: boolean;
  readonly productLineId: number;
  readonly coverTypeId: number;
  readonly preparedDate: string;
  readonly sentDate: string | null;
  readonly validUntil: string | null;
  readonly boundPremium: number | null;
  readonly notes: string | null;
  readonly versions: QuoteVersionDto[];
  readonly history: { operation: string }[];
  readonly availableOperations: string[];
}

interface QuoteListItemDto {
  readonly id: number;
  readonly quoteRef: string;
  readonly isCurrent: boolean;
  readonly currentQuotedPremium: number;
}

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly availableOperations?: readonly string[];
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

/** Deliberately SHORT — a long shared token dominates trigram similarity on party names. */
const RUN = `t026-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
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

function daysFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
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

  /** Holds every lead + quote grant in BOTH tenants, including `quotes.correct_closed`. */
  let admin: TestUserSession;
  /** Holds the RM role (eligible assignee) and the view/update grants, but NOT correct_closed. */
  let editor: TestUserSession;
  /** Holds `quotes.view` only — the availableOperations permission-profile fixture. */
  let viewer: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  let rmRoleId = 0;
  let rmSlotA = 0;

  const createdTenants: number[] = [];

  const OWNED_TABLES = [
    'follow_ups',
    'pricing_approvals',
    'quote_status_history',
    'quote_assignments',
    'quote_versions',
    'quotes',
    'lead_status_history',
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
      "select id::text as id from tenants where name like 't026-%'",
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

  /**
   * `require_pricing_approval_for_high_value` starts FALSE and `high_value_threshold` at 100000.
   * The gate suite flips the switch on and off with direct SQL, so the default state proves the
   * ungated path first.
   */
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

  async function setGate(tenantId: number, enabled: boolean, threshold: number): Promise<void> {
    await query(
      `update tenant_settings
          set require_pricing_approval_for_high_value = $2, high_value_threshold = $3
        where tenant_id = $1`,
      [tenantId, enabled, String(threshold)],
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
      quotes: { db },
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
  let otherProductLineA = 0;
  let otherCoverTypeA = 0;
  let partyA = 0;
  let lostReasonA = 0;
  let otherLostReasonA = 0;

  // Tenant B, for the isolation cases.
  let partyTypeB = 0;
  let regionB = 0;
  let channelB = 0;
  let productLineB = 0;
  let coverTypeB = 0;
  let partyB = 0;

  function leadBody(tenant: 'A' | 'B', overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const a = tenant === 'A';
    return {
      partyId: a ? partyA : partyB,
      isExistingClient: true,
      dateReceived: yesterday(),
      requestChannelId: a ? channelA : channelB,
      brokerId: null,
      ownerUserId: appUserId(admin),
      regionId: a ? regionA : regionB,
      externalRef: null,
      productLineId: a ? productLineA : productLineB,
      coverTypeId: a ? coverTypeA : coverTypeB,
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

  /**
   * Moves a lead New -> Assigned through its own operation.
   *
   * Needed by anything that depends on the quote-creation Pricing cascade or the lead's pricing
   * sub-workflow, because start-pricing (and therefore the cascade) is illegal from New.
   */
  async function assignLead(leadId: number): Promise<void> {
    const response = await call('POST', `${LEADS}/${leadId}/operations/assign`, {
      token: admin.accessToken,
      tenantId: tenantA,
      body: { assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(admin) }] },
    });
    expect(response.status, 'lead assign should have succeeded').toBe(200);
  }

  async function createLead(tenant: 'A' | 'B' = 'A'): Promise<number> {
    const response = await call('POST', LEADS, {
      token: admin.accessToken,
      tenantId: tenant === 'A' ? tenantA : tenantB,
      body: leadBody(tenant),
    });
    expect(response.status).toBe(201);
    const outcome = (await response.json()) as { lead: { id: number } | null };
    return outcome.lead?.id ?? 0;
  }

  async function createQuote(
    leadId: number,
    body: Record<string, unknown> = {},
    options: { session?: TestUserSession; tenantId?: number } = {},
  ): Promise<Response> {
    return await call('POST', `${LEADS}/${leadId}/quotes`, {
      token: (options.session ?? admin).accessToken,
      tenantId: options.tenantId ?? tenantA,
      body: { quotedPremium: 5000, ...body },
    });
  }

  async function createQuoteOk(
    leadId: number,
    body: Record<string, unknown> = {},
  ): Promise<QuoteDto> {
    const response = await createQuote(leadId, body);
    expect(response.status, 'quote creation should have succeeded').toBe(201);
    return (await response.json()) as QuoteDto;
  }

  async function getQuote(
    quoteId: number,
    session: TestUserSession = admin,
  ): Promise<QuoteDto> {
    const response = await call('GET', `${QUOTES}/${quoteId}`, {
      token: session.accessToken,
      tenantId: tenantA,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as QuoteDto;
  }

  /** POSTs a quote operation. `set-current` lives on its own path — see routes.ts. */
  async function operate(
    quoteId: number,
    op: string,
    body: unknown = {},
    options: { session?: TestUserSession; tenantId?: number } = {},
  ): Promise<Response> {
    const path =
      op === 'set-current'
        ? `${QUOTES}/${quoteId}/set-current`
        : `${QUOTES}/${quoteId}/operations/${op}`;
    return await call('POST', path, {
      token: (options.session ?? admin).accessToken,
      tenantId: options.tenantId ?? tenantA,
      body,
    });
  }

  async function operateOk(quoteId: number, op: string, body: unknown = {}): Promise<QuoteDto> {
    const response = await operate(quoteId, op, body);
    expect(response.status, `${op} should have succeeded`).toBe(200);
    return (await response.json()) as QuoteDto;
  }

  async function problemOf(response: Response): Promise<ProblemBody> {
    return (await response.json()) as ProblemBody;
  }

  /** The quote's raw columns — the side-effect check the API response cannot fake. */
  async function readQuoteRow(id: number): Promise<Record<string, unknown> | undefined> {
    const rows = await query<Record<string, unknown>>(
      `select status_id::text as status_id, is_current, sent_date::text as sent_date,
              valid_until::text as valid_until, decision_date::text as decision_date,
              bound_premium::text as bound_premium, lost_reason_id::text as lost_reason_id,
              competitor, loss_comments, withdrawal_note, notes,
              product_line_id::text as product_line_id, prepared_date::text as prepared_date
         from quotes where id = $1`,
      [id],
    );
    return rows[0];
  }

  async function readVersions(quoteId: number): Promise<Record<string, unknown>[]> {
    return await query<Record<string, unknown>>(
      `select id::text as id, version_no, quoted_premium::text as quoted_premium, terms_notes,
              revision_note, is_current
         from quote_versions where quote_id = $1 order by version_no`,
      [quoteId],
    );
  }

  async function countCurrentVersions(quoteId: number): Promise<number> {
    const rows = await query<{ count: string }>(
      `select count(*)::text as count from quote_versions where quote_id = $1 and is_current`,
      [quoteId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  async function readQuoteHistory(quoteId: number): Promise<Record<string, unknown>[]> {
    return await query<Record<string, unknown>>(
      // ORDER BY is QUALIFIED, and orders by `id` alone to match production (T-048). A bare
      // `order by id` here would resolve to the `id::text as id` OUTPUT ALIAS in preference to the
      // real bigint column — Postgres prefers the alias — making the tie-break a TEXT sort, where
      // '10' precedes '9'. That is precisely the defect T-048 fixed; this helper landed after its
      // scan, so it reintroduced the mechanism rather than surviving it.
      `select id::text as id, operation, previous_status_id::text as previous_status_id,
              new_status_id::text as new_status_id, acted_by::text as acted_by, inputs
         from quote_status_history where quote_id = $1 order by quote_status_history.id`,
      [quoteId],
    );
  }

  async function readLeadRow(id: number): Promise<Record<string, unknown> | undefined> {
    const rows = await query<Record<string, unknown>>(
      `select status_id::text as status_id, pricing_approval_state,
              decision_date::text as decision_date, lost_reason_id::text as lost_reason_id,
              lost_before_quote, last_follow_up_date::text as last_follow_up_date,
              next_follow_up_date::text as next_follow_up_date, follow_up_count,
              last_activity_at::text as last_activity_at
         from leads where id = $1`,
      [id],
    );
    return rows[0];
  }

  async function quoteStatusIdOf(canonicalKey: string, tenantId = tenantA): Promise<number> {
    const rows = await query<{ id: string }>(
      `select id::text as id from reference_items
        where tenant_id = $1 and list_type = 'quote_status' and canonical_key = $2`,
      [tenantId, canonicalKey],
    );
    return Number(rows[0]?.id);
  }

  async function leadStatusIdOf(canonicalKey: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `select id::text as id from reference_items
        where tenant_id = $1 and list_type = 'lead_status' and canonical_key = $2`,
      [tenantA, canonicalKey],
    );
    return Number(rows[0]?.id);
  }

  /** Drives a quote to Sent through the only legal path, so no fixture SQL fakes the state. */
  async function sentQuote(leadId: number, premium = 5000): Promise<QuoteDto> {
    const quote = await createQuoteOk(leadId, { quotedPremium: premium });
    await operateOk(quote.id, 'send', {
      validUntil: daysFromNow(30),
      nextFollowUpDate: daysFromNow(7),
    });
    return await getQuote(quote.id);
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

    admin = await auth.createTestUserWithSession({ label: 'q-admin' });
    editor = await auth.createTestUserWithSession({ label: 'q-editor' });
    viewer = await auth.createTestUserWithSession({ label: 'q-viewer' });

    for (const session of [admin, editor, viewer]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(admin), tenantB);

    const LEAD_GRANTS = [
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
    ] as const;

    const QUOTE_GRANTS = [
      'quotes.create',
      'quotes.view',
      'quotes.view_all',
      'quotes.update',
      'quotes.revise',
      'quotes.mark_sent',
      'quotes.close_won',
      'quotes.close_lost',
      'quotes.assign',
      'quotes.withdraw',
      'quotes.set_current',
      'quotes.correct_closed',
    ] as const;

    for (const permission of [...LEAD_GRANTS, ...QUOTE_GRANTS]) {
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantA);
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantB);
    }

    // The editor holds everything the admin does EXCEPT `quotes.correct_closed` — the discriminator
    // for the closed-record correction gate.
    for (const permission of [...LEAD_GRANTS, ...QUOTE_GRANTS.filter((p) => p !== 'quotes.correct_closed')]) {
      await fixtures.grantDirectPermission(appUserId(editor), permission, tenantA);
    }

    await fixtures.grantDirectPermission(appUserId(viewer), 'quotes.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(viewer), 'leads.view', tenantA);

    rmRoleId = await fixtures.createRole({ tenantId: tenantA });
    await fixtures.assignRole(appUserId(admin), rmRoleId, tenantA);
    await fixtures.assignRole(appUserId(editor), rmRoleId, tenantA);
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
    otherProductLineA = await seedRef(tenantA, 'product_line', uniqueName('Marine A'));
    otherCoverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Hull A'), {
      productLineId: otherProductLineA,
    });

    for (const [key, category] of [
      ['new', 'open'],
      ['assigned', 'open'],
      ['information_gathering', 'open'],
      ['underwriting', 'open'],
      ['pricing', 'open'],
      ['quote_sent', 'quoted'],
      ['negotiation', 'quoted'],
      ['closed_won', 'won'],
      ['closed_lost', 'lost'],
      ['expired', 'expired'],
      ['withdrawn', 'withdrawn'],
    ] as const) {
      await seedRef(tenantA, 'lead_status', uniqueName(`${key} A`), {
        reportingCategory: category,
        canonicalKey: key,
        isTerminal: category !== 'open' && category !== 'quoted',
      });
    }

    for (const [key, category] of [
      ['draft', 'open'],
      ['sent', 'quoted'],
      ['revised', 'quoted'],
      ['won', 'won'],
      ['lost', 'lost'],
      ['expired', 'expired'],
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

    partyA = await seedParty(tenantA, `Acme ${RUN}`, partyTypeA);

    // Tenant B: the isolation fixture set.
    partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('Corp B'));
    regionB = await seedRef(tenantB, 'region', uniqueName('North B'));
    channelB = await seedRef(tenantB, 'request_channel', uniqueName('Email B'));
    productLineB = await seedRef(tenantB, 'product_line', uniqueName('Motor B'));
    coverTypeB = await seedRef(tenantB, 'cover_type', uniqueName('Comp B'), {
      productLineId: productLineB,
    });
    for (const [key, category] of [
      ['new', 'open'],
      ['pricing', 'open'],
      ['quote_sent', 'quoted'],
    ] as const) {
      await seedRef(tenantB, 'lead_status', uniqueName(`${key} B`), {
        reportingCategory: category,
        canonicalKey: key,
      });
    }
    await seedRef(tenantB, 'quote_status', uniqueName('q-draft B'), {
      reportingCategory: 'open',
      canonicalKey: 'draft',
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

  // -------------------------------------------------------------------------------------------
  // Creation: lead-subordinate, versioned, cascading (AC-052, V-067).
  // -------------------------------------------------------------------------------------------

  describe('creation is lead-subordinate (AC-052, V-067)', () => {
    it('creates a Draft version-1 quote under a lead and returns 201 with a Location header', async () => {
      const leadId = await createLead();
      const response = await createQuote(leadId, { quotedPremium: 1234.56 });

      expect(response.status).toBe(201);
      const quote = (await response.json()) as QuoteDto;
      expect(response.headers.get('location')).toBe(`/api/v1/quotes/${String(quote.id)}`);

      expect(quote.leadId).toBe(leadId);
      expect(quote.statusCanonicalKey).toBe('draft');
      expect(quote.quoteRef).toMatch(/^Q-\d{4}-\d{4}$/);
      expect(quote.versions).toHaveLength(1);
      expect(quote.versions[0]).toMatchObject({ versionNo: 1, quotedPremium: 1234.56, isCurrent: true });
    });

    it('has NO standalone quote-create route (route-table assertion)', async () => {
      // AC-052's "no standalone create". Asserted against the COMPOSED app, not against routes.ts
      // source: a route added anywhere in the pipeline would be caught here.
      const response = await call('POST', QUOTES, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { leadId: 1, quotedPremium: 100 },
      });
      expect(response.status).toBe(404);
    });

    it('marks the lead FK on every created quote and keeps it in the same tenant', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const rows = await query<{ lead_id: string; tenant_id: string }>(
        'select lead_id::text as lead_id, tenant_id::text as tenant_id from quotes where id = $1',
        [quote.id],
      );
      expect(rows[0]?.lead_id).toBe(String(leadId));
      expect(rows[0]?.tenant_id).toBe(String(tenantA));
    });

    it('accepts multiple quotes on one lead, and only the FIRST is marked current', async () => {
      const leadId = await createLead();
      const first = await createQuoteOk(leadId, { quotedPremium: 1000 });
      const second = await createQuoteOk(leadId, { quotedPremium: 2000 });

      expect(first.isCurrent).toBe(true);
      expect((await getQuote(second.id)).isCurrent).toBe(false);

      const listResponse = await call('GET', `${LEADS}/${leadId}/quotes`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(listResponse.status).toBe(200);
      const list = (await listResponse.json()) as QuoteListItemDto[];

      // A BARE ARRAY, not `{ items, totalCount }` — the measured envelope (QuoteEndpoints.cs:60-65).
      expect(Array.isArray(list)).toBe(true);
      expect(list.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
      expect(list.find((row) => row.id === second.id)?.currentQuotedPremium).toBe(2000);
    });

    it('cascades an ASSIGNED lead to Pricing on quote creation, and is a no-op afterwards', async () => {
      const leadId = await createLead();
      await assignLead(leadId);
      expect((await readLeadRow(leadId))?.['status_id']).toBe(
        String(await leadStatusIdOf('assigned')),
      );

      await createQuoteOk(leadId);
      expect((await readLeadRow(leadId))?.['status_id']).toBe(
        String(await leadStatusIdOf('pricing')),
      );

      // A second quote leaves the lead where it is — the cascade is guarded by the LEAD matrix's
      // own start-pricing legality, which is illegal FROM Pricing.
      await createQuoteOk(leadId);
      expect((await readLeadRow(leadId))?.['status_id']).toBe(
        String(await leadStatusIdOf('pricing')),
      );
    });

    it('does NOT cascade a NEW lead to Pricing — start-pricing is illegal from New', async () => {
      // MEASURED, and counter-intuitive enough to pin explicitly: `MoveLeadToPricingIfPreQuotingAsync`
      // guards on `LeadWorkflow.IsLegal(StartPricing, ...)`, and the lead matrix allows start-pricing
      // only from Assigned / Information Gathering / Underwriting (LeadWorkflow.cs:104-109). So a
      // quote raised against a brand-new, unassigned lead leaves that lead in New. The naive reading
      // of "pre-Pricing lead moves to Pricing" would have this cascade and it does not.
      const leadId = await createLead();
      expect((await readLeadRow(leadId))?.['status_id']).toBe(String(await leadStatusIdOf('new')));

      await createQuoteOk(leadId);
      expect((await readLeadRow(leadId))?.['status_id']).toBe(String(await leadStatusIdOf('new')));
    });

    it('defaults product line and cover type from the lead when omitted', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      expect(quote.productLineId).toBe(productLineA);
      expect(quote.coverTypeId).toBe(coverTypeA);
    });

    it('accepts an explicit product line / cover type pair', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId, {
        productLineId: otherProductLineA,
        coverTypeId: otherCoverTypeA,
      });
      expect(quote.productLineId).toBe(otherProductLineA);
    });

    it('rejects a cover type belonging to a different product line with 422 QUOTE_INVALID_COVER_TYPE', async () => {
      const leadId = await createLead();
      const response = await createQuote(leadId, {
        productLineId: productLineA,
        coverTypeId: otherCoverTypeA,
      });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('QUOTE_INVALID_COVER_TYPE');
    });

    it('rejects a prepared date preceding the lead date received with 422 QUOTE_VALIDATION_FAILED', async () => {
      const leadId = await createLead();
      const response = await createQuote(leadId, { preparedDate: '2000-01-01' });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('QUOTE_VALIDATION_FAILED');
    });

    it('rejects a non-positive quoted premium with 422 carrying errors[{field,code,message}] (AC-096)', async () => {
      const leadId = await createLead();
      const response = await createQuote(leadId, { quotedPremium: 0 });
      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe('QUOTE_VALIDATION_FAILED');
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'quotedPremium',
            code: 'QUOTE_MUST_BE_GREATER_THAN_ZERO',
          }),
        ]),
      );
    });

    it('rejects creation under a CLOSED lead with 409 QUOTE_LEAD_CLOSED_CANNOT_CREATE', async () => {
      const leadId = await createLead();
      // Closed via the lead's own withdraw operation — a real transition, not fixture SQL.
      const withdrawn = await call('POST', `${LEADS}/${leadId}/operations/withdraw`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { withdrawalNote: 'no longer required' },
      });
      expect(withdrawn.status).toBe(200);

      const response = await createQuote(leadId);
      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe('QUOTE_LEAD_CLOSED_CANNOT_CREATE');
    });

    it('writes exactly one quote.created audit row with the creation payload (AC-024, V-031)', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId, { quotedPremium: 777 });

      await assertAudited(query, {
        action: 'quote.created',
        entityType: 'quote',
        entityId: String(quote.id),
        actorUserId: appUserId(admin),
        tenantId: tenantA,
        before: null,
        after: {
          quoteRef: quote.quoteRef,
          leadId,
          productLineId: productLineA,
          coverTypeId: coverTypeA,
          quotedPremium: 777,
        },
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Versioning (AC-053, V-068).
  // -------------------------------------------------------------------------------------------

  describe('versioning with a single current version (AC-053, V-068)', () => {
    it('allows a Draft quote to be edited in place, rewriting the current version premium', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId, { quotedPremium: 1000 });

      const response = await call('PUT', `${QUOTES}/${quote.id}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: {
          productLineId: productLineA,
          coverTypeId: coverTypeA,
          quotedPremium: 1500,
          preparedDate: todayIso(),
          validUntil: daysFromNow(20),
          notes: 'revised while draft',
        },
      });
      expect(response.status).toBe(200);

      const versions = await readVersions(quote.id);
      // Edited IN PLACE: still one version, not a new one. Minting is Revise's job.
      expect(versions).toHaveLength(1);
      expect(versions[0]?.['quoted_premium']).toBe('1500.00');
      expect((await readQuoteRow(quote.id))?.['notes']).toBe('revised while draft');
    });

    it('rejects a direct edit of a SENT quote with 409 QUOTE_DRAFT_EDIT_ONLY', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);

      const response = await call('PUT', `${QUOTES}/${quote.id}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: {
          productLineId: productLineA,
          coverTypeId: coverTypeA,
          quotedPremium: 9999,
          preparedDate: todayIso(),
          validUntil: null,
          notes: null,
        },
      });
      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe('QUOTE_DRAFT_EDIT_ONLY');

      // And nothing moved.
      const versions = await readVersions(quote.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]?.['quoted_premium']).toBe('5000.00');
    });

    it('revise mints a new current version, preserves the prior one byte-identical, and moves the quote to Revised', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId, 4000);
      const before = await readVersions(quote.id);
      const priorDigest = JSON.stringify(before[0]);

      const revised = await operateOk(quote.id, 'revise', {
        newQuotedPremium: 4500,
        termsNotes: 'extended cover',
        revisionNote: 'client negotiated',
      });

      expect(revised.statusCanonicalKey).toBe('revised');

      const after = await readVersions(quote.id);
      expect(after).toHaveLength(2);

      // The prior version is preserved EXCEPT for its is_current demotion — asserted as a digest of
      // everything else, so a silent premium or note rewrite would fail here.
      expect(JSON.stringify({ ...after[0], is_current: true })).toBe(priorDigest);
      expect(after[0]?.['is_current']).toBe(false);

      expect(after[1]).toMatchObject({
        version_no: 2,
        quoted_premium: '4500.00',
        terms_notes: 'extended cover',
        revision_note: 'client negotiated',
        is_current: true,
      });
    });

    it('inherits the prior premium when revise supplies terms only', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId, 3300);

      await operateOk(quote.id, 'revise', {
        termsNotes: 'terms only change',
        revisionNote: 'wording update',
      });

      const versions = await readVersions(quote.id);
      expect(versions[1]?.['quoted_premium']).toBe('3300.00');
    });

    it('rejects revise with neither a premium nor terms notes (422)', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);

      const response = await operate(quote.id, 'revise', { revisionNote: 'nothing changed' });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('QUOTE_VALIDATION_FAILED');
    });

    it('holds exactly one current version after every mutation, DB-verified', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId, { quotedPremium: 100 });
      expect(await countCurrentVersions(quote.id)).toBe(1);

      await operateOk(quote.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(3),
      });
      expect(await countCurrentVersions(quote.id)).toBe(1);

      await operateOk(quote.id, 'revise', { newQuotedPremium: 200, revisionNote: 'r1' });
      expect(await countCurrentVersions(quote.id)).toBe(1);
    });

    it('has a DATABASE guarantee of one current version per quote, not merely application logic', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      // `uq_quote_versions_current` (T-005). Proven by trying to write the wrong state DIRECTLY,
      // bypassing every application code path — the only way to show the guard is real.
      //
      // The message names the PARTITION's propagated index (`quote_versions_p<n>_tenant_id_quote_id_idx`),
      // not the parent's `uq_quote_versions_current`: Postgres generates a fresh name per partition
      // when propagating a unique index from a partitioned parent. Matching the column shape is
      // therefore the honest assertion — it still pins WHICH uniqueness rule fired, which is the
      // part that matters, and it would not be satisfied by any other index on this table.
      await expect(
        query(
          `insert into quote_versions
             (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
           values ($1, $2, 99, 1, true, now())`,
          [tenantA, quote.id],
        ),
      ).rejects.toThrow(/duplicate key value violates unique constraint "quote_versions_p\d+_tenant_id_quote_id_idx/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The one-current-QUOTE invariant this task adds (scope amendment).
  // -------------------------------------------------------------------------------------------

  describe('one current quote per lead (uq_quotes_current, T-026 scope amendment)', () => {
    it('set-current promotes this quote and demotes the incumbent', async () => {
      const leadId = await createLead();
      const first = await createQuoteOk(leadId);
      const second = await createQuoteOk(leadId);

      await operateOk(second.id, 'set-current');

      expect((await readQuoteRow(first.id))?.['is_current']).toBe(false);
      expect((await readQuoteRow(second.id))?.['is_current']).toBe(true);
    });

    it('leaves the quote status untouched (set-current is a marker, not a transition)', async () => {
      const leadId = await createLead();
      const first = await createQuoteOk(leadId);
      const second = await sentQuote(leadId);

      const before = (await readQuoteRow(second.id))?.['status_id'];
      await operateOk(second.id, 'set-current');
      expect((await readQuoteRow(second.id))?.['status_id']).toBe(before);
      expect((await readQuoteRow(first.id))?.['is_current']).toBe(false);
    });

    it('has a DATABASE guarantee of one current quote per lead, not merely application logic', async () => {
      const leadId = await createLead();
      const first = await createQuoteOk(leadId);
      const second = await createQuoteOk(leadId);

      expect((await readQuoteRow(first.id))?.['is_current']).toBe(true);
      expect((await readQuoteRow(second.id))?.['is_current']).toBe(false);

      // The new `uq_quotes_current` index (this task's migration). Written DIRECTLY so no
      // application path can be credited for the rejection — this is what closes the concurrency
      // window the reference left open. As above, the message names the partition's propagated
      // index rather than the parent's, so the column shape is what is pinned.
      await expect(
        query('update quotes set is_current = true where id = $1', [second.id]),
      ).rejects.toThrow(/duplicate key value violates unique constraint "quotes_p\d+_tenant_id_lead_id_idx/);
    });

    it('rejects set-current on a closed quote with 409 (V-049)', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      await operateOk(quote.id, 'withdraw', { withdrawalNote: 'done' });

      const response = await operate(quote.id, 'set-current');
      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe('QUOTE_ILLEGAL_TRANSITION');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Send, mark-won, mark-lost, withdraw (AC-054, V-069).
  // -------------------------------------------------------------------------------------------

  describe('send requirements (AC-054, V-069)', () => {
    it('sends a draft quote, recording sent date and valid-until', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const sent = await operateOk(quote.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(5),
      });

      expect(sent.statusCanonicalKey).toBe('sent');
      const row = await readQuoteRow(quote.id);
      expect(row?.['sent_date']).toBe(todayIso());
      expect(row?.['valid_until']).toBe(daysFromNow(30));
    });

    it('rejects send without valid-until with 422 and a field error', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const response = await operate(quote.id, 'send', { nextFollowUpDate: daysFromNow(5) });
      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe('QUOTE_VALIDATION_FAILED');
      expect(problem.errors?.some((e) => e.field === 'validUntil')).toBe(true);
    });

    it('rejects send without a next follow-up date with 422 and a field error', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const response = await operate(quote.id, 'send', { validUntil: daysFromNow(30) });
      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.errors?.some((e) => e.field === 'nextFollowUpDate')).toBe(true);
    });

    it('rejects valid-until on or before the sent date with 422 QUOTE_WORKFLOW_VALIDATION_FAILED', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      // Equal, not merely earlier: the rule is strictly greater-than.
      const response = await operate(quote.id, 'send', {
        sentDate: todayIso(),
        validUntil: todayIso(),
        nextFollowUpDate: daysFromNow(5),
      });
      expect(response.status).toBe(422);
      // A DIFFERENT code from the shape-level 422 above, which is the whole point of asserting codes:
      // this rule needs the defaulted sent date, so it lives in the handler, not the schema.
      expect((await problemOf(response)).code).toBe('QUOTE_WORKFLOW_VALIDATION_FAILED');
    });

    it('moves the lead to Quote Sent on the FIRST send and logs the follow-up', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      await operateOk(quote.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(9),
      });

      const lead = await readLeadRow(leadId);
      expect(lead?.['status_id']).toBe(String(await leadStatusIdOf('quote_sent')));
      expect(lead?.['next_follow_up_date']).toBe(daysFromNow(9));
      expect(lead?.['last_follow_up_date']).toBe(todayIso());
      expect(Number(lead?.['follow_up_count'])).toBe(1);

      const followUps = await query<{ outcome_note: string }>(
        'select outcome_note from follow_ups where lead_id = $1',
        [leadId],
      );
      expect(followUps).toHaveLength(1);
      expect(followUps[0]?.outcome_note).toBe(`Quote ${quote.quoteRef} sent.`);
    });

    it('does NOT re-move the lead on a subsequent send of a second quote', async () => {
      const leadId = await createLead();
      const first = await createQuoteOk(leadId);
      const second = await createQuoteOk(leadId);

      await operateOk(first.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(4),
      });
      const historyAfterFirst = await query<{ count: string }>(
        `select count(*)::text as count from lead_status_history
          where lead_id = $1 and operation = 'quote-sent-first-send'`,
        [leadId],
      );
      expect(Number(historyAfterFirst[0]?.count)).toBe(1);

      await operateOk(second.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(4),
      });
      const historyAfterSecond = await query<{ count: string }>(
        `select count(*)::text as count from lead_status_history
          where lead_id = $1 and operation = 'quote-sent-first-send'`,
        [leadId],
      );
      // Still ONE: the second send is not the first send.
      expect(Number(historyAfterSecond[0]?.count)).toBe(1);
    });

    it('rejects send from a Sent quote with 409 and the legal-operation hint (AC-096)', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);

      const response = await operate(quote.id, 'send', {
        validUntil: daysFromNow(40),
        nextFollowUpDate: daysFromNow(5),
      });
      expect(response.status).toBe(409);
      const problem = await problemOf(response);
      expect(problem.code).toBe('QUOTE_ILLEGAL_TRANSITION');
      expect(problem.availableOperations).toEqual([
        'assign',
        'revise',
        'mark-won',
        'mark-lost',
        'withdraw',
        'set-current',
      ]);
    });

    it('rejects send from a REVISED quote (the reference-resolved V-046 conflict)', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);
      await operateOk(quote.id, 'revise', { newQuotedPremium: 6000, revisionNote: 'r' });

      const response = await operate(quote.id, 'send', {
        validUntil: daysFromNow(40),
        nextFollowUpDate: daysFromNow(5),
      });
      expect(response.status).toBe(409);
      expect((await problemOf(response)).availableOperations).not.toContain('send');
    });
  });

  describe('mark-won cascades (AC-054, V-069)', () => {
    it('transitions the quote to Won, withdraws open siblings, and moves the lead to Closed Won', async () => {
      const leadId = await createLead();
      const winner = await sentQuote(leadId, 8000);
      const siblingOpen = await createQuoteOk(leadId, { quotedPremium: 7000 });
      const siblingSent = await sentQuote(leadId, 7500);

      const won = await operateOk(winner.id, 'mark-won', { boundPremium: 8100 });

      expect(won.statusCanonicalKey).toBe('won');
      expect((await readQuoteRow(winner.id))?.['bound_premium']).toBe('8100.00');

      const withdrawnId = String(await quoteStatusIdOf('withdrawn'));
      for (const sibling of [siblingOpen, siblingSent]) {
        const row = await readQuoteRow(sibling.id);
        expect(row?.['status_id'], `sibling ${sibling.id} should be withdrawn`).toBe(withdrawnId);
        expect(row?.['withdrawal_note']).toBe(
          'Automatically withdrawn: another quote on this lead was marked won.',
        );
      }

      const lead = await readLeadRow(leadId);
      expect(lead?.['status_id']).toBe(String(await leadStatusIdOf('closed_won')));
    });

    it('defaults the bound premium to the current version premium when omitted', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId, 4321);

      await operateOk(quote.id, 'mark-won', {});
      expect((await readQuoteRow(quote.id))?.['bound_premium']).toBe('4321.00');
    });

    it('records each sibling withdrawal in that sibling own history and audit trail', async () => {
      const leadId = await createLead();
      const winner = await sentQuote(leadId, 5000);
      const sibling = await createQuoteOk(leadId, { quotedPremium: 4000 });

      await operateOk(winner.id, 'mark-won', {});

      const history = await readQuoteHistory(sibling.id);
      expect(history.map((row) => row['operation'])).toContain('withdraw-sibling-of-won');

      await assertAudited(query, {
        action: 'quote.withdrawn_sibling_of_won',
        entityType: 'quote',
        entityId: String(sibling.id),
        tenantId: tenantA,
      });
    });

    it('makes Closed Won reachable ONLY from quote mark-won: no lead operation produces it', async () => {
      const leadId = await createLead();
      await createQuoteOk(leadId);
      const lead = await call('GET', `${LEADS}/${leadId}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      const dto = (await lead.json()) as { availableOperations: string[] };

      // The lead matrix has no operation whose target is Closed Won — every offered operation is
      // driven to completion below and none of them lands there.
      const closedWonId = String(await leadStatusIdOf('closed_won'));
      expect(dto.availableOperations).not.toContain('mark-won');
      expect((await readLeadRow(leadId))?.['status_id']).not.toBe(closedWonId);
    });

    it('writes a lead-side quote-won history row and audit entry (AC-024)', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId, 2500);
      await operateOk(quote.id, 'mark-won', { boundPremium: 2600 });

      const leadHistory = await query<{ operation: string }>(
        'select operation from lead_status_history where lead_id = $1 order by acted_at, id',
        [leadId],
      );
      expect(leadHistory.map((row) => row.operation)).toContain('quote-won');

      await assertAudited(query, {
        action: 'lead.quote-won',
        entityType: 'lead',
        entityId: String(leadId),
        tenantId: tenantA,
      });
    });
  });

  describe('mark-lost and withdraw (AC-054, V-069)', () => {
    it('closes the lead as lost-after-quote when no other open quote remains', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);

      await operateOk(quote.id, 'mark-lost', { lostReasonId: lostReasonA, competitor: 'Rival Co' });

      const lead = await readLeadRow(leadId);
      expect(lead?.['status_id']).toBe(String(await leadStatusIdOf('closed_lost')));
      expect(lead?.['lost_before_quote']).toBe(false);
      expect(lead?.['lost_reason_id']).toBe(String(lostReasonA));
    });

    it('leaves the lead OPEN when another open quote remains', async () => {
      const leadId = await createLead();
      const losing = await sentQuote(leadId);
      await createQuoteOk(leadId);

      await operateOk(losing.id, 'mark-lost', { lostReasonId: lostReasonA });

      const lead = await readLeadRow(leadId);
      expect(lead?.['status_id']).not.toBe(String(await leadStatusIdOf('closed_lost')));
    });

    it('honours an explicit alsoCloseLead:false even when nothing else is open', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);

      await operateOk(quote.id, 'mark-lost', {
        lostReasonId: lostReasonA,
        alsoCloseLead: false,
      });

      expect((await readLeadRow(leadId))?.['status_id']).not.toBe(
        String(await leadStatusIdOf('closed_lost')),
      );
    });

    it("requires loss comments when the reason canonical key is 'other' (422)", async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);

      const response = await operate(quote.id, 'mark-lost', { lostReasonId: otherLostReasonA });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('QUOTE_WORKFLOW_VALIDATION_FAILED');
    });

    it('rejects an inactive or foreign lost reason with 422 QUOTE_WORKFLOW_INVALID_LOST_REASON', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);

      const response = await operate(quote.id, 'mark-lost', { lostReasonId: 999_999_999 });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('QUOTE_WORKFLOW_INVALID_LOST_REASON');
    });

    it('withdraws a draft quote and never touches the lead', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      const leadBefore = await readLeadRow(leadId);

      const withdrawn = await operateOk(quote.id, 'withdraw', { withdrawalNote: 'client paused' });

      expect(withdrawn.statusCanonicalKey).toBe('withdrawn');
      expect((await readQuoteRow(quote.id))?.['withdrawal_note']).toBe('client paused');
      expect((await readLeadRow(leadId))?.['status_id']).toBe(leadBefore?.['status_id']);
    });

    it('rejects withdraw without a note (422)', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const response = await operate(quote.id, 'withdraw', {});
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('QUOTE_VALIDATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------------------------
  // The high-value pricing gate (AC-049, V-063) — the re-scoped criterion.
  // -------------------------------------------------------------------------------------------

  describe('high-value pricing gate on Send (AC-049, V-063)', () => {
    /** Everything the gate could possibly have written, as one comparable digest. */
    async function gateDigest(quoteId: number, leadId: number): Promise<string> {
      const quote = await readQuoteRow(quoteId);
      const lead = await readLeadRow(leadId);
      const history = await query<{ count: string }>(
        'select count(*)::text as count from quote_status_history where quote_id = $1',
        [quoteId],
      );
      const audit = await query<{ count: string }>(
        "select count(*)::text as count from audit_log where entity_type = 'quote' and entity_id = $1",
        [String(quoteId)],
      );
      const followUps = await query<{ count: string }>(
        'select count(*)::text as count from follow_ups where lead_id = $1',
        [leadId],
      );
      return JSON.stringify({ quote, lead, history, audit, followUps });
    }

    it('blocks Send with 422 PRICING_APPROVAL_REQUIRED when the premium exceeds the threshold and approval is not granted', async () => {
      await setGate(tenantA, true, 10_000);
      try {
        const leadId = await createLead();
        const quote = await createQuoteOk(leadId, { quotedPremium: 25_000 });

        const before = await gateDigest(quote.id, leadId);

        const response = await operate(quote.id, 'send', {
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
        });

        expect(response.status).toBe(422);
        const problem = await problemOf(response);
        expect(problem.code).toBe('PRICING_APPROVAL_REQUIRED');
        expect(problem.detail).toContain(String(leadId));

        // "NOTHING PERSISTS" (QuoteWorkflowErrors.cs:26) — asserted as an unchanged digest across
        // the quote row, the lead row, the history table, the audit table and the follow-ups.
        expect(await gateDigest(quote.id, leadId)).toBe(before);
      } finally {
        await setGate(tenantA, false, 100_000);
      }
    });

    it('allows Send once the lead pricing approval is APPROVED', async () => {
      await setGate(tenantA, true, 10_000);
      try {
        const leadId = await createLead();
        // Assigned first, so quote creation cascades the lead to Pricing — the only status the
        // pricing sub-workflow is legal from.
        await assignLead(leadId);
        const quote = await createQuoteOk(leadId, { quotedPremium: 25_000 });

        // Approval is a property of the LEAD, granted through the lead's own pricing sub-workflow.
        const requested = await call('POST', `${LEADS}/${leadId}/operations/request-pricing-approval`, {
          token: admin.accessToken,
          tenantId: tenantA,
          body: { approverUserId: appUserId(admin) },
        });
        expect(requested.status, 'pricing-approval request should have succeeded').toBe(200);

        const approved = await call('POST', `${LEADS}/${leadId}/operations/approve-pricing`, {
          token: admin.accessToken,
          tenantId: tenantA,
          body: {},
        });
        expect(approved.status).toBe(200);
        expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('approved');

        const sent = await operateOk(quote.id, 'send', {
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
        });
        expect(sent.statusCanonicalKey).toBe('sent');
      } finally {
        await setGate(tenantA, false, 100_000);
      }
    });

    it('allows the same Send with the gate DISABLED and no approval at all', async () => {
      await setGate(tenantA, false, 10_000);
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId, { quotedPremium: 25_000 });

      expect((await readLeadRow(leadId))?.['pricing_approval_state']).toBe('none');

      const sent = await operateOk(quote.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(5),
      });
      expect(sent.statusCanonicalKey).toBe('sent');
      await setGate(tenantA, false, 100_000);
    });

    it('allows Send when the premium is at or below the threshold, gate enabled', async () => {
      await setGate(tenantA, true, 10_000);
      try {
        const leadId = await createLead();
        // EXACTLY the threshold: the comparison is strictly greater-than, so this must pass.
        const quote = await createQuoteOk(leadId, { quotedPremium: 10_000 });

        const sent = await operateOk(quote.id, 'send', {
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
        });
        expect(sent.statusCanonicalKey).toBe('sent');
      } finally {
        await setGate(tenantA, false, 100_000);
      }
    });

    it('reads the CURRENT VERSION premium, not the version-1 premium', async () => {
      // The measured field. A quote created cheap, sent, then revised ABOVE the threshold and
      // re-sent would be the obvious wrong-field test, but Send is illegal from Revised — so the
      // discriminating state is built by revising a quote whose v1 was below and v2 above, then
      // asserting the gate reads v2 via a fresh draft carrying the same shape.
      await setGate(tenantA, true, 10_000);
      try {
        const leadId = await createLead();
        const quote = await createQuoteOk(leadId, { quotedPremium: 5_000 });

        // Raise the CURRENT version above the threshold through the draft-edit path, leaving
        // version_no 1 in place. If the gate read anything but the current version's premium — a
        // stale copy, the lead's estimate, or a hardcoded zero — this Send would be allowed.
        const updated = await call('PUT', `${QUOTES}/${quote.id}`, {
          token: admin.accessToken,
          tenantId: tenantA,
          body: {
            productLineId: productLineA,
            coverTypeId: coverTypeA,
            quotedPremium: 40_000,
            preparedDate: todayIso(),
            validUntil: null,
            notes: null,
          },
        });
        expect(updated.status).toBe(200);

        const response = await operate(quote.id, 'send', {
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
        });
        expect(response.status).toBe(422);
        expect((await problemOf(response)).code).toBe('PRICING_APPROVAL_REQUIRED');
      } finally {
        await setGate(tenantA, false, 100_000);
      }
    });

    it('does not gate when the tenant has no threshold configured, even with the switch on', async () => {
      await query(
        `update tenant_settings set require_pricing_approval_for_high_value = true,
                high_value_threshold = null where tenant_id = $1`,
        [tenantA],
      );
      try {
        const leadId = await createLead();
        const quote = await createQuoteOk(leadId, { quotedPremium: 900_000 });

        const sent = await operateOk(quote.id, 'send', {
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
        });
        expect(sent.statusCanonicalKey).toBe('sent');
      } finally {
        await setGate(tenantA, false, 100_000);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // availableOperations (AC-050, V-064).
  // -------------------------------------------------------------------------------------------

  describe('availableOperations is server-computed (AC-050, V-064)', () => {
    it('reflects the matrix for a Draft quote for a fully-permissioned caller', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      expect(quote.availableOperations).toEqual([
        'assign',
        'send',
        'withdraw',
        'set-current',
      ]);
    });

    it('reflects the matrix for a Sent quote', async () => {
      const leadId = await createLead();
      const quote = await sentQuote(leadId);
      expect(quote.availableOperations).toEqual([
        'assign',
        'revise',
        'mark-won',
        'mark-lost',
        'withdraw',
        'set-current',
      ]);
    });

    it('is EMPTY for a closed quote', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      const withdrawn = await operateOk(quote.id, 'withdraw', { withdrawalNote: 'stop' });
      expect(withdrawn.availableOperations).toEqual([]);
    });

    it('narrows to the caller permissions: a view-only caller sees none', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const asViewer = await getQuote(quote.id, viewer);
      expect(asViewer.availableOperations).toEqual([]);
      // ...while the same quote in the same status offers four to the admin, proving the list is a
      // function of the CALLER and not only of the status.
      expect((await getQuote(quote.id, admin)).availableOperations).toHaveLength(4);
    });

    it('still rejects server-side an operation absent from availableOperations (UI gating is not load-bearing)', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      expect(quote.availableOperations).not.toContain('mark-won');

      // Legal-but-unpermitted would be 403; illegal-for-this-status is 409. This one is illegal.
      const response = await operate(quote.id, 'mark-won', {});
      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe('QUOTE_ILLEGAL_TRANSITION');
    });

    it('answers 403 QUOTE_OPERATION_FORBIDDEN when the caller lacks the operation permission', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const response = await operate(quote.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(5),
      }, { session: viewer });

      expect(response.status).toBe(403);
      // The route guard rejects before the executor does; either way the caller learns only that
      // they may not act, never whether the operation would have been legal.
      const problem = await problemOf(response);
      expect(problem.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Closed-record read-only and the audited correction path (AC-055, V-070).
  // -------------------------------------------------------------------------------------------

  describe('closed quotes are read-only except audited corrections (AC-055, V-070)', () => {
    async function wonQuote(): Promise<{ leadId: number; quoteId: number }> {
      const leadId = await createLead();
      const quote = await sentQuote(leadId, 6000);
      await operateOk(quote.id, 'mark-won', { boundPremium: 6100 });
      return { leadId, quoteId: quote.id };
    }

    function correctionBody(premium: number, notes: string): Record<string, unknown> {
      return {
        productLineId: productLineA,
        coverTypeId: coverTypeA,
        quotedPremium: premium,
        preparedDate: todayIso(),
        validUntil: null,
        notes,
      };
    }

    it('rejects a correction from a caller without quotes.correct_closed with 403', async () => {
      const { quoteId } = await wonQuote();

      const response = await call('PUT', `${QUOTES}/${quoteId}`, {
        token: editor.accessToken,
        tenantId: tenantA,
        body: correctionBody(9999, 'unauthorised'),
      });

      expect(response.status).toBe(403);
      expect((await problemOf(response)).code).toBe('QUOTE_CLOSED_REQUIRES_CORRECTION_PERMISSION');
      // And nothing changed.
      expect((await readQuoteRow(quoteId))?.['notes']).not.toBe('unauthorised');
    });

    it('applies the correction for a caller holding the permission and audits before/after', async () => {
      const { quoteId } = await wonQuote();
      const beforeRow = await readQuoteRow(quoteId);

      const response = await call('PUT', `${QUOTES}/${quoteId}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: correctionBody(6250, 'corrected after close'),
      });
      expect(response.status).toBe(200);

      expect((await readQuoteRow(quoteId))?.['notes']).toBe('corrected after close');

      const audits = await findAuditRows(query, {
        action: 'quote.updated',
        entityId: String(quoteId),
        tenantId: tenantA,
      });
      expect(audits).toHaveLength(1);
      const details = audits[0]?.details as Record<string, Record<string, unknown>>;
      // The before half must reflect actual PRE-state, including the premium that lives on the
      // version row rather than on the quote.
      expect(details['before']?.['quotedPremium']).toBe(6000);
      expect(details['before']?.['notes']).toBe(beforeRow?.['notes'] ?? null);
      expect(details['after']?.['quotedPremium']).toBe(6250);
      expect(details['after']?.['notes']).toBe('corrected after close');
    });

    it('rejects every WORKFLOW operation on a closed quote with 409 and an empty hint', async () => {
      const { quoteId } = await wonQuote();

      for (const op of ['assign', 'send', 'revise', 'mark-won', 'mark-lost', 'withdraw', 'set-current']) {
        const response = await operate(quoteId, op, {
          assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(admin) }],
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
          revisionNote: 'x',
          newQuotedPremium: 10,
          lostReasonId: lostReasonA,
          withdrawalNote: 'x',
        });
        expect(response.status, `${op} on a closed quote`).toBe(409);
        const problem = await problemOf(response);
        expect(problem.code, `${op} code`).toBe('QUOTE_ILLEGAL_TRANSITION');
        expect(problem.availableOperations, `${op} hint`).toEqual([]);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // History, audit, assignment (AC-024, V-031).
  // -------------------------------------------------------------------------------------------

  describe('history and audit (AC-024, V-031)', () => {
    it('appends one history row per operation with actor, statuses and inputs', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      await operateOk(quote.id, 'send', {
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(6),
      });
      await operateOk(quote.id, 'revise', { newQuotedPremium: 5500, revisionNote: 'bump' });

      const history = await readQuoteHistory(quote.id);
      expect(history.map((row) => row['operation'])).toEqual(['send', 'revise']);

      expect(history[0]?.['acted_by']).toBe(String(appUserId(admin)));
      expect(history[0]?.['previous_status_id']).toBe(String(await quoteStatusIdOf('draft')));
      expect(history[0]?.['new_status_id']).toBe(String(await quoteStatusIdOf('sent')));

      const reviseInputs = history[1]?.['inputs'] as Record<string, unknown>;
      expect(reviseInputs['revisionNote']).toBe('bump');
      expect(reviseInputs['newVersionNo']).toBe(2);
    });

    it.each([
      ['send', 'quote.send'],
      ['revise', 'quote.revise'],
      ['withdraw', 'quote.withdraw'],
      ['mark-lost', 'quote.mark-lost'],
      ['mark-won', 'quote.mark-won'],
      ['assign', 'quote.assign'],
      ['set-current', 'quote.set-current'],
    ])('writes exactly one %s audit row', async (op, action) => {
      const leadId = await createLead();
      let quoteId: number;

      if (op === 'send' || op === 'assign' || op === 'withdraw' || op === 'set-current') {
        quoteId = (await createQuoteOk(leadId)).id;
      } else {
        quoteId = (await sentQuote(leadId)).id;
      }

      await operateOk(quoteId, op, {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(admin) }],
        validUntil: daysFromNow(30),
        nextFollowUpDate: daysFromNow(5),
        revisionNote: 'r',
        newQuotedPremium: 10,
        lostReasonId: lostReasonA,
        withdrawalNote: 'w',
      });

      await assertAudited(query, {
        action,
        entityType: 'quote',
        entityId: String(quoteId),
        actorUserId: appUserId(admin),
        tenantId: tenantA,
      });
    });

    it('stamps lead activity even for an operation that never changes lead status', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);
      const before = (await readLeadRow(leadId))?.['last_activity_at'];

      await new Promise((resolve) => setTimeout(resolve, 5));
      await operateOk(quote.id, 'withdraw', { withdrawalNote: 'pause' });

      expect((await readLeadRow(leadId))?.['last_activity_at']).not.toBe(before);
    });

    it('assigns and reassigns quote slots, recording only the slots that moved', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      // Creation already defaulted the quote's RM slot from the lead's, so re-sending the same
      // assignee must record NO role change while a different assignee records one.
      await operateOk(quote.id, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(admin) }],
      });
      const first = await readQuoteHistory(quote.id);
      expect((first.at(-1)?.['inputs'] as Record<string, unknown>)['roleChanges']).toEqual([]);

      await operateOk(quote.id, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(editor) }],
      });
      const second = await readQuoteHistory(quote.id);
      expect((second.at(-1)?.['inputs'] as Record<string, unknown>)['roleChanges']).toEqual([
        {
          businessAssignmentId: rmSlotA,
          previousUserId: appUserId(admin),
          newUserId: appUserId(editor),
        },
      ]);
    });

    it('rejects an ineligible assignee with 422 QUOTE_WORKFLOW_INVALID_ASSIGNEE', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId);

      const response = await operate(quote.id, 'assign', {
        assignments: [{ businessAssignmentId: rmSlotA, userId: appUserId(viewer) }],
      });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('QUOTE_WORKFLOW_INVALID_ASSIGNEE');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation (AC-021, AC-022, V-026, V-027).
  // -------------------------------------------------------------------------------------------

  describe('tenant isolation (AC-021, AC-022, V-026, V-027)', () => {
    it('answers 404 identically for a cross-tenant quote id and a nonexistent one', async () => {
      const leadB = await createLead('B');
      const foreignResponse = await call('POST', `${LEADS}/${leadB}/quotes`, {
        token: admin.accessToken,
        tenantId: tenantB,
        body: { quotedPremium: 4200 },
      });
      expect(foreignResponse.status).toBe(201);
      const foreignQuote = (await foreignResponse.json()) as QuoteDto;

      const asForeign = await call('GET', `${QUOTES}/${foreignQuote.id}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      const asMissing = await call('GET', `${QUOTES}/999999999`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(asForeign.status).toBe(404);
      expect(asMissing.status).toBe(404);

      // Byte-identical body shape after masking the ids and dropping the correlation id.
      // Written with an explicit key rather than `detail: body.detail?.replace(...)`: under
      // `exactOptionalPropertyTypes`, `string | undefined` is not assignable to `detail?: string`,
      // and silencing that with a cast would also hide a genuinely absent `detail`.
      const scrub = (body: ProblemBody): Record<string, unknown> => {
        const scrubbed: Record<string, unknown> = { ...body };
        delete scrubbed['correlationId'];
        if (body.detail !== undefined) scrubbed['detail'] = body.detail.replace(/\d+/g, 'N');
        return scrubbed;
      };
      expect(scrub(await problemOf(asForeign))).toEqual(scrub(await problemOf(asMissing)));
    });

    it('leaves a foreign quote physically unchanged after a cross-tenant operation attempt', async () => {
      const leadB = await createLead('B');
      const created = await call('POST', `${LEADS}/${leadB}/quotes`, {
        token: admin.accessToken,
        tenantId: tenantB,
        body: { quotedPremium: 3100 },
      });
      const foreignQuote = (await created.json()) as QuoteDto;

      const digestBefore = JSON.stringify(await readQuoteRow(foreignQuote.id));

      for (const op of ['send', 'withdraw', 'set-current']) {
        const response = await operate(foreignQuote.id, op, {
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
          withdrawalNote: 'hostile',
        });
        expect(response.status, `cross-tenant ${op}`).toBe(404);
      }

      expect(JSON.stringify(await readQuoteRow(foreignQuote.id))).toBe(digestBefore);
    });

    it("excludes another tenant's quotes from a lead's Quotes card", async () => {
      const leadA = await createLead();
      await createQuoteOk(leadA);

      const response = await call('GET', `${LEADS}/${leadA}/quotes`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      const list = (await response.json()) as QuoteListItemDto[];

      const foreignRefs = await query<{ quote_ref: string }>(
        'select quote_ref from quotes where tenant_id = $1',
        [tenantB],
      );
      for (const foreign of foreignRefs) {
        expect(list.map((row) => row.quoteRef)).not.toContain(foreign.quote_ref);
      }
    });

    it('answers 404 for quote creation under a cross-tenant or nonexistent lead (V-067)', async () => {
      const leadB = await createLead('B');

      const crossTenant = await createQuote(leadB, {}, { tenantId: tenantA });
      expect(crossTenant.status).toBe(404);
      expect((await problemOf(crossTenant)).code).toBe('QUOTE_LEAD_NOT_FOUND');

      const missing = await call('POST', `${LEADS}/999999999/quotes`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { quotedPremium: 100 },
      });
      expect(missing.status).toBe(404);
      expect((await problemOf(missing)).code).toBe('QUOTE_LEAD_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Money typing (T-008 obligation inherited by this task).
  // -------------------------------------------------------------------------------------------

  describe('money stays exact across the quote surface (T-008 obligation)', () => {
    it('round-trips a premium with cents without drift', async () => {
      const leadId = await createLead();
      const quote = await createQuoteOk(leadId, { quotedPremium: 12345.67 });

      const rows = await query<{ quoted_premium: string }>(
        'select quoted_premium::text as quoted_premium from quote_versions where quote_id = $1',
        [quote.id],
      );
      // Stored as an exact numeric, not a float artefact like 12345.669999999999.
      expect(rows[0]?.quoted_premium).toBe('12345.67');
      expect((await getQuote(quote.id)).versions[0]?.quotedPremium).toBe(12345.67);
    });

    it('compares the pricing gate against numeric, exact at the boundary cent', async () => {
      await setGate(tenantA, true, 10_000);
      try {
        const leadId = await createLead();
        // One cent above the threshold: a float-rounded comparison could miss this.
        const quote = await createQuoteOk(leadId, { quotedPremium: 10_000.01 });

        const response = await operate(quote.id, 'send', {
          validUntil: daysFromNow(30),
          nextFollowUpDate: daysFromNow(5),
        });
        expect(response.status).toBe(422);
        expect((await problemOf(response)).code).toBe('PRICING_APPROVAL_REQUIRED');
      } finally {
        await setGate(tenantA, false, 100_000);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // Residue.
  // -------------------------------------------------------------------------------------------

  it('leaves no rows outside this suite tenants', async () => {
    const rows = await query<{ count: string }>(
      `select count(*)::text as count from quotes where tenant_id not in ($1, $2)
         and quote_ref like $3`,
      [tenantA, tenantB, `${RUN}%`],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
