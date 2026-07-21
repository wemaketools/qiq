/**
 * Queue handler registry (T-031; the real consumer lands in T-034, spec §9.5 Job 4).
 *
 * Handlers are keyed by the message `type` on the envelope. An unregistered type is NOT a poison
 * message — during a rolling deploy a producer can legitimately run ahead of the consumer — so the
 * drain loop retries it and only dead-letters after max_attempts (see drain.ts).
 */
import type { JobContext, JobHandler, JobHandlerRegistry, JobResult } from '../types.js';

/**
 * Spec §9.5 Job 4: targeted alert re-evaluation for one lead.
 *
 * The constant lives HERE, not next to the handler, because it is the wire contract: producers
 * (`buildAlertReevaluationMessage`) and the dispatcher must agree on the exact string, and a
 * handler registered under a key nothing publishes — or published under a key nothing handles — is
 * a queue that quietly dead-letters everything. The handler itself is in
 * `./alert-reevaluate-lead.ts` and is registered by the job composition root.
 */
export const ALERT_REEVALUATE_LEAD_TYPE = 'alert.reevaluate-lead';

/**
 * Infrastructure smoke handler for `npm run queue:enqueue:test` (AC-065).
 *
 * It deliberately performs NO business writes — its purpose is to prove the pipe, not to change
 * data. Its durable evidence is the pair of rows every queue execution produces: the job_run row
 * and the claimed job_idempotency_key. That is enough to show enqueue -> read -> handle -> ack
 * worked end to end, and it cannot corrupt a developer's local data while doing so.
 */
export const echoJobHandler: JobHandler = {
  name: 'job.echo',
  async handle(payload: Readonly<Record<string, unknown>>, context: JobContext): Promise<JobResult> {
    context.logger.info('echo job handled', {
      payloadKeys: Object.keys(payload).sort().join(','),
      attempt: context.attempt,
    });
    return { counts: { echoed: 1, payloadKeys: Object.keys(payload).length } };
  },
};

const handlers = new Map<string, JobHandler>([[echoJobHandler.name, echoJobHandler]]);

/** Registration seam for queued job types, called from the job composition root. */
export function registerQueueHandler(handler: JobHandler): void {
  handlers.set(handler.name, handler);
}

export const queueHandlers: JobHandlerRegistry = handlers;
