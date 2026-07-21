/**
 * Local job scripts (T-031, AC-065, V-082).
 *
 * Spec §9.5 makes the local scripts the documented deterministic path for running jobs without
 * Vercel and pg_net, and requires them to run the SAME handler code as the deployed endpoints.
 * These tests invoke the real npm scripts as a developer would — child processes, real
 * `.env.local`, real pgmq — and then assert the durable evidence in the database, not the console
 * text. A script that printed a convincing summary while writing nothing would fail here.
 *
 * DESTRUCTIVE TO LOCAL QUEUE STATE: these tests purge the shared `alert_reevaluation` queue and its
 * archive between cases. Anything else using that queue on the same local stack — a developer's
 * `queue:worker`, a hand-enqueued message — will be swept away while this suite runs. That is the
 * price of testing the REAL migrated queue rather than a private one, and it is safe because the
 * local database is disposable; do not run this suite against a database you care about.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import { createDb, type DbHandle } from '../../lib/db/index.js';
import { ALERT_REEVALUATION_QUEUE } from '../../jobs/queue/pgmq-adapter.js';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';
import { runNpmScript } from './helpers/repo.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('local job scripts', probe);

const CORRELATION_PREFIX = 'jobs-script';

describeStack(title, () => {
  let handle: DbHandle;
  const correlationId = `${CORRELATION_PREFIX}-${randomUUID()}`;
  const idempotencyKey = `${CORRELATION_PREFIX}:${randomUUID()}`;

  beforeAll(async () => {
    if (!probe.available) return;
    handle = createDb({ connectionString: probe.stack.dbUrl });
    await sql`select pgmq.purge_queue(${ALERT_REEVALUATION_QUEUE})`.execute(handle.db);
  });

  afterAll(async () => {
    if (!probe.available) return;
    await sql`select pgmq.purge_queue(${ALERT_REEVALUATION_QUEUE})`.execute(handle.db);
    await sql`delete from job_idempotency_key where key like ${`${CORRELATION_PREFIX}:%`}`.execute(
      handle.db,
    );
    await sql`delete from job_run where correlation_id like ${`${CORRELATION_PREFIX}-%`}`.execute(
      handle.db,
    );
    await handle.close();
  });

  it(
    'queue:enqueue:test injects a message that queue:worker drains through the real handler',
    async () => {
      const enqueue = runNpmScript(
        `queue:enqueue:test -- --key ${idempotencyKey} --correlation ${correlationId}`,
        180_000,
      );
      expect(enqueue.status, enqueue.output).toBe(0);
      expect(enqueue.stdout).toContain('"queue": "alert_reevaluation"');
      expect(enqueue.stdout).toContain(idempotencyKey);

      // The message really is on the queue before the worker runs (not just claimed to be).
      const queued = await sql<{ count: number }>`
        select count(*)::int as count from pgmq.q_alert_reevaluation
      `.execute(handle.db);
      expect(queued.rows[0]?.count).toBe(1);

      const worker = runNpmScript('queue:worker -- --idle-exit', 180_000);
      expect(worker.status, worker.output).toBe(0);
      expect(worker.stdout).toContain('drained 1 message(s)');
      expect(worker.stdout).toContain('1 succeeded');

      const drained = await sql<{ count: number }>`
        select count(*)::int as count from pgmq.q_alert_reevaluation
      `.execute(handle.db);
      expect(drained.rows[0]?.count).toBe(0);

      // The durable evidence: the same job_run shape an endpoint-triggered run produces.
      const runs = await sql<{
        job_name: string;
        trigger: string;
        environment: string;
        status: string;
        duration_ms: number | null;
        counts: Record<string, unknown> | null;
      }>`
        select job_name, trigger, environment, status, duration_ms, counts
          from job_run where correlation_id = ${correlationId}
      `.execute(handle.db);

      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({
        job_name: 'job.echo',
        trigger: 'queue',
        status: 'succeeded',
      });
      expect(runs.rows[0]?.duration_ms).toBeGreaterThanOrEqual(0);
      expect(runs.rows[0]?.counts).toMatchObject({ echoed: 1 });

      const claims = await sql<{ count: number }>`
        select count(*)::int as count from job_idempotency_key where key = ${idempotencyKey}
      `.execute(handle.db);
      expect(claims.rows[0]?.count).toBe(1);
    },
    600_000,
  );

  it(
    'jobs:status reports the job_run history and the pgmq backlog/archive counts',
    async () => {
      const status = runNpmScript('jobs:status -- --limit 50', 180_000);

      expect(status.status, status.output).toBe(0);
      expect(status.stdout).toContain('QUEUE alert_reevaluation');
      expect(status.stdout).toContain('backlog:');
      expect(status.stdout).toContain('dead-letter total:');
      // Not merely non-empty: the run the previous test produced must be visible.
      expect(status.stdout).toContain('job.echo');
      expect(status.stdout).toContain(correlationId);
    },
    600_000,
  );

  it(
    'jobs:status --json emits machine-readable output',
    async () => {
      const status = runNpmScript('jobs:status -- --json --limit 5', 180_000);
      expect(status.status, status.output).toBe(0);

      const start = status.stdout.indexOf('{');
      const parsed = JSON.parse(status.stdout.slice(start)) as {
        runs: unknown[];
        queue: { queueName: string; queueLength: number; archivedCount: number };
      };
      expect(Array.isArray(parsed.runs)).toBe(true);
      expect(parsed.queue.queueName).toBe(ALERT_REEVALUATION_QUEUE);
      expect(typeof parsed.queue.queueLength).toBe('number');
      expect(typeof parsed.queue.archivedCount).toBe('number');
    },
    600_000,
  );

  it(
    'queue:worker exits cleanly when there is nothing to drain',
    async () => {
      const worker = runNpmScript('queue:worker -- --idle-exit', 180_000);
      expect(worker.status, worker.output).toBe(0);
      expect(worker.stdout).toContain('queue is empty; exiting');
      // Positive control for the previous assertion: no work was invented out of an empty queue.
      expect(worker.stdout).not.toContain('drained');
    },
    600_000,
  );
});
