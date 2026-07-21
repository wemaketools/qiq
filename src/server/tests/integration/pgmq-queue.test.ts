/**
 * pgmq queue semantics against the REAL extension (T-031, AC-064, V-081).
 *
 * Visibility timeouts, ack durability, attempt counting and dead-lettering are properties of pgmq,
 * not of our adapter, so they are proven here against the local Supabase stack. The in-memory
 * adapter's unit tests describe the drain loop's behaviour; they are not evidence about the queue.
 *
 * These tests use the REAL `alert_reevaluation` queue created by
 * supabase/migrations/20260719000100_pgmq_queues.sql — if that migration did not run, this suite
 * cannot pass. Each test purges the queue and its archive first, so the suite is re-runnable and
 * order-independent.
 *
 * DESTRUCTIVE TO LOCAL QUEUE STATE: these tests purge the shared `alert_reevaluation` queue and its
 * archive between cases. Anything else using that queue on the same local stack — a developer's
 * `queue:worker`, a hand-enqueued message — will be swept away while this suite runs. That is the
 * price of testing the REAL migrated queue rather than a private one, and it is safe because the
 * local database is disposable; do not run this suite against a database you care about.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import { createDb, type DbHandle } from '../../lib/db/index.js';
import { ALERT_REEVALUATION_QUEUE, PgmqTransport } from '../../jobs/queue/pgmq-adapter.js';
import { jobMessageEnvelopeSchema, type JobMessageEnvelope } from '../../jobs/types.js';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('pgmq queue semantics', probe);

/** Short enough to wait out in a test, long enough that a handler could plausibly run. */
const VT_SECONDS = 1;

function envelope(overrides: Partial<JobMessageEnvelope> = {}): JobMessageEnvelope {
  return jobMessageEnvelopeSchema.parse({
    type: 'alert.reevaluate-lead',
    tenantId: 1,
    correlationId: 'pgmq-test-correlation',
    idempotencyKey: `pgmq-test:${Math.random().toString(36).slice(2)}`,
    payload: { leadId: 42 },
    ...overrides,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describeStack(title, () => {
  let handle: DbHandle;
  let transport: PgmqTransport;

  beforeAll(() => {
    if (!probe.available) return;
    handle = createDb({ connectionString: probe.stack.dbUrl });
    transport = new PgmqTransport(handle.db, ALERT_REEVALUATION_QUEUE);
  });

  afterEach(async () => {
    await sql`select pgmq.purge_queue(${ALERT_REEVALUATION_QUEUE})`.execute(handle.db);
    await sql`delete from pgmq.a_alert_reevaluation`.execute(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('the migration created the alert_reevaluation queue and its dead-letter archive', async () => {
    const queues = await sql<{ queue_name: string }>`
      select queue_name from pgmq.list_queues()
    `.execute(handle.db);
    expect(queues.rows.map((row) => row.queue_name)).toContain(ALERT_REEVALUATION_QUEUE);

    const tables = await sql<{ tablename: string }>`
      select tablename from pg_tables
       where schemaname = 'pgmq' and tablename in ('q_alert_reevaluation', 'a_alert_reevaluation')
       order by tablename
    `.execute(handle.db);
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'a_alert_reevaluation',
      'q_alert_reevaluation',
    ]);
  });

  it('stores the full message envelope and returns it intact on read', async () => {
    const message = envelope({ idempotencyKey: 'lead-42:hist-7' });
    await transport.enqueue(message);

    const [delivered] = await transport.read({
      visibilityTimeoutSeconds: VT_SECONDS,
      quantity: 10,
    });

    expect(delivered).toBeDefined();
    // Schema assertion on what actually crossed the database boundary (V-081).
    expect(jobMessageEnvelopeSchema.parse(delivered?.body)).toEqual({
      type: 'alert.reevaluate-lead',
      tenantId: 1,
      correlationId: 'pgmq-test-correlation',
      idempotencyKey: 'lead-42:hist-7',
      payload: { leadId: 42 },
    });
    expect(delivered?.readCount).toBe(1);
    expect(delivered?.enqueuedAt).toBeInstanceOf(Date);
  });

  it('hides a read message from a second reader for the duration of the visibility timeout', async () => {
    await transport.enqueue(envelope());

    const first = await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });
    const second = await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });

    expect(first).toHaveLength(1);
    // Two concurrent drains (a pg_cron invocation overlapping a manual one) must not both run it.
    expect(second).toHaveLength(0);
  });

  it('redelivers an unacked message once the visibility timeout expires, with read_ct incremented', async () => {
    await transport.enqueue(envelope());

    const first = await transport.read({ visibilityTimeoutSeconds: VT_SECONDS, quantity: 10 });
    expect(first[0]?.readCount).toBe(1);

    await sleep(VT_SECONDS * 1000 + 400);

    const second = await transport.read({ visibilityTimeoutSeconds: VT_SECONDS, quantity: 10 });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    // pgmq owns the attempt counter; it survives the crash that would lose an app-side counter.
    expect(second[0]?.readCount).toBe(2);
  });

  it('ack deletes the message permanently', async () => {
    const messageId = await transport.enqueue(envelope());
    await transport.read({ visibilityTimeoutSeconds: VT_SECONDS, quantity: 10 });

    await transport.ack(messageId);
    await sleep(VT_SECONDS * 1000 + 400);

    expect(await transport.read({ visibilityTimeoutSeconds: VT_SECONDS, quantity: 10 })).toHaveLength(0);
    const remaining = await sql<{ count: number }>`
      select count(*)::int as count from pgmq.q_alert_reevaluation where msg_id = ${messageId}
    `.execute(handle.db);
    expect(remaining.rows[0]?.count).toBe(0);
  });

  it('retry makes the message visible again after the requested delay', async () => {
    const messageId = await transport.enqueue(envelope());
    await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });

    // Without set_vt the message would stay hidden for the full 30s visibility timeout.
    await transport.retry(messageId, 1);
    await sleep(1_400);

    const redelivered = await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });
    expect(redelivered.map((m) => m.id)).toEqual([messageId]);
  });

  it('dead-letter archives the message and it is never delivered again', async () => {
    const messageId = await transport.enqueue(envelope());
    await transport.read({ visibilityTimeoutSeconds: VT_SECONDS, quantity: 10 });

    await transport.deadLetter(messageId);
    await sleep(VT_SECONDS * 1000 + 400);

    expect(await transport.read({ visibilityTimeoutSeconds: VT_SECONDS, quantity: 10 })).toHaveLength(0);

    const archived = await sql<{ msg_id: number }>`
      select msg_id from pgmq.a_alert_reevaluation where msg_id = ${messageId}
    `.execute(handle.db);
    expect(archived.rows).toHaveLength(1);
  });

  it('reports backlog, oldest-message age and archive count', async () => {
    const empty = await transport.metrics();
    expect(empty.queueLength).toBe(0);
    expect(empty.archivedCount).toBe(0);
    expect(empty.oldestMessageAgeSeconds).toBeNull();

    await transport.enqueue(envelope());
    const toArchive = await transport.enqueue(envelope());
    await transport.deadLetter(toArchive);

    const metrics = await transport.metrics();
    expect(metrics.queueName).toBe(ALERT_REEVALUATION_QUEUE);
    expect(metrics.queueLength).toBe(1);
    expect(metrics.archivedCount).toBe(1);
    expect(metrics.oldestMessageAgeSeconds).not.toBeNull();
  });

  it('refuses a queue name that could not be a safe pgmq identifier', () => {
    expect(() => new PgmqTransport(handle.db, 'drop; table--')).toThrow(/Invalid pgmq queue name/u);
  });
});
