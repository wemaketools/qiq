/**
 * pgmq-backed queue transport (T-031, M-16, Q-7, AC-064).
 *
 * Supabase Queues == pgmq. Its four primitives map exactly onto what Hangfire used to do for us:
 *
 *   pgmq.send      enqueue
 *   pgmq.read      deliver with a VISIBILITY TIMEOUT and increment `read_ct`
 *   pgmq.delete    ack (permanent removal)
 *   pgmq.set_vt    "not now" — put the message back for a later attempt
 *   pgmq.archive   dead-letter into pgmq.a_<queue>
 *
 * `read_ct` is the attempt counter and it is maintained by pgmq itself, not by us. That matters:
 * an app-maintained counter would be lost by exactly the crash it is supposed to survive.
 *
 * Every mutating method accepts an optional `executor` so the drain loop can ack INSIDE the
 * handler's transaction (see ../unit-of-work.ts). The queue lives in the same database as the
 * business data, which is what makes that possible at all — and is a large part of why Q-7 chose
 * pgmq over an external broker.
 */
import { sql } from 'kysely';

import type { DbClient, DbExecutor } from '../../lib/db/index.js';
import {
  jobMessageEnvelopeSchema,
  type EnqueueOptions,
  type JobMessageEnvelope,
  type QueueMessage,
  type QueueMetrics,
  type QueuePublisher,
  type QueueTransport,
  type ReadOptions,
} from '../types.js';

/** pgmq derives table names (`q_<name>`, `a_<name>`) from this, so it is not free-form text. */
const SAFE_QUEUE_NAME = /^[a-z_][a-z0-9_]{0,46}$/u;

export const ALERT_REEVALUATION_QUEUE = 'alert_reevaluation';

interface SendRow {
  readonly msg_id: number;
}

interface ReadRow {
  readonly msg_id: number;
  readonly read_ct: number;
  readonly enqueued_at: Date;
  readonly message: unknown;
}

interface MetricsRow {
  readonly queue_length: number;
  readonly oldest_msg_age_sec: number | null;
}

interface CountRow {
  readonly count: number;
}

export class PgmqTransport implements QueueTransport, QueuePublisher {
  readonly queueName: string;

  constructor(
    private readonly db: DbClient,
    queueName: string = ALERT_REEVALUATION_QUEUE,
  ) {
    if (!SAFE_QUEUE_NAME.test(queueName)) {
      throw new Error(
        `Invalid pgmq queue name "${queueName}": expected lowercase letters, digits and underscores.`,
      );
    }
    this.queueName = queueName;
  }

  private executor(executor?: DbExecutor): DbExecutor {
    return executor ?? this.db;
  }

  async enqueue(message: JobMessageEnvelope, options: EnqueueOptions = {}): Promise<number> {
    // Validated on the way out as well as on the way in: a message that cannot be parsed by the
    // consumer is undeliverable work that would sit in the queue until it dead-lettered.
    const envelope = jobMessageEnvelopeSchema.parse(message);
    const delay = Math.max(0, Math.trunc(options.delaySeconds ?? 0));

    const result = await sql<SendRow>`
      select pgmq.send(${this.queueName}, ${JSON.stringify(envelope)}::jsonb, ${delay}::integer) as msg_id
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error(`pgmq.send returned no message id for ${this.queueName}`);
    return Number(row.msg_id);
  }

  async read(options: ReadOptions): Promise<readonly QueueMessage[]> {
    const result = await sql<ReadRow>`
      select msg_id, read_ct, enqueued_at, message
        from pgmq.read(
          ${this.queueName},
          ${Math.max(1, Math.trunc(options.visibilityTimeoutSeconds))}::integer,
          ${Math.max(1, Math.trunc(options.quantity))}::integer
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: Number(row.msg_id),
      readCount: Number(row.read_ct),
      enqueuedAt: new Date(row.enqueued_at),
      body: row.message,
    }));
  }

  async ack(messageId: number, executor?: DbExecutor): Promise<void> {
    await sql`select pgmq.delete(${this.queueName}, ${messageId}::bigint)`.execute(
      this.executor(executor),
    );
  }

  async retry(messageId: number, delaySeconds: number, executor?: DbExecutor): Promise<void> {
    await sql`
      select pgmq.set_vt(${this.queueName}, ${messageId}::bigint, ${Math.max(0, Math.trunc(delaySeconds))}::integer)
    `.execute(this.executor(executor));
  }

  async deadLetter(messageId: number, executor?: DbExecutor): Promise<void> {
    await sql`select pgmq.archive(${this.queueName}, ${messageId}::bigint)`.execute(
      this.executor(executor),
    );
  }

  async metrics(): Promise<QueueMetrics> {
    const metrics = await sql<MetricsRow>`
      select queue_length, oldest_msg_age_sec from pgmq.metrics(${this.queueName})
    `.execute(this.db);

    // The archive table name cannot be parameterized; the constructor's whitelist is what makes
    // this identifier safe to interpolate.
    const archived = await sql<CountRow>`
      select count(*)::int as count from ${sql.table(`pgmq.a_${this.queueName}`)}
    `.execute(this.db);

    const row = metrics.rows[0];
    return {
      queueName: this.queueName,
      queueLength: Number(row?.queue_length ?? 0),
      archivedCount: Number(archived.rows[0]?.count ?? 0),
      oldestMessageAgeSeconds:
        row?.oldest_msg_age_sec === null || row?.oldest_msg_age_sec === undefined
          ? null
          : Number(row.oldest_msg_age_sec),
    };
  }
}
