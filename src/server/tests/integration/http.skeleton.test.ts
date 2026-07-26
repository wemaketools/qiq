/**
 * /api/v1 serving skeleton (AC-011, AC-014, AC-095, AC-096; V-013, V-014, V-017, V-123, V-124).
 *
 * Exercises the real Hono app over the real fetch boundary — request in, Response out — with only
 * the log sink and the config injected. Nothing about the pipeline is mocked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { loadConfig, resetConfigCache, type AppConfig } from '../../lib/config/index.js';
import { ForbiddenError, IllegalOperationError, NotFoundError } from '../../lib/errors/index.js';
import { PROBLEM_JSON_CONTENT_TYPE, SANITIZED_INTERNAL_DETAIL } from '../../lib/errors/problem.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { validateBody } from '../../lib/validation/index.js';

const TEST_ENV: Record<string, string> = {
  APP_ENV: 'local',
  LOG_LEVEL: 'info',
  SUPABASE_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_DIRECT_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'local-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'local-service-role-key',
  CRON_SECRET: 'local-cron-secret',
  INTERNAL_JOB_SECRET: 'local-internal-job-secret',
  API_KEY_PEPPER: 'local-api-key-pepper-value',
};

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

interface Harness {
  readonly app: ApiApp;
  logRecords(): Record<string, unknown>[];
  logText(): string;
}

function harness(
  options: { register?: (app: ApiApp) => void; config?: AppConfig } = {},
): Harness {
  const lines: string[] = [];
  const app = buildApp({
    config: options.config ?? testConfig(),
    loggerOptions: { sink: (line) => lines.push(line) },
    ...(options.register ? { registerRoutes: options.register } : {}),
  });

  return {
    app,
    logRecords: () => lines.map((line) => JSON.parse(line.trimEnd()) as Record<string, unknown>),
    logText: () => lines.join(''),
  };
}

const LEAKY_SECRET = 'hunter2-not-for-clients';
const LEAKY_MESSAGE = `connect ECONNREFUSED postgres://app:${LEAKY_SECRET}@db.internal:5432 at Object.query (/var/task/src/server/lib/db/index.js:42:9)`;

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigCache();
});

describe('GET /api/v1/health (anonymous)', () => {
  it('returns 200 with status and version and requires no Authorization header', async () => {
    const { app } = harness();

    const response = await app.request('http://localhost/api/v1/health');
    const body = (await response.json()) as { status: string; version: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.version).toBeTypeOf('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('is served through the Vercel adapter entrypoint (api/v1/[[...segments]].ts)', async () => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      vi.stubEnv(key, value);
    }
    resetConfigCache();

    const entry = await import('../../../../api/v1/[[...segments]].js');
    const response = await entry.GET(new Request('http://localhost/api/v1/health'));

    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'ok' });
  });
});

describe('unknown routes', () => {
  it('returns a problem+json 404 with the preserved RFC 7807 fields', async () => {
    const { app } = harness();

    const response = await app.request('http://localhost/api/v1/definitely-not-a-route');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    expect(body).toMatchObject({
      type: 'https://tools.ietf.org/html/rfc9110#section-15.5.5',
      title: 'Not Found',
      status: 404,
    });
    expect(body['correlationId']).toBeTypeOf('string');
  });

  it('returns problem+json 404 for a path outside the /api/v1 base path too', async () => {
    const { app } = harness();

    const response = await app.request('http://localhost/not-the-api');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
  });
});

describe('unexpected handler errors (AC-014, V-017, V-124)', () => {
  function boomHarness(): Harness {
    return harness({
      register: (app) => {
        app.get('/boom', () => {
          const error = new Error(LEAKY_MESSAGE);
          error.stack = `Error: ${LEAKY_MESSAGE}\n    at handler (/var/task/src/server/domains/leads/routes.js:17:3)`;
          throw error;
        });
      },
    });
  }

  it('returns a sanitized problem+json 500 that leaks no internals', async () => {
    const h = boomHarness();

    const response = await h.app.request('http://localhost/api/v1/boom');
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);

    for (const leak of [
      LEAKY_SECRET,
      'ECONNREFUSED',
      'postgres://',
      'db.internal',
      '/var/task/',
      'routes.js',
      'at handler',
      'stack',
    ]) {
      expect(raw, `500 body leaked "${leak}"`).not.toContain(leak);
    }

    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'https://tools.ietf.org/html/rfc9110#section-15.6.1',
      title: 'An error occurred while processing your request.',
      status: 500,
      detail: SANITIZED_INTERNAL_DETAIL,
    });
    expect(body['correlationId']).toBeTypeOf('string');
  });

  it('logs the real error server-side under the same correlation id the client received', async () => {
    const h = boomHarness();

    const response = await h.app.request('http://localhost/api/v1/boom');
    const body = (await response.json()) as { correlationId: string };

    const errorRecord = h.logRecords().find((record) => record['level'] === 'error');
    expect(errorRecord, 'no error log line was emitted').toBeDefined();
    expect(errorRecord!['correlationId']).toBe(body.correlationId);
    expect(h.logText()).toContain('ECONNREFUSED');
  });

  it('scrubs credentials out of the server-side error log (T-007 redactor still applies)', async () => {
    const h = boomHarness();
    await h.app.request('http://localhost/api/v1/boom');

    expect(h.logText()).not.toContain(LEAKY_SECRET);
  });
});

describe('zod validation failures (AC-014, AC-096)', () => {
  const bodySchema = z.object({ name: z.string().min(1), email: z.email() });

  function validatedHarness(): Harness {
    return harness({
      register: (app) => {
        app.post('/widgets', async (c) => c.json(await validateBody(c, bodySchema)));
      },
    });
  }

  async function post(app: ApiApp, body: unknown): Promise<Response> {
    return app.request('http://localhost/api/v1/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 422 problem+json with errors:[{field,code,message}]', async () => {
    const { app } = validatedHarness();

    const response = await post(app, { name: '', email: 'nope' });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    expect(body).toMatchObject({
      type: 'https://tools.ietf.org/html/rfc4918#section-11.2',
      title: 'Unprocessable Entity',
      status: 422,
    });

    const errors = body['errors'] as { field: string; code: string; message: string }[];
    expect(Array.isArray(errors)).toBe(true);
    expect(errors).toHaveLength(2);
    for (const entry of errors) {
      expect(Object.keys(entry).sort()).toEqual(['code', 'field', 'message']);
      expect(entry.field).toBeTypeOf('string');
      expect(entry.code).toBeTypeOf('string');
      expect(entry.message).toBeTypeOf('string');
    }
    expect(errors.map((e) => e.field).sort()).toEqual(['email', 'name']);
  });

  it('still populates detail so the existing SPA error banner has text to render', async () => {
    const { app } = validatedHarness();

    const body = (await (await post(app, { name: '', email: 'nope' })).json()) as { detail: string };

    expect(body.detail).toContain('VALIDATION_FAILED:');
    expect(body.detail.length).toBeGreaterThan('VALIDATION_FAILED:'.length);
  });

  it('returns 400 problem+json for a body that is not valid JSON at all', async () => {
    const { app } = validatedHarness();

    const response = await app.request('http://localhost/api/v1/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('passes a valid body through to the handler', async () => {
    const { app } = validatedHarness();

    const response = await post(app, { name: 'Acme', email: 'ops@acme.test' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Acme', email: 'ops@acme.test' });
  });
});

describe('error taxonomy over HTTP (AC-096, V-124)', () => {
  const cases = [
    { path: '/e/403', status: 403, title: 'Forbidden' },
    { path: '/e/404', status: 404, title: 'Not Found' },
    { path: '/e/409', status: 409, title: 'Conflict' },
  ] as const;

  function taxonomyHarness(): Harness {
    return harness({
      register: (app) => {
        app.get('/e/403', () => {
          throw new ForbiddenError("Missing required permission 'broker.edit'.");
        });
        app.get('/e/404', () => {
          throw new NotFoundError('Broker 7 was not found.', { code: 'BROKER_NOT_FOUND' });
        });
        app.get('/e/409', () => {
          throw new IllegalOperationError('Quote QT-1 cannot be bound from status Lost.', {
            code: 'QUOTE_ILLEGAL_TRANSITION',
            availableOperations: ['reopen'],
          });
        });
      },
    });
  }

  it.each(cases)('$path maps to $status problem+json', async ({ path, status, title }) => {
    const { app } = taxonomyHarness();

    const response = await app.request(`http://localhost/api/v1${path}`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    expect(body).toMatchObject({ status, title });
    expect(body['correlationId']).toBeTypeOf('string');
  });

  it('409 carries the legal-operation hint', async () => {
    const { app } = taxonomyHarness();

    const body = (await (await app.request('http://localhost/api/v1/e/409')).json()) as Record<string, unknown>;

    expect(body['availableOperations']).toEqual(['reopen']);
    expect(body['code']).toBe('QUOTE_ILLEGAL_TRANSITION');
  });
});

describe('correlation id (spec §15, V-013)', () => {
  it('generates one and echoes it in the response header', async () => {
    const { app } = harness();

    const response = await app.request('http://localhost/api/v1/health');
    const header = response.headers.get('x-correlation-id');

    expect(header).toBeTypeOf('string');
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates a safe inbound x-correlation-id verbatim into header and log line', async () => {
    const h = harness();

    const response = await h.app.request('http://localhost/api/v1/health', {
      headers: { 'x-correlation-id': 'caller-supplied-id-42' },
    });

    expect(response.headers.get('x-correlation-id')).toBe('caller-supplied-id-42');
    expect(h.logRecords().at(-1)!['correlationId']).toBe('caller-supplied-id-42');
  });

  it('rejects an unsafe inbound correlation id rather than echoing it (log injection guard)', async () => {
    const h = harness();

    const response = await h.app.request('http://localhost/api/v1/health', {
      // A legal header value that is still unsafe to echo into a log line.
      headers: { 'x-correlation-id': 'spaces and "quotes" level=fake' },
    });

    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.logText()).not.toContain('level=fake');
  });
});

describe('request logging (AC-011, V-013)', () => {
  it('emits one JSON line per request with correlationId, route, method, status and durationMs', async () => {
    const h = harness();

    await h.app.request('http://localhost/api/v1/health');

    const records = h.logRecords();
    expect(records).toHaveLength(1);

    const record = records[0]!;
    expect(record['correlationId']).toBeTypeOf('string');
    expect(record['route']).toBe('GET /api/v1/health');
    expect(record['method']).toBe('GET');
    expect(record['status']).toBe(200);
    expect(record['durationMs']).toBeTypeOf('number');
    expect(record['durationMs'] as number).toBeGreaterThanOrEqual(0);
    expect(record['level']).toBe('info');
  });

  it('logs the status of an error response, not just successes', async () => {
    const h = harness();

    await h.app.request('http://localhost/api/v1/definitely-not-a-route');

    const requestRecord = h.logRecords().find((record) => record['durationMs'] !== undefined);
    expect(requestRecord!['status']).toBe(404);
  });

  it('includes userId and tenantId once the auth and tenant slots populate them', async () => {
    // T-011/T-013 fill the reserved middleware slots; this proves the log plumbing already reads
    // whatever they set, so V-013's authenticated tenant-scoped assertion has a working substrate.
    const h = harness({
      register: (app) => {
        app.use('*', async (c, next) => {
          c.set('userId', 'user-123');
          c.set('tenantId', '42');
          await next();
        });
        app.get('/scoped', (c) => c.json({ ok: true }));
      },
    });

    await h.app.request('http://localhost/api/v1/scoped');

    const record = h.logRecords().at(-1)!;
    expect(record['userId']).toBe('user-123');
    expect(record['tenantId']).toBe('42');
    expect(record['correlationId']).toBeTypeOf('string');
  });

  it('never writes an Authorization header value into the request log', async () => {
    const h = harness();

    await h.app.request('http://localhost/api/v1/health', {
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-token' },
    });

    expect(h.logText()).not.toContain('super-secret-token');
    expect(h.logText()).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('security headers (spec §16)', () => {
  it('sets the reference header set on a successful response', async () => {
    const { app } = harness();

    const response = await app.request('http://localhost/api/v1/health');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('sets them on error responses too (404/500), as the .NET middleware ordering guaranteed', async () => {
    const h = harness({
      register: (app) => {
        app.get('/boom', () => {
          throw new Error('boom');
        });
      },
    });

    for (const path of ['/api/v1/definitely-not-a-route', '/api/v1/boom']) {
      const response = await h.app.request(`http://localhost${path}`);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
    }
  });

  it('omits HSTS locally, where TLS is not real (parity with SecurityHeadersMiddleware)', async () => {
    const { app } = harness({ config: testConfig({ APP_ENV: 'local' }) });

    const response = await app.request('http://localhost/api/v1/health');

    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('emits HSTS in deployed environments', async () => {
    const { app } = harness({ config: testConfig({ APP_ENV: 'production' }) });

    const response = await app.request('http://localhost/api/v1/health');

    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });
});
