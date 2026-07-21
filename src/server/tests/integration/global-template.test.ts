/**
 * The global default reference template, end to end (T-016; AC-024, AC-026, AC-028; V-031, V-037).
 *
 * Port of the reference's global-template surface
 * (`src/api/QuoteIQ.Api/Endpoints/GlobalTemplateEndpoints.cs`,
 * `ReplaceDefaultReferenceItemsCommandHandler.cs`, `ReplaceDefaultReferenceItemsValidator.cs`).
 *
 * THIS SUITE MUTATES A GLOBAL, SHARED TABLE
 * =========================================
 * `default_reference_items` is one row set for the whole database, and tenant creation reads it. So
 * every test here snapshots the table in `beforeAll`, and `afterAll` restores it byte for byte —
 * otherwise a passing run would leave the local stack unable to create a valid tenant, and the
 * damage would surface in an unrelated suite. Tests that must succeed submit a template that still
 * contains the full canonical status taxonomy, for the same reason.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { REQUIRED_CANONICAL_STATUSES } from '../../domains/reference-data/index.js';
import { TEMPLATE_REPLACED_ACTION } from '../../domains/reference-data/global-template.routes.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('global default reference template', probe);

const TEMPLATE_PATH = '/api/v1/global/default-reference-items';

interface TemplateItem {
  readonly listType: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly isBrokerChannel: boolean | null;
  readonly defaultProductLineKey: string | null;
  readonly reportingCategory: string | null;
  readonly canonicalKey: string | null;
  readonly isTerminal: boolean;
}

interface ProblemBody {
  readonly detail?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  let internal: TestUserSession;
  let outsider: TestUserSession;

  /** The template exactly as this suite found it. Restored in afterAll. */
  let snapshot: TemplateItem[] = [];

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) {
      throw new Error(`fixture user ${session.email} has no application users row`);
    }
    return Number(session.appUserId);
  }

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  function harness(): ApiApp {
    return buildApp({
      config,
      loggerOptions: { sink: () => undefined },
      auth: {
        verifyAccessToken: createAccessTokenVerifier({ config }),
        lookupAppUser: (authUserId) => pgLookup.lookup(authUserId),
      },
      rbac: { loadGrantGraph: createGrantGraphLoader(db) },
      globalTemplate: { db },
    });
  }

  async function call(
    method: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    return await harness().request(`http://localhost${TEMPLATE_PATH}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function readTemplate(token: string): Promise<TemplateItem[]> {
    const response = await call('GET', { token });
    expect(response.status).toBe(200);
    return (await response.json()) as TemplateItem[];
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

    internal = await auth.createTestUserWithSession({ label: 'template-internal' });
    outsider = await auth.createTestUserWithSession({ label: 'template-outsider' });

    await fixtures.grantDirectPermission(appUserId(internal), 'global.manage_templates', null);
    // A different global permission: proves the guard checks the required code, not "any grant".
    await fixtures.grantDirectPermission(appUserId(outsider), 'global.view_any_tenant', null);

    snapshot = await readTemplate(internal.accessToken);
    expect(snapshot.length, 'the seeded template must be present').toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    if (!probe.available) return;

    if (snapshot.length > 0) {
      const response = await call('PUT', {
        token: internal.accessToken,
        body: { items: snapshot },
      });
      // Restoration is not optional: a corrupted template breaks tenant creation everywhere else.
      expect(response.status, 'failed to restore the global template').toBe(200);
    }
    await query('delete from audit_log where action = $1', [TEMPLATE_REPLACED_ACTION]).catch(
      () => undefined,
    );

    await fixtures?.cleanup();
    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 120_000);

  it('returns the template in the reference DefaultReferenceItemDto shape', async () => {
    const items = await readTemplate(internal.accessToken);
    const first = items[0];

    expect(first).toBeDefined();
    // DefaultReferenceItemDto carries NO id (ReferenceItemDto.cs:33-42) — the template is addressed
    // as a whole set, so an id leaking into the payload would be a contract change.
    expect(Object.keys(first as object).sort()).toEqual(
      [
        'canonicalKey',
        'defaultProductLineKey',
        'displayOrder',
        'isActive',
        'isBrokerChannel',
        'isTerminal',
        'listType',
        'name',
        'reportingCategory',
      ].sort(),
    );

    // The guarded taxonomy the tenant seeder depends on is present and intact.
    for (const required of REQUIRED_CANONICAL_STATUSES) {
      const match = items.find(
        (item) => item.listType === required.listType && item.canonicalKey === required.canonicalKey,
      );
      expect(match, `template is missing ${required.listType}/${required.canonicalKey}`).toBeDefined();
      expect(match?.reportingCategory).toBe(required.reportingCategory);
      expect(match?.isTerminal).toBe(required.isTerminal);
    }
  });

  it('denies both template routes without global.manage_templates, and allows them with it', async () => {
    // Positive control first, so the denials below cannot be satisfied by refusing everyone.
    expect((await call('GET', { token: internal.accessToken })).status).toBe(200);

    expect((await call('GET', { token: outsider.accessToken })).status).toBe(403);
    expect(
      (await call('PUT', { token: outsider.accessToken, body: { items: snapshot } })).status,
    ).toBe(403);

    expect((await call('GET')).status, 'anonymous').toBe(401);
    expect((await call('PUT', { body: { items: [] } })).status, 'anonymous').toBe(401);
  });

  it('replaces the template transactionally and audits the edit', async () => {
    const replacement: TemplateItem[] = [
      ...snapshot,
      {
        listType: 'lost_reason',
        name: 't016 template probe',
        displayOrder: 99,
        isActive: true,
        isBrokerChannel: null,
        defaultProductLineKey: null,
        reportingCategory: null,
        canonicalKey: null,
        isTerminal: false,
      },
    ];

    const response = await call('PUT', { token: internal.accessToken, body: { items: replacement } });
    expect(response.status).toBe(200);
    expect(await response.text(), 'Results.Ok() sends an empty body').toBe('');

    const after = await readTemplate(internal.accessToken);
    expect(after).toHaveLength(replacement.length);
    expect(after.some((item) => item.name === 't016 template probe')).toBe(true);

    await assertAudited(query, {
      action: TEMPLATE_REPLACED_ACTION,
      entityType: 'default_reference_items',
      entityId: 'template',
      actorUserId: appUserId(internal),
      // A global template belongs to no tenant.
      tenantId: null,
      before: { count: snapshot.length },
      after: { count: replacement.length },
    });

    // Put the original back immediately: every later test in this file reads the real template.
    await query('delete from audit_log where action = $1', [TEMPLATE_REPLACED_ACTION]);
    expect(
      (await call('PUT', { token: internal.accessToken, body: { items: snapshot } })).status,
    ).toBe(200);
    await query('delete from audit_log where action = $1', [TEMPLATE_REPLACED_ACTION]);
  });

  it('rejects an invalid reporting category on a status row', async () => {
    const response = await call('PUT', {
      token: internal.accessToken,
      body: {
        items: [
          {
            listType: 'lead_status',
            name: 'Bad status',
            displayOrder: 1,
            isActive: true,
            reportingCategory: 'not-a-category',
            canonicalKey: null,
            isTerminal: false,
          },
        ],
      },
    });

    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemBody;
    expect(problem.detail).toContain(
      'Reporting category must be one of: open, quoted, won, lost, expired, withdrawn.',
    );

    // ...and the stored template is untouched.
    expect(await readTemplate(internal.accessToken)).toHaveLength(snapshot.length);
  });

  it('rejects a status row with no reporting category at all', async () => {
    const response = await call('PUT', {
      token: internal.accessToken,
      body: {
        items: [
          { listType: 'quote_status', name: 'No category', displayOrder: 1, isActive: true },
        ],
      },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).detail).toContain(
      'Lead/quote statuses require a reporting category.',
    );
  });

  it('rejects duplicate (listType, name) pairs', async () => {
    const response = await call('PUT', {
      token: internal.accessToken,
      body: {
        items: [
          { listType: 'region', name: 'Gaborone', displayOrder: 1, isActive: true },
          { listType: 'region', name: '  gaborone ', displayOrder: 2, isActive: true },
        ],
      },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).detail).toContain(
      'Duplicate (listType, name) pairs are not allowed in the template.',
    );
  });

  it('rejects a cover type whose product line is absent from the submitted set', async () => {
    const response = await call('PUT', {
      token: internal.accessToken,
      body: {
        items: [
          { listType: 'product_line', name: 'Motor', displayOrder: 1, isActive: true },
          {
            listType: 'cover_type',
            name: 'Comprehensive',
            displayOrder: 1,
            isActive: true,
            defaultProductLineKey: 'Marine',
          },
        ],
      },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).detail).toBe(
      "'Marine' is not an active product line in the submitted template.",
    );
  });

  it('rejects a cover type with no product line key', async () => {
    const response = await call('PUT', {
      token: internal.accessToken,
      body: {
        items: [
          { listType: 'cover_type', name: 'Comprehensive', displayOrder: 1, isActive: true },
        ],
      },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).detail).toContain(
      'Cover types require a product line.',
    );
  });

  it('rejects an unknown list type', async () => {
    const response = await call('PUT', {
      token: internal.accessToken,
      body: { items: [{ listType: 'not_a_list', name: 'x', displayOrder: 1, isActive: true }] },
    });

    expect(response.status).toBe(422);
    expect((await response.json() as ProblemBody).errors?.[0]?.field).toBe('items[0].listType');
  });
});
