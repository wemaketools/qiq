/**
 * In-memory queue transport — UNIT TESTS ONLY (T-031).
 *
 * The approved test seam for exercising the drain loop's control flow (dispatch, retry counting,
 * dead-lettering, time budget) without a database. It reproduces pgmq's semantics faithfully enough
 * to be worth trusting for that purpose: a read makes a message invisible until a controllable
 * clock passes its visibility deadline, and each delivery increments `readCount`.
 *
 * It is NOT a substitute for the pgmq integration tests. Queue semantics are a property of pgmq,
 * not of this file, so every claim about visibility timeouts, ack durability and archiving is
 * proven again in src/server/tests/integration/pgmq-queue.test.ts against the real extension.
 * If this adapter ever disagrees with pgmq, pgmq is right.
 *
 * Never import this from production code. A repository test asserts that (see
 * src/server/tests/integration/jobs-layering.test.ts).
 */
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

interface StoredMessage {
  id: number;
  readCount: number;
  enqueuedAtMs: number;
  /** Epoch ms before which the message is invisible to readers. */
  visibleAtMs: number;
  body: unknown;
}

export interface InMemoryQueueOptions {
  readonly queueName?: string;
  /** Injectable clock so visibility timeouts are deterministic instead of slept through. */
  readonly now?: () => number;
}

export class InMemoryQueueTransport implements QueueTransport, QueuePublisher {
  readonly queueName: string;

  private readonly now: () => number;
  private readonly messages = new Map<number, StoredMessage>();
  private readonly archivedMessages: StoredMessage[] = [];
  private nextId = 1;

  constructor(options: InMemoryQueueOptions = {}) {
    this.queueName = options.queueName ?? 'in_memory';
    this.now = options.now ?? (() => Date.now());
  }

  async enqueue(message: JobMessageEnvelope, options: EnqueueOptions = {}): Promise<number> {
    const envelope = jobMessageEnvelopeSchema.parse(message);
    return this.enqueueRaw(envelope, options);
  }

  /** Injects a body that need not satisfy the envelope schema, for poison-message tests. */
  enqueueRaw(body: unknown, options: EnqueueOptions = {}): number {
    const id = this.nextId++;
    const now = this.now();
    this.messages.set(id, {
      id,
      readCount: 0,
      enqueuedAtMs: now,
      visibleAtMs: now + (options.delaySeconds ?? 0) * 1000,
      body,
    });
    return id;
  }

  async read(options: ReadOptions): Promise<readonly QueueMessage[]> {
    const now = this.now();
    const delivered: QueueMessage[] = [];

    for (const message of this.messages.values()) {
      if (delivered.length >= options.quantity) break;
      if (message.visibleAtMs > now) continue;

      message.readCount += 1;
      message.visibleAtMs = now + options.visibilityTimeoutSeconds * 1000;
      delivered.push({
        id: message.id,
        readCount: message.readCount,
        enqueuedAt: new Date(message.enqueuedAtMs),
        body: message.body,
      });
    }

    return delivered;
  }

  async ack(messageId: number): Promise<void> {
    this.messages.delete(messageId);
  }

  async retry(messageId: number, delaySeconds: number): Promise<void> {
    const message = this.messages.get(messageId);
    if (message === undefined) return;
    message.visibleAtMs = this.now() + delaySeconds * 1000;
  }

  async deadLetter(messageId: number): Promise<void> {
    const message = this.messages.get(messageId);
    if (message === undefined) return;
    this.messages.delete(messageId);
    this.archivedMessages.push(message);
  }

  async metrics(): Promise<QueueMetrics> {
    const now = this.now();
    const ages = [...this.messages.values()].map((m) => (now - m.enqueuedAtMs) / 1000);
    return {
      queueName: this.queueName,
      queueLength: this.messages.size,
      archivedCount: this.archivedMessages.length,
      oldestMessageAgeSeconds: ages.length === 0 ? null : Math.max(...ages),
    };
  }

  // --- test inspection ---------------------------------------------------------------------

  /** Messages still on the queue, visible or not. */
  get pending(): readonly StoredMessage[] {
    return [...this.messages.values()];
  }

  get archived(): readonly StoredMessage[] {
    return this.archivedMessages;
  }
}
