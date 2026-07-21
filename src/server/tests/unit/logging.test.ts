import { describe, expect, it } from 'vitest';

import {
  CORRELATION_ID_HEADER,
  createLogger,
  jobLogger,
  newCorrelationId,
  redact,
  requestLogger,
  resolveCorrelationId,
  scrubString,
  type LogSink,
} from '../../lib/logging/index.js';
import { describeSensitiveMatches, findSensitiveData } from '../helpers/sensitive-scan.js';

interface Capture {
  readonly lines: string[];
  readonly sink: LogSink;
  records(): Record<string, unknown>[];
  last(): Record<string, unknown>;
  text(): string;
}

function capture(): Capture {
  const lines: string[] = [];
  return {
    lines,
    sink: (line: string) => {
      lines.push(line);
    },
    records() {
      return lines.map((line) => JSON.parse(line.trimEnd()) as Record<string, unknown>);
    },
    last() {
      const parsed = this.records();
      expect(parsed.length).toBeGreaterThan(0);
      return parsed[parsed.length - 1]!;
    },
    text() {
      return lines.join('');
    },
  };
}

const fixedClock = () => new Date('2026-07-18T12:34:56.789Z');

function testLogger(context: Record<string, unknown> = {}, sink?: LogSink) {
  return createLogger(context, {
    ...(sink === undefined ? {} : { sink }),
    level: 'debug',
    env: 'test',
    clock: fixedClock,
  });
}

describe('structured log shape', () => {
  it('emits one parseable JSON object per call', () => {
    const out = capture();
    const log = testLogger({}, out.sink);

    log.info('lead created');

    expect(out.lines).toHaveLength(1);
    expect(() => JSON.parse(out.lines[0]!.trimEnd())).not.toThrow();
  });

  it('emits exactly one trailing newline and no embedded newlines', () => {
    const out = capture();

    testLogger({}, out.sink).info('multi\nline\nmessage');

    const line = out.lines[0]!;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('includes level, message, timestamp and environment stamp', () => {
    const out = capture();

    testLogger({}, out.sink).warn('sla breach detected');

    const record = out.last();
    expect(record.level).toBe('warn');
    expect(record.message).toBe('sla breach detected');
    expect(record.timestamp).toBe('2026-07-18T12:34:56.789Z');
    expect(record.env).toBe('test');
  });

  it('carries request context fields required by V-013', () => {
    const out = capture();

    requestLogger(
      {
        correlationId: 'corr-123',
        userId: 'user-9',
        tenantId: 'tenant-4',
        route: 'GET /api/v1/leads',
      },
      { sink: out.sink, level: 'debug', env: 'test', clock: fixedClock },
    ).info('request completed', { status: 200, durationMs: 42 });

    const record = out.last();
    expect(record).toMatchObject({
      correlationId: 'corr-123',
      userId: 'user-9',
      tenantId: 'tenant-4',
      route: 'GET /api/v1/leads',
      status: 200,
      durationMs: 42,
    });
  });

  it('carries job context fields required by V-013', () => {
    const out = capture();

    jobLogger(
      { jobName: 'alerts.sweep', correlationId: 'corr-job-1' },
      { sink: out.sink, level: 'debug', env: 'test', clock: fixedClock },
    ).info('job finished', { counts: { 'tenant-1': 3, 'tenant-2': 0 }, durationMs: 1200 });

    const record = out.last();
    expect(record.jobName).toBe('alerts.sweep');
    expect(record.correlationId).toBe('corr-job-1');
    expect(record.counts).toEqual({ 'tenant-1': 3, 'tenant-2': 0 });
  });

  it('merges child context and lets the child override inherited values', () => {
    const out = capture();
    const base = testLogger({ correlationId: 'corr-1', tenantId: 'tenant-1' }, out.sink);

    base.child({ tenantId: 'tenant-2', route: 'POST /api/v1/quotes' }).info('scoped');

    const record = out.last();
    expect(record.correlationId).toBe('corr-1');
    expect(record.tenantId).toBe('tenant-2');
    expect(record.route).toBe('POST /api/v1/quotes');
  });

  it('does not mutate the parent context when a child adds fields', () => {
    const out = capture();
    const base = testLogger({ correlationId: 'corr-1' }, out.sink);

    base.child({ tenantId: 'tenant-2' }).info('child');
    base.info('parent');

    const [child, parent] = out.records();
    expect(child!.tenantId).toBe('tenant-2');
    expect(parent!.tenantId).toBeUndefined();
  });

  it('omits undefined context values instead of emitting nulls', () => {
    const out = capture();

    testLogger({ correlationId: 'corr-1', userId: undefined }, out.sink).info('anonymous');

    expect(Object.keys(out.last())).not.toContain('userId');
  });

  it('honours the configured minimum level', () => {
    const out = capture();
    const log = createLogger({}, { sink: out.sink, level: 'warn', env: 'test', clock: fixedClock });

    log.debug('noisy');
    log.info('chatty');
    log.warn('warned');
    log.error('failed');

    expect(out.records().map((r) => r.level)).toEqual(['warn', 'error']);
  });
});

describe('correlation ids', () => {
  it('generates a distinct uuid when no id is supplied', () => {
    const first = newCorrelationId();
    const second = newCorrelationId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it('propagates an inbound correlation id verbatim from a Headers object', () => {
    const headers = new Headers({ [CORRELATION_ID_HEADER]: 'inbound-corr-42' });

    expect(resolveCorrelationId(headers)).toBe('inbound-corr-42');
  });

  it('propagates an inbound correlation id from a plain header record', () => {
    expect(resolveCorrelationId({ 'X-Correlation-Id': 'inbound-corr-43' })).toBe('inbound-corr-43');
  });

  it('falls back to x-request-id when no correlation header is present', () => {
    expect(resolveCorrelationId({ 'x-request-id': 'req-77' })).toBe('req-77');
  });

  it('generates a new id when the header is absent', () => {
    expect(resolveCorrelationId({})).toMatch(/^[0-9a-f]{8}-/);
    expect(resolveCorrelationId()).toMatch(/^[0-9a-f]{8}-/);
  });

  it.each([
    ['newline injection', 'abc\n{"level":"error"}'],
    ['carriage return', 'abc\rdef'],
    ['empty', '   '],
    ['over-long', 'x'.repeat(200)],
  ])('rejects an untrusted inbound correlation id (%s) and generates a fresh one', (_label, value) => {
    const resolved = resolveCorrelationId({ [CORRELATION_ID_HEADER]: value });

    expect(resolved).not.toBe(value);
    expect(resolved).toMatch(/^[0-9a-f]{8}-/);
  });
});

/**
 * Each case is a real secret value that MUST NOT survive serialization.
 * `control` proves the fixture is not vacuous: it is a value that must still be readable.
 */
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.s1gnatur3v4lue';
const ACCESS_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.abcdefghijklmnop';
const REFRESH_TOKEN = 'v1MTo6cmVmcmVzaC10b2tlbi12YWx1ZQ';
const PASSWORD = 'Sup3rSecret-Password!';
const DB_PASSWORD = 'db-p4ssw0rd-value';
const DATABASE_URL = `postgresql://postgres:${DB_PASSWORD}@db.example.supabase.co:6543/postgres`;
const API_KEY = 'qiq_live_9f8e7d6c5b4a3210';
const PEPPER = 'pepper-value-with-enough-entropy';
const SSN = '123-45-6789';
const ATTACHMENT = 'JVBERi0xLjQKJcfsj6IKNSAwIG9iago8PC9MZW5ndGg';

interface RedactionCase {
  readonly name: string;
  readonly secret: string;
  readonly build: () => Record<string, unknown>;
}

const redactionCases: readonly RedactionCase[] = [
  {
    name: 'Authorization header value',
    secret: ACCESS_TOKEN,
    build: () => ({ headers: { authorization: `Bearer ${ACCESS_TOKEN}`, accept: 'application/json' } }),
  },
  {
    name: 'Authorization header under a non-obvious key',
    secret: ACCESS_TOKEN,
    build: () => ({ note: `inbound header was Bearer ${ACCESS_TOKEN}` }),
  },
  {
    name: 'access token',
    secret: ACCESS_TOKEN,
    build: () => ({ accessToken: ACCESS_TOKEN }),
  },
  {
    name: 'refresh token',
    secret: REFRESH_TOKEN,
    build: () => ({ refresh_token: REFRESH_TOKEN }),
  },
  {
    name: 'password',
    secret: PASSWORD,
    build: () => ({ credentials: { email: 'user@example.com', password: PASSWORD } }),
  },
  {
    name: 'supabase service-role key',
    secret: SERVICE_ROLE_KEY,
    build: () => ({ supabase: { serviceRoleKey: SERVICE_ROLE_KEY } }),
  },
  {
    name: 'supabase service-role key under a benign key name',
    secret: SERVICE_ROLE_KEY,
    build: () => ({ detail: `client configured with ${SERVICE_ROLE_KEY}` }),
  },
  {
    name: 'DATABASE_URL credentials',
    secret: DB_PASSWORD,
    build: () => ({ database: { url: DATABASE_URL } }),
  },
  {
    name: 'plaintext API key',
    secret: API_KEY,
    build: () => ({ apiKey: API_KEY }),
  },
  {
    name: 'API key pepper',
    secret: PEPPER,
    build: () => ({ API_KEY_PEPPER: PEPPER }),
  },
  {
    name: 'cookie header',
    secret: 'sb-access-token=abc123def456',
    build: () => ({ cookie: 'sb-access-token=abc123def456' }),
  },
  {
    name: 'PII (national identifier)',
    secret: SSN,
    build: () => ({ party: { name: 'Acme Ltd', ssn: SSN } }),
  },
  {
    name: 'attachment content',
    secret: ATTACHMENT,
    build: () => ({ attachmentContent: ATTACHMENT }),
  },
  {
    name: 'secret nested four levels deep',
    secret: PASSWORD,
    build: () => ({ a: { b: { c: { password: PASSWORD } } } }),
  },
  {
    name: 'secret inside an array of objects',
    secret: ACCESS_TOKEN,
    build: () => ({ attempts: [{ ok: true }, { accessToken: ACCESS_TOKEN }] }),
  },
  {
    name: 'secret inside an array of strings',
    secret: SERVICE_ROLE_KEY,
    build: () => ({ args: ['--key', SERVICE_ROLE_KEY] }),
  },
  {
    name: 'secret inside an Error message',
    secret: DB_PASSWORD,
    build: () => ({ err: new Error(`connect ECONNREFUSED for ${DATABASE_URL}`) }),
  },
  {
    name: 'secret inside a nested Error cause',
    secret: ACCESS_TOKEN,
    build: () => ({
      err: new Error('request failed', { cause: new Error(`Bearer ${ACCESS_TOKEN}`) }),
    }),
  },
  {
    name: 'secret on a custom Error property',
    secret: PASSWORD,
    build: () => {
      const error = Object.assign(new Error('login failed'), { password: PASSWORD });
      return { err: error };
    },
  },
  {
    name: 'secret inside a Map value',
    secret: SERVICE_ROLE_KEY,
    build: () => ({ entries: new Map([['token', SERVICE_ROLE_KEY]]) }),
  },
];

describe('redaction — sensitive values never reach the output', () => {
  it.each(redactionCases.map((c) => [c.name, c] as const))(
    'removes %s from the serialized log line',
    (_name, testCase) => {
      // Guard against a vacuous test: the raw fixture must actually contain the secret, so
      // that "the secret is absent" can only be satisfied by real redaction.
      const raw = JSON.stringify(testCase.build(), (_k, v: unknown) => {
        if (v instanceof Error) {
          return { ...v, name: v.name, message: v.message, cause: v.cause };
        }
        if (v instanceof Map) return Object.fromEntries(v);
        return v;
      });
      expect(raw, 'fixture must contain the secret before redaction').toContain(testCase.secret);

      const out = capture();
      testLogger({}, out.sink).error('operation failed', testCase.build());

      const line = out.text();
      expect(line).not.toContain(testCase.secret);
      expect(line).toContain('[REDACTED]');
    },
  );

  it.each(redactionCases.map((c) => [c.name, c] as const))(
    'passes the shared sensitive-data scan for %s',
    (_name, testCase) => {
      const out = capture();
      testLogger({}, out.sink).error('operation failed', testCase.build());

      const matches = findSensitiveData(out.text(), [testCase.secret]);
      expect(matches, describeSensitiveMatches(matches)).toEqual([]);
    },
  );

  it('scrubs secrets embedded in the log message itself', () => {
    const out = capture();

    testLogger({}, out.sink).error(`token refresh failed for Bearer ${ACCESS_TOKEN}`);

    const line = out.text();
    expect(line).not.toContain(ACCESS_TOKEN);
    expect(findSensitiveData(line, [ACCESS_TOKEN])).toEqual([]);
  });

  it('scrubs secrets appearing in a context KEY as well as a value', () => {
    const out = capture();

    testLogger({}, out.sink).error('bad key', { [`token-${ACCESS_TOKEN}`]: 'x' });

    expect(out.text()).not.toContain(ACCESS_TOKEN);
  });

  it('preserves non-sensitive diagnostic values (redaction is not blanket deletion)', () => {
    const out = capture();

    testLogger({}, out.sink).info('request completed', {
      correlationId: 'corr-1',
      tenantId: 'tenant-7',
      route: 'GET /api/v1/leads',
      status: 200,
      durationMs: 15,
      leadRef: 'LEAD-2026-000123',
      counts: { created: 2 },
    });

    const record = out.last();
    expect(record.leadRef).toBe('LEAD-2026-000123');
    expect(record.status).toBe(200);
    expect(record.durationMs).toBe(15);
    expect(record.counts).toEqual({ created: 2 });
    expect(JSON.stringify(record)).not.toContain('[REDACTED]');
  });

  it('keeps the redacted key present so the shape stays diagnosable', () => {
    const out = capture();

    testLogger({}, out.sink).info('auth', { accessToken: ACCESS_TOKEN });

    expect(out.last().accessToken).toBe('[REDACTED]');
  });

  it('serializes Error objects with name, message and stack', () => {
    const out = capture();

    testLogger({}, out.sink).error('boom', { err: new TypeError('bad shape') });

    const err = out.last().err as Record<string, unknown>;
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('bad shape');
    expect(typeof err.stack).toBe('string');
  });

  it('does not throw or hang on circular structures', () => {
    const out = capture();
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;

    expect(() => testLogger({}, out.sink).info('circular', { circular })).not.toThrow();
    expect(out.last().circular).toMatchObject({ name: 'root', self: '[Circular]' });
  });

  it('caps recursion depth instead of exploding on deep structures', () => {
    const out = capture();
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 40; i += 1) {
      deep = { nested: deep };
    }

    expect(() => testLogger({}, out.sink).info('deep', { deep })).not.toThrow();
    expect(out.text()).toContain('[MaxDepth]');
  });

  it('summarizes binary payloads rather than dumping their content', () => {
    const out = capture();

    testLogger({}, out.sink).info('upload', { buffer: Buffer.from('confidential-quote-pdf') });

    const line = out.text();
    expect(line).not.toContain('confidential-quote-pdf');
    expect(line).toMatch(/Buffer/);
  });
});

describe('redact / scrubString primitives', () => {
  it('redact is reusable outside the logger and returns JSON-safe values', () => {
    const result = redact({ password: PASSWORD, tenantId: 't-1' }) as Record<string, unknown>;

    expect(result.password).toBe('[REDACTED]');
    expect(result.tenantId).toBe('t-1');
  });

  it.each([
    ['bearer token', `Authorization: Bearer ${ACCESS_TOKEN}`, ACCESS_TOKEN],
    ['basic auth', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['jwt', `token is ${SERVICE_ROLE_KEY}`, SERVICE_ROLE_KEY],
    ['postgres url password', `dsn=${DATABASE_URL}`, DB_PASSWORD],
    ['supabase secret key', 'key sb_secret_abcdef123456', 'sb_secret_abcdef123456'],
  ])('scrubString removes %s', (_label, input, secret) => {
    const scrubbed = scrubString(input);

    expect(scrubbed).not.toContain(secret);
    expect(findSensitiveData(scrubbed, [secret])).toEqual([]);
  });

  it('scrubString leaves ordinary text untouched', () => {
    expect(scrubString('lead LEAD-2026-000123 moved to Quoted')).toBe(
      'lead LEAD-2026-000123 moved to Quoted',
    );
  });

  it('keeps the host of a connection string readable while removing the password', () => {
    const scrubbed = scrubString(DATABASE_URL);

    expect(scrubbed).toContain('db.example.supabase.co');
    expect(scrubbed).not.toContain(DB_PASSWORD);
  });
});
