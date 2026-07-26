/**
 * API-credential administration end to end (T-022; AC-022, AC-024, AC-040; V-027, V-031, V-051,
 * V-052).
 *
 * Port of `src/api/tests/QuoteIQ.Api.Tests/ApiAccess/ApiAccessEndpointsTests.cs` onto the approved
 * Q-19 reshape (Keycloak confidential clients -> first-party hashed keys). Same shape as
 * `brokers.test.ts`: real signed-in sessions, real tenants and partitions, real grants, the real
 * Hono pipeline via `app.request`. Nothing is stubbed, because the properties under test — that no
 * plaintext key survives anywhere, that rotation invalidates instantly, and that a credential
 * determines its own tenant — are properties of the composed system plus the database.
 *
 * THE STORAGE ASSERTIONS READ THE DATABASE, NOT THE RESPONSE
 * =========================================================
 * "Only a salted hash is stored" (AC-040, V-052) is unobservable through the API by construction:
 * an endpoint that leaked the key and an endpoint that did not look identical from the outside once
 * the reveal-once response is gone. Every storage claim below therefore scans the actual
 * `api_credentials` row — every text column — for the plaintext and for the secret half, and the
 * audit assertions scan `audit_log.details` the same way.
 *
 * AND THE INVALIDATION ASSERTIONS GO THROUGH `verifyApiKey`, NOT THROUGH INTAKE
 * ============================================================================
 * `POST /intake/leads` is T-030. `verifyApiKey` is the seam T-030 consumes, and it is exported for
 * exactly that reason, so "the old key fails after regenerate" is asserted against the verifier
 * itself here and re-asserted at the HTTP boundary when the intake route lands.
 *
 * This suite creates its own tenants (with their own partitions) and seeds its own rows, so it
 * never mutates the shared demo seed and can run alongside the other domain suites.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  API_CREDENTIAL_DISABLED_ACTION,
  API_CREDENTIAL_PROVISIONED_ACTION,
  API_CREDENTIAL_REGENERATED_ACTION,
  recordApiKeyUse,
  verifyApiKey,
} from '../../domains/api-access/index.js';
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
const title = suiteTitle('api-access credential administration', probe);

const BASE = '/api/v1/settings/api-credentials';

/** The pepper this suite's app is built with. `verifyApiKey` must be given the same one. */
const PEPPER = 'local-api-key-pepper-value';

/** `ApiCredentialDto` — src/api/.../ApiAccess/ApiAccessDtos.cs, and settingsApi.ts:276-284. */
interface ApiCredentialDto {
  readonly id: number;
  readonly brokerId: number | null;
  readonly clientId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastRotatedAt: string | null;
  readonly disabledAt: string | null;
}

/** `CredentialSecretDto` (:39) — the reveal-once envelope. */
interface CredentialSecretDto {
  readonly credential: ApiCredentialDto;
  readonly clientId: string;
  readonly secret: string;
}

/** `ApiCredentialListDto` (:42). Note: a bare `credentials` array, NOT a paged envelope. */
interface ApiCredentialListDto {
  readonly credentials: readonly ApiCredentialDto[];
}

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
}

/**
 * A SHORT per-run marker. Deliberately short: a long token dominates trigram similarity and can
 * make two unrelated fixture names score as near-duplicates in the party-matching suite.
 */
const RUN = `k22${process.pid % 10000}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix}${RUN}${nameSequence}`;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds all four api_access permissions in BOTH tenants, and is a member of both. */
  let admin: TestUserSession;
  /** Holds only `api_access.view` in tenant A: the mutation-guard control. */
  let viewer: TestUserSession;
  /** Member of tenant A with a DIFFERENT permission: proves the guard checks the required code. */
  let plainMember: TestUserSession;

  let tenantA: number;
  let tenantB: number;
  let brokerA: number;
  let disabledBrokerA: number;
  let brokerB: number;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return auth.query<T>(sql, params);
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

  /** Seeds a broker row directly, bypassing the broker API. */
  async function seedBroker(tenantId: number, status = 'active'): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into brokers (tenant_id, name, status, created_at, updated_at)
       values ($1, $2, $3, now(), now()) returning id::text as id`,
      [tenantId, uniqueName('Br'), status],
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
      apiAccess: { db, apiKeyPepper: PEPPER },
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

  /** Provisions a credential as the admin, asserting 201, and returns the reveal-once envelope. */
  async function provision(
    tenantId: number,
    brokerId?: number,
  ): Promise<CredentialSecretDto> {
    const path = brokerId === undefined ? BASE : `${BASE}/broker/${brokerId}`;
    const response = await call('POST', path, { token: admin.accessToken, tenantId });
    expect(response.status, `provision failed: ${await response.clone().text()}`).toBe(201);
    return (await response.json()) as CredentialSecretDto;
  }

  async function readList(tenantId: number, queryString = ''): Promise<ApiCredentialListDto> {
    const response = await call('GET', `${BASE}${queryString}`, {
      token: admin.accessToken,
      tenantId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as ApiCredentialListDto;
  }

  interface CredentialRow extends Record<string, unknown> {
    readonly id: string;
    readonly tenant_id: string;
    readonly broker_id: string | null;
    readonly key_id: string;
    readonly key_hash: string;
    readonly key_salt: string;
    readonly name: string;
    readonly status: string;
    readonly created_by: string | null;
    readonly last_rotated_at: Date | null;
    readonly disabled_at: Date | null;
    readonly last_used_at: Date | null;
  }

  /** The stored row, straight from the database — the only place the storage claims are checkable. */
  async function readCredentialRow(id: number): Promise<CredentialRow> {
    const rows = await query<CredentialRow>(
      `select id::text as id, tenant_id::text as tenant_id, broker_id::text as broker_id,
              key_id, key_hash, key_salt, name, status, created_by::text as created_by,
              last_rotated_at, disabled_at, last_used_at
         from api_credentials where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`api credential ${String(id)} not found`);
    return row;
  }

  /**
   * Asserts that neither the full key nor its secret half appears in ANY column of the row.
   * A column-by-column scan rather than a `key_hash` spot check: the point of AC-040 is that no
   * column anywhere can hold a usable key, including one added later by a well-meaning migration.
   */
  function expectNoKeyMaterial(row: CredentialRow, issued: CredentialSecretDto): void {
    const secretHalf = issued.secret.split('.')[1] ?? issued.secret;
    for (const [column, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      expect(value, `column ${column} contains the plaintext key`).not.toContain(issued.secret);
      expect(value, `column ${column} contains the key's secret half`).not.toContain(secretHalf);
    }
  }

  function verify(presented: string) {
    return verifyApiKey({ db, apiKeyPepper: PEPPER }, presented);
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
      API_KEY_PEPPER: PEPPER,
    });

    auth = new TestAuthFixtures(stack);
    fixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));

    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    pgLookup = createPgAppUserLookup(config);

    tenantA = await createTenant('a');
    tenantB = await createTenant('b');

    admin = await auth.createTestUserWithSession({ label: 'api-admin' });
    viewer = await auth.createTestUserWithSession({ label: 'api-viewer' });
    plainMember = await auth.createTestUserWithSession({ label: 'api-member' });

    await addMembership(appUserId(admin), tenantA);
    await addMembership(appUserId(admin), tenantB);
    await addMembership(appUserId(viewer), tenantA);
    await addMembership(appUserId(plainMember), tenantA);

    for (const tenantId of [tenantA, tenantB]) {
      for (const code of [
        'api_access.view',
        'api_access.enable',
        'api_access.disable',
        'api_access.regenerate_secret',
      ] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }
    }
    await fixtures.grantDirectPermission(appUserId(viewer), 'api_access.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(plainMember), 'leads.view', tenantA);

    brokerA = await seedBroker(tenantA);
    disabledBrokerA = await seedBroker(tenantA, 'disabled');
    brokerB = await seedBroker(tenantB);
  }, 120_000);

  afterAll(async () => {
    if (!probe.available) return;

    await fixtures?.cleanup();

    // Tenant data BEFORE `auth.cleanup()`: that call ends the pg pool these deletes run on, and
    // every delete swallows its error, so the reverse order is a silent no-op that leaks this
    // suite's tenants, credentials and audit rows into the next run.
    for (const tenantId of createdTenants) {
      for (const table of ['api_credentials', 'brokers', 'audit_log', 'user_tenants']) {
        await query(`delete from ${table} where tenant_id = $1`, [tenantId]).catch(() => undefined);
      }
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 180_000);

  // ---------------------------------------------------------------------------------------------
  // Provisioning and the reveal-once contract (AC-040, V-051)
  // ---------------------------------------------------------------------------------------------

  describe('provision (POST /settings/api-credentials)', () => {
    it('returns 201 with a Location header and the plaintext key exactly once', async () => {
      const tenantId = await createTenant('provision-201');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.view', 'api_access.enable'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const response = await call('POST', BASE, { token: admin.accessToken, tenantId });
      expect(response.status).toBe(201);

      const issued = (await response.json()) as CredentialSecretDto;
      expect(response.headers.get('location')).toBe(`${BASE}/${String(issued.credential.id)}`);
      expect(issued.credential.brokerId).toBeNull();
      expect(issued.credential.status).toBe('active');
      expect(issued.credential.lastRotatedAt).toBeNull();
      expect(issued.credential.disabledAt).toBeNull();
      // `clientId` is the public lookup handle (key_id), echoed at the envelope level too, which is
      // the shape settingsApi.ts:296-298 reads.
      expect(issued.clientId).toBe(issued.credential.clientId);
      expect(issued.secret.startsWith(`${issued.clientId}.`)).toBe(true);

      // The DTO itself must never carry a secret field (ApiAccessDtos.cs:11-13).
      expect(Object.keys(issued.credential)).not.toContain('secret');
    });

    it('stores only a salted hash — no plaintext or reversible form in any column (V-052)', async () => {
      const tenantId = await createTenant('storage');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);

      const issued = await provision(tenantId);
      const row = await readCredentialRow(issued.credential.id);

      expect(row.key_id).toBe(issued.clientId);
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_salt.length).toBeGreaterThanOrEqual(16);
      expect(row.status).toBe('active');
      expect(row.created_by).toBe(String(appUserId(admin)));
      expectNoKeyMaterial(row, issued);
    });

    it('never re-serves the key on any subsequent read', async () => {
      const tenantId = await createTenant('reveal-once');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.view', 'api_access.enable'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const issued = await provision(tenantId);

      const listResponse = await call('GET', BASE, { token: admin.accessToken, tenantId });
      const listText = await listResponse.text();
      expect(listText).not.toContain(issued.secret);
      expect(listText).not.toContain(issued.secret.split('.')[1]);

      const list = JSON.parse(listText) as ApiCredentialListDto;
      expect(list.credentials).toHaveLength(1);
      expect(Object.keys(list.credentials[0] ?? {})).not.toContain('secret');
    });

    it('issues a key that verifies and resolves its own tenant (P-06 unspoofable scope)', async () => {
      const tenantId = await createTenant('verify');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);

      const issued = await provision(tenantId);
      const result = await verify(issued.secret);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tenantId).toBe(tenantId);
      expect(result.value.brokerId).toBeNull();
      expect(result.value.credentialId).toBe(issued.credential.id);
    });

    it('writes exactly one api_credential.provisioned audit row carrying no key material', async () => {
      const tenantId = await createTenant('audit-provision');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);

      const issued = await provision(tenantId);

      const row = await assertAudited(query, {
        action: API_CREDENTIAL_PROVISIONED_ACTION,
        entityType: 'api_credential',
        entityId: String(issued.credential.id),
        actorUserId: appUserId(admin),
        tenantId,
        before: null,
        after: { clientId: issued.clientId, brokerId: null, status: 'active' },
      });

      expect(JSON.stringify(row.details)).not.toContain(issued.secret);
      expect(JSON.stringify(row.details)).not.toContain(issued.secret.split('.')[1]);
    });

    it('rejects a second credential for the same scope with 409 API_CREDENTIAL_ALREADY_EXISTS', async () => {
      const tenantId = await createTenant('duplicate');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);

      await provision(tenantId);
      const response = await call('POST', BASE, { token: admin.accessToken, tenantId });

      expect(response.status).toBe(409);
      const body = (await response.json()) as ProblemBody;
      expect(body.code).toBe('API_CREDENTIAL_ALREADY_EXISTS');
      expect(body.detail).toContain('API_CREDENTIAL_ALREADY_EXISTS');
    });
  });

  describe('provision broker scope (POST /settings/api-credentials/broker/{brokerId})', () => {
    it('binds the credential to the broker and resolves it on verification', async () => {
      const issued = await provision(tenantA, brokerA);

      expect(issued.credential.brokerId).toBe(brokerA);
      expect(await readCredentialRow(issued.credential.id)).toMatchObject({
        broker_id: String(brokerA),
      });

      const result = await verify(issued.secret);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tenantId).toBe(tenantA);
      expect(result.value.brokerId).toBe(brokerA);
    });

    it('rejects a broker that is not active in this tenant with 422', async () => {
      const response = await call('POST', `${BASE}/broker/${disabledBrokerA}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(422);
      const body = (await response.json()) as ProblemBody;
      expect(body.code).toBe('API_CREDENTIAL_INVALID_BROKER');
    });

    it("rejects ANOTHER tenant's broker id with 422 and writes nothing (AC-022)", async () => {
      const response = await call('POST', `${BASE}/broker/${brokerB}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as ProblemBody).code).toBe('API_CREDENTIAL_INVALID_BROKER');

      const rows = await query<{ count: string }>(
        'select count(*)::text as count from api_credentials where tenant_id = $1 and broker_id = $2',
        [tenantA, brokerB],
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('rejects a non-numeric broker id with 404, matching the {brokerId:long} route constraint', async () => {
      const response = await call('POST', `${BASE}/broker/not-a-number`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Rotation and disable (AC-040, V-051, V-052)
  // ---------------------------------------------------------------------------------------------

  describe('regenerate (POST /settings/api-credentials/{id}/regenerate)', () => {
    it('issues a new key, invalidates the old one immediately, and rotates the stored hash', async () => {
      const tenantId = await createTenant('regen');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.enable', 'api_access.regenerate_secret'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const original = await provision(tenantId);
      const beforeRow = await readCredentialRow(original.credential.id);

      const response = await call('POST', `${BASE}/${original.credential.id}/regenerate`, {
        token: admin.accessToken,
        tenantId,
      });
      expect(response.status).toBe(200);
      const rotated = (await response.json()) as CredentialSecretDto;

      expect(rotated.secret).not.toBe(original.secret);
      expect(rotated.credential.id).toBe(original.credential.id);
      expect(rotated.credential.lastRotatedAt).not.toBeNull();

      const afterRow = await readCredentialRow(original.credential.id);
      expect(afterRow.key_hash).not.toBe(beforeRow.key_hash);
      expect(afterRow.key_salt).not.toBe(beforeRow.key_salt);
      expect(afterRow.last_rotated_at).not.toBeNull();
      expectNoKeyMaterial(afterRow, rotated);
      expectNoKeyMaterial(afterRow, original);

      // The whole point of rotation: the previous key stops working the instant this returns.
      const oldResult = await verify(original.secret);
      expect(oldResult.ok).toBe(false);
      const newResult = await verify(rotated.secret);
      expect(newResult.ok).toBe(true);
    });

    it('writes exactly one api_credential.regenerated audit row with no key material', async () => {
      const tenantId = await createTenant('audit-regen');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.enable', 'api_access.regenerate_secret'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const original = await provision(tenantId);
      const response = await call('POST', `${BASE}/${original.credential.id}/regenerate`, {
        token: admin.accessToken,
        tenantId,
      });
      const rotated = (await response.json()) as CredentialSecretDto;

      const row = await assertAudited(query, {
        action: API_CREDENTIAL_REGENERATED_ACTION,
        entityType: 'api_credential',
        entityId: String(original.credential.id),
        actorUserId: appUserId(admin),
        tenantId,
      });

      const details = JSON.stringify(row.details);
      expect(details).not.toContain(original.secret);
      expect(details).not.toContain(rotated.secret);
      expect(details).not.toContain(rotated.secret.split('.')[1]);
    });

    it('answers 404 for an unknown id', async () => {
      const response = await call('POST', `${BASE}/99999999/regenerate`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ProblemBody).code).toBe('API_CREDENTIAL_NOT_FOUND');
    });
  });

  describe('disable (POST /settings/api-credentials/{id}/disable)', () => {
    it('stops verification immediately and stamps disabled_at', async () => {
      const tenantId = await createTenant('disable');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.enable', 'api_access.disable'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const issued = await provision(tenantId);
      expect((await verify(issued.secret)).ok).toBe(true);

      const response = await call('POST', `${BASE}/${issued.credential.id}/disable`, {
        token: admin.accessToken,
        tenantId,
      });
      expect(response.status).toBe(200);

      const dto = (await response.json()) as ApiCredentialDto;
      expect(dto.status).toBe('disabled');
      expect(dto.disabledAt).not.toBeNull();

      const row = await readCredentialRow(issued.credential.id);
      expect(row.status).toBe('disabled');
      expect(row.disabled_at).not.toBeNull();
      // The hash is NOT cleared: the row stays attributable for leads already ingested through it
      // (N-09/AC-075), and the status alone is what fails verification.
      expect(row.key_hash).not.toBe('');

      const result = await verify(issued.secret);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('credential_disabled');
    });

    it('is idempotent: a repeated disable succeeds without a second audit row', async () => {
      const tenantId = await createTenant('disable-twice');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.enable', 'api_access.disable'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const issued = await provision(tenantId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await call('POST', `${BASE}/${issued.credential.id}/disable`, {
          token: admin.accessToken,
          tenantId,
        });
        expect(response.status).toBe(200);
      }

      await assertAudited(query, {
        action: API_CREDENTIAL_DISABLED_ACTION,
        entityId: String(issued.credential.id),
        tenantId,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // The retired reveal path (Q-19 deviation — see routes.ts)
  // ---------------------------------------------------------------------------------------------

  describe('reveal (POST /settings/api-credentials/{id}/reveal)', () => {
    it('answers 410 API_CREDENTIAL_NOT_REVEALABLE and returns no key material', async () => {
      const tenantId = await createTenant('reveal');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.view', 'api_access.enable'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const issued = await provision(tenantId);
      const response = await call('POST', `${BASE}/${issued.credential.id}/reveal`, {
        token: admin.accessToken,
        tenantId,
      });

      expect(response.status).toBe(410);
      const text = await response.text();
      expect(text).not.toContain(issued.secret);
      expect((JSON.parse(text) as ProblemBody).code).toBe('API_CREDENTIAL_NOT_REVEALABLE');
    });

    it('does NOT silently rotate the key behind the reveal action', async () => {
      const tenantId = await createTenant('reveal-norotate');
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.view', 'api_access.enable'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const issued = await provision(tenantId);
      const before = await readCredentialRow(issued.credential.id);
      await call('POST', `${BASE}/${issued.credential.id}/reveal`, {
        token: admin.accessToken,
        tenantId,
      });

      expect((await readCredentialRow(issued.credential.id)).key_hash).toBe(before.key_hash);
      expect((await verify(issued.secret)).ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // List contract and tenant isolation (AC-022, V-027)
  // ---------------------------------------------------------------------------------------------

  describe('list (GET /settings/api-credentials)', () => {
    it('returns only this tenant\'s credentials, and filters by brokerId when asked', async () => {
      const tenantId = await createTenant('list');
      const otherBroker = await seedBroker(tenantId);
      await addMembership(appUserId(admin), tenantId);
      for (const code of ['api_access.view', 'api_access.enable'] as const) {
        await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
      }

      const tenantScoped = await provision(tenantId);
      const brokerScoped = await provision(tenantId, otherBroker);

      const all = await readList(tenantId);
      expect(all.credentials.map((c) => c.id).sort()).toEqual(
        [tenantScoped.credential.id, brokerScoped.credential.id].sort(),
      );

      const filtered = await readList(tenantId, `?brokerId=${otherBroker}`);
      expect(filtered.credentials).toHaveLength(1);
      expect(filtered.credentials[0]?.id).toBe(brokerScoped.credential.id);
    });

    it('never returns another tenant\'s credential rows', async () => {
      const issuedB = await provision(tenantB);

      const listA = await readList(tenantA);
      expect(listA.credentials.map((c) => c.id)).not.toContain(issuedB.credential.id);
      expect(listA.credentials.every((c) => c.clientId !== issuedB.clientId)).toBe(true);
    });
  });

  describe('tenant isolation on mutations (AC-022, V-027)', () => {
    it("answers 404 and changes nothing when regenerating another tenant's credential", async () => {
      const issuedB = await provision(tenantB, brokerB);
      const before = await readCredentialRow(issuedB.credential.id);

      const response = await call('POST', `${BASE}/${issuedB.credential.id}/regenerate`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(404);
      expect(((await response.json()) as ProblemBody).code).toBe('API_CREDENTIAL_NOT_FOUND');

      const after = await readCredentialRow(issuedB.credential.id);
      expect(after.key_hash).toBe(before.key_hash);
      expect(after.last_rotated_at).toBeNull();
      // And the key still works — a 404 that had rotated anyway would satisfy a status-only test.
      expect((await verify(issuedB.secret)).ok).toBe(true);
    });

    it("answers 404 and changes nothing when disabling another tenant's credential", async () => {
      const tenantId = await createTenant('iso-disable');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);
      const issued = await provision(tenantId);

      const response = await call('POST', `${BASE}/${issued.credential.id}/disable`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(404);
      expect((await readCredentialRow(issued.credential.id)).status).toBe('active');
      expect((await verify(issued.secret)).ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Permission matrix (ApiAccessEndpoints.cs:36-41)
  // ---------------------------------------------------------------------------------------------

  describe('permission matrix', () => {
    it('requires api_access.view to list', async () => {
      expect(
        (await call('GET', BASE, { token: viewer.accessToken, tenantId: tenantA })).status,
      ).toBe(200);
      expect(
        (await call('GET', BASE, { token: plainMember.accessToken, tenantId: tenantA })).status,
      ).toBe(403);
    });

    it('requires api_access.enable to provision (view alone is not enough)', async () => {
      const tenantScoped = await call('POST', BASE, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(tenantScoped.status).toBe(403);

      const brokerScoped = await call('POST', `${BASE}/broker/${brokerA}`, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(brokerScoped.status).toBe(403);
    });

    it('requires api_access.regenerate_secret to regenerate', async () => {
      const tenantId = await createTenant('perm-regen');
      await addMembership(appUserId(admin), tenantId);
      await addMembership(appUserId(viewer), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);
      await fixtures.grantDirectPermission(appUserId(viewer), 'api_access.view', tenantId);
      const issued = await provision(tenantId);

      const response = await call('POST', `${BASE}/${issued.credential.id}/regenerate`, {
        token: viewer.accessToken,
        tenantId,
      });
      expect(response.status).toBe(403);
      expect((await readCredentialRow(issued.credential.id)).last_rotated_at).toBeNull();
    });

    it('requires api_access.disable to disable', async () => {
      const tenantId = await createTenant('perm-disable');
      await addMembership(appUserId(admin), tenantId);
      await addMembership(appUserId(viewer), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);
      await fixtures.grantDirectPermission(appUserId(viewer), 'api_access.view', tenantId);
      const issued = await provision(tenantId);

      const response = await call('POST', `${BASE}/${issued.credential.id}/disable`, {
        token: viewer.accessToken,
        tenantId,
      });
      expect(response.status).toBe(403);
      expect((await readCredentialRow(issued.credential.id)).status).toBe('active');
    });

    it('rejects an unauthenticated caller with 401 before any permission check', async () => {
      expect((await call('GET', BASE, { tenantId: tenantA })).status).toBe(401);
    });

    it('rejects a caller with no verified tenant header with 403', async () => {
      expect((await call('GET', BASE, { token: admin.accessToken })).status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // verifyApiKey — the seam T-030 consumes (AC-040, V-052)
  // ---------------------------------------------------------------------------------------------

  describe('verifyApiKey', () => {
    it.each([
      ['an empty string', ''],
      ['a malformed key with no separator', 'qiq_abcdef'],
      ['a key with the wrong prefix', 'other_abcdef.secret'],
    ])('fails on %s without touching the database', async (_label, presented) => {
      const result = await verify(presented);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('malformed_key');
    });

    it('fails on a well-formed key whose id matches no credential', async () => {
      const result = await verify(`qiq_${'0'.repeat(32)}.${'A'.repeat(43)}`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('unknown_key');
    });

    it('fails when the key id is right but the secret is wrong', async () => {
      const tenantId = await createTenant('verify-wrong');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);
      const issued = await provision(tenantId);

      const forged = `${issued.clientId}.${'A'.repeat(43)}`;
      const result = await verify(forged);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('secret_mismatch');
    });

    it('fails when the pepper differs, even for the correct key (V-052)', async () => {
      const tenantId = await createTenant('verify-pepper');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);
      const issued = await provision(tenantId);

      const result = await verifyApiKey(
        { db, apiKeyPepper: 'a-completely-different-pepper' },
        issued.secret,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('secret_mismatch');
    });

    it('stamps last_used_at only through recordApiKeyUse, never through verification itself', async () => {
      const tenantId = await createTenant('last-used');
      await addMembership(appUserId(admin), tenantId);
      await fixtures.grantDirectPermission(appUserId(admin), 'api_access.enable', tenantId);
      const issued = await provision(tenantId);

      const result = await verify(issued.secret);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verification is a pure read: a successful verify must NOT have written anything, so that a
      // failed usage stamp can never fail an otherwise valid intake request.
      expect((await readCredentialRow(issued.credential.id)).last_used_at).toBeNull();

      await recordApiKeyUse({ db, apiKeyPepper: PEPPER }, result.value);
      expect((await readCredentialRow(issued.credential.id)).last_used_at).not.toBeNull();
    });

    it('carries no key material or user/tenant hints in its failure', async () => {
      const result = await verify(`qiq_${'0'.repeat(32)}.${'A'.repeat(43)}`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // A single opaque message for every failure: an error that distinguished "no such credential"
      // from "wrong secret" would let a caller enumerate valid key ids.
      expect(result.error.message).toBe('The presented API key is not valid.');
      expect(Object.keys(result.error)).toEqual(['reason', 'message']);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Cross-cutting: no audit row anywhere in this suite may carry key material
  // ---------------------------------------------------------------------------------------------

  it('leaves no key material in any api_credential audit row (AC-040)', async () => {
    const tenantId = await createTenant('audit-scan');
    await addMembership(appUserId(admin), tenantId);
    for (const code of ['api_access.enable', 'api_access.regenerate_secret', 'api_access.disable'] as const) {
      await fixtures.grantDirectPermission(appUserId(admin), code, tenantId);
    }

    const issued = await provision(tenantId);
    const id = issued.credential.id;
    const rotatedResponse = await call('POST', `${BASE}/${id}/regenerate`, {
      token: admin.accessToken,
      tenantId,
    });
    const rotated = (await rotatedResponse.json()) as CredentialSecretDto;
    await call('POST', `${BASE}/${id}/disable`, { token: admin.accessToken, tenantId });

    const rows = [
      ...(await findAuditRows(query, {
        action: API_CREDENTIAL_PROVISIONED_ACTION,
        entityId: String(id),
        tenantId,
      })),
      ...(await findAuditRows(query, {
        action: API_CREDENTIAL_REGENERATED_ACTION,
        entityId: String(id),
        tenantId,
      })),
      ...(await findAuditRows(query, {
        action: API_CREDENTIAL_DISABLED_ACTION,
        entityId: String(id),
        tenantId,
      })),
    ];
    expect(rows).toHaveLength(3);

    const serialized = JSON.stringify(rows);
    for (const key of [issued.secret, rotated.secret]) {
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(key.split('.')[1]);
    }
  });
});
