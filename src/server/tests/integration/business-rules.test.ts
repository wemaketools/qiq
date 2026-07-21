/**
 * The tenant business-rules surface, end to end (T-020; AC-022, AC-024, AC-037; V-027, V-031,
 * V-048).
 *
 * Port of the reference's `BusinessRuleEndpointsTests`, and deliberately the same shape as
 * `reference-data.test.ts`: real signed-in sessions, real `tenants`/`user_tenants` rows, real
 * per-tenant partitions, real grants, the real Hono pipeline (auth -> tenant context -> permission
 * resolution -> routes) via `app.request`. Nothing is stubbed, because the properties under test —
 * tenant isolation and permission enforcement — are properties of the composed system.
 *
 * WHY THE ISOLATION TESTS HERE ARE LOAD-BEARING RATHER THAN BELT-AND-BRACES
 * ========================================================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20). There is no database-level
 * net beneath the tenant predicates in repository.ts, so the ONLY thing between tenant A's SLA
 * targets and tenant B's is application code plus the assertions below. This table is a
 * particularly unforgiving place to forget a predicate: `uq_tenant_settings_tenant_id` means there
 * is exactly one row per tenant, so an unscoped SELECT returns *someone's* plausible-looking
 * settings and an unscoped UPDATE rewrites EVERY tenant's thresholds in one statement. The
 * isolation test therefore asserts tenant B's stored row is byte-for-byte unchanged after a tenant
 * A write, not merely that tenant A's response looked right.
 *
 * WHAT THIS SUITE DOES *NOT* COVER, AND WHY
 * =========================================
 * V-048 also asks that changing a rule observably changes behaviour in the governed feature
 * (high-value classification, upload rejection boundary, pricing-gate legality, SLA/alert
 * outcomes, rendered lead refs). Every one of those consumers is explicitly `out_of_scope` for
 * T-020 ("Consumers of the rules (leads/workflow/jobs tasks)") and none of them exists yet. This
 * suite therefore pins the half T-020 owns — the values persist per tenant, survive a round trip,
 * are permission-bound and are audited — and the behavioural half lands with T-024+ against the
 * same settings. Flagged in the task file rather than faked here.
 *
 * This suite creates its own tenants (with their own partitions) and provisions their own settings
 * rows, so it never mutates the shared demo seed.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import {
  BUSINESS_RULES_DTO_FIELDS,
  DEFAULT_TENANT_SETTINGS,
  TENANT_SETTINGS_UPDATED_ACTION,
  getTenantSettings,
  type BusinessRulesDto,
} from '../../domains/business-rules/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, toTenantId, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('tenant business rules', probe);

const PATH = '/api/v1/settings/business-rules';

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

const RUN = `t020br-${process.pid}-${Date.now()}`;

/**
 * A complete, valid write payload. The endpoint is a FULL REPLACE (all 21 fields required), so
 * every test starts from a known-good body and mutates the one field under test — which is also
 * what stops a test from passing because some unrelated field happened to be invalid.
 */
function rulesPayload(overrides: Partial<BusinessRulesDto> = {}): Record<string, unknown> {
  return {
    currencyCode: 'ZAR',
    currencySymbol: 'R',
    maxAttachmentMb: 25,
    highValueThreshold: 500000.5,
    quoteExpiryAlertDays: 14,
    followUpOverdueGraceDays: 2,
    agingAmberDays: 5,
    agingRedDays: 12,
    unassignedLeadHours: 36,
    stalledLeadDays: 9,
    stalledQuoteDays: 11,
    duplicateCheckDays: 45,
    leadRefFormat: 'LX-{YYYY}-{SEQ:5}',
    quoteRefFormat: 'QX-{YYYY}-{SEQ:5}',
    leadInactivityExpiryDays: 90,
    pricingApprovalTargetDays: 4,
    slaAssignmentDays: 2,
    slaUnderwritingDays: 6,
    slaReceivedToSentDays: 8,
    requirePricingApprovalForHighValue: true,
    manualExternalRefEnabled: true,
    ...overrides,
  };
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds `business_rules.manage` in BOTH tenants and is a member of both. */
  let admin: TestUserSession;
  /** Member of tenant A with NO business-rules grant: the permission-matrix control. */
  let plainMember: TestUserSession;

  let tenantA: number;
  let tenantB: number;
  /** Provisioned WITHOUT a settings row, for the 404 provisioning-alarm case. */
  let tenantUnprovisioned: number;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) {
      throw new Error(`fixture user ${session.email} has no application users row`);
    }
    return Number(session.appUserId);
  }

  async function createTenant(label: string, provisionSettings = true): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-${label}`],
    );
    const id = Number(rows[0]?.id);
    createdTenants.push(id);
    // Partitions before any row, so this suite's rows land in the tenant's OWN partition rather
    // than the DEFAULT safety net — the same ordering tenant creation itself enforces.
    await query('select create_tenant_partitions($1)', [id]);

    if (provisionSettings) {
      // Exactly what tenants/service.ts's `provisionDefaultSettings` inserts: tenant + stamps only,
      // so every business-rule value comes from the COLUMN DEFAULTS. That is what makes the
      // defaults assertion below a real check of the migration rather than of this fixture.
      await query(
        `insert into tenant_settings (tenant_id, created_at, created_by, updated_at, updated_by)
         values ($1, now(), null, now(), null)`,
        [id],
      );
    }
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
      businessRules: { db },
    });
  }

  async function call(
    method: string,
    options: { token?: string; tenantId?: number; body?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    return await harness().request(`http://localhost${PATH}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  /** GET as the admin, asserting 200. */
  async function readRules(tenantId: number): Promise<BusinessRulesDto> {
    const response = await call('GET', { token: admin.accessToken, tenantId });
    expect(response.status).toBe(200);
    return (await response.json()) as BusinessRulesDto;
  }

  /** PUT as the admin, asserting 200. */
  async function writeRules(
    tenantId: number,
    body: Record<string, unknown>,
  ): Promise<BusinessRulesDto> {
    const response = await call('PUT', { token: admin.accessToken, tenantId, body });
    expect(response.status).toBe(200);
    return (await response.json()) as BusinessRulesDto;
  }

  /** PUT expecting a failure; returns the problem body so the CODE and message can be asserted. */
  async function writeExpectingProblem(
    tenantId: number,
    body: Record<string, unknown>,
    expectedStatus: number,
  ): Promise<ProblemBody> {
    const response = await call('PUT', { token: admin.accessToken, tenantId, body });
    expect(response.status).toBe(expectedStatus);
    return (await response.json()) as ProblemBody;
  }

  /** Reads the stored row straight from the database — the side-effect check the API cannot fake. */
  async function readStoredRow(tenantId: number): Promise<Record<string, unknown>> {
    const rows = await query<Record<string, unknown>>(
      `select currency_code, currency_symbol, max_attachment_mb, high_value_threshold::text as high_value_threshold,
              quote_expiry_alert_days, follow_up_overdue_grace_days, aging_amber_days, aging_red_days,
              unassigned_lead_hours, stalled_lead_days, stalled_quote_days, duplicate_check_days,
              lead_ref_format, quote_ref_format, lead_inactivity_expiry_days, pricing_approval_target_days,
              sla_assignment_days, sla_underwriting_days, sla_received_to_sent_days,
              require_pricing_approval_for_high_value, manual_external_ref_enabled,
              expire_lead_when_last_quote_expires, updated_by::text as updated_by
         from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no tenant_settings row for tenant ${String(tenantId)}`);
    return row;
  }

  async function clearAuditRows(): Promise<void> {
    for (const tenantId of createdTenants) {
      await query('delete from audit_log where action = $1 and tenant_id = $2', [
        TENANT_SETTINGS_UPDATED_ACTION,
        tenantId,
      ]).catch(() => undefined);
    }
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

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');
    tenantUnprovisioned = await createTenant('tenant-unprovisioned', false);

    admin = await auth.createTestUserWithSession({ label: 'rules-admin' });
    plainMember = await auth.createTestUserWithSession({ label: 'rules-member' });

    await addMembership(appUserId(admin), tenantA);
    await addMembership(appUserId(admin), tenantB);
    await addMembership(appUserId(admin), tenantUnprovisioned);
    await addMembership(appUserId(plainMember), tenantA);

    await fixtures.grantDirectPermission(appUserId(admin), 'business_rules.manage', tenantA);
    await fixtures.grantDirectPermission(appUserId(admin), 'business_rules.manage', tenantB);
    await fixtures.grantDirectPermission(
      appUserId(admin),
      'business_rules.manage',
      tenantUnprovisioned,
    );
    // A DIFFERENT permission: proves the guard checks the required code, not "any grant at all".
    // `business_rules.view` specifically, because that is the permission the reference USED to gate
    // the GET with — holding it must not confer the manage right.
    await fixtures.grantDirectPermission(appUserId(plainMember), 'business_rules.view', tenantA);
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await clearAuditRows();
    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on (tests/helpers/auth.ts), and every delete here swallows its error, so the reverse order
    // is a silent no-op that leaks this suite's tenants and audit rows into the next run.
    for (const tenantId of createdTenants) {
      await query('delete from tenant_settings where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      await query('delete from audit_log where tenant_id = $1', [tenantId]).catch(() => undefined);
      await query('delete from user_tenants where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 180_000);

  // -------------------------------------------------------------------------------------------
  // Contract: DTO shape and provisioning defaults
  // -------------------------------------------------------------------------------------------

  it('returns exactly the reference BusinessRulesDto field set, no more and no less', async () => {
    const rules = await readRules(tenantB);

    // Field-for-field with BusinessRulesDto.cs:7-27 / the SPA's FullBusinessRulesDto. An EXTRA
    // field here would be an unapproved contract widening (spec A-3); a missing one breaks the
    // Settings screen, which PUTs back the DTO it last read.
    expect(Object.keys(rules).sort()).toEqual([...BUSINESS_RULES_DTO_FIELDS].sort());
    expect(BUSINESS_RULES_DTO_FIELDS).toHaveLength(21);
  });

  it('does not expose expireLeadWhenLastQuoteExpires, which the reference DTO omits', async () => {
    // The column exists and the settings READER surfaces it, but the wire contract does not — the
    // reference has no way to read or set it through this endpoint (schemas.ts).
    const rules = await readRules(tenantB);
    expect(Object.hasOwn(rules, 'expireLeadWhenLastQuoteExpires')).toBe(false);
  });

  it('serves a freshly provisioned tenant the documented column defaults', async () => {
    // The migration documents these as kept 1:1 with the .NET property initialisers, and tenant
    // provisioning inserts the row from application code WITHOUT naming any of them — so a drifted
    // column default would silently give tenants different rules depending on which path made them.
    // Built by projecting the DTO's own field list off the defaults, so this compares exactly the
    // 21 wire fields against the documented provisioning baseline.
    const expected = Object.fromEntries(
      BUSINESS_RULES_DTO_FIELDS.map((field) => [field, DEFAULT_TENANT_SETTINGS[field]]),
    );
    expect(await readRules(tenantB)).toEqual(expected);
  });

  it('renders the numeric high-value threshold as a JSON number, not a string', async () => {
    // `numeric` arrives from node-postgres as a string; the reference sent `decimal?` as a JSON
    // number and the SPA declares `number | null`. A leaked string would type-check everywhere and
    // then compare wrongly at the first `>` in high-value classification.
    const updated = await writeRules(tenantA, rulesPayload({ highValueThreshold: 250000.75 }));
    expect(updated.highValueThreshold).toBe(250000.75);
    expect(typeof updated.highValueThreshold).toBe('number');
    await clearAuditRows();
  });

  it('keeps a null high-value threshold distinct from zero', async () => {
    // Null means "this tenant has no high-value classification"; zero would mean "every lead is
    // high-value". The column is nullable precisely for this distinction.
    const updated = await writeRules(tenantA, rulesPayload({ highValueThreshold: null }));
    expect(updated.highValueThreshold).toBeNull();

    const stored = await readStoredRow(tenantA);
    expect(stored['high_value_threshold']).toBeNull();
    await clearAuditRows();
  });

  // -------------------------------------------------------------------------------------------
  // Round trip
  // -------------------------------------------------------------------------------------------

  it('persists every field of a PUT and reads the same values back', async () => {
    const payload = rulesPayload();
    const written = await writeRules(tenantA, payload);

    // The response is the STORED row, not an echo — asserted by re-reading through a fresh request.
    expect(written).toEqual(payload);
    expect(await readRules(tenantA)).toEqual(payload);
    await clearAuditRows();
  });

  it('stamps updated_by with the acting user', async () => {
    await writeRules(tenantA, rulesPayload({ slaAssignmentDays: 3 }));
    const stored = await readStoredRow(tenantA);
    expect(stored['updated_by']).toBe(String(appUserId(admin)));
    await clearAuditRows();
  });

  it('accepts followUpOverdueGraceDays of zero, which every other threshold rejects', async () => {
    // The one GreaterThanOrEqualTo(0) rule in the reference validator, matching its column default.
    const written = await writeRules(tenantA, rulesPayload({ followUpOverdueGraceDays: 0 }));
    expect(written.followUpOverdueGraceDays).toBe(0);
    await clearAuditRows();
  });

  // -------------------------------------------------------------------------------------------
  // Validation — status AND code AND message, never status alone
  // -------------------------------------------------------------------------------------------

  it('rejects a non-positive threshold with 422 and the reference code and message', async () => {
    const problem = await writeExpectingProblem(
      tenantA,
      rulesPayload({ stalledLeadDays: -1 }),
      422,
    );

    expect(problem.code).toBe('BUSINESS_RULES_VALIDATION_FAILED');
    expect(problem.detail).toContain('BUSINESS_RULES_VALIDATION_FAILED:');
    expect(problem.detail).toContain("'Stalled Lead Days' must be greater than '0'.");
    expect(problem.errors?.map((error) => error.field)).toContain('stalledLeadDays');
  });

  it('rejects a zero threshold, not merely a negative one', async () => {
    const problem = await writeExpectingProblem(tenantA, rulesPayload({ agingAmberDays: 0 }), 422);
    expect(problem.code).toBe('BUSINESS_RULES_VALIDATION_FAILED');
    expect(problem.detail).toContain("'Aging Amber Days' must be greater than '0'.");
  });

  it('rejects a non-positive high-value threshold while still allowing null', async () => {
    const problem = await writeExpectingProblem(
      tenantA,
      rulesPayload({ highValueThreshold: 0 }),
      422,
    );
    expect(problem.code).toBe('BUSINESS_RULES_VALIDATION_FAILED');
    expect(problem.detail).toContain("'High Value Threshold' must be greater than '0'.");
  });

  it.each([
    ['bwp', 'lower case'],
    ['BW', 'two letters'],
    ['BWPP', 'four letters'],
    ['B W', 'a space'],
    ['', 'empty'],
  ])('rejects the currency code %j (%s) with the reference message', async (currencyCode) => {
    const problem = await writeExpectingProblem(tenantA, rulesPayload({ currencyCode }), 422);

    expect(problem.code).toBe('BUSINESS_RULES_VALIDATION_FAILED');
    expect(problem.detail).toContain(
      "Currency code must be a 3-letter ISO-4217-shaped code (e.g. 'BWP').",
    );
  });

  it('accepts a well-formed but non-existent ISO code, matching the reference shape-only rule', async () => {
    // UpdateBusinessRulesValidator.cs:8-10 calls this an explicit scope boundary. Tightening it
    // would reject codes an existing tenant may already have stored.
    const written = await writeRules(tenantA, rulesPayload({ currencyCode: 'ZZZ' }));
    expect(written.currencyCode).toBe('ZZZ');
    await clearAuditRows();
  });

  it('rejects an empty currency symbol and one longer than 10 characters', async () => {
    const empty = await writeExpectingProblem(tenantA, rulesPayload({ currencySymbol: '' }), 422);
    expect(empty.detail).toContain("'Currency Symbol' must not be empty.");

    const long = await writeExpectingProblem(
      tenantA,
      rulesPayload({ currencySymbol: 'X'.repeat(11) }),
      422,
    );
    expect(long.detail).toContain("'Currency Symbol' must be 10 characters or fewer.");
  });

  it('rejects an oversized attachment cap that the integer column could not store', async () => {
    // TARGET-ONLY HARDENING (schemas.ts): the reference validated only `GreaterThan(0)`, so a value
    // above the int32 ceiling passed validation and then failed in the database as an unmapped 500.
    // No request that SUCCEEDED against the reference is affected.
    const problem = await writeExpectingProblem(
      tenantA,
      rulesPayload({ maxAttachmentMb: 2_147_483_648 }),
      422,
    );

    expect(problem.code).toBe('BUSINESS_RULES_VALIDATION_FAILED');
    expect(problem.detail).toContain("'Max Attachment Mb' must be 2147483647 or fewer.");
  });

  it('rejects a zero or negative attachment cap', async () => {
    const problem = await writeExpectingProblem(tenantA, rulesPayload({ maxAttachmentMb: 0 }), 422);
    expect(problem.detail).toContain("'Max Attachment Mb' must be greater than '0'.");
  });

  it('rejects an aging red threshold that is not strictly above amber', async () => {
    // Amber >= red makes the amber bucket unreachable: every aging lead jumps straight to red and
    // the amber SLA signal silently disappears from every dashboard.
    const equal = await writeExpectingProblem(
      tenantA,
      rulesPayload({ agingAmberDays: 10, agingRedDays: 10 }),
      422,
    );
    expect(equal.detail).toContain(
      'Aging red threshold must be greater than the aging amber threshold.',
    );

    const inverted = await writeExpectingProblem(
      tenantA,
      rulesPayload({ agingAmberDays: 15, agingRedDays: 3 }),
      422,
    );
    expect(inverted.detail).toContain(
      'Aging red threshold must be greater than the aging amber threshold.',
    );
  });

  it('rejects a reference format with an unknown token, naming the token', async () => {
    const problem = await writeExpectingProblem(
      tenantA,
      rulesPayload({ leadRefFormat: 'L-{BRANCH}-{SEQ:4}' }),
      422,
    );

    expect(problem.code).toBe('BUSINESS_RULES_VALIDATION_FAILED');
    expect(problem.detail).toContain("Unknown reference format token '{BRANCH}'.");
  });

  it('rejects a reference format with no sequence token', async () => {
    // Without a sequence every lead in the tenant would share one reference.
    const problem = await writeExpectingProblem(
      tenantA,
      rulesPayload({ quoteRefFormat: 'Q-{YYYY}' }),
      422,
    );
    expect(problem.detail).toContain('Reference format must include a {SEQ:n} token.');
  });

  it('rejects a partial body rather than silently resetting the omitted fields', async () => {
    // The dangerous case is `followUpOverdueGraceDays`, whose legal value includes 0: under C#
    // binding an omitted field would have quietly RESET a tenant's configured grace period.
    const problem = await writeExpectingProblem(
      tenantA,
      { currencyCode: 'BWP', currencySymbol: 'P' },
      422,
    );

    expect(problem.code).toBe('BUSINESS_RULES_VALIDATION_FAILED');
    expect(problem.errors?.map((error) => error.field)).toContain('followUpOverdueGraceDays');
  });

  it('answers 400, not 422, for a body that is not JSON at all', async () => {
    const response = await harness().request(`http://localhost${PATH}`, {
      method: 'PUT',
      headers: new Headers({
        authorization: `Bearer ${admin.accessToken}`,
        'x-tenant-id': String(tenantA),
        'content-type': 'application/json',
      }),
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('leaves the stored row untouched when validation fails', async () => {
    // A 422 that had already written would be invisible to a status-code-only test.
    const before = await readStoredRow(tenantA);
    await writeExpectingProblem(tenantA, rulesPayload({ slaUnderwritingDays: -5 }), 422);
    expect(await readStoredRow(tenantA)).toEqual(before);
  });

  it('writes no audit row when validation fails', async () => {
    await clearAuditRows();
    await writeExpectingProblem(tenantA, rulesPayload({ duplicateCheckDays: 0 }), 422);

    const rows = await findAuditRows(query, {
      action: TENANT_SETTINGS_UPDATED_ACTION,
      tenantId: tenantA,
    });
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // Permission matrix
  // -------------------------------------------------------------------------------------------

  it('lets a plain tenant member READ the rules with no business-rules grant', async () => {
    // The 2026-07-13 fix (BusinessRuleEndpoints.cs:13-22): aging thresholds and SLA windows drive
    // list/detail rendering for every member, so gating the GET made non-admins fall back to
    // hard-coded defaults and 403'd the lead form. Re-adding the gate would re-break that.
    const response = await call('GET', { token: plainMember.accessToken, tenantId: tenantA });
    expect(response.status).toBe(200);
  });

  it('refuses a plain tenant member the WRITE, even holding business_rules.view', async () => {
    const response = await call('PUT', {
      token: plainMember.accessToken,
      tenantId: tenantA,
      body: rulesPayload(),
    });

    expect(response.status).toBe(403);
  });

  it('leaves the stored row untouched after a forbidden write', async () => {
    const before = await readStoredRow(tenantA);
    await call('PUT', {
      token: plainMember.accessToken,
      tenantId: tenantA,
      body: rulesPayload({ currencyCode: 'XXX', currencySymbol: 'X' }),
    });
    expect(await readStoredRow(tenantA)).toEqual(before);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await call('GET', { tenantId: tenantA })).status).toBe(401);
    expect((await call('PUT', { tenantId: tenantA, body: rulesPayload() })).status).toBe(401);
  });

  it('refuses a request with no tenant header on this tenant-scoped route', async () => {
    // `/settings/*` is not on GLOBAL_ROUTE_PREFIXES, so the T-013 middleware demands a verified
    // X-Tenant-Id before any handler runs. Without this the handler would have no tenant to scope by.
    //
    // 403 with the UNIFORM denial message, not 400 (tenancy/middleware.ts:116-134): a missing
    // header, a malformed one, a nonexistent tenant, a soft-deleted one and plain non-membership
    // all answer identically, so this endpoint cannot be used to enumerate tenants.
    const response = await call('GET', { token: admin.accessToken });
    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation (AC-022, V-027) — the load-bearing assertions
  // -------------------------------------------------------------------------------------------

  it('does not let a tenant-A write touch tenant B, asserted against the stored row', async () => {
    const tenantBBefore = await readStoredRow(tenantB);

    await writeRules(
      tenantA,
      rulesPayload({ currencyCode: 'AAA', currencySymbol: 'A', stalledQuoteDays: 21 }),
    );

    // Byte-for-byte: an unscoped UPDATE would have rewritten every tenant's row in one statement
    // and tenant A's own response would still have looked perfectly correct.
    expect(await readStoredRow(tenantB)).toEqual(tenantBBefore);
    await clearAuditRows();
  });

  it('serves each tenant its own values from the same endpoint', async () => {
    await writeRules(tenantA, rulesPayload({ currencyCode: 'AAA', currencySymbol: 'A' }));
    await writeRules(tenantB, rulesPayload({ currencyCode: 'BBB', currencySymbol: 'B' }));

    expect((await readRules(tenantA)).currencyCode).toBe('AAA');
    expect((await readRules(tenantB)).currencyCode).toBe('BBB');
    await clearAuditRows();
  });

  it('refuses a caller who is not a member of the tenant they name', async () => {
    // plainMember belongs to tenant A only. Naming tenant B must not reach the handler at all —
    // and must NOT reveal whether tenant B exists.
    const response = await call('GET', { token: plainMember.accessToken, tenantId: tenantB });
    expect(response.status).toBe(403);
  });

  it('audits the tenant the change was made in, not merely that a change happened', async () => {
    await clearAuditRows();
    await writeRules(tenantA, rulesPayload({ slaReceivedToSentDays: 9 }));

    const rowsInB = await findAuditRows(query, {
      action: TENANT_SETTINGS_UPDATED_ACTION,
      tenantId: tenantB,
    });
    expect(rowsInB).toHaveLength(0);
    await clearAuditRows();
  });

  // -------------------------------------------------------------------------------------------
  // Audit (AC-024, V-031)
  // -------------------------------------------------------------------------------------------

  it('writes exactly one audit row per update, with the real before and after state', async () => {
    await clearAuditRows();

    const before = await readRules(tenantA);
    const payload = rulesPayload({ currencyCode: 'GBP', currencySymbol: '£', agingAmberDays: 4, agingRedDays: 40 });
    const after = await writeRules(tenantA, payload);

    // `assertAudited` insists on EXACTLY ONE row, so a double-write cannot pass. The before/after
    // halves are pinned to the actual pre- and post-state rather than merely being present:
    // a payload echoing the REQUEST on both halves would satisfy a presence-only check.
    await assertAudited(query, {
      action: TENANT_SETTINGS_UPDATED_ACTION,
      entityType: 'tenant_settings',
      entityId: String(tenantA),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: { ...before },
      after: { ...after },
    });

    await clearAuditRows();
  });

  it('records all 21 fields on both audit halves, not a diff', async () => {
    await clearAuditRows();
    await writeRules(tenantA, rulesPayload({ unassignedLeadHours: 48 }));

    const rows = await findAuditRows(query, {
      action: TENANT_SETTINGS_UPDATED_ACTION,
      tenantId: tenantA,
    });
    const details = rows[0]?.details as { before: object; after: object };

    // Twenty-one interacting thresholds are only interpretable together: "agingRedDays moved to 40"
    // means nothing without the amber value it must stay above.
    expect(Object.keys(details.before).sort()).toEqual([...BUSINESS_RULES_DTO_FIELDS].sort());
    expect(Object.keys(details.after).sort()).toEqual([...BUSINESS_RULES_DTO_FIELDS].sort());
    await clearAuditRows();
  });

  // -------------------------------------------------------------------------------------------
  // The missing-settings-row provisioning alarm
  // -------------------------------------------------------------------------------------------

  it('answers 404 with the reference code when a tenant has no settings row', async () => {
    // Every tenant is provisioned one inside the tenant-creation transaction, so this can only
    // happen if provisioning was bypassed. Preserved as a 404 rather than materialising a defaults
    // row on read, which would hide the provisioning bug that produced it.
    const response = await call('GET', {
      token: admin.accessToken,
      tenantId: tenantUnprovisioned,
    });

    expect(response.status).toBe(404);
    const problem = (await response.json()) as ProblemBody;
    expect(problem.code).toBe('BUSINESS_RULES_NOT_FOUND');
    expect(problem.detail).toContain('This tenant has no business-rules settings row.');
  });

  it('answers 404 on the WRITE path too, rather than creating the missing row', async () => {
    const problem = await writeExpectingProblem(tenantUnprovisioned, rulesPayload(), 404);
    expect(problem.code).toBe('BUSINESS_RULES_NOT_FOUND');

    const rows = await query('select 1 from tenant_settings where tenant_id = $1', [
      tenantUnprovisioned,
    ]);
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // The server-side settings reader (the seam T-024+ consume)
  // -------------------------------------------------------------------------------------------

  it('reads a tenant its own settings through getTenantSettings, including the server-only field', async () => {
    await writeRules(tenantA, rulesPayload({ duplicateCheckDays: 33 }));

    const settings = await getTenantSettings(db, toTenantId(tenantA));
    expect(settings.duplicateCheckDays).toBe(33);
    // The field the wire DTO deliberately omits is reachable here, which is the whole point of the
    // reader being a separate type from the DTO.
    expect(settings.expireLeadWhenLastQuoteExpires).toBe(false);
    await clearAuditRows();
  });

  it('scopes the settings reader by tenant', async () => {
    await writeRules(tenantA, rulesPayload({ currencyCode: 'AAA', currencySymbol: 'A' }));
    await writeRules(tenantB, rulesPayload({ currencyCode: 'BBB', currencySymbol: 'B' }));

    expect((await getTenantSettings(db, toTenantId(tenantA))).currencyCode).toBe('AAA');
    expect((await getTenantSettings(db, toTenantId(tenantB))).currencyCode).toBe('BBB');
    await clearAuditRows();
  });

  it('throws rather than inventing defaults when the settings row is missing', async () => {
    // A defaults fallback would let a tenant whose provisioning silently failed keep running on
    // DIFFERENT thresholds from the ones its Settings screen reports (which 404s) — a
    // data-correctness bug wearing a working system's clothes.
    await expect(getTenantSettings(db, toTenantId(tenantUnprovisioned))).rejects.toThrow(
      /has no tenant_settings row/,
    );
  });
});
