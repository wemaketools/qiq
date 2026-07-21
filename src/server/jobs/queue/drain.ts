/**
 * The queue drain loop (T-031, M-16/M-17, Q-7, AC-063/AC-064, spec §9.5).
 *
 * ONE implementation, TWO entrypoints: `/api/queue/drain` (invoked by pg_cron via pg_net when
 * deployed) and `npm run queue:worker` (the documented local path, which avoids container->host
 * networking). Spec §9.5 requires both paths to run the same handler code; they both run THIS
 * function, so "the same" is a fact about the import graph rather than a promise.
 *
 * Per message:
 *
 *   parse envelope ─ invalid ─────────────> archive immediately (poison; see below)
 *          │
 *          ├─ job_run row (status=running, attempt = pgmq read_ct)   [own connection]
 *          │
 *          └─ TRANSACTION: claim idempotency key ─ already claimed ─> skip handler, ack, duplicate
 *                          │
 *                          ├─ handler(payload, ctx)
 *                          └─ ack (pgmq.delete)
 *                 commit ─> job_run succeeded
 *                 throw  ─> everything above rolled back; then, OUTSIDE the transaction:
 *                             read_ct >= maxAttempts ? archive (dead-letter) : set_vt (retry)
 *                           job_run failed, with error class/message
 *
 * Three decisions worth defending:
 *
 * 1. A MALFORMED MESSAGE IS ARCHIVED ON SIGHT, not retried. Its body cannot become parseable, so
 *    five deliveries would only be five identical failures on a schedule. An UNKNOWN TYPE is the
 *    opposite case and IS retried: during a rolling deploy a producer can legitimately be ahead of
 *    the consumer, and the type becomes known within minutes. Conflating the two either loses
 *    valid work or spins on garbage.
 *
 * 2. THE TIME BUDGET IS CHECKED BEFORE STARTING WORK, NEVER DURING IT. Vercel functions are
 *    time-bounded (maxDuration 60 for this route), so the loop stops accepting new messages once
 *    the budget is spent and returns; whatever was read but not processed simply stays invisible
 *    until its visibility timeout expires and the next invocation picks it up. Aborting a handler
 *    mid-flight to hit a deadline would be the one way to actually lose work here.
 *
 * 3. job_run IS WRITTEN OUTSIDE THE TRANSACTION. See ../job-run-repository.ts: a failure row
 *    written inside the rolled-back transaction would vanish with the failure it records.
 */
import { jobLogger, newCorrelationId, type Logger } from '../../lib/logging/index.js';
import type { JobRunRepository } from '../job-run-repository.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
  jobMessageEnvelopeSchema,
  type DrainOptions,
  type DrainSummary,
  type JobHandlerRegistry,
  type JobMessageEnvelope,
  type QueueConsumer,
  type QueueMessage,
  type QueueTransport,
} from '../types.js';
import type { RunInJobTransaction } from '../unit-of-work.js';

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_MAX_MESSAGES = 100;
/** Well inside the route's 60s maxDuration, leaving room for the in-flight handler to finish. */
export const DEFAULT_TIME_BUDGET_MS = 25_000;
export const DEFAULT_RETRY_DELAY_SECONDS = 30;

export interface DrainDeps {
  readonly transport: QueueTransport;
  readonly handlers: JobHandlerRegistry;
  readonly jobRuns: JobRunRepository;
  readonly runInTransaction: RunInJobTransaction;
  readonly logger?: Logger;
  /** Injectable monotonic-ish clock so the time-budget behaviour is testable without sleeping. */
  readonly now?: () => number;
}

/** Thrown when a message names a handler this deployment does not have. Retryable on purpose. */
export class UnknownJobTypeError extends Error {
  constructor(readonly type: string) {
    super(`No handler is registered for job type "${type}"`);
    this.name = 'UnknownJobTypeError';
  }
}

interface ResolvedOptions {
  readonly batchSize: number;
  readonly maxMessages: number;
  readonly timeBudgetMs: number;
  readonly visibilityTimeoutSeconds: number;
  readonly maxAttempts: number;
  readonly retryDelaySeconds: number;
}

function resolveOptions(options: DrainOptions): ResolvedOptions {
  return {
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    maxMessages: options.maxMessages ?? DEFAULT_MAX_MESSAGES,
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    visibilityTimeoutSeconds:
      options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    // Floored at one second. A zero-delay retry makes a failing message immediately visible to the
    // very loop that just failed it, which turns one poisoned message into a spin that burns every
    // attempt (and the whole invocation's budget) in milliseconds. Backoff has to be real.
    retryDelaySeconds: Math.max(1, options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS),
  };
}

interface MutableSummary {
  succeeded: number;
  duplicates: number;
  failed: number;
  deadLettered: number;
  invalid: number;
  read: number;
}

export function createQueueConsumer(deps: DrainDeps): QueueConsumer {
  const now = deps.now ?? (() => Date.now());
  const baseLogger = deps.logger;

  async function processMessage(
    message: QueueMessage,
    options: ResolvedOptions,
    summary: MutableSummary,
  ): Promise<void> {
    const parsed = jobMessageEnvelopeSchema.safeParse(message.body);

    if (!parsed.success) {
      // Poison: unparseable now and forever. Record it, then get it off the queue.
      summary.invalid += 1;
      summary.deadLettered += 1;
      const correlationId = newCorrelationId();
      const jobRunId = await deps.jobRuns.start({
        jobName: 'queue.invalid-message',
        trigger: 'queue',
        correlationId,
        attempt: message.readCount,
        messageId: message.id,
      });
      await deps.transport.deadLetter(message.id);
      await deps.jobRuns.fail(
        jobRunId,
        new Error(`Malformed queue message: ${parsed.error.issues[0]?.message ?? 'invalid'}`),
        { deadLettered: true },
      );
      return;
    }

    const envelope: JobMessageEnvelope = parsed.data;
    const logContext = {
      jobName: envelope.type,
      correlationId: envelope.correlationId,
      trigger: 'queue' as const,
    };
    const log = baseLogger === undefined ? jobLogger(logContext) : baseLogger.child(logContext);

    const jobRunId = await deps.jobRuns.start({
      jobName: envelope.type,
      trigger: 'queue',
      correlationId: envelope.correlationId,
      attempt: message.readCount,
      idempotencyKey: envelope.idempotencyKey,
      messageId: message.id,
    });

    try {
      const outcome = await deps.runInTransaction(async (trx) => {
        const claimed = await trx.claimIdempotencyKey({
          key: envelope.idempotencyKey,
          jobName: envelope.type,
          tenantId: envelope.tenantId,
          jobRunId,
        });

        if (!claimed) {
          // Someone already did this exact work. Drop the duplicate and move on — this is the
          // whole point of at-least-once delivery being survivable.
          await deps.transport.ack(message.id, trx.db);
          return { duplicate: true as const };
        }

        const handler = deps.handlers.get(envelope.type);
        if (handler === undefined) throw new UnknownJobTypeError(envelope.type);

        const result = await handler.handle(envelope.payload, {
          db: trx.db,
          jobName: envelope.type,
          trigger: 'queue',
          correlationId: envelope.correlationId,
          tenantId: envelope.tenantId,
          attempt: message.readCount,
          jobRunId,
          logger: log,
        });

        await deps.transport.ack(message.id, trx.db);
        return { duplicate: false as const, counts: result?.counts };
      });

      if (outcome.duplicate) {
        summary.duplicates += 1;
        await deps.jobRuns.succeed(jobRunId, { duplicate: 1, skipped: true });
        log.info('queue message skipped as a duplicate', {
          messageId: message.id,
          idempotencyKey: envelope.idempotencyKey,
        });
        return;
      }

      summary.succeeded += 1;
      await deps.jobRuns.succeed(jobRunId, outcome.counts);
    } catch (error) {
      summary.failed += 1;
      const deadLettered = message.readCount >= options.maxAttempts;

      if (deadLettered) {
        await deps.transport.deadLetter(message.id);
        summary.deadLettered += 1;
      } else {
        await deps.transport.retry(message.id, options.retryDelaySeconds);
      }

      await deps.jobRuns.fail(jobRunId, error, {
        attempt: message.readCount,
        maxAttempts: options.maxAttempts,
        deadLettered,
      });

      log.error('queue message failed', {
        messageId: message.id,
        attempt: message.readCount,
        deadLettered,
        err: error,
      });
    }
  }

  return {
    async drain(rawOptions: DrainOptions = {}): Promise<DrainSummary> {
      const options = resolveOptions(rawOptions);
      const startedAt = now();
      const summary: MutableSummary = {
        read: 0,
        succeeded: 0,
        duplicates: 0,
        failed: 0,
        deadLettered: 0,
        invalid: 0,
      };
      let budgetExhausted = false;

      // Ids already attempted in THIS invocation. A message whose retry delay elapses while the
      // loop is still running would otherwise be handed back to the same drain that just failed
      // it, giving it several of its five attempts within a few seconds and defeating the backoff
      // entirely. One attempt per message per invocation; the next tick takes it from there.
      const attempted = new Set<number>();

      while (summary.read < options.maxMessages) {
        if (now() - startedAt >= options.timeBudgetMs) {
          budgetExhausted = true;
          break;
        }

        const quantity = Math.min(options.batchSize, options.maxMessages - summary.read);
        const batch = await deps.transport.read({
          visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
          quantity,
        });
        if (batch.length === 0) break;

        let sawRedelivery = false;
        for (const message of batch) {
          if (attempted.has(message.id)) {
            // Caught up with our own tail: re-hide it and stop, rather than re-running it here.
            await deps.transport.retry(message.id, options.retryDelaySeconds);
            sawRedelivery = true;
            break;
          }
          if (now() - startedAt >= options.timeBudgetMs) {
            // Stop taking on new work. Messages already read but not processed stay invisible for
            // the remainder of their visibility timeout and are redelivered to the next drain —
            // no message is lost, none is acked without having run.
            budgetExhausted = true;
            break;
          }
          attempted.add(message.id);
          summary.read += 1;
          await processMessage(message, options, summary);
        }

        if (budgetExhausted || sawRedelivery) break;
      }

      return {
        queueName: deps.transport.queueName,
        read: summary.read,
        succeeded: summary.succeeded,
        duplicates: summary.duplicates,
        failed: summary.failed,
        deadLettered: summary.deadLettered,
        invalid: summary.invalid,
        elapsedMs: now() - startedAt,
        budgetExhausted,
      };
    },
  };
}
