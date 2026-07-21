/**
 * Server-to-server lead intake, end to end (T-030; AC-061; V-077, V-078).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/Intake/IntakeEndpointTests.cs` onto the Q-19 reshape
 * (Keycloak client-credentials tokens -> first-party hashed API keys). Same shape as
 * `api-access.test.ts` and `leads-core.test.ts`: real tenants and partitions, real credentials
 * issued through the real T-022 admin endpoints, the real Hono pipeline via `app.request`. Nothing
 * is stubbed, because every property under test — that the tenant comes from the credential row,
 * that four different rejections are indistinguishable, that a lead physically lands in the right
 * partition — is a property of the composed system plus the database.
 *
 * THE 401 MATRIX ASSERTS BODIES, NOT STATUSES
 * ===========================================
 * Every authentication failure here is a 401 BY DESIGN, so a status-only assertion proves nothing:
 * five handlers each returning a differently-worded 401 would pass it while leaking the entire
 * enumeration oracle the design exists to close. `expectIdenticalRejections` compares the full
 * response bodies byte for byte (modulo the per-request `correlationId`) across all five ways to
 * fail. That is the security property, so that is what is asserted.
 *
 * AND THE SCOPING ASSERTIONS READ THE `leads` ROW, NOT THE RESPONSE
 * ================================================================
 * "The stored lead always carries the credential's tenant and broker" (V-078) is unobservable
 * through this endpoint by construction — the 201 carries only an id and a ref. Every scoping claim
 * below therefore queries the actual row.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LEAD_CREATED_ACTION } from '../../domains/leads/service.js';
import {
  API_KEY_HEADER,
  BROKER_NOT_ALLOWED_CODE,
  DUPLICATE_LEADS_CODE,
  INTAKE_UNAUTHORIZED_CODE,
  INTAKE_UNAUTHORIZED_MESSAGE,
} from '../../domains/intake/index.js';
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
const title = suiteTitle('intake', probe);

const INTAKE = '/api/v1/intake/leads';
const CREDENTIALS = '/api/v1/settings/api-credentials';

/** The pepper this suite's app is built with, so issued keys verify against the same secret. */
const PEPPER = 'local-api-key-pepper-value';

interface IntakeOutcome {
  readonly leadId: number;
  readonly leadRef: string;
  readonly warnings: readonly { code: string; details: Record<string, unknown> }[];
}

interface ProblemBody {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
  readonly correlationId?: string;
}

interface CredentialSecretDto {
  readonly credential: { id: number; brokerId: number | null; clientId: string; status: string };
  readonly clientId: string;
  readonly secret: string;
}

/** SHORT per-run marker — a long shared token skews the trigram party-name matching. */
const RUN = `t030-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
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

  /** Provisions credentials in both tenants; also the only session this suite ever signs in with. */
  let admin: TestUserSession;
  /** Member of tenant A holding the RM role, so it is an eligible accountable owner. */
  let owner: TestUserSession;
  /** Member of tenant A who does NOT hold the RM role: the ineligible-owner control. */
  let stranger: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;
  let rmRoleId = 0;

  /** Every log line the app emitted during this run, for the no-key-material scan. */
  const logLines: string[] = [];

  const createdTenants: number[] = [];

  const OWNED_TABLES = [
    'lead_notes',
    'lead_assignments',
    'leads',
    'reference_sequences',
    'business_assignments',
    'api_credentials',
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
      "select id::text as id from tenants where name like 't030-%'",
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
      canonicalKey?: string | null;
      reportingCategory?: string | null;
      isBrokerChannel?: boolean | null;
      productLineId?: number | null;
    } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          is_broker_channel, product_line_id, is_terminal, created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, $6, $7, false, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.isBrokerChannel ?? null,
        options.productLineId ?? null,
      ],
    );
    return Number(rows[0]?.id);
  }

  async function seedParty(tenantId: number, partyTypeId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, uniqueName('Party'), partyTypeId],
    );
    return Number(rows[0]?.id);
  }

  async function seedBroker(tenantId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into brokers (tenant_id, name, status, created_at, updated_at)
       values ($1, $2, 'active', now(), now()) returning id::text as id`,
      [tenantId, uniqueName('Broker')],
    );
    return Number(rows[0]?.id);
  }

  async function seedRmSlot(tenantId: number, roleId: number): Promise<void> {
    await query(
      `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
       values ($1, 'rm', $2, now(), now())`,
      [tenantId, roleId],
    );
  }

  function harness(): ApiApp {
    return buildApp({
      config,
      loggerOptions: {
        sink: (line: unknown) => {
          logLines.push(typeof line === 'string' ? line : JSON.stringify(line));
        },
      },
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
      apiAccess: { db, apiKeyPepper: PEPPER },
      leads: { db },
      intake: { apiAccess: { db, apiKeyPepper: PEPPER }, leads: { db } },
    });
  }

  /** A session-authenticated admin call, used ONLY to issue credentials through T-022. */
  async function adminCall(
    method: string,
    path: string,
    tenantId: number,
  ): Promise<Response> {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${admin.accessToken}`);
    headers.set('x-tenant-id', String(tenantId));
    return await harness().request(`http://localhost${path}`, { method, headers });
  }

  /**
   * An INTAKE call. Carries the API key and NOTHING ELSE by default — no bearer token and no
   * `X-Tenant-Id`, which is the point of V-077's second expected result.
   */
  async function intakeCall(
    options: { key?: string; body?: unknown; token?: string; tenantId?: number } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.key !== undefined) headers.set(API_KEY_HEADER, options.key);
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    headers.set('content-type', 'application/json');

    return await harness().request(`http://localhost${INTAKE}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? {}),
    });
  }

  /**
   * Issues (or re-uses) a credential for a scope.
   *
   * MEMOIZED because T-022 enforces ONE credential per scope: a second provision for the same
   * tenant+broker answers 409 by design. The shared tenants A and B are therefore issued their key
   * once and every test re-presents it; a test that needs a credential in a particular STATE
   * (disabled, rotated) uses `freshTenant()` so it cannot disturb its neighbours.
   */
  const credentialCache = new Map<string, CredentialSecretDto>();

  async function provision(tenantId: number, brokerId?: number): Promise<CredentialSecretDto> {
    const cacheKey = `${String(tenantId)}:${brokerId === undefined ? 'tenant' : String(brokerId)}`;
    const cached = credentialCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const path = brokerId === undefined ? CREDENTIALS : `${CREDENTIALS}/broker/${brokerId}`;
    const response = await adminCall('POST', path, tenantId);
    expect(response.status, `provision failed: ${await response.clone().text()}`).toBe(201);

    const issued = (await response.json()) as CredentialSecretDto;
    credentialCache.set(cacheKey, issued);
    return issued;
  }

  // Seeded tenant-A reference fixtures.
  let partyTypeA = 0;
  let regionA = 0;
  let channelA = 0;
  let brokerChannelA = 0;
  let productLineA = 0;
  let coverTypeA = 0;
  let brokerA = 0;
  let otherBrokerA = 0;
  let partyA = 0;
  let duplicatePartyA = 0;

  // Tenant-B fixtures, for the cross-tenant assertions.
  let partyTypeB = 0;
  let regionB = 0;
  let productLineB = 0;
  let coverTypeB = 0;
  let partyB = 0;
  let brokerB = 0;

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
      ...overrides,
    };
  }

  interface LeadRow extends Record<string, unknown> {
    readonly id: string;
    readonly tenant_id: string;
    readonly broker_id: string | null;
    readonly source: string;
    readonly intake_credential_id: string | null;
    readonly created_by: string | null;
    readonly lead_ref: string;
    readonly party_id: string;
  }

  async function readLeadRow(id: number): Promise<LeadRow> {
    const rows = await query<LeadRow>(
      `select id::text as id, tenant_id::text as tenant_id, broker_id::text as broker_id,
              source, intake_credential_id::text as intake_credential_id,
              created_by::text as created_by, lead_ref, party_id::text as party_id
         from leads where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`lead ${String(id)} not found`);
    return row;
  }

  async function countLeads(tenantId: number): Promise<number> {
    const rows = await query<{ count: string }>(
      'select count(*)::text as count from leads where tenant_id = $1',
      [tenantId],
    );
    return Number(rows[0]?.count ?? '0');
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
      API_KEY_PEPPER: PEPPER,
    });

    auth = new TestAuthFixtures(stack);
    fixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));

    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    pgLookup = createPgAppUserLookup(config);

    await purgeStaleRunsOfThisSuite();

    tenantA = await createTenant('a');
    tenantB = await createTenant('b');
    await seedSettings(tenantA);
    await seedSettings(tenantB);

    admin = await auth.createTestUserWithSession({ label: 'intake-admin' });
    owner = await auth.createTestUserWithSession({ label: 'intake-owner' });
    stranger = await auth.createTestUserWithSession({ label: 'intake-stranger' });

    for (const tenantId of [tenantA, tenantB]) {
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.disable', tenantId);
      await fixtures.grantDirectPermission(
        appUserId(admin),
        'api_access.regenerate_secret',
        tenantId,
      );
    }
    await addMembership(appUserId(owner), tenantA);
    await addMembership(appUserId(stranger), tenantA);

    // The RM slot decides who may be an accountable owner: `owner` holds the role, `stranger` does
    // not, which is what makes the ineligible-owner 422 a real check rather than a missing-user one.
    rmRoleId = await fixtures.createRole({ tenantId: tenantA });
    await fixtures.assignRole(appUserId(owner), rmRoleId, tenantA);
    await seedRmSlot(tenantA, rmRoleId);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp'));
    regionA = await seedRef(tenantA, 'region', uniqueName('North'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email'));
    brokerChannelA = await seedRef(tenantA, 'request_channel', uniqueName('BrokerCh'), {
      isBrokerChannel: true,
    });
    productLineA = await seedRef(tenantA, 'product_line', uniqueName('Motor'));
    coverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Comp'), {
      productLineId: productLineA,
    });
    await seedRef(tenantA, 'lead_status', uniqueName('New'), {
      canonicalKey: 'new',
      reportingCategory: 'open',
    });
    brokerA = await seedBroker(tenantA);
    otherBrokerA = await seedBroker(tenantA);
    partyA = await seedParty(tenantA, partyTypeA);
    duplicatePartyA = await seedParty(tenantA, partyTypeA);

    partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('CorpB'));
    regionB = await seedRef(tenantB, 'region', uniqueName('SouthB'));
    productLineB = await seedRef(tenantB, 'product_line', uniqueName('MotorB'));
    coverTypeB = await seedRef(tenantB, 'cover_type', uniqueName('CompB'), {
      productLineId: productLineB,
    });
    await seedRef(tenantB, 'request_channel', uniqueName('EmailB'));
    await seedRef(tenantB, 'lead_status', uniqueName('NewB'), {
      canonicalKey: 'new',
      reportingCategory: 'open',
    });
    brokerB = await seedBroker(tenantB);
    partyB = await seedParty(tenantB, partyTypeB);
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant data BEFORE `auth.cleanup()`: that call ends the pg pool these deletes run on, and
    // every delete swallows its error, so the reverse order is a SILENT no-op that leaks this
    // suite's tenants, leads, credentials and audit rows into the next run.
    for (const tenantId of createdTenants) await deleteTenantData(tenantId);

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 180_000);

  // -----------------------------------------------------------------------------------------------
  // The happy path and unspoofable scoping (AC-061, V-077)
  // -----------------------------------------------------------------------------------------------

  describe('successful intake', () => {
    it('creates the lead in the credential\'s tenant with source=api and the credential recorded', async () => {
      const issued = await provision(tenantA);

      const response = await intakeCall({ key: issued.secret, body: validBody() });
      expect(response.status, await response.clone().text()).toBe(201);

      const outcome = (await response.json()) as IntakeOutcome;
      expect(outcome.leadId).toBeGreaterThan(0);
      expect(outcome.leadRef).toMatch(/^L-\d{4}-\d{4}$/);
      expect(outcome.warnings).toEqual([]);

      const row = await readLeadRow(outcome.leadId);
      expect(row.tenant_id).toBe(String(tenantA));
      expect(row.source).toBe('api');
      expect(row.intake_credential_id).toBe(String(issued.credential.id));
      // No application user is behind an API key, so the lead records none rather than borrowing
      // the id of whoever happened to provision the credential.
      expect(row.created_by).toBeNull();
    });

    it('authenticates with the API key ALONE — no Supabase session and no tenant header (V-077)', async () => {
      const tenantId = await freshTenant('no-session');
      const issued = await provision(tenantId);
      const refs = await seedTenantRefs(tenantId);

      // The request below carries exactly one credential-bearing header: X-API-Key. If this route
      // had been mounted inside the session-auth group, the missing bearer token would 401 it.
      const response = await intakeCall({ key: issued.secret, body: refs.body });
      expect(response.status).toBe(201);
    });

    it('ignores an Authorization header entirely — the key is not a fallback scheme', async () => {
      const tenantId = await freshTenant('ignores-bearer');
      const issued = await provision(tenantId);
      const refs = await seedTenantRefs(tenantId);

      // A stale/hostile bearer token alongside a valid key must not change the outcome, and must
      // not cause the session middleware to run and reject the request.
      const response = await intakeCall({
        key: issued.secret,
        token: 'not-a-real-token',
        body: refs.body,
      });
      expect(response.status).toBe(201);
    });

    it('ignores an X-Tenant-Id header naming ANOTHER tenant (P-06: tenant is unspoofable)', async () => {
      const issued = await provision(tenantA);

      const response = await intakeCall({
        key: issued.secret,
        tenantId: tenantB,
        body: validBody(),
      });
      expect(response.status).toBe(201);

      const outcome = (await response.json()) as IntakeOutcome;
      // The header named tenant B; the credential says tenant A; the ROW must say tenant A.
      expect((await readLeadRow(outcome.leadId)).tenant_id).toBe(String(tenantA));
    });

    it('ignores tenantId / source / intakeCredentialId fields smuggled into the body', async () => {
      const issued = await provision(tenantA);

      const response = await intakeCall({
        key: issued.secret,
        body: validBody({
          tenantId: tenantB,
          source: 'browser',
          intakeCredentialId: 999999,
          createAnyway: true,
        }),
      });
      expect(response.status).toBe(201);

      const row = await readLeadRow(((await response.json()) as IntakeOutcome).leadId);
      expect(row.tenant_id).toBe(String(tenantA));
      expect(row.source).toBe('api');
      expect(row.intake_credential_id).toBe(String(issued.credential.id));
    });

    it('creates an unassigned lead when the owner is omitted (owner optional per P-06)', async () => {
      const tenantId = await freshTenant('no-owner');
      const issued = await provision(tenantId);
      const refs = await seedTenantRefs(tenantId);

      const response = await intakeCall({
        key: issued.secret,
        body: { ...refs.body, ownerUserId: undefined },
      });
      expect(response.status, await response.clone().text()).toBe(201);

      const outcome = (await response.json()) as IntakeOutcome;
      // Ownerless means NO accountable-owner assignment row at all — the unassigned-lead alert is
      // what surfaces these, and a placeholder assignment would silence it.
      const assignments = await query<{ count: string }>(
        'select count(*)::text as count from lead_assignments where lead_id = $1',
        [outcome.leadId],
      );
      expect(assignments[0]?.count).toBe('0');
    });

    it('creates an unassigned lead even in a tenant with NO RM role configured', async () => {
      // The RM-slot lookup is skipped entirely when no owner is named. Were it not, an ownerless
      // intake into an unconfigured tenant would 422 — exactly the unattended tenant this path
      // exists to serve.
      const tenantId = await freshTenant('no-rm-slot');
      const issued = await provision(tenantId);
      const refs = await seedTenantRefs(tenantId, { rmSlot: false });

      const response = await intakeCall({
        key: issued.secret,
        body: { ...refs.body, ownerUserId: undefined },
      });
      expect(response.status, await response.clone().text()).toBe(201);
    });

    it('writes a lead.created audit row for the credential\'s tenant with a null actor', async () => {
      const tenantId = await freshTenant('audit');
      const issued = await provision(tenantId);
      const refs = await seedTenantRefs(tenantId);

      const response = await intakeCall({ key: issued.secret, body: refs.body });
      const outcome = (await response.json()) as IntakeOutcome;

      const row = await assertAudited(query, {
        action: LEAD_CREATED_ACTION,
        entityType: 'lead',
        entityId: String(outcome.leadId),
        tenantId,
      });
      // No application user is behind an API key, so the row identifies the CREDENTIAL instead —
      // the same `actor_label` mechanism the background jobs use for "system". A row with neither
      // an actor id nor a label would be unattributable, which `assertAudited` refuses outright.
      expect(row.actor_user_id).toBeNull();
      expect(row.actor_label).toBe(`api_credential:${String(issued.credential.id)}`);
      // The label must never carry key material — not the secret, and not the public key id.
      expect(row.actor_label).not.toContain(issued.clientId);
    });

    it('stamps last_used_at on the credential after a successful intake', async () => {
      const tenantId = await freshTenant('last-used');
      const issued = await provision(tenantId);
      const refs = await seedTenantRefs(tenantId);

      expect(await lastUsedAt(issued.credential.id)).toBeNull();
      expect((await intakeCall({ key: issued.secret, body: refs.body })).status).toBe(201);
      expect(await lastUsedAt(issued.credential.id)).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------------------------------
  // The unspoofable-broker rule (AC-061, V-078; IntakeLeadCommandHandler.cs:39-58)
  // -----------------------------------------------------------------------------------------------

  describe('broker scoping', () => {
    it('forces the credential\'s broker onto a payload that names none', async () => {
      const issued = await provision(tenantA, brokerA);

      const response = await intakeCall({ key: issued.secret, body: validBody({ brokerId: null }) });
      expect(response.status, await response.clone().text()).toBe(201);

      const row = await readLeadRow(((await response.json()) as IntakeOutcome).leadId);
      expect(row.broker_id).toBe(String(brokerA));
    });

    it('accepts a payload naming the credential\'s OWN broker', async () => {
      const tenantId = await freshTenant('broker-same');
      const refs = await seedTenantRefs(tenantId);
      const issued = await provision(tenantId, refs.brokerId);

      const response = await intakeCall({
        key: issued.secret,
        body: { ...refs.body, brokerId: refs.brokerId },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      expect((await readLeadRow(((await response.json()) as IntakeOutcome).leadId)).broker_id).toBe(
        String(refs.brokerId),
      );
    });

    it('REJECTS a payload naming a different broker with 422 BROKER_NOT_ALLOWED, persisting nothing', async () => {
      const tenantId = await freshTenant('broker-other');
      const refs = await seedTenantRefs(tenantId);
      const otherBroker = await seedBroker(tenantId);
      const issued = await provision(tenantId, refs.brokerId);

      const before = await countLeads(tenantId);
      const response = await intakeCall({
        key: issued.secret,
        body: { ...refs.body, brokerId: otherBroker },
      });

      expect(response.status).toBe(422);
      const body = (await response.json()) as ProblemBody;
      expect(body.errors).toEqual([
        {
          field: 'brokerId',
          code: BROKER_NOT_ALLOWED_CODE,
          message:
            'This credential is scoped to a specific broker; the payload names a different broker.',
        },
      ]);

      // Rejected, NOT silently rewritten to the credential's broker: an integrator that believes it
      // filed against broker X must not find the lead under broker Y.
      expect(await countLeads(tenantId)).toBe(before);
    });

    it('passes a tenant-scoped credential\'s payload broker through the normal active-broker checks', async () => {
      const issued = await provision(tenantA);

      const accepted = await intakeCall({
        key: issued.secret,
        body: validBody({ brokerId: otherBrokerA }),
      });
      expect(accepted.status).toBe(201);
      expect((await readLeadRow(((await accepted.json()) as IntakeOutcome).leadId)).broker_id).toBe(
        String(otherBrokerA),
      );

      // ANOTHER tenant's broker is not an active broker HERE, and fails the same undifferentiated
      // way an inactive one does — no cross-tenant existence oracle.
      const rejected = await intakeCall({
        key: issued.secret,
        body: validBody({ brokerId: brokerB }),
      });
      expect(rejected.status).toBe(422);
      expect(((await rejected.json()) as ProblemBody).errors).toEqual([
        expect.objectContaining({ field: 'brokerId', code: 'LEAD_INVALID_BROKER' }),
      ]);
    });

    it('applies the broker-flagged request-channel rule to a tenant-scoped credential', async () => {
      const issued = await provision(tenantA);

      const response = await intakeCall({
        key: issued.secret,
        body: validBody({ requestChannelId: brokerChannelA, brokerId: null }),
      });
      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).code).toBe('LEAD_VALIDATION_FAILED');
    });
  });

  // -----------------------------------------------------------------------------------------------
  // The 401 matrix — five ways to fail, ONE body (AC-061, V-078)
  // -----------------------------------------------------------------------------------------------

  describe('authentication matrix', () => {
    /**
     * Compares full response bodies, not statuses. `correlationId` is stripped because it is
     * per-request by construction; everything else must match byte for byte, or the endpoint is an
     * enumeration oracle for whichever field differs.
     */
    async function rejectionShape(response: Response): Promise<ProblemBody> {
      expect(response.status).toBe(401);
      const body = (await response.json()) as ProblemBody & { correlationId?: string };
      const rest: Record<string, unknown> = { ...body };
      // Per-request by construction, and the ONLY field allowed to differ between two rejections.
      delete rest['correlationId'];
      return rest as ProblemBody;
    }

    it('rejects missing, malformed, unknown, disabled and regenerated-away keys IDENTICALLY', async () => {
      const tenantId = await freshTenant('matrix');
      const refs = await seedTenantRefs(tenantId);

      const disabled = await provision(tenantId);
      expect(
        (await adminCall('POST', `${CREDENTIALS}/${disabled.credential.id}/disable`, tenantId))
          .status,
      ).toBe(200);

      const rotatedTenant = await freshTenant('matrix-rot');
      const rotatedRefs = await seedTenantRefs(rotatedTenant);
      const original = await provision(rotatedTenant);
      const rotateResponse = await adminCall(
        'POST',
        `${CREDENTIALS}/${original.credential.id}/regenerate`,
        rotatedTenant,
      );
      expect(rotateResponse.status).toBe(200);

      const bodies = await Promise.all(
        [
          // missing header entirely
          intakeCall({ body: refs.body }),
          // present but empty
          intakeCall({ key: '   ', body: refs.body }),
          // malformed — not one of ours
          intakeCall({ key: 'not-a-quoteiq-key', body: refs.body }),
          // well-formed but resolves to no credential
          intakeCall({ key: `qiq_${'0'.repeat(32)}.${'A'.repeat(43)}`, body: refs.body }),
          // right key id, wrong secret
          intakeCall({ key: `${disabled.clientId}.${'A'.repeat(43)}`, body: refs.body }),
          // a genuinely valid key whose credential is DISABLED
          intakeCall({ key: disabled.secret, body: refs.body }),
          // a key that was valid until it was regenerated away
          intakeCall({ key: original.secret, body: rotatedRefs.body }),
        ].map(async (pending) => await rejectionShape(await pending)),
      );

      const [first, ...rest] = bodies;
      for (const body of rest) expect(body).toEqual(first);

      expect(first).toEqual({
        type: 'https://tools.ietf.org/html/rfc9110#section-15.5.2',
        title: 'Unauthorized',
        status: 401,
        detail: `${INTAKE_UNAUTHORIZED_CODE}: ${INTAKE_UNAUTHORIZED_MESSAGE}`,
        code: INTAKE_UNAUTHORIZED_CODE,
      });
    });

    it('leaks nothing about the credential in the 401 body — no key id, tenant or broker', async () => {
      const issued = await provision(tenantA);
      const response = await intakeCall({
        key: `${issued.clientId}.${'A'.repeat(43)}`,
        body: validBody(),
      });

      const text = await response.clone().text();

      // NUMERIC ids are checked by EXACT SHAPE, never by substring. Substring-scanning a small
      // integer against this body is meaningless: credential id 1 and tenant id 1 both "occur" in
      // `"status":401`, and tenant id 91 occurs inside the constant `rfc9110` type URL. Both
      // reddened this test for reasons having nothing to do with a leak, the moment `db:validate`
      // reset the sequences and handed out low ids. Deep equality is strictly STRONGER here: any
      // leak has to appear as an added field or an altered value, and this catches all of them
      // with no false positives at all. `rejectionShape` drops only `correlationId`, which is
      // per-request by construction.
      expect(await rejectionShape(response)).toEqual({
        type: 'https://tools.ietf.org/html/rfc9110#section-15.5.2',
        title: 'Unauthorized',
        status: 401,
        detail: `${INTAKE_UNAUTHORIZED_CODE}: ${INTAKE_UNAUTHORIZED_MESSAGE}`,
        code: INTAKE_UNAUTHORIZED_CODE,
      });

      // The high-entropy secrets ARE worth a substring scan — they cannot collide by chance.
      expect(text).not.toContain(issued.clientId);
      expect(text).not.toContain(issued.secret);
    });

    it('persists nothing and does not stamp last_used_at when authentication fails', async () => {
      const tenantId = await freshTenant('no-write-on-401');
      const refs = await seedTenantRefs(tenantId);
      const issued = await provision(tenantId);

      const before = await countLeads(tenantId);
      const response = await intakeCall({
        key: `${issued.clientId}.${'A'.repeat(43)}`,
        body: refs.body,
      });

      expect(response.status).toBe(401);
      expect(await countLeads(tenantId)).toBe(before);
      // A failed verification is not a use: stamping here would let anyone holding a key ID keep a
      // revoked-looking credential looking alive.
      expect(await lastUsedAt(issued.credential.id)).toBeNull();
    });

    it('rejects a valid Supabase session with no API key — a session cannot buy intake', async () => {
      const response = await intakeCall({
        token: admin.accessToken,
        tenantId: tenantA,
        body: validBody(),
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as ProblemBody).code).toBe(INTAKE_UNAUTHORIZED_CODE);
    });

    it('never writes the presented key, or any part of it, to the log', async () => {
      const issued = await provision(tenantA);
      const secretHalf = issued.secret.split('.')[1] ?? issued.secret;

      logLines.length = 0;
      await intakeCall({ key: issued.secret, body: validBody() });
      await intakeCall({ key: `${issued.clientId}.${'A'.repeat(43)}`, body: validBody() });

      const logged = logLines.join('\n');
      expect(logged).not.toContain(issued.secret);
      expect(logged).not.toContain(secretHalf);
      // Not even the PUBLIC key id: it is enough to confirm a guessed credential exists, and log
      // sinks are a softer target than the database.
      expect(logged).not.toContain(issued.clientId);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Cross-tenant reachability (AC-061, V-078)
  // -----------------------------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('cannot reach another tenant\'s party, region, product line or cover type', async () => {
      const issued = await provision(tenantA);
      const beforeB = await countLeads(tenantB);

      for (const [field, code, overrides] of [
        ['partyId', 'LEAD_INVALID_PARTY', { partyId: partyB }],
        ['regionId', 'LEAD_INVALID_REGION', { regionId: regionB }],
        ['productLineId', 'LEAD_INVALID_PRODUCT_LINE', { productLineId: productLineB }],
        ['coverTypeId', 'LEAD_INVALID_COVER_TYPE', { coverTypeId: coverTypeB }],
      ] as const) {
        const response = await intakeCall({ key: issued.secret, body: validBody(overrides) });
        expect(response.status, `${field} should be unreachable`).toBe(422);
        expect(((await response.json()) as ProblemBody).errors).toEqual([
          expect.objectContaining({ field, code }),
        ]);
      }

      expect(await countLeads(tenantB)).toBe(beforeB);
    });

    it('a tenant-B credential creates only in tenant B, whatever the payload names', async () => {
      const issuedB = await provision(tenantB);
      const beforeA = await countLeads(tenantA);

      const response = await intakeCall({
        key: issuedB.secret,
        body: {
          partyId: partyB,
          isExistingClient: false,
          dateReceived: yesterday(),
          requestChannelId: await firstRefId(tenantB, 'request_channel'),
          brokerId: null,
          regionId: regionB,
          productLineId: productLineB,
          coverTypeId: coverTypeB,
          policyTerm: 'm12',
          // tenant A's party id, offered as bait.
          tenantId: tenantA,
        },
      });

      expect(response.status, await response.clone().text()).toBe(201);
      expect((await readLeadRow(((await response.json()) as IntakeOutcome).leadId)).tenant_id).toBe(
        String(tenantB),
      );
      expect(await countLeads(tenantA)).toBe(beforeA);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // The validation catalog at the intake boundary (AC-061, V-077)
  // -----------------------------------------------------------------------------------------------

  describe('structured 422 errors', () => {
    it('reports a shape-level failure with its per-field code', async () => {
      const issued = await provision(tenantA);

      const response = await intakeCall({
        key: issued.secret,
        body: validBody({ policyTerm: 'other', policyTermOther: null }),
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).errors).toEqual([
        {
          field: 'policyTermOther',
          code: 'LEAD_POLICY_TERM_OTHER_REQUIRED',
          message: "Policy term 'other' requires a free-text description.",
        },
      ]);
    });

    it('reports a future dateReceived, inclusive of today at the boundary', async () => {
      const issued = await provision(tenantA);

      const future = await intakeCall({
        key: issued.secret,
        body: validBody({ dateReceived: tomorrow() }),
      });
      expect(future.status).toBe(422);
      expect(((await future.json()) as ProblemBody).errors).toEqual([
        expect.objectContaining({ field: 'dateReceived', code: 'LEAD_DATE_RECEIVED_FUTURE' }),
      ]);
    });

    it('requires partyId — the API path has no inline-party creation', async () => {
      const issued = await provision(tenantA);

      const response = await intakeCall({
        key: issued.secret,
        body: {
          ...validBody(),
          partyId: undefined,
          // Offered and NOT honoured: the handler hard-codes `InlineParty: null` (:62).
          inlineParty: { name: uniqueName('Ghost'), partyTypeId: partyTypeA },
        },
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).errors).toEqual([
        expect.objectContaining({ field: 'partyId' }),
      ]);

      // And no party was created behind the rejection.
      const ghosts = await query<{ count: string }>(
        'select count(*)::text as count from parties where tenant_id = $1 and name like $2',
        [tenantA, 'Ghost%'],
      );
      expect(ghosts[0]?.count).toBe('0');
    });

    it('reports an ineligible owner on the ownerUserId field', async () => {
      const issued = await provision(tenantA);

      const response = await intakeCall({
        key: issued.secret,
        body: validBody({ ownerUserId: appUserId(stranger) }),
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).errors).toEqual([
        expect.objectContaining({ field: 'ownerUserId', code: 'LEAD_INVALID_OWNER' }),
      ]);
    });

    it('answers 400, not 500, when the body is not JSON at all', async () => {
      const issued = await provision(tenantA);
      const headers = new Headers();
      headers.set(API_KEY_HEADER, issued.secret);
      headers.set('content-type', 'application/json');

      const response = await harness().request(`http://localhost${INTAKE}`, {
        method: 'POST',
        headers,
        body: 'not json at all',
      });
      expect(response.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Duplicates never block, and retries are not idempotent (FR-33; CLAUDE.md retry expectations)
  // -----------------------------------------------------------------------------------------------

  describe('duplicates', () => {
    it('returns 201 WITH a DUPLICATE_LEADS warning instead of the browser 409 confirm gate', async () => {
      const issued = await provision(tenantA);
      const body = validBody({ partyId: duplicatePartyA });

      const first = await intakeCall({ key: issued.secret, body });
      expect(first.status).toBe(201);
      const firstOutcome = (await first.json()) as IntakeOutcome;
      expect(firstOutcome.warnings).toEqual([]);

      const second = await intakeCall({ key: issued.secret, body });
      // NOT 409: an unattended caller has nobody to ask, so the gate the browser shows a human is
      // pre-answered here exactly as the reference forces `CreateAnyway: true` (:78).
      expect(second.status, await second.clone().text()).toBe(201);

      const secondOutcome = (await second.json()) as IntakeOutcome;
      expect(secondOutcome.warnings).toHaveLength(1);
      // PLURAL — the intake surface's code differs from the browser's `DUPLICATE_LEAD`, measured.
      expect(secondOutcome.warnings[0]?.code).toBe(DUPLICATE_LEADS_CODE);

      const duplicates = secondOutcome.warnings[0]?.details.duplicates as
        | readonly { leadId: number }[]
        | undefined;
      expect(duplicates?.map((d) => d.leadId)).toContain(firstOutcome.leadId);

      // And the second lead PHYSICALLY EXISTS — a warning that came with nothing persisted would
      // satisfy a status-only assertion while losing the lead.
      expect((await readLeadRow(secondOutcome.leadId)).source).toBe('api');
      expect(secondOutcome.leadId).not.toBe(firstOutcome.leadId);
    });

    it('is NOT idempotent under duplicate delivery — a re-POST creates a second, warned lead', async () => {
      // Deliberate and inherited from the reference: a lead is a business event, and a genuine
      // second enquiry from the same client for the same product line is normal. Swallowing a
      // resubmission would lose it, so the ambiguity is surfaced as a warning for a human instead.
      // There is no idempotency key in the reference contract — FLAGGED in the task file.
      const tenantId = await freshTenant('retry');
      const issued = await provision(tenantId);
      const refs = await seedTenantRefs(tenantId);

      const ids = new Set<number>();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await intakeCall({ key: issued.secret, body: refs.body });
        expect(response.status).toBe(201);
        ids.add(((await response.json()) as IntakeOutcome).leadId);
      }

      expect(ids.size).toBe(3);
      expect(await countLeads(tenantId)).toBe(3);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Route surface
  // -----------------------------------------------------------------------------------------------

  describe('route surface', () => {
    it('accepts the key in the LITERAL documented header, not merely in whatever the constant says', async () => {
      // Pinned as a literal on purpose. Every other test sends `API_KEY_HEADER`, so renaming that
      // constant would rename both sides at once and stay green while breaking every integrator
      // already in production — a mutation of the constant survived until this test existed.
      expect(API_KEY_HEADER).toBe('X-API-Key');

      const issued = await provision(tenantA);
      const response = await harness().request(`http://localhost${INTAKE}`, {
        method: 'POST',
        headers: new Headers({
          'X-API-Key': issued.secret,
          'content-type': 'application/json',
        }),
        body: JSON.stringify(validBody()),
      });
      expect(response.status, await response.clone().text()).toBe(201);
    });

    it('exposes only POST — a GET on the intake path is a 404, not an unauthenticated read', async () => {
      const response = await harness().request(`http://localhost${INTAKE}`, { method: 'GET' });
      expect(response.status).toBe(404);
    });

    it('does not register any other /intake path', async () => {
      const response = await harness().request('http://localhost/api/v1/intake/quotes', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: '{}',
      });
      expect(response.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Helpers that need the fixtures above
  // -----------------------------------------------------------------------------------------------

  async function freshTenant(label: string): Promise<number> {
    const tenantId = await createTenant(label);
    await seedSettings(tenantId);
    await addMembership(appUserId(admin), tenantId);
    for (const code of [
      'api_access.enable',
      'api_access.disable',
      'api_access.regenerate_secret',
    ] as const) {
      await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
    }
    return tenantId;
  }

  /** Seeds a self-contained reference set for an isolated tenant, plus a body that satisfies it. */
  async function seedTenantRefs(
    tenantId: number,
    options: { rmSlot?: boolean } = {},
  ): Promise<{ brokerId: number; body: Record<string, unknown> }> {
    const partyType = await seedRef(tenantId, 'party_type', uniqueName('T'));
    const region = await seedRef(tenantId, 'region', uniqueName('R'));
    const channel = await seedRef(tenantId, 'request_channel', uniqueName('C'));
    const productLine = await seedRef(tenantId, 'product_line', uniqueName('P'));
    const coverType = await seedRef(tenantId, 'cover_type', uniqueName('V'), {
      productLineId: productLine,
    });
    await seedRef(tenantId, 'lead_status', uniqueName('N'), {
      canonicalKey: 'new',
      reportingCategory: 'open',
    });
    const brokerId = await seedBroker(tenantId);
    const partyId = await seedParty(tenantId, partyType);

    if (options.rmSlot !== false) {
      const roleId = await fixtures.createRole({ tenantId });
      await addMembership(appUserId(owner), tenantId);
      await fixtures.assignRole(appUserId(owner), roleId, tenantId);
      await seedRmSlot(tenantId, roleId);
    }

    return {
      brokerId,
      body: {
        partyId,
        isExistingClient: true,
        dateReceived: yesterday(),
        requestChannelId: channel,
        brokerId: null,
        regionId: region,
        productLineId: productLine,
        coverTypeId: coverType,
        policyTerm: 'm12',
      },
    };
  }

  async function firstRefId(tenantId: number, listType: string): Promise<number> {
    const rows = await query<{ id: string }>(
      'select id::text as id from reference_items where tenant_id = $1 and list_type = $2 limit 1',
      [tenantId, listType],
    );
    return Number(rows[0]?.id);
  }

  async function lastUsedAt(credentialId: number): Promise<Date | null> {
    const rows = await query<{ last_used_at: Date | null }>(
      'select last_used_at from api_credentials where id = $1',
      [credentialId],
    );
    return rows[0]?.last_used_at ?? null;
  }
});
