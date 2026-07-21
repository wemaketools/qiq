/**
 * Background-job contracts (T-031, spec §9.5, M-14..M-17, Q-7).
 *
 * These are the seams the Hangfire replacement is built on. Four of them, deliberately small:
 *
 *   JobHandler       the unit of work. Knows nothing about pgmq, HTTP, secrets or retries.
 *   QueuePublisher   "put this message somewhere durable".
 *   QueueTransport   the queue's mechanics: read-with-visibility / ack / retry / dead-letter.
 *   QueueConsumer    `drain(options)` — the loop that ties the three together (queue/drain.ts).
 *
 * The split between QueueTransport and QueueConsumer is what makes the drain loop testable without
 * a database: the loop is written once and runs over either the pgmq adapter (production, and every
 * integration test) or the in-memory adapter (unit tests only). Two real implementations, so the
 * abstraction earns its place under CLAUDE.md's "no abstraction without two implementations" rule.
 */
import { z } from 'zod';

import type { DbExecutor } from '../lib/db/index.js';
import type { Logger } from '../lib/logging/index.js';

export const jobTriggers = ['cron', 'queue', 'manual'] as const;
export type JobTrigger = (typeof jobTriggers)[number];

export const jobRunStatuses = ['running', 'succeeded', 'failed'] as const;
export type JobRunStatus = (typeof jobRunStatuses)[number];

/** Default max delivery attempts before a message is dead-lettered (spec §9.5). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Default pgmq visibility timeout: long enough to cover a handler, short enough to retry soon. */
export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 60;

/** Correlation ids are echoed into logs and SQL, so they are bounded and character-restricted. */
const correlationId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u, 'must be printable, non-whitespace ASCII');

/**
 * The wire format of every queued message (spec §9.5 "payload shape").
 *
 * Validated on the way OUT (a malformed message must never reach the queue) and again on the way
 * IN, because what comes back is untrusted input: pgmq stores jsonb, and anything with database
 * access can write to the queue table. A message that fails this schema can never become valid, so
 * the drain loop treats it as poison and archives it immediately rather than retrying it five
 * times (see queue/drain.ts).
 */
export const jobMessageEnvelopeSchema = z.object({
  /** Handler selector, e.g. 'alert.reevaluate-lead'. */
  type: z.string().min(1).max(100),
  /** Owning tenant, or null for a cross-tenant/global unit of work. */
  tenantId: z.number().int().positive().nullable(),
  /** §15: propagated from the enqueuing request into the resulting job_run row. */
  correlationId,
  /** Dedupe key claimed transactionally with the handler effect (see job_idempotency_key). */
  idempotencyKey: z.string().min(1).max(200),
  /** Minimal payload — ids, not entity snapshots. The handler re-reads current state. */
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type JobMessageEnvelope = z.infer<typeof jobMessageEnvelopeSchema>;

/** Outcome counters recorded on the job_run row. */
export type JobCounts = Readonly<Record<string, number | string | boolean | null>>;

export interface JobResult {
  readonly counts?: JobCounts;
}

/**
 * What a handler is given. `db` is ALWAYS the open transaction that also carries the idempotency
 * claim and the ack — a handler that writes through any other connection breaks the exactly-once
 * property, because its effect would survive a rollback that released the key.
 */
export interface JobContext {
  readonly db: DbExecutor;
  readonly jobName: string;
  readonly trigger: JobTrigger;
  readonly correlationId: string;
  readonly tenantId: number | null;
  readonly attempt: number;
  readonly jobRunId: number;
  readonly logger: Logger;
}

export interface JobHandler<TPayload = Readonly<Record<string, unknown>>> {
  readonly name: string;
  handle(payload: TPayload, context: JobContext): Promise<JobResult | void>;
}

/** A registry keyed by message `type` (queue) or job name (cron). */
export type JobHandlerRegistry = ReadonlyMap<string, JobHandler>;

/** A message as delivered by the transport. */
export interface QueueMessage {
  readonly id: number;
  /** pgmq `read_ct`: 1 on first delivery. This IS the attempt number. */
  readonly readCount: number;
  readonly enqueuedAt: Date;
  /** Raw jsonb body, still untrusted — parse with `jobMessageEnvelopeSchema`. */
  readonly body: unknown;
}

export interface EnqueueOptions {
  /** Seconds to hold the message invisible after enqueue. */
  readonly delaySeconds?: number;
}

export interface QueuePublisher {
  /** Returns the queue message id. */
  enqueue(message: JobMessageEnvelope, options?: EnqueueOptions): Promise<number>;
}

export interface ReadOptions {
  readonly visibilityTimeoutSeconds: number;
  readonly quantity: number;
}

/**
 * Queue mechanics. Every mutating method takes an optional executor so the drain loop can perform
 * the ack INSIDE the handler's transaction; see queue/drain.ts for why that matters.
 */
export interface QueueTransport {
  readonly queueName: string;
  enqueue(message: JobMessageEnvelope, options?: EnqueueOptions): Promise<number>;
  read(options: ReadOptions): Promise<readonly QueueMessage[]>;
  /** Acknowledge: delete the message permanently. */
  ack(messageId: number, executor?: DbExecutor): Promise<void>;
  /** Make the message visible again after `delaySeconds` for another attempt. */
  retry(messageId: number, delaySeconds: number, executor?: DbExecutor): Promise<void>;
  /** Dead-letter: move the message to the archive; it is never delivered again. */
  deadLetter(messageId: number, executor?: DbExecutor): Promise<void>;
  metrics(): Promise<QueueMetrics>;
}

export interface QueueMetrics {
  readonly queueName: string;
  readonly queueLength: number;
  readonly archivedCount: number;
  /** Age in seconds of the oldest unconsumed message, or null when the queue is empty. */
  readonly oldestMessageAgeSeconds: number | null;
}

export interface DrainOptions {
  /** Messages requested per pgmq read. */
  readonly batchSize?: number;
  /** Hard ceiling on messages processed in one invocation. */
  readonly maxMessages?: number;
  /** Wall-clock budget; the loop stops starting new work once it is spent (Vercel maxDuration). */
  readonly timeBudgetMs?: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly maxAttempts?: number;
  /** Delay applied to a failed message before it becomes visible again. */
  readonly retryDelaySeconds?: number;
}

export interface DrainSummary {
  readonly queueName: string;
  readonly read: number;
  readonly succeeded: number;
  /** Messages skipped because their idempotency key was already claimed. */
  readonly duplicates: number;
  readonly failed: number;
  readonly deadLettered: number;
  /** Unparseable messages archived as poison. */
  readonly invalid: number;
  readonly elapsedMs: number;
  /** True when the loop stopped because the time budget ran out, not because the queue was empty. */
  readonly budgetExhausted: boolean;
}

export interface QueueConsumer {
  drain(options?: DrainOptions): Promise<DrainSummary>;
}
