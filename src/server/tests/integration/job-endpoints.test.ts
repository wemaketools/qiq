/**
 * Job endpoints and the drain loop end-to-end against the local stack
 * (T-031, AC-062/AC-063/AC-064, V-079/V-080/V-081).
 *
 * This suite imports the ACTUAL Vercel entrypoints — api/queue/drain.ts and the three
 * api/cron/*.ts files — rather than the shared helpers behind them. Testing the helper would leave
 * the one thing an attacker actually reaches (the exported default function) unproven; the
 * environment is stubbed instead so the real `createJobRuntime()` path runs.
 *
 * The queue, the job_run rows and the handler's side effect are all real. Nothing about pgmq is
 * mocked here — the in-memory adapter is confined to the unit tests.
 *
 * DESTRUCTIVE TO LOCAL QUEUE STATE: these tests purge the shared `alert_reevaluation` queue and its
 * archive between cases. Anything else using that queue on the same local stack — a developer's
 * `queue:worker`, a hand-enqueued message — will be swept away while this suite runs. That is the
 * price of testing the REAL migrated queue rather than a private one, and it is safe because the
 * local database is disposable; do not run this suite against a database you care about.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';

import { resetConfigCache } from '../../lib/config/index.js';
import { closeDb, createDb, type DbHandle } from '../../lib/db/index.js';
import { createJobRuntime, type JobRuntime } from '../../jobs/runtime.js';
import { ALERT_REEVALUATION_QUEUE } from '../../jobs/queue/pgmq-adapter.js';
import { registerQueueHandler } from '../../jobs/queue/registry.js';
import { jobMessageEnvelopeSchema, type JobHandler, type JobMessageEnvelope } from '../../jobs/types.js';
import alertEvaluationEntrypoint, {
  jobName as alertEvaluationJobName,
} from '../../../../api/cron/alert-evaluation.js';
import leadInactivityEntrypoint, {
  jobName as leadInactivityJobName,
} from '../../../../api/cron/lead-inactivity-expiry.js';
import quoteExpiryEntrypoint, {
  jobName as quoteExpiryJobName,
} from '../../../../api/cron/quote-expiry.js';
import drainEntrypoint from '../../../../api/queue/drain.js';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('job endpoints and queue drain', probe);

const CRON_SECRET = 'integration-cron-secret-value-0001';
const INTERNAL_JOB_SECRET = 'integration-internal-job-secret-0002';

/** Everything this suite writes is tagged so cleanup is exact and other suites are untouched. */
const EFFECT_ENTITY_TYPE = 'job_test_effect';
const CORRELATION_PREFIX = 'jobs-it';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type EndpointHandler = (request: Request) => Promise<Response>;

/**
 * A handler with a REAL, countable database effect. Idempotency claims are only meaningful against
 * something that would visibly happen twice — a handler that writes nothing cannot demonstrate
 * exactly-once.
 */
const auditEffectHandler: JobHandler = {
  name: 'test.audit-effect',
  async handle(payload, context) {
    const marker = String((payload as { marker?: unknown }).marker ?? 'unmarked');
    await context.db
      .insertInto('audit_log')
      .values({
        tenant_id: null,
        entity_type: EFFECT_ENTITY_TYPE,
        entity_id: marker,
        action: 'job-effect-applied',
        actor_label: 'system',
        acted_at: sql<string>`now()`,
        details: null,
      })
      .execute();
    return { counts: { effects: 1, marker } };
  },
};

const alwaysFailsHandler: JobHandler = {
  name: 'test.always-fails',
  async handle() {
    throw new Error('deliberate handler failure');
  },
};

const slowHandler: JobHandler = {
  name: 'test.slow',
  async handle() {
    await sleep(120);
    return { counts: { slow: 1 } };
  },
};

function envelope(overrides: Partial<JobMessageEnvelope> = {}): JobMessageEnvelope {
  const unique = Math.random().toString(36).slice(2, 10);
  return jobMessageEnvelopeSchema.parse({
    type: auditEffectHandler.name,
    tenantId: null,
    correlationId: `${CORRELATION_PREFIX}-${unique}`,
    idempotencyKey: `${CORRELATION_PREFIX}:${unique}`,
    payload: { marker: unique },
    ...overrides,
  });
}

describeStack(title, () => {
  let handle: DbHandle;
  let runtime: JobRuntime;
  let drainEndpoint: EndpointHandler;
  const cronEndpoints = new Map<string, EndpointHandler>();

  beforeAll(() => {
    if (!probe.available) return;

    // The real entrypoints read configuration through getConfig(); stub the environment they see
    // so the production wiring (createJobRuntime -> getDb -> PgmqTransport) is what runs.
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('LOG_LEVEL', 'error');
    vi.stubEnv('SUPABASE_DATABASE_URL', probe.stack.dbUrl);
    vi.stubEnv('SUPABASE_DIRECT_DATABASE_URL', probe.stack.dbUrl);
    vi.stubEnv('SUPABASE_URL', probe.stack.apiUrl);
    vi.stubEnv('SUPABASE_ANON_KEY', probe.stack.anonKey);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', probe.stack.serviceRoleKey);
    vi.stubEnv('CRON_SECRET', CRON_SECRET);
    vi.stubEnv('INTERNAL_JOB_SECRET', INTERNAL_JOB_SECRET);
    vi.stubEnv('API_KEY_PEPPER', 'integration-api-key-pepper-value');
    resetConfigCache();

    registerQueueHandler(auditEffectHandler);
    registerQueueHandler(alwaysFailsHandler);
    registerQueueHandler(slowHandler);

    handle = createDb({ connectionString: probe.stack.dbUrl });
    runtime = createJobRuntime();

    drainEndpoint = drainEntrypoint;
    cronEndpoints.set(quoteExpiryJobName, quoteExpiryEntrypoint);
    cronEndpoints.set(leadInactivityJobName, leadInactivityEntrypoint);
    cronEndpoints.set(alertEvaluationJobName, alertEvaluationEntrypoint);
  });

  afterEach(async () => {
    if (!probe.available) return;
    await sql`select pgmq.purge_queue(${ALERT_REEVALUATION_QUEUE})`.execute(handle.db);
    await sql`delete from pgmq.a_alert_reevaluation`.execute(handle.db);
  });

  afterAll(async () => {
    if (probe.available) {
      await sql`delete from audit_log where entity_type = ${EFFECT_ENTITY_TYPE}`.execute(handle.db);
      await sql`delete from job_idempotency_key where key like ${`${CORRELATION_PREFIX}:%`}`.execute(
        handle.db,
      );
      await sql`delete from job_run where correlation_id like ${`${CORRELATION_PREFIX}-%`}`.execute(
        handle.db,
      );
      await handle.close();
      await closeDb();
    }
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  // --- helpers ------------------------------------------------------------------------------

  function drainRequest(authorization?: string): Request {
    return new Request('https://example.test/api/queue/drain', {
      method: 'POST',
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  async function countEffects(marker: string): Promise<number> {
    const result = await sql<{ count: number }>`
      select count(*)::int as count from audit_log
       where entity_type = ${EFFECT_ENTITY_TYPE} and entity_id = ${marker}
    `.execute(handle.db);
    return result.rows[0]?.count ?? 0;
  }

  async function countJobRuns(): Promise<number> {
    const result = await sql<{ count: number }>`select count(*)::int as count from job_run`.execute(
      handle.db,
    );
    return result.rows[0]?.count ?? 0;
  }

  async function jobRunsFor(correlationId: string): Promise<
    readonly {
      job_name: string;
      trigger: string;
      environment: string;
      correlation_id: string;
      status: string;
      attempt: number;
      duration_ms: number | null;
      finished_at: Date | null;
      idempotency_key: string | null;
      message_id: number | null;
      error_class: string | null;
      error_message: string | null;
      counts: Record<string, unknown> | null;
    }[]
  > {
    const result = await sql<{
      job_name: string;
      trigger: string;
      environment: string;
      correlation_id: string;
      status: string;
      attempt: number;
      duration_ms: number | null;
      finished_at: Date | null;
      idempotency_key: string | null;
      message_id: number | null;
      error_class: string | null;
      error_message: string | null;
      counts: Record<string, unknown> | null;
    }>`
      select job_name, trigger, environment, correlation_id, status, attempt, duration_ms,
             finished_at, idempotency_key, message_id, error_class, error_message, counts
        from job_run where correlation_id = ${correlationId} order by id asc
    `.execute(handle.db);
    return result.rows;
  }

  async function queueLength(): Promise<number> {
    return (await runtime.transport.metrics()).queueLength;
  }

  // --- AC-064 / AC-063: round trip through the real endpoint ---------------------------------

  it('drains an enqueued message end to end and records a complete job_run row', async () => {
    const message = envelope();
    await runtime.publisher.enqueue(message);

    const response = await drainEndpoint(drainRequest(`Bearer ${INTERNAL_JOB_SECRET}`));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, read: 1, succeeded: 1, failed: 0, deadLettered: 0 });

    expect(await countEffects(String(message.payload.marker))).toBe(1);
    expect(await queueLength()).toBe(0);

    const runs = await jobRunsFor(message.correlationId);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.job_name).toBe(auditEffectHandler.name);
    expect(run?.trigger).toBe('queue');
    expect(run?.environment).toBe('local');
    // §15: the correlation id supplied at enqueue survives into the job_run row.
    expect(run?.correlation_id).toBe(message.correlationId);
    expect(run?.status).toBe('succeeded');
    expect(run?.attempt).toBe(1);
    expect(run?.idempotency_key).toBe(message.idempotencyKey);
    expect(run?.message_id).not.toBeNull();
    expect(run?.finished_at).not.toBeNull();
    expect(run?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(run?.counts).toMatchObject({ effects: 1 });
  });

  it('applies the effect exactly once when the same idempotency key arrives twice', async () => {
    const first = envelope();
    const duplicate = envelope({
      idempotencyKey: first.idempotencyKey,
      correlationId: first.correlationId,
      payload: first.payload,
    });

    await runtime.publisher.enqueue(first);
    await runtime.publisher.enqueue(duplicate);

    const response = await drainEndpoint(drainRequest(`Bearer ${INTERNAL_JOB_SECRET}`));
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ read: 2, succeeded: 1, duplicates: 1 });
    // THE assertion: two deliveries of the same unit of work, one row written.
    expect(await countEffects(String(first.payload.marker))).toBe(1);
    // Both messages are gone: a duplicate is completed work, not work to retry forever.
    expect(await queueLength()).toBe(0);

    const runs = await jobRunsFor(first.correlationId);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
    expect(runs[1]?.counts).toMatchObject({ duplicate: 1 });

    const claims = await sql<{ count: number }>`
      select count(*)::int as count from job_idempotency_key where key = ${first.idempotencyKey}
    `.execute(handle.db);
    expect(claims.rows[0]?.count).toBe(1);
  });

  it('two distinct keys both apply (positive control against over-eager deduplication)', async () => {
    const a = envelope();
    const b = envelope();
    await runtime.publisher.enqueue(a);
    await runtime.publisher.enqueue(b);

    await drainEndpoint(drainRequest(`Bearer ${INTERNAL_JOB_SECRET}`));

    expect(await countEffects(String(a.payload.marker))).toBe(1);
    expect(await countEffects(String(b.payload.marker))).toBe(1);
  });

  it('retries a failing message and dead-letters it after max attempts, recording every attempt', async () => {
    const message = envelope({ type: alwaysFailsHandler.name });
    await runtime.publisher.enqueue(message);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const summary = await runtime.consumer.drain({
        maxAttempts: 5,
        retryDelaySeconds: 1,
        visibilityTimeoutSeconds: 1,
      });
      expect(summary.failed).toBe(1);
      expect(summary.deadLettered).toBe(attempt === 5 ? 1 : 0);
      // The failed message must still be there for attempts 1-4 — an ack on failure loses work.
      if (attempt < 5) expect(await queueLength()).toBe(1);
      // The retry delay is real (floored at 1s), so wait it out rather than spinning.
      await sleep(1_200);
    }

    expect(await queueLength()).toBe(0);
    const archived = await sql<{ count: number }>`
      select count(*)::int as count from pgmq.a_alert_reevaluation
    `.execute(handle.db);
    expect(archived.rows[0]?.count).toBe(1);

    const runs = await jobRunsFor(message.correlationId);
    expect(runs).toHaveLength(5);
    expect(runs.map((run) => run.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(runs.every((run) => run.status === 'failed')).toBe(true);
    expect(runs.every((run) => run.finished_at !== null)).toBe(true);
    expect(runs[0]?.error_class).toBe('Error');
    expect(runs[0]?.error_message).toBe('deliberate handler failure');
    expect(runs[4]?.counts).toMatchObject({ deadLettered: true });

    // A dead-lettered message is never delivered again.
    await sleep(1_200);
    const after = await runtime.consumer.drain({ maxAttempts: 5 });
    expect(after.read).toBe(0);
  });

  it('rolls back the idempotency claim with the failed effect, so the retry really re-runs', async () => {
    const message = envelope({ type: alwaysFailsHandler.name });
    await runtime.publisher.enqueue(message);

    await runtime.consumer.drain({ maxAttempts: 5, retryDelaySeconds: 1, visibilityTimeoutSeconds: 1 });

    const claims = await sql<{ count: number }>`
      select count(*)::int as count from job_idempotency_key where key = ${message.idempotencyKey}
    `.execute(handle.db);
    // A claim surviving a rolled-back attempt would make every retry a silent no-op.
    expect(claims.rows[0]?.count).toBe(0);

    await sleep(1_200);
    const second = await runtime.consumer.drain({ maxAttempts: 5, retryDelaySeconds: 1 });
    expect(second.read).toBe(1);
    expect(second.duplicates).toBe(0);
  });

  it('stops draining when the time budget is spent and leaves the remaining messages queued', async () => {
    for (let index = 0; index < 8; index += 1) {
      await runtime.publisher.enqueue(envelope({ type: slowHandler.name }));
    }

    const summary = await runtime.consumer.drain({
      timeBudgetMs: 300,
      visibilityTimeoutSeconds: 1,
    });

    expect(summary.budgetExhausted).toBe(true);
    expect(summary.read).toBeLessThan(8);
    expect(summary.read).toBeGreaterThan(0);
    expect(await queueLength()).toBe(8 - summary.succeeded);

    // The next invocation picks up exactly what was left, once the visibility timeout lapses.
    await sleep(1_300);
    const second = await runtime.consumer.drain({ timeBudgetMs: 30_000 });
    expect(second.succeeded).toBe(8 - summary.succeeded);
    expect(await queueLength()).toBe(0);
  });

  // --- AC-062: endpoint protection ------------------------------------------------------------

  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer definitely-not-the-secret'],
    ['an empty bearer credential', 'Bearer '],
    ['the OTHER endpoint\'s secret', `Bearer ${CRON_SECRET}`],
  ])('/api/queue/drain rejects %s with no side effects', async (_label, authorization) => {
    const message = envelope();
    await runtime.publisher.enqueue(message);
    const jobRunsBefore = await countJobRuns();

    const response = await drainEndpoint(drainRequest(authorization));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    // Zero side effects: no job_run row, no handler effect, and the message is untouched.
    expect(await countJobRuns()).toBe(jobRunsBefore);
    expect(await countEffects(String(message.payload.marker))).toBe(0);
    expect(await queueLength()).toBe(1);
  });

  it('/api/queue/drain accepts the correct secret (positive control)', async () => {
    const message = envelope();
    await runtime.publisher.enqueue(message);

    const response = await drainEndpoint(drainRequest(`Bearer ${INTERNAL_JOB_SECRET}`));

    expect(response.status).toBe(200);
    expect(await countEffects(String(message.payload.marker))).toBe(1);
  });

  it.each(['quote-expiry', 'lead-inactivity-expiry', 'alert-evaluation'])(
    '/api/cron/%s rejects a missing and a wrong secret without writing a job_run row',
    async (jobName) => {
      const endpoint = cronEndpoints.get(jobName);
      expect(endpoint).toBeDefined();
      const before = await countJobRuns();

      for (const authorization of [undefined, 'Bearer wrong-cron-secret', `Bearer ${INTERNAL_JOB_SECRET}`]) {
        const response = await endpoint!(
          new Request(`https://example.test/api/cron/${jobName}`, {
            headers: authorization === undefined ? {} : { authorization },
          }),
        );
        expect(response.status).toBe(401);
        expect(response.headers.get('content-type')).toBe('application/problem+json');
      }

      expect(await countJobRuns()).toBe(before);
    },
  );

  it.each(['quote-expiry', 'lead-inactivity-expiry', 'alert-evaluation'])(
    '/api/cron/%s with the correct secret runs the registered sweep and records a job_run row',
    async (jobName) => {
      const endpoint = cronEndpoints.get(jobName);
      const correlationId = `${CORRELATION_PREFIX}-cron-${jobName}`;
      const response = await endpoint!(
        new Request(`https://example.test/api/cron/${jobName}`, {
          headers: { authorization: `Bearer ${CRON_SECRET}`, 'x-correlation-id': correlationId },
        }),
      );

      // All three sweeps are registered (T-032's two expiries, T-034's alert-evaluation), so these
      // now execute for real. The endpoint is the DEPLOYED path (pg_cron -> pg_net -> here), and
      // this asserts the secret-protected URL actually reaches the sweep rather than merely
      // authenticating.
      //
      // 501 is the assertion that matters and the one registration flips. The exact success/failure of
      // the sweep is deliberately NOT asserted: it walks every active tenant in a database shared
      // with other suites, and an unprovisioned tenant belonging to some other suite is a legitimate
      // per-tenant failure that has nothing to do with this endpoint. Sweep correctness is pinned
      // against controlled fixtures in the two dedicated suites.
      expect(response.status).not.toBe(501);

      const runs = await jobRunsFor(correlationId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        job_name: jobName,
        trigger: 'cron',
        environment: 'local',
      });
      expect(runs[0]?.duration_ms).toBeGreaterThanOrEqual(0);
      // The handler was found and ran — the property this test exists for.
      expect(runs[0]?.error_class).not.toBe('HandlerNotRegisteredError');
    },
  );

  it('/api/cron/alert-evaluation is registered by T-034: no longer a 501, no HandlerNotRegisteredError', async () => {
    const jobName = 'alert-evaluation';
    const endpoint = cronEndpoints.get(jobName);
    // Distinct from the parametrized test above, which now also runs alert-evaluation — a shared
    // correlation id would leave two job_run rows and break the single-row assertion.
    const correlationId = `${CORRELATION_PREFIX}-cron-ae-standalone`;
    const response = await endpoint!(
      new Request(`https://example.test/api/cron/${jobName}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}`, 'x-correlation-id': correlationId },
      }),
    );

    // The inverse of what T-033 left red by design: registration lands in T-034, so the endpoint
    // now reaches the handler. A regression to 501 means the handler fell out of the composition
    // root — the exact gap `cron:list` and the cron-scripts suite also guard.
    expect(response.status).not.toBe(501);

    const runs = await jobRunsFor(correlationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job_name: jobName, trigger: 'cron', environment: 'local' });
    expect(runs[0]?.error_class).not.toBe('HandlerNotRegisteredError');
  });

  it('a malformed queue message is archived immediately rather than retried', async () => {
    await sql`select pgmq.send(${ALERT_REEVALUATION_QUEUE}, ${'{"garbage":true}'}::jsonb)`.execute(
      handle.db,
    );

    const summary = await runtime.consumer.drain();

    expect(summary).toMatchObject({ invalid: 1, deadLettered: 1 });
    expect(await queueLength()).toBe(0);
    const archived = await sql<{ count: number }>`
      select count(*)::int as count from pgmq.a_alert_reevaluation
    `.execute(handle.db);
    expect(archived.rows[0]?.count).toBe(1);
  });
});
