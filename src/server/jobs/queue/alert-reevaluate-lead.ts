/**
 * Job 4 — targeted alert re-evaluation for ONE lead (T-034; AC-071; V-089, spec §9.5).
 *
 * Port of `IAlertReevaluationQueue` / `AlertReevaluationQueue` +
 * `AlertEvaluationJob.ExecuteForLeadAsync`, with Hangfire's `IBackgroundJobClient.Enqueue` replaced
 * by a pgmq send (M-16, Q-7).
 *
 * ============================================================================================
 * JOB CONTRACT (spec §9.5's required documentation for every job)
 * ============================================================================================
 *   NAME              alert.reevaluate-lead  (a QUEUE message type, not a cron job name)
 *   TRIGGER           Published by the lead/quote workflow executors after their transaction
 *                     commits. Consumed by the drain loop: `/api/queue/drain` every minute in a
 *                     deployment, `npm run queue:worker` locally.
 *   PURPOSE           Make one lead's alerts agree with the rules NOW, so completing an action
 *                     clears its alert in ~a minute instead of waiting up to 15 for the sweep.
 *   PAYLOAD           { leadId }. The tenant travels on the envelope. IDS ONLY — the handler
 *                     re-reads current state, so a message that sat in the queue through three
 *                     other edits still evaluates the truth rather than a stale snapshot.
 *   IDEMPOTENCY KEY   `{leadId}:{eventKey}` — see `alertReevaluationKey`. For a lead workflow
 *                     operation the eventKey is the `lead_status_history.id` this operation just
 *                     appended, which makes the documented AC-071 key literally `{leadId}:
 *                     {statusHistoryId}`. Quote-side events use their own prefixed namespaces.
 *   RETRY BEHAVIOUR   At-least-once, and safe: the handler is `evaluateForLead`, which RECONCILES
 *                     (it re-derives the match set and diffs it) rather than appending. Re-running
 *                     it is a no-op, and `uq_alerts_open_per_type_lead_quote` is the database-level
 *                     backstop against a duplicate even under two concurrent drains.
 *   FAILURE HANDLING  The drain loop retries with a delay up to `maxAttempts`, then archives the
 *                     message (dead-letter) with a failed job_run row. LOSING THE MESSAGE IS NOT
 *                     A CORRECTNESS FAILURE: the every-15-minute alert-evaluation sweep is the
 *                     safety net and converges the same alert set. That is why the PUBLISH side is
 *                     fire-and-forget (see `createAlertReevaluationSeam`).
 *   DATABASE STATE    Reads the alert rule inputs; writes ONLY `alerts` — never a lead or quote
 *                     status, which belongs exclusively to the expiry sweeps.
 *   OBSERVABILITY     job_run row per delivery (type, correlationId, attempt, idempotency key) plus
 *                     created/resolved/matched counts. Ids and counts only, never a business field.
 *
 * ============================================================================================
 * WHY THE KEY IS PER-EVENT AND NOT PER-LEAD
 * ============================================================================================
 * The drain loop claims the idempotency key and SKIPS the handler when it is already claimed. So
 * the key does not merely deduplicate — it DECIDES WHETHER WORK HAPPENS. A key of `{leadId}` would
 * dedupe a redelivery correctly and, with the identical mechanism, permanently suppress every
 * subsequent action on that lead: the alert raised by the second edit would never clear until the
 * sweep happened to notice. Dropping work and deduplicating work are indistinguishable from the
 * outside, which is exactly why the distinction has to be made here, deliberately, once.
 */
import { z } from 'zod';

import { evaluateForLead } from '../../domains/alerts/index.js';
import type { LeadChangeEvent, LeadChangedListener } from '../../domains/leads/index.js';
import { toTenantId, type TenantId } from '../../lib/db/index.js';
import { jobLogger, newCorrelationId, type Logger } from '../../lib/logging/index.js';
import type { JobContext, JobHandler, JobMessageEnvelope, JobResult, QueuePublisher } from '../types.js';

export { ALERT_REEVALUATE_LEAD_TYPE } from './registry.js';
import { ALERT_REEVALUATE_LEAD_TYPE } from './registry.js';

/**
 * The payload, validated on the way in.
 *
 * `strict()` because anything with database access can write to the pgmq table: a message carrying
 * extra fields is not something this handler should quietly accept and half-honour.
 */
export const alertReevaluatePayloadSchema = z
  .object({ leadId: z.number().int().positive() })
  .strict();

export type AlertReevaluatePayload = z.infer<typeof alertReevaluatePayloadSchema>;

/**
 * `{leadId}:{eventKey}` (AC-071).
 *
 * The lead id leads so that a key is greppable by lead in `job_idempotency_key` during an incident;
 * the event component is what makes two changes to one lead two units of work.
 */
export function alertReevaluationKey(leadId: number, eventKey: string): string {
  return `${String(leadId)}:${eventKey}`;
}

export interface AlertReevaluationMessageInput {
  readonly tenantId: TenantId;
  readonly leadId: number;
  /** Uniquely identifies the state change. See the header. */
  readonly eventKey: string;
  /** §15: propagated from the originating request so the job_run row joins back to it. */
  readonly correlationId?: string | undefined;
}

export function buildAlertReevaluationMessage(
  input: AlertReevaluationMessageInput,
): JobMessageEnvelope {
  return {
    type: ALERT_REEVALUATE_LEAD_TYPE,
    tenantId: Number(input.tenantId),
    // A message with no correlation id is a job_run row that cannot be traced back to the request
    // that caused it. Minting one is strictly better than emitting an untraceable message.
    correlationId: input.correlationId ?? newCorrelationId(),
    idempotencyKey: alertReevaluationKey(input.leadId, input.eventKey),
    payload: { leadId: input.leadId },
  };
}

export interface AlertReevaluationSeamDeps {
  readonly publisher: QueuePublisher;
  /**
   * Optional. When absent a logger is built PER CALL carrying that event's own correlation id, so a
   * failed publish is traceable back to the request that caused it (§15). A single logger built
   * once at composition time could only ever carry one correlation id for the life of the process,
   * which is no more useful than carrying none.
   */
  readonly logger?: Logger | undefined;
}

/**
 * Builds the `onLeadChanged` callback the workflow executors invoke AFTER their commit.
 *
 * IT NEVER THROWS, AND THAT IS THE POINT. By the time this runs the user's operation is durable.
 * Propagating a queue outage here would turn a succeeded write into a 500, and a client that
 * retries a 500 would re-run a workflow operation that already happened. The reference degrades the
 * same way (`AlertReevaluationQueue` no-ops when no background client is registered), and the
 * consequence is identical and bounded: the alert clears on the next 15-minute sweep instead of
 * within the minute. The failure is LOGGED, so a persistently broken queue is visible rather than
 * merely slow.
 */
export function createAlertReevaluationSeam(deps: AlertReevaluationSeamDeps): LeadChangedListener {
  return async (leadId: number, tenantId: TenantId, event: LeadChangeEvent): Promise<void> => {
    const envelope = buildAlertReevaluationMessage({
      tenantId,
      leadId,
      eventKey: event.eventKey,
      correlationId: event.correlationId,
    });

    try {
      await deps.publisher.enqueue(envelope);
    } catch (error) {
      const log =
        deps.logger ??
        jobLogger({
          jobName: ALERT_REEVALUATE_LEAD_TYPE,
          trigger: 'queue',
          correlationId: envelope.correlationId,
        });
      log.error('could not enqueue targeted alert re-evaluation; the sweep will converge', {
        tenantId: Number(tenantId),
        leadId,
        err: error,
      });
    }
  };
}

/**
 * The registrable consumer.
 *
 * A plain object, not a factory over a `DbClient`: unlike the cron sweeps this handler must run on
 * the drain loop's OWN transaction (`context.db`), the same one that claims the idempotency key and
 * acks the message. Reaching for any other connection would let the alert write survive a rollback
 * that released the key — which is precisely the exactly-once property the drain loop exists to
 * provide.
 */
export const alertReevaluateLeadHandler: JobHandler = {
  name: ALERT_REEVALUATE_LEAD_TYPE,

  async handle(payload: Readonly<Record<string, unknown>>, context: JobContext): Promise<JobResult> {
    if (context.tenantId === null) {
      // Not retryable-by-waiting, but it IS a real fault: a tenant-scoped evaluation with no
      // tenant would either do nothing or, worse, be tempting to "fix" by scanning every tenant.
      throw new Error(`${ALERT_REEVALUATE_LEAD_TYPE} requires a tenantId on the envelope`);
    }

    const { leadId } = alertReevaluatePayloadSchema.parse(payload);
    const result = await evaluateForLead(context.db, toTenantId(context.tenantId), leadId);

    context.logger.info('re-evaluated alerts for lead', {
      tenantId: context.tenantId,
      leadId,
      created: result.created,
      resolved: result.resolved,
      matched: result.matched,
    });

    return {
      counts: {
        leadId,
        created: result.created,
        resolved: result.resolved,
        matched: result.matched,
      },
    };
  },
};
