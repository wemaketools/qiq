/**
 * Drain-loop control flow over the in-memory transport (T-031, AC-064, V-081).
 *
 * The in-memory adapter is the approved UNIT seam: it exercises the branching in drain.ts
 * (dispatch, duplicate suppression, retry counting, dead-lettering, poison handling, time budget)
 * with a controllable clock, which real pgmq cannot give us without sleeping through visibility
 * timeouts. Everything asserted here about QUEUE SEMANTICS is asserted again against the real
 * extension in ../integration/pgmq-queue.test.ts — this file proves the loop, that file proves
 * the queue.
 */
import { describe, expect, it } from 'vitest';

import type { JobRunRepository, JobRunStartInput } from '../../jobs/job-run-repository.js';
import { createQueueConsumer, UnknownJobTypeError } from '../../jobs/queue/drain.js';
import { InMemoryQueueTransport } from '../../jobs/queue/in-memory-adapter.js';
import {
  jobMessageEnvelopeSchema,
  type JobCounts,
  type JobHandler,
  type JobMessageEnvelope,
} from '../../jobs/types.js';
import { createInMemoryJobTransactionRunner } from '../../jobs/unit-of-work.js';

interface RecordedRun {
  readonly id: number;
  readonly start: JobRunStartInput;
  status: 'running' | 'succeeded' | 'failed';
  counts?: JobCounts;
  error?: unknown;
}

class RecordingJobRunRepository implements JobRunRepository {
  readonly runs: RecordedRun[] = [];

  async start(input: JobRunStartInput): Promise<number> {
    const id = this.runs.length + 1;
    this.runs.push({ id, start: input, status: 'running' });
    return id;
  }

  async succeed(jobRunId: number, counts?: JobCounts): Promise<void> {
    const run = this.find(jobRunId);
    run.status = 'succeeded';
    if (counts !== undefined) run.counts = counts;
  }

  async fail(jobRunId: number, error: unknown, counts?: JobCounts): Promise<void> {
    const run = this.find(jobRunId);
    run.status = 'failed';
    run.error = error;
    if (counts !== undefined) run.counts = counts;
  }

  private find(jobRunId: number): RecordedRun {
    const run = this.runs.find((candidate) => candidate.id === jobRunId);
    if (run === undefined) throw new Error(`no recorded run ${jobRunId}`);
    return run;
  }
}

function envelope(overrides: Partial<JobMessageEnvelope> = {}): JobMessageEnvelope {
  return jobMessageEnvelopeSchema.parse({
    type: 'test.job',
    tenantId: 1,
    correlationId: 'corr-1',
    idempotencyKey: 'key-1',
    payload: { leadId: 7 },
    ...overrides,
  });
}

interface Harness {
  readonly transport: InMemoryQueueTransport;
  readonly jobRuns: RecordingJobRunRepository;
  readonly consumer: ReturnType<typeof createQueueConsumer>;
  readonly effects: string[];
  advance(ms: number): void;
}

function harness(options: { handler?: JobHandler; nowSteps?: readonly number[] } = {}): Harness {
  let clock = 1_000_000;
  const transport = new InMemoryQueueTransport({ now: () => clock });
  const jobRuns = new RecordingJobRunRepository();
  const effects: string[] = [];

  const handler: JobHandler = options.handler ?? {
    name: 'test.job',
    async handle(payload) {
      effects.push(JSON.stringify(payload));
      return { counts: { applied: 1 } };
    },
  };

  const consumer = createQueueConsumer({
    transport,
    handlers: new Map([[handler.name, handler]]),
    jobRuns,
    runInTransaction: createInMemoryJobTransactionRunner().run,
    now: () => clock,
  });

  return {
    transport,
    jobRuns,
    consumer,
    effects,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('in-memory queue transport contract', () => {
  it('delivers an enqueued message once and hides it for the visibility timeout', async () => {
    const transport = new InMemoryQueueTransport();
    await transport.enqueue(envelope());

    const first = await transport.read({ visibilityTimeoutSeconds: 60, quantity: 10 });
    const second = await transport.read({ visibilityTimeoutSeconds: 60, quantity: 10 });

    expect(first).toHaveLength(1);
    expect(first[0]?.readCount).toBe(1);
    expect(second).toHaveLength(0);
  });

  it('redelivers an unacked message after the visibility timeout with an incremented read count', async () => {
    let clock = 0;
    const transport = new InMemoryQueueTransport({ now: () => clock });
    await transport.enqueue(envelope());

    await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });
    clock += 31_000;
    const redelivered = await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });

    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.readCount).toBe(2);
  });

  it('ack removes the message permanently', async () => {
    let clock = 0;
    const transport = new InMemoryQueueTransport({ now: () => clock });
    const id = await transport.enqueue(envelope());
    await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });

    await transport.ack(id);
    clock += 60_000;

    expect(await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 })).toHaveLength(0);
    expect(transport.pending).toHaveLength(0);
  });

  it('dead-lettering moves the message to the archive and stops delivering it', async () => {
    let clock = 0;
    const transport = new InMemoryQueueTransport({ now: () => clock });
    const id = await transport.enqueue(envelope());
    await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });

    await transport.deadLetter(id);
    clock += 60_000;

    expect(await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 })).toHaveLength(0);
    expect(transport.archived.map((m) => m.id)).toEqual([id]);
    expect((await transport.metrics()).archivedCount).toBe(1);
  });

  it('rejects an envelope that does not satisfy the message schema', async () => {
    const transport = new InMemoryQueueTransport();
    await expect(
      transport.enqueue({
        type: '',
        tenantId: 1,
        correlationId: 'c',
        idempotencyKey: 'k',
        payload: {},
      }),
    ).rejects.toThrow();
  });
});

describe('drain loop', () => {
  it('runs the handler, acks the message and records a succeeded job_run', async () => {
    const h = harness();
    await h.transport.enqueue(envelope());

    const summary = await h.consumer.drain();

    expect(summary.read).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(h.effects).toEqual(['{"leadId":7}']);
    expect(h.transport.pending).toHaveLength(0);
    expect(h.jobRuns.runs).toHaveLength(1);
    expect(h.jobRuns.runs[0]?.status).toBe('succeeded');
    expect(h.jobRuns.runs[0]?.start).toMatchObject({
      jobName: 'test.job',
      trigger: 'queue',
      correlationId: 'corr-1',
      idempotencyKey: 'key-1',
      attempt: 1,
    });
    expect(h.jobRuns.runs[0]?.counts).toEqual({ applied: 1 });
  });

  it('applies the effect exactly once when the same idempotency key is delivered twice', async () => {
    const h = harness();
    await h.transport.enqueue(envelope({ idempotencyKey: 'dup-key' }));
    await h.transport.enqueue(envelope({ idempotencyKey: 'dup-key' }));

    const summary = await h.consumer.drain();

    expect(summary.read).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.duplicates).toBe(1);
    // The load-bearing assertion: two deliveries, ONE effect.
    expect(h.effects).toHaveLength(1);
    // Both messages are acked — a duplicate is finished work, not work to retry.
    expect(h.transport.pending).toHaveLength(0);
    expect(h.jobRuns.runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect(h.jobRuns.runs[1]?.counts).toMatchObject({ duplicate: 1 });
  });

  it('distinct idempotency keys are both applied (positive control against over-suppression)', async () => {
    const h = harness();
    await h.transport.enqueue(envelope({ idempotencyKey: 'key-a' }));
    await h.transport.enqueue(envelope({ idempotencyKey: 'key-b' }));

    const summary = await h.consumer.drain();

    expect(summary.succeeded).toBe(2);
    expect(summary.duplicates).toBe(0);
    expect(h.effects).toHaveLength(2);
  });

  it('leaves a failed message on the queue for retry and does not apply its effect', async () => {
    const effects: string[] = [];
    const h = harness({
      handler: {
        name: 'test.job',
        async handle() {
          effects.push('should not be visible');
          throw new Error('boom');
        },
      },
    });
    await h.transport.enqueue(envelope());

    const summary = await h.consumer.drain();

    expect(summary.failed).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(h.transport.pending).toHaveLength(1);
    expect(h.transport.archived).toHaveLength(0);
    expect(h.jobRuns.runs[0]?.status).toBe('failed');
    expect((h.jobRuns.runs[0]?.error as Error).message).toBe('boom');
  });

  it('releases the idempotency key when the handler fails so the retry really re-runs', async () => {
    let attempts = 0;
    const applied: number[] = [];
    const h = harness({
      handler: {
        name: 'test.job',
        async handle() {
          attempts += 1;
          if (attempts === 1) throw new Error('transient');
          applied.push(attempts);
          return {};
        },
      },
    });
    await h.transport.enqueue(envelope());

    await h.consumer.drain({ retryDelaySeconds: 1 });
    h.advance(2_000);
    await h.consumer.drain();

    // A key burned by the failed attempt would make the retry a silent no-op — the classic
    // "idempotency" bug that quietly drops work.
    expect(applied).toEqual([2]);
    expect(h.transport.pending).toHaveLength(0);
    expect(h.jobRuns.runs.map((r) => r.status)).toEqual(['failed', 'succeeded']);
  });

  it('dead-letters after max attempts and never delivers the message again', async () => {
    const h = harness({
      handler: {
        name: 'test.job',
        async handle() {
          throw new Error('always fails');
        },
      },
    });
    await h.transport.enqueue(envelope());

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await h.consumer.drain({ maxAttempts: 5, retryDelaySeconds: 1 });
      h.advance(2_000);
    }

    expect(h.jobRuns.runs).toHaveLength(5);
    expect(h.jobRuns.runs.map((r) => r.start.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(h.jobRuns.runs.every((r) => r.status === 'failed')).toBe(true);
    expect(h.jobRuns.runs[4]?.counts).toMatchObject({ deadLettered: true });
    expect(h.transport.archived).toHaveLength(1);
    expect(h.transport.pending).toHaveLength(0);

    // Sixth pass: nothing left to deliver.
    const after = await h.consumer.drain({ maxAttempts: 5 });
    expect(after.read).toBe(0);
    expect(h.jobRuns.runs).toHaveLength(5);
  });

  it('retries an unknown job type rather than treating it as poison', async () => {
    const h = harness();
    await h.transport.enqueue(envelope({ type: 'not.registered' }));

    const summary = await h.consumer.drain({ maxAttempts: 5 });

    expect(summary.failed).toBe(1);
    expect(summary.invalid).toBe(0);
    expect(h.transport.pending).toHaveLength(1);
    expect(h.jobRuns.runs[0]?.error).toBeInstanceOf(UnknownJobTypeError);
  });

  it('archives a malformed message immediately instead of retrying it five times', async () => {
    const h = harness();
    h.transport.enqueueRaw({ nonsense: true });

    const summary = await h.consumer.drain();

    expect(summary.invalid).toBe(1);
    expect(summary.deadLettered).toBe(1);
    expect(h.transport.pending).toHaveLength(0);
    expect(h.transport.archived).toHaveLength(1);
    expect(h.jobRuns.runs[0]?.start.jobName).toBe('queue.invalid-message');
    expect(h.jobRuns.runs[0]?.status).toBe('failed');
  });

  it('stops starting new work once the time budget is spent and leaves the rest queued', async () => {
    let clock = 0;
    const transport = new InMemoryQueueTransport({ now: () => clock });
    const jobRuns = new RecordingJobRunRepository();
    const handled: string[] = [];

    const consumer = createQueueConsumer({
      transport,
      handlers: new Map<string, JobHandler>([
        [
          'test.job',
          {
            name: 'test.job',
            async handle(payload) {
              handled.push(String((payload as { n?: number }).n));
              // Each message costs 400ms of the budget.
              clock += 400;
              return {};
            },
          },
        ],
      ]),
      jobRuns,
      runInTransaction: createInMemoryJobTransactionRunner().run,
      now: () => clock,
    });

    for (let n = 0; n < 10; n += 1) {
      await transport.enqueue(envelope({ idempotencyKey: `key-${n}`, payload: { n } }));
    }

    const summary = await consumer.drain({ timeBudgetMs: 1_000, retryDelaySeconds: 0 });

    expect(summary.budgetExhausted).toBe(true);
    expect(summary.read).toBe(3);
    expect(handled).toEqual(['0', '1', '2']);
    // The remaining seven are still on the queue: read-but-unprocessed messages are never acked.
    expect(transport.pending).toHaveLength(7);

    // The next invocation picks them up once their visibility timeout expires.
    clock += 61_000;
    const second = await consumer.drain({ timeBudgetMs: 10_000 });
    expect(second.read).toBe(7);
    expect(handled).toHaveLength(10);
  });

  it('an ample budget processes everything (positive control against a stuck loop)', async () => {
    const h = harness();
    for (let n = 0; n < 6; n += 1) {
      await h.transport.enqueue(envelope({ idempotencyKey: `key-${n}`, payload: { n } }));
    }

    const summary = await h.consumer.drain({ timeBudgetMs: 60_000, batchSize: 2 });

    expect(summary.budgetExhausted).toBe(false);
    expect(summary.read).toBe(6);
    expect(summary.succeeded).toBe(6);
  });

  it('honours maxMessages within one invocation', async () => {
    const h = harness();
    for (let n = 0; n < 5; n += 1) {
      await h.transport.enqueue(envelope({ idempotencyKey: `key-${n}`, payload: { n } }));
    }

    const summary = await h.consumer.drain({ maxMessages: 2 });

    expect(summary.read).toBe(2);
    expect(h.transport.pending).toHaveLength(3);
  });

  it('returns an empty summary when the queue is empty', async () => {
    const h = harness();
    const summary = await h.consumer.drain();
    expect(summary).toMatchObject({ read: 0, succeeded: 0, failed: 0, budgetExhausted: false });
    expect(h.jobRuns.runs).toHaveLength(0);
  });
});
