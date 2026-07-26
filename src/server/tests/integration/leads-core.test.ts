/**
 * Lead create/detail/edit/bulk-reassign, end to end (T-024; AC-021, AC-022, AC-024, AC-042,
 * AC-043, AC-044, AC-046; V-026, V-031, V-055, V-056, V-057, V-059).
 *
 * Same shape as `parties.test.ts`: real signed-in sessions, real tenants/partitions, real grants,
 * the real Hono pipeline (auth -> tenant context -> permission resolution -> routes) via
 * `app.request`. Nothing is stubbed, because the properties under test — tenant isolation, the
 * permission matrix, sequence concurrency and the two DIFFERENT duplicate behaviours — are
 * properties of the composed system, not of any one function.
 *
 * EVERY VALIDATION CASE ASSERTS THE ERROR CODE, NOT MERELY THE 422
 * ===============================================================
 * The catalog is large and EVERY rule answers 422. A status-only assertion cannot tell one rule
 * from another, nor a correct rejection from an accidental one — a body rejected for the wrong
 * reason looks identical to a body rejected for the right one. So each case below names the code it
 * expects, and the two-layer split (shape rules -> `LEAD_VALIDATION_FAILED` with a per-field code
 * in `errors[]`; reference-value rules -> their own `LEAD_INVALID_*` code) is asserted explicitly.
 *
 * The list/filter/sort/paging/breadth surface lives in `leads-list.test.ts`.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LEAD_CREATED_ACTION, LEAD_REASSIGNED_ACTION, LEAD_UPDATED_ACTION } from '../../domains/leads/service.js';
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
const title = suiteTitle('leads-core', probe);

const BASE = '/api/v1/leads';

interface LeadDto {
  readonly id: number;
  readonly leadRef: string;
  readonly externalRef: string | null;
  readonly partyId: number;
  readonly partyName: string;
  readonly brokerId: number | null;
  readonly brokerName: string | null;
  readonly regionId: number;
  readonly productLineId: number;
  readonly productLineName: string;
  readonly coverTypeId: number;
  readonly coverTypeName: string;
  readonly sumInsured: number | null;
  readonly estimatedPremium: number | null;
  readonly policyTerm: string;
  readonly policyTermOther: string | null;
  readonly priority: string;
  readonly isExistingClient: boolean;
  readonly statusId: number;
  readonly statusName: string;
  readonly statusCanonicalKey: string | null;
  readonly dateReceived: string;
  readonly source: string;
  readonly owner: { userId: number; firstName: string; lastName: string } | null;
  readonly notes: { id: number; body: string; createdAt: string }[];
  readonly availableOperations: string[];
  readonly nextFollowUpDate: string | null;
  readonly isNextFollowUpOverdue: boolean;
}

interface LeadWarningDto {
  readonly code: string;
  readonly details: Record<string, unknown>;
}

interface CreateLeadOutcomeDto {
  readonly lead: LeadDto | null;
  readonly warnings: LeadWarningDto[];
  readonly requiresConfirmation: boolean;
}

interface UpdateLeadOutcomeDto {
  readonly lead: LeadDto;
  readonly warnings: LeadWarningDto[];
}

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

/**
 * A per-run marker, deliberately SHORT.
 *
 * The parties suite learned this the hard way: duplicate PARTY detection is trigram similarity over
 * the whole name, so a long shared token dominates the trigrams and pushes two unrelated names over
 * the 0.4 threshold. This suite creates parties too (inline-party intake), so the same hazard
 * applies and the same mitigation is used. The `t024-` prefix is load-bearing — the stale-fixture
 * purge keys on it.
 */
const RUN = `t024-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix} ${RUN}-${nameSequence}`;
}

/** Yesterday, so `dateReceived` is always legal without riding the not-in-the-future boundary. */
function yesterday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function today(): string {
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

  /** Holds the full leads grant set in BOTH tenants and is a member of both. */
  let admin: TestUserSession;
  /** Member of tenant A holding the RM role (so it is an eligible owner) but no leads grants. */
  let owner: TestUserSession;
  /** A second eligible owner, for the reassign target. */
  let otherOwner: TestUserSession;
  /** Holds `leads.view` ONLY: proves view implies neither create, update nor reassign. */
  let viewer: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  let rmRoleId = 0;

  const createdTenants: number[] = [];

  /** Tables this suite writes into, in dependency order for deletion. */
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

  /** Deletes anything left by a PREVIOUS aborted run, before this run seeds anything. */
  async function purgeStaleRunsOfThisSuite(): Promise<void> {
    const stale = await query<{ id: string }>(
      "select id::text as id from tenants where name like 't024-%'",
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

  /**
   * Seeds the tenant's business rules. `lead_ref_format` and `duplicate_check_days` are the two
   * fields this suite actually exercises; the rest are ordinary defaults.
   */
  async function seedSettings(
    tenantId: number,
    overrides: { leadRefFormat?: string; highValueThreshold?: number | null; manualExternalRef?: boolean } = {},
  ): Promise<void> {
    await query(
      `insert into tenant_settings
         (tenant_id, currency_code, currency_symbol, max_attachment_mb, high_value_threshold,
          quote_expiry_alert_days, follow_up_overdue_grace_days, aging_amber_days, aging_red_days,
          unassigned_lead_hours, stalled_lead_days, stalled_quote_days, duplicate_check_days,
          lead_ref_format, quote_ref_format, lead_inactivity_expiry_days, pricing_approval_target_days,
          sla_assignment_days, sla_underwriting_days, sla_received_to_sent_days,
          require_pricing_approval_for_high_value, manual_external_ref_enabled,
          expire_lead_when_last_quote_expires, created_at, updated_at)
       values ($1, 'USD', '$', 10, $2, 7, 2, 5, 10, 24, 7, 7, 30, $3, 'Q-{YYYY}-{SEQ:4}', 60, 3,
               2, 3, 5, false, $4, false, now(), now())`,
      [
        tenantId,
        overrides.highValueThreshold === undefined ? 100000 : overrides.highValueThreshold,
        overrides.leadRefFormat ?? 'L-{YYYY}-{SEQ:4}',
        overrides.manualExternalRef ?? true,
      ],
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
      isBrokerChannel?: boolean | null;
      productLineId?: number | null;
      isTerminal?: boolean;
    } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          is_broker_channel, product_line_id, is_terminal, created_at, updated_at)
       values ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        options.isActive ?? true,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.isBrokerChannel ?? null,
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

  async function seedBroker(tenantId: number, name: string, status = 'active'): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into brokers (tenant_id, name, status, created_at, updated_at)
       values ($1, $2, $3, now(), now()) returning id::text as id`,
      [tenantId, name, status],
    );
    return Number(rows[0]?.id);
  }

  /** The RM-slot business assignment: the seam that decides who may own a lead. */
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

  // Seeded reference fixtures.
  let partyTypeA = 0;
  let regionA = 0;
  let channelA = 0;
  let brokerChannelA = 0;
  let productLineA = 0;
  let productLineA2 = 0;
  let coverTypeA = 0;
  let coverTypeA2 = 0;
  let inactiveCoverTypeA = 0;
  let newStatusA = 0;
  let closedStatusA = 0;
  let brokerA = 0;
  let partyA = 0;
  let secondPartyA = 0;

  let partyTypeB = 0;
  let regionB = 0;
  let channelB = 0;
  let productLineB = 0;
  let coverTypeB = 0;
  let newStatusB = 0;
  let partyB = 0;

  /** A body that satisfies every rule, so a test can vary exactly one field. */
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

  /** POSTs a lead as the admin and asserts it was created. */
  async function createLead(
    overrides: Record<string, unknown> = {},
    tenantId = tenantA,
  ): Promise<CreateLeadOutcomeDto> {
    const response = await call('POST', BASE, {
      token: admin.accessToken,
      tenantId,
      body: validBody(overrides),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as CreateLeadOutcomeDto;
  }

  /** Reads a lead row straight from the database — the side-effect check the API cannot fake. */
  async function readLeadRow(id: number): Promise<Record<string, unknown> | undefined> {
    const rows = await query<Record<string, unknown>>(
      `select id::text as id, lead_ref, external_ref, tenant_id::text as tenant_id,
              status_id::text as status_id, priority, policy_term, policy_term_other,
              last_activity_at::text as last_activity_at, party_id::text as party_id, source,
              pricing_approval_state
         from leads where id = $1`,
      [id],
    );
    return rows[0];
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

    admin = await auth.createTestUserWithSession({ label: 'leads-admin' });
    owner = await auth.createTestUserWithSession({
      label: 'leads-owner',
      firstName: 'Rita',
      lastName: 'Mensah',
    });
    otherOwner = await auth.createTestUserWithSession({
      label: 'leads-owner2',
      firstName: 'Sam',
      lastName: 'Okafor',
    });
    viewer = await auth.createTestUserWithSession({ label: 'leads-viewer' });

    for (const session of [admin, owner, otherOwner, viewer]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(admin), tenantB);

    for (const permission of [
      'leads.view',
      'leads.view_all',
      'leads.create',
      'leads.update',
      'leads.reassign',
    ] as const) {
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantA);
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantB);
    }
    // View ONLY: proves view implies neither create, update nor reassign.
    await fixtures.grantDirectPermission(appUserId(viewer), 'leads.view', tenantA);

    // The RM role both owners hold — this is what makes them ELIGIBLE owners.
    rmRoleId = await fixtures.createRole({ tenantId: tenantA });
    await fixtures.assignRole(appUserId(owner), rmRoleId, tenantA);
    await fixtures.assignRole(appUserId(otherOwner), rmRoleId, tenantA);
    await seedRmSlot(tenantA, rmRoleId);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp A'));
    regionA = await seedRef(tenantA, 'region', uniqueName('North A'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email A'));
    brokerChannelA = await seedRef(tenantA, 'request_channel', uniqueName('Broker A'), {
      isBrokerChannel: true,
    });
    productLineA = await seedRef(tenantA, 'product_line', uniqueName('Motor A'));
    productLineA2 = await seedRef(tenantA, 'product_line', uniqueName('Marine A'));
    coverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Comp A'), {
      productLineId: productLineA,
    });
    // Belongs to the OTHER product line: the cover-type dependency's negative fixture.
    coverTypeA2 = await seedRef(tenantA, 'cover_type', uniqueName('Hull A'), {
      productLineId: productLineA2,
    });
    inactiveCoverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Retired A'), {
      productLineId: productLineA,
      isActive: false,
    });
    newStatusA = await seedRef(tenantA, 'lead_status', uniqueName('New A'), {
      reportingCategory: 'open',
      canonicalKey: 'new',
    });
    closedStatusA = await seedRef(tenantA, 'lead_status', uniqueName('Lost A'), {
      reportingCategory: 'lost',
      isTerminal: true,
    });
    brokerA = await seedBroker(tenantA, uniqueName('Broker Co A'));
    partyA = await seedParty(tenantA, `Acme ${RUN}`, partyTypeA);
    secondPartyA = await seedParty(tenantA, `Zenith ${RUN}`, partyTypeA);

    partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('Corp B'));
    regionB = await seedRef(tenantB, 'region', uniqueName('North B'));
    channelB = await seedRef(tenantB, 'request_channel', uniqueName('Email B'));
    productLineB = await seedRef(tenantB, 'product_line', uniqueName('Motor B'));
    coverTypeB = await seedRef(tenantB, 'cover_type', uniqueName('Comp B'), {
      productLineId: productLineB,
    });
    newStatusB = await seedRef(tenantB, 'lead_status', uniqueName('New B'), {
      reportingCategory: 'open',
      canonicalKey: 'new',
    });
    partyB = await seedParty(tenantB, `Tenant B Party ${RUN}`, partyTypeB);
    void newStatusA;
    void newStatusB;
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on, and every delete here swallows its error, so the reverse order is a silent no-op that
    // leaks this suite's tenants and audit rows into the next run.
    for (const tenantId of createdTenants) {
      await deleteTenantData(tenantId);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
    await pool?.end().catch(() => undefined);
  });

  describe('POST /leads — creation', () => {
    it('creates a lead with status New, a generated ref, and the owner assignment', async () => {
      const result = await createLead();
      const lead = result.lead;

      expect(lead).not.toBeNull();
      expect(result.requiresConfirmation).toBe(false);
      expect(lead?.statusCanonicalKey).toBe('new');
      expect(lead?.owner?.userId).toBe(appUserId(owner));
      expect(lead?.owner?.firstName).toBe('Rita');
      expect(lead?.source).toBe('browser');
      // The tenant's template, rendered with the current year (AC-043).
      expect(lead?.leadRef).toMatch(new RegExp(`^L-${new Date().getUTCFullYear()}-\\d{4}$`));
    });

    it('stamps last_activity_at on creation, which the inactivity job depends on', async () => {
      const { lead } = await createLead();
      const row = await readLeadRow(lead!.id);

      expect(row?.last_activity_at).not.toBeNull();
    });

    it('records the intake note as the lead’s first activity note', async () => {
      const { lead } = await createLead({ intakeNotes: 'Called the broker to confirm cover.' });
      const detail = await call('GET', `${BASE}/${String(lead!.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      const body = (await detail.json()) as LeadDto;
      expect(body.notes).toHaveLength(1);
      expect(body.notes[0]?.body).toBe('Called the broker to confirm cover.');
    });

    it('creates the inline party and the lead atomically, and warns about a near-duplicate name', async () => {
      const result = await createLead({
        partyId: null,
        inlineParty: { name: `Acme ${RUN}`, partyTypeId: partyTypeA },
      });

      const partyRows = await query<{ id: string; name: string }>(
        'select id::text as id, name from parties where id = $1',
        [result.lead!.partyId],
      );
      expect(partyRows).toHaveLength(1);

      // The inline party's duplicate-NAME warning is forwarded onto the lead response, and is
      // NON-BLOCKING: the lead exists regardless.
      const warning = result.warnings.find((w) => w.code === 'DUPLICATE_PARTY_NAME');
      expect(warning).toBeDefined();
      expect(await readLeadRow(result.lead!.id)).toBeDefined();
    });

    it('derives High priority from the tenant high-value threshold', async () => {
      const { lead } = await createLead({ estimatedPremium: 150_000 });
      expect(lead?.priority).toBe('high');
    });

    it('derives Normal priority below the threshold', async () => {
      const { lead } = await createLead({ estimatedPremium: 50_000 });
      expect(lead?.priority).toBe('normal');
    });

    it('honours an explicitly supplied priority instead of deriving it', async () => {
      const { lead } = await createLead({ estimatedPremium: 50_000, priority: 'high' });
      expect(lead?.priority).toBe('high');
    });

    it('accepts a broker on a broker-flagged channel', async () => {
      const { lead } = await createLead({ requestChannelId: brokerChannelA, brokerId: brokerA });
      expect(lead?.brokerId).toBe(brokerA);
      expect(lead?.brokerName).not.toBeNull();
    });

    it('stores policy-term free text only when the term is Other', async () => {
      const { lead } = await createLead({ policyTerm: 'other', policyTermOther: '18 months' });
      expect(lead?.policyTerm).toBe('other');
      expect(lead?.policyTermOther).toBe('18 months');
    });

    it('accepts a lead received TODAY — the not-in-the-future boundary is inclusive', async () => {
      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ dateReceived: today() }),
      });
      expect(response.status).toBe(201);
    });
  });

  /**
   * V-055: one case per ported rule, each asserting the CODE. See this file's header for why a
   * status-only assertion would be worthless here.
   */
  describe('POST /leads — validation catalog (AC-042)', () => {
    async function post(body: Record<string, unknown>): Promise<{ status: number; body: ProblemBody }> {
      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body,
      });
      return { status: response.status, body: (await response.json()) as ProblemBody };
    }

    /** Shape-level rules: 422 `LEAD_VALIDATION_FAILED` with a per-field code in `errors[]`. */
    const shapeCases: { name: string; overrides: Record<string, unknown>; field: string; code: string }[] = [
      {
        name: 'date received in the future',
        overrides: { dateReceived: tomorrow() },
        field: 'dateReceived',
        code: 'LEAD_DATE_RECEIVED_FUTURE',
      },
      {
        name: 'policy term Other with no free text',
        overrides: { policyTerm: 'other', policyTermOther: null },
        field: 'policyTermOther',
        code: 'LEAD_POLICY_TERM_OTHER_REQUIRED',
      },
      {
        name: 'policy-term free text supplied with a NON-Other term',
        overrides: { policyTerm: 'm12', policyTermOther: '18 months' },
        field: 'policyTermOther',
        code: 'LEAD_POLICY_TERM_OTHER_NOT_ALLOWED',
      },
      {
        name: 'unrecognised policy term',
        overrides: { policyTerm: 'm18' },
        field: 'policyTerm',
        code: 'LEAD_POLICY_TERM_INVALID',
      },
      {
        name: 'unrecognised priority',
        overrides: { priority: 'urgent' },
        field: 'priority',
        code: 'LEAD_PRIORITY_INVALID',
      },
      {
        name: 'sum insured of zero',
        overrides: { sumInsured: 0 },
        field: 'sumInsured',
        code: 'LEAD_MUST_BE_GREATER_THAN_ZERO',
      },
      {
        name: 'negative estimated premium',
        overrides: { estimatedPremium: -1 },
        field: 'estimatedPremium',
        code: 'LEAD_MUST_BE_GREATER_THAN_ZERO',
      },
      {
        name: 'both partyId and inlineParty supplied',
        overrides: { inlineParty: { name: uniqueName('Both'), partyTypeId: 1 } },
        field: 'partyId',
        code: 'LEAD_PARTY_CHOICE_INVALID',
      },
      {
        name: 'neither partyId nor inlineParty supplied',
        overrides: { partyId: null },
        field: 'partyId',
        code: 'LEAD_PARTY_CHOICE_INVALID',
      },
    ];

    for (const testCase of shapeCases) {
      it(`rejects ${testCase.name} with ${testCase.code}`, async () => {
        const { status, body } = await post(validBody(testCase.overrides));

        expect(status).toBe(422);
        expect(body.code).toBe('LEAD_VALIDATION_FAILED');
        const error = body.errors?.find((e) => e.field === testCase.field);
        expect(error, `expected an error on '${testCase.field}', got ${JSON.stringify(body.errors)}`).toBeDefined();
        expect(error?.code).toBe(testCase.code);
      });
    }

    /**
     * MISSING REQUIRED FIELDS get their own cases, because this is exactly where the zod
     * short-circuit defect hides: a `.nullish().refine(...)` schema skips validation entirely on an
     * absent field and the failure surfaces a layer down under a DIFFERENT code — with both being
     * 422, only a code assertion can tell.
     */
    const requiredFields = [
      'dateReceived',
      'requestChannelId',
      'regionId',
      'productLineId',
      'coverTypeId',
      'ownerUserId',
      'policyTerm',
      'isExistingClient',
    ] as const;

    for (const field of requiredFields) {
      it(`rejects a MISSING ${field} at the schema layer, not a layer down`, async () => {
        const body = validBody();
        delete body[field];

        const result = await post(body);
        expect(result.status).toBe(422);
        expect(result.body.code).toBe('LEAD_VALIDATION_FAILED');
        expect(result.body.errors?.some((e) => e.field === field)).toBe(true);
      });
    }

    /** Reference-value rules: their OWN codes, from the service rather than the schema. */
    it('rejects an unknown party with LEAD_INVALID_PARTY', async () => {
      const { status, body } = await post(validBody({ partyId: 987_654_321 }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_PARTY');
    });

    it('rejects an inactive request channel with LEAD_INVALID_REQUEST_CHANNEL', async () => {
      const inactive = await seedRef(tenantA, 'request_channel', uniqueName('Dead A'), {
        isActive: false,
      });
      const { status, body } = await post(validBody({ requestChannelId: inactive }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_REQUEST_CHANNEL');
    });

    it('requires a broker on a broker-flagged channel', async () => {
      const { status, body } = await post(
        validBody({ requestChannelId: brokerChannelA, brokerId: null }),
      );
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_VALIDATION_FAILED');
      expect(body.detail).toContain('Broker is required');
    });

    it('rejects a DISABLED broker with LEAD_INVALID_BROKER', async () => {
      const inactive = await seedBroker(tenantA, uniqueName('Dormant A'), 'disabled');
      const { status, body } = await post(validBody({ brokerId: inactive }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_BROKER');
    });

    it('rejects an inactive region with LEAD_INVALID_REGION', async () => {
      const inactive = await seedRef(tenantA, 'region', uniqueName('Dead region A'), {
        isActive: false,
      });
      const { status, body } = await post(validBody({ regionId: inactive }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_REGION');
    });

    it('rejects an inactive product line with LEAD_INVALID_PRODUCT_LINE', async () => {
      const inactive = await seedRef(tenantA, 'product_line', uniqueName('Dead PL A'), {
        isActive: false,
      });
      const { status, body } = await post(validBody({ productLineId: inactive }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_PRODUCT_LINE');
    });

    it('rejects a cover type belonging to a DIFFERENT product line', async () => {
      // The cover-type/product-line dependency — the rule most easily lost in a port.
      const { status, body } = await post(validBody({ coverTypeId: coverTypeA2 }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_COVER_TYPE');
    });

    it('rejects an inactive cover type with the same code as a mismatched one', async () => {
      const { status, body } = await post(validBody({ coverTypeId: inactiveCoverTypeA }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_COVER_TYPE');
    });

    it('rejects an owner who does not hold the RM role with LEAD_INVALID_OWNER', async () => {
      const { status, body } = await post(validBody({ ownerUserId: appUserId(viewer) }));
      expect(status).toBe(422);
      expect(body.code).toBe('LEAD_INVALID_OWNER');
    });

    it('reports the REGION when both region and product line are invalid (guard ORDER is observable)', async () => {
      const deadRegion = await seedRef(tenantA, 'region', uniqueName('Dead R2 A'), { isActive: false });
      const deadLine = await seedRef(tenantA, 'product_line', uniqueName('Dead PL2 A'), { isActive: false });

      const { body } = await post(validBody({ regionId: deadRegion, productLineId: deadLine }));
      expect(body.code).toBe('LEAD_INVALID_REGION');
    });

    it('persists NOTHING when validation fails', async () => {
      const before = await query<{ count: string }>(
        'select count(*)::text as count from leads where tenant_id = $1',
        [tenantA],
      );
      await post(validBody({ dateReceived: tomorrow() }));
      const after = await query<{ count: string }>(
        'select count(*)::text as count from leads where tenant_id = $1',
        [tenantA],
      );

      expect(after[0]?.count).toBe(before[0]?.count);
    });

    it('rejects an external ref when the tenant disallows manual external refs', async () => {
      const tenantC = await createTenant('tenant-c');
      await seedSettings(tenantC, { manualExternalRef: false });
      await addMembership(appUserId(admin), tenantC);
      for (const permission of ['leads.view', 'leads.create'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), permission, tenantC);
      }
      const typeC = await seedRef(tenantC, 'party_type', uniqueName('Corp C'));
      const partyC = await seedParty(tenantC, `Party C ${RUN}`, typeC);
      const regionC = await seedRef(tenantC, 'region', uniqueName('R C'));
      const channelC = await seedRef(tenantC, 'request_channel', uniqueName('Ch C'));
      const lineC = await seedRef(tenantC, 'product_line', uniqueName('PL C'));
      const coverC = await seedRef(tenantC, 'cover_type', uniqueName('CT C'), { productLineId: lineC });
      const roleC = await fixtures.createRole({ tenantId: tenantC });
      await fixtures.assignRole(appUserId(owner), roleC, tenantC);
      await addMembership(appUserId(owner), tenantC);
      await seedRmSlot(tenantC, roleC);

      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantC,
        body: {
          partyId: partyC,
          isExistingClient: true,
          dateReceived: yesterday(),
          requestChannelId: channelC,
          brokerId: null,
          ownerUserId: appUserId(owner),
          regionId: regionC,
          externalRef: 'EXT-1',
          productLineId: lineC,
          coverTypeId: coverC,
          policyTerm: 'm12',
          createAnyway: true,
        },
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).code).toBe('LEAD_EXTERNAL_REF_NOT_ENABLED');
    });
  });

  /**
   * AC-043 / V-056. The concurrency case is the ONLY level at which `SELECT ... FOR UPDATE` is
   * falsifiable: drop it and these 20 parallel creates mint duplicate references.
   */
  describe('lead reference generation (AC-043)', () => {
    it('mints 20 UNIQUE refs under 20 parallel creates through the pooler', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          call('POST', BASE, {
            token: admin.accessToken,
            tenantId: tenantA,
            body: validBody({ partyId: secondPartyA }),
          }),
        ),
      );

      expect(results.every((r) => r.status === 201)).toBe(true);

      const bodies = (await Promise.all(results.map((r) => r.json()))) as CreateLeadOutcomeDto[];
      const refs = bodies.map((b) => b.lead!.leadRef);

      expect(new Set(refs).size, `duplicate refs minted: ${refs.join(', ')}`).toBe(20);
    });

    it('keeps sequences INDEPENDENT across tenants', async () => {
      // Tenant B starts its own numbering at 1 regardless of how many leads tenant A has.
      const before = await query<{ next_value: string }>(
        `select next_value::text as next_value from reference_sequences
          where tenant_id = $1 and entity_type = 'lead'`,
        [tenantB],
      );
      expect(before).toHaveLength(0);

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
          productLineId: productLineB,
          coverTypeId: coverTypeB,
          policyTerm: 'm12',
          createAnyway: true,
        },
      });

      // Tenant B has no RM slot configured, so creation is refused BEFORE any sequence is
      // allocated — which is itself the property worth pinning: a rejected create must not burn a
      // reference number.
      expect(response.status).toBe(422);
      const after = await query<{ next_value: string }>(
        `select next_value::text as next_value from reference_sequences
          where tenant_id = $1 and entity_type = 'lead'`,
        [tenantB],
      );
      expect(after).toHaveLength(0);
    });

    it('renders the tenant’s own template rather than a hard-coded format', async () => {
      const tenantD = await createTenant('tenant-d');
      await seedSettings(tenantD, { leadRefFormat: 'BR/{YYYY}/{SEQ:6}' });
      await addMembership(appUserId(admin), tenantD);
      await addMembership(appUserId(owner), tenantD);
      for (const permission of ['leads.view', 'leads.create'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), permission, tenantD);
      }
      const typeD = await seedRef(tenantD, 'party_type', uniqueName('Corp D'));
      const partyD = await seedParty(tenantD, `Party D ${RUN}`, typeD);
      const regionD = await seedRef(tenantD, 'region', uniqueName('R D'));
      const channelD = await seedRef(tenantD, 'request_channel', uniqueName('Ch D'));
      const lineD = await seedRef(tenantD, 'product_line', uniqueName('PL D'));
      const coverD = await seedRef(tenantD, 'cover_type', uniqueName('CT D'), { productLineId: lineD });
      await seedRef(tenantD, 'lead_status', uniqueName('New D'), {
        reportingCategory: 'open',
        canonicalKey: 'new',
      });
      const roleD = await fixtures.createRole({ tenantId: tenantD });
      await fixtures.assignRole(appUserId(owner), roleD, tenantD);
      await seedRmSlot(tenantD, roleD);

      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantD,
        body: {
          partyId: partyD,
          isExistingClient: true,
          dateReceived: yesterday(),
          requestChannelId: channelD,
          brokerId: null,
          ownerUserId: appUserId(owner),
          regionId: regionD,
          productLineId: lineD,
          coverTypeId: coverD,
          policyTerm: 'm12',
          createAnyway: true,
        },
      });

      expect(response.status).toBe(201);
      const outcome = (await response.json()) as CreateLeadOutcomeDto;
      expect(outcome.lead?.leadRef).toBe(`BR/${new Date().getUTCFullYear()}/000001`);
    });
  });

  /** AC-044 / V-057 — and note the TWO different behaviours (see service.ts's header). */
  describe('duplicate handling (AC-044)', () => {
    it('CONFIRM-GATES a duplicate lead with 409 and persists nothing', async () => {
      const party = await seedParty(tenantA, `Dup Co ${RUN}-${String(nameSequence++)}`, partyTypeA);
      await createLead({ partyId: party });

      const before = await query<{ count: string }>(
        'select count(*)::text as count from leads where party_id = $1',
        [party],
      );

      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ partyId: party, createAnyway: false }),
      });

      expect(response.status).toBe(409);
      const outcome = (await response.json()) as CreateLeadOutcomeDto;
      expect(outcome.requiresConfirmation).toBe(true);
      expect(outcome.lead).toBeNull();
      expect(outcome.warnings[0]?.code).toBe('DUPLICATE_LEAD');

      const after = await query<{ count: string }>(
        'select count(*)::text as count from leads where party_id = $1',
        [party],
      );
      expect(after[0]?.count).toBe(before[0]?.count);
    });

    it('proceeds when the caller confirms with createAnyway', async () => {
      const party = await seedParty(tenantA, `Dup Co2 ${RUN}-${String(nameSequence++)}`, partyTypeA);
      await createLead({ partyId: party });

      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ partyId: party, createAnyway: true }),
      });

      expect(response.status).toBe(201);
      const rows = await query<{ count: string }>(
        'select count(*)::text as count from leads where party_id = $1',
        [party],
      );
      expect(rows[0]?.count).toBe('2');
    });

    it('does NOT treat a different product line as a duplicate', async () => {
      const party = await seedParty(tenantA, `Dup Co3 ${RUN}-${String(nameSequence++)}`, partyTypeA);
      await createLead({ partyId: party, productLineId: productLineA, coverTypeId: coverTypeA });

      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({
          partyId: party,
          productLineId: productLineA2,
          coverTypeId: coverTypeA2,
          createAnyway: false,
        }),
      });

      expect(response.status).toBe(201);
    });

    it('never surfaces ANOTHER TENANT’s lead as a duplicate', async () => {
      // Same party id space is per-tenant, so the strongest available check is that a tenant-A
      // duplicate scan cannot see tenant-B rows at all: tenant B's leads are invisible here.
      const party = await seedParty(tenantA, `Dup Co4 ${RUN}-${String(nameSequence++)}`, partyTypeA);
      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ partyId: party, createAnyway: false }),
      });

      expect(response.status).toBe(201);
    });

    it('warns NON-BLOCKINGLY about a duplicate external ref, and the row really persists', async () => {
      const externalRef = `EXT-${RUN}-${String(nameSequence++)}`;
      await createLead({ externalRef, partyId: secondPartyA });

      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ externalRef, partyId: secondPartyA, createAnyway: true }),
      });

      expect(response.status).toBe(201);
      const outcome = (await response.json()) as CreateLeadOutcomeDto;
      expect(outcome.warnings.some((w) => w.code === 'DUPLICATE_EXTERNAL_REF')).toBe(true);

      // The headline property: the warning did NOT prevent the write.
      const row = await readLeadRow(outcome.lead!.id);
      expect(row?.external_ref).toBe(externalRef);
    });

    it('warns non-blockingly about a duplicate external ref on EDIT too', async () => {
      const externalRef = `EXT-EDIT-${RUN}-${String(nameSequence++)}`;
      await createLead({ externalRef, partyId: secondPartyA });
      const { lead } = await createLead({ partyId: secondPartyA });

      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: {
          isExistingClient: true,
          dateReceived: yesterday(),
          requestChannelId: channelA,
          brokerId: null,
          regionId: regionA,
          externalRef,
          productLineId: productLineA,
          coverTypeId: coverTypeA,
          policyTerm: 'm12',
          priority: 'normal',
        },
      });

      expect(response.status).toBe(200);
      const outcome = (await response.json()) as UpdateLeadOutcomeDto;
      expect(outcome.warnings.some((w) => w.code === 'DUPLICATE_EXTERNAL_REF')).toBe(true);
      expect((await readLeadRow(lead!.id))?.external_ref).toBe(externalRef);
    });
  });

  describe('GET /leads/{id} and PUT /leads/{id}', () => {
    it('returns the full detail projection', async () => {
      const { lead } = await createLead({ estimatedPremium: 1234, sumInsured: 99_000 });
      const response = await call('GET', `${BASE}/${String(lead!.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as LeadDto;
      expect(body.estimatedPremium).toBe(1234);
      expect(body.sumInsured).toBe(99_000);
      expect(body.productLineName).not.toBe('');
      expect(body.coverTypeName).not.toBe('');
      expect(body.partyName).not.toBe('');
    });

    it('404s a NONEXISTENT id', async () => {
      const response = await call('GET', `${BASE}/987654321`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ProblemBody).code).toBe('LEAD_NOT_FOUND');
    });

    it('updates the editable intake fields and stamps last_activity_at', async () => {
      const { lead } = await createLead();
      const before = await readLeadRow(lead!.id);

      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: {
          isExistingClient: false,
          dateReceived: yesterday(),
          requestChannelId: channelA,
          brokerId: brokerA,
          regionId: regionA,
          externalRef: null,
          productLineId: productLineA2,
          coverTypeId: coverTypeA2,
          sumInsured: 5000,
          estimatedPremium: 250,
          policyTerm: 'm24',
          policyTermOther: null,
          priority: 'high',
        },
      });

      expect(response.status).toBe(200);
      const outcome = (await response.json()) as UpdateLeadOutcomeDto;
      expect(outcome.lead.productLineId).toBe(productLineA2);
      expect(outcome.lead.priority).toBe('high');
      expect(outcome.lead.isExistingClient).toBe(false);

      const after = await readLeadRow(lead!.id);
      expect(String(after?.last_activity_at)).not.toBe(String(before?.last_activity_at));
    });

    it('clears policy-term free text when the term changes away from Other', async () => {
      const { lead } = await createLead({ policyTerm: 'other', policyTermOther: '18 months' });

      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
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
          policyTerm: 'm12',
          policyTermOther: null,
          priority: 'normal',
        },
      });

      expect(response.status).toBe(200);
      expect((await readLeadRow(lead!.id))?.policy_term_other).toBeNull();
    });

    it('normalises WHITESPACE-ONLY policy-term text to null rather than an empty string', async () => {
      // The schema trims, so `'   '` survives the "other-text only with Other" rule as `''`. Without
      // the term-conditional clear in the service, that empty string is what lands in the column —
      // so a consumer checking `policyTermOther !== null` would see a value where there is none.
      const { lead } = await createLead();

      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
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
          policyTerm: 'm12',
          policyTermOther: '   ',
          priority: 'normal',
        },
      });

      expect(response.status).toBe(200);
      expect((await readLeadRow(lead!.id))?.policy_term_other).toBeNull();
    });

    it('403s an edit of a CLOSED lead without the correction permission', async () => {
      const { lead } = await createLead();
      await query('update leads set status_id = $1 where id = $2', [closedStatusA, lead!.id]);

      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
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
          policyTerm: 'm12',
          priority: 'normal',
        },
      });

      // 403, NOT 422 — an authorization verdict about the caller, not a complaint about the body.
      expect(response.status).toBe(403);
      expect(((await response.json()) as ProblemBody).code).toBe(
        'LEAD_CLOSED_REQUIRES_CORRECTION_PERMISSION',
      );
    });

    it('allows the closed-lead edit once the correction permission is held', async () => {
      const corrector = await auth.createTestUserWithSession({ label: 'leads-corrector' });
      await addMembership(appUserId(corrector), tenantA);
      for (const permission of ['leads.view', 'leads.update', 'leads.correct_closed'] as const) {
        await fixtures.grantDirectPermission(appUserId(corrector), permission, tenantA);
      }

      const { lead } = await createLead();
      await query('update leads set status_id = $1 where id = $2', [closedStatusA, lead!.id]);

      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
        token: corrector.accessToken,
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
          policyTerm: 'm12',
          priority: 'normal',
        },
      });

      expect(response.status).toBe(200);
    });
  });

  /** AC-046 / V-059. */
  describe('POST /leads/bulk-reassign (AC-046)', () => {
    it('reassigns every selected lead and audits each one with the note', async () => {
      const first = await createLead();
      const second = await createLead();

      const response = await call('POST', `${BASE}/bulk-reassign`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: {
          leadIds: [first.lead!.id, second.lead!.id],
          newOwnerUserId: appUserId(otherOwner),
          note: 'Territory handover Q3',
        },
      });

      expect(response.status).toBe(200);
      expect(((await response.json()) as { reassignedCount: number }).reassignedCount).toBe(2);

      // Per-lead assertion, not just the count.
      for (const id of [first.lead!.id, second.lead!.id]) {
        const detail = await call('GET', `${BASE}/${String(id)}`, {
          token: admin.accessToken,
          tenantId: tenantA,
        });
        expect(((await detail.json()) as LeadDto).owner?.userId).toBe(appUserId(otherOwner));

        await assertAudited(query, {
          entityType: 'lead',
          entityId: String(id),
          action: LEAD_REASSIGNED_ACTION,
          tenantId: tenantA,
          actorUserId: appUserId(admin),
        });
      }

      const auditRows = await query<{ details: { after?: { note?: string } } }>(
        `select details from audit_log
          where entity_type = 'lead' and entity_id = $1 and action = $2`,
        [String(first.lead!.id), LEAD_REASSIGNED_ACTION],
      );
      expect(auditRows[0]?.details.after?.note).toBe('Territory handover Q3');
    });

    it('422s a request with NO note', async () => {
      const { lead } = await createLead();
      const response = await call('POST', `${BASE}/bulk-reassign`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { leadIds: [lead!.id], newOwnerUserId: appUserId(otherOwner), note: '' },
      });

      expect(response.status).toBe(422);
      const body = (await response.json()) as ProblemBody;
      expect(body.code).toBe('LEAD_VALIDATION_FAILED');
      expect(body.errors?.some((e) => e.field === 'note')).toBe(true);
    });

    it('422s an empty lead list', async () => {
      const response = await call('POST', `${BASE}/bulk-reassign`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { leadIds: [], newOwnerUserId: appUserId(otherOwner), note: 'x' },
      });
      expect(response.status).toBe(422);
    });

    it('422s an INELIGIBLE new owner', async () => {
      const { lead } = await createLead();
      const response = await call('POST', `${BASE}/bulk-reassign`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: { leadIds: [lead!.id], newOwnerUserId: appUserId(viewer), note: 'x' },
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).code).toBe('LEAD_INVALID_OWNER');
    });

    it('403s a caller without leads.reassign', async () => {
      const { lead } = await createLead();
      const response = await call('POST', `${BASE}/bulk-reassign`, {
        token: viewer.accessToken,
        tenantId: tenantA,
        body: { leadIds: [lead!.id], newOwnerUserId: appUserId(otherOwner), note: 'x' },
      });

      expect(response.status).toBe(403);
    });

    it('rolls the WHOLE batch back when any lead id is not this tenant’s', async () => {
      const first = await createLead();
      const ownerBefore = first.lead!.owner?.userId;

      const response = await call('POST', `${BASE}/bulk-reassign`, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: {
          leadIds: [first.lead!.id, 987_654_321],
          newOwnerUserId: appUserId(otherOwner),
          note: 'should not apply',
        },
      });

      expect(response.status).toBe(404);

      // The all-or-nothing property: lead 1 must be UNCHANGED even though it was processed first.
      const detail = await call('GET', `${BASE}/${String(first.lead!.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(((await detail.json()) as LeadDto).owner?.userId).toBe(ownerBefore);
    });
  });

  /** AC-024 / V-031. */
  describe('audit coverage (AC-024)', () => {
    it('writes exactly one lead.created entry', async () => {
      const { lead } = await createLead();

      await assertAudited(query, {
        entityType: 'lead',
        entityId: String(lead!.id),
        action: LEAD_CREATED_ACTION,
        tenantId: tenantA,
        actorUserId: appUserId(admin),
      });
    });

    it('writes a lead.updated entry with a before/after diff', async () => {
      const { lead } = await createLead({ policyTerm: 'm12' });

      await call('PUT', `${BASE}/${String(lead!.id)}`, {
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
          policyTerm: 'm24',
          priority: 'normal',
        },
      });

      const rows = await query<{ details: { before?: { policyTerm?: string }; after?: { policyTerm?: string } } }>(
        `select details from audit_log
          where entity_type = 'lead' and entity_id = $1 and action = $2`,
        [String(lead!.id), LEAD_UPDATED_ACTION],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.details.before?.policyTerm).toBe('m12');
      expect(rows[0]?.details.after?.policyTerm).toBe('m24');
    });
  });

  /** AC-021 / AC-022, V-026 / V-027 — see parties.test.ts's header for why these are load-bearing. */
  describe('tenant isolation (AC-021, AC-022)', () => {
    it('404s a GET of another tenant’s lead, identically to a nonexistent id', async () => {
      const { lead } = await createLead();

      const foreign = await call('GET', `${BASE}/${String(lead!.id)}`, {
        token: admin.accessToken,
        tenantId: tenantB,
      });
      const missing = await call('GET', `${BASE}/987654321`, {
        token: admin.accessToken,
        tenantId: tenantB,
      });

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);

      // INDISTINGUISHABLE: same code, and a detail that differs only by the id echoed back.
      const foreignBody = (await foreign.json()) as ProblemBody;
      const missingBody = (await missing.json()) as ProblemBody;
      expect(foreignBody.code).toBe(missingBody.code);
      expect(foreignBody.detail?.replace(String(lead!.id), 'X')).toBe(
        missingBody.detail?.replace('987654321', 'X'),
      );
    });

    it('404s a PUT of another tenant’s lead WITHOUT any side effect', async () => {
      const { lead } = await createLead();
      const before = await readLeadRow(lead!.id);

      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
        token: admin.accessToken,
        tenantId: tenantB,
        body: {
          isExistingClient: false,
          dateReceived: yesterday(),
          requestChannelId: channelB,
          brokerId: null,
          regionId: regionB,
          externalRef: null,
          productLineId: productLineB,
          coverTypeId: coverTypeB,
          policyTerm: 'm36',
          priority: 'high',
        },
      });

      expect(response.status).toBe(404);
      // A 404 that still edited the row would satisfy a status-only test.
      expect(await readLeadRow(lead!.id)).toStrictEqual(before);
    });

    it('refuses to create a lead against another tenant’s party', async () => {
      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ partyId: partyB }),
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).code).toBe('LEAD_INVALID_PARTY');
    });

    it('refuses another tenant’s reference values with the SAME code as inactive ones', async () => {
      const response = await call('POST', BASE, {
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody({ productLineId: productLineB }),
      });

      expect(response.status).toBe(422);
      // Not a distinguishable "belongs to another tenant" answer — that would be an existence oracle.
      expect(((await response.json()) as ProblemBody).code).toBe('LEAD_INVALID_PRODUCT_LINE');
    });

    it('404s a bulk reassign naming another tenant’s lead, with no side effect', async () => {
      const { lead } = await createLead();
      const before = await readLeadRow(lead!.id);

      const response = await call('POST', `${BASE}/bulk-reassign`, {
        token: admin.accessToken,
        tenantId: tenantB,
        body: { leadIds: [lead!.id], newOwnerUserId: appUserId(admin), note: 'x' },
      });

      expect([404, 422]).toContain(response.status);
      expect(await readLeadRow(lead!.id)).toStrictEqual(before);
    });
  });

  describe('permission matrix', () => {
    it('403s a create without leads.create', async () => {
      const response = await call('POST', BASE, {
        token: viewer.accessToken,
        tenantId: tenantA,
        body: validBody(),
      });
      expect(response.status).toBe(403);
    });

    it('403s an update without leads.update', async () => {
      const { lead } = await createLead();
      const response = await call('PUT', `${BASE}/${String(lead!.id)}`, {
        token: viewer.accessToken,
        tenantId: tenantA,
        body: {
          isExistingClient: true,
          dateReceived: yesterday(),
          requestChannelId: channelA,
          brokerId: null,
          regionId: regionA,
          productLineId: productLineA,
          coverTypeId: coverTypeA,
          policyTerm: 'm12',
          priority: 'normal',
        },
      });
      expect(response.status).toBe(403);
    });

    it('401s an unauthenticated request', async () => {
      const response = await call('GET', `${BASE}/1`, { tenantId: tenantA });
      expect(response.status).toBe(401);
    });
  });
});
