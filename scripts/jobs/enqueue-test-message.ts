#!/usr/bin/env tsx
/**
 * `npm run queue:enqueue:test` — inject a message into the local pgmq queue (T-031, AC-065).
 *
 * The manual half of the local job loop: enqueue here, then `npm run queue:worker` drains it
 * through the real handler registry. Defaults to the `job.echo` infrastructure smoke handler, which
 * performs no business writes — its evidence is the job_run row and the claimed idempotency key.
 *
 * Passing the SAME --key twice is the hand-operated version of a duplicate delivery: the second
 * message is acked and skipped, and its job_run row carries counts {"duplicate": 1}.
 *
 * The REAL message type is supported too (T-034), with its own shorthand:
 *
 *   npm run queue:enqueue:test -- --lead 42 --tenant 1
 *
 * which builds a well-formed `alert.reevaluate-lead` envelope through the SAME
 * `buildAlertReevaluationMessage` the workflow executors use — so what this script enqueues cannot
 * drift from what production enqueues. Hand-assembling the envelope here would make this a test of
 * the script rather than of the pipe.
 *
 * Usage:
 *   npm run queue:enqueue:test
 *   npm run queue:enqueue:test -- --lead 42 --tenant 1
 *   npm run queue:enqueue:test -- --type alert.reevaluate-lead --tenant 1 --payload '{"leadId":42}'
 *   npm run queue:enqueue:test -- --payload '{"leadId":42}'
 */
import { randomUUID } from 'node:crypto';

import { closeDb, toTenantId } from '../../src/server/lib/db/index.js';
import {
  ALERT_REEVALUATE_LEAD_TYPE,
  buildAlertReevaluationMessage,
} from '../../src/server/jobs/queue/alert-reevaluate-lead.js';
import { createJobRuntime } from '../../src/server/jobs/runtime.js';
import { jobMessageEnvelopeSchema, type JobMessageEnvelope } from '../../src/server/jobs/types.js';

function stringFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tenantRaw = stringFlag(argv, '--tenant');
  const payloadRaw = stringFlag(argv, '--payload');
  const leadRaw = stringFlag(argv, '--lead');

  // --- The real message type, built by the production builder. ---
  if (leadRaw !== undefined) {
    const leadId = Number(leadRaw);
    if (!Number.isInteger(leadId) || leadId <= 0) fail('--lead must be a positive integer lead id');
    // The handler is tenant-scoped and refuses a null tenant, so requiring it HERE turns an
    // operator's omission into a clear message instead of a dead-lettered message five minutes later.
    if (tenantRaw === undefined) fail('--lead requires --tenant <id>: the handler is tenant-scoped');
    const tenantId = Number(tenantRaw);
    if (!Number.isInteger(tenantId) || tenantId <= 0) fail('--tenant must be a positive integer');

    const envelope = buildAlertReevaluationMessage({
      tenantId: toTenantId(tenantId),
      leadId,
      // Distinguishable from a real workflow event in `job_idempotency_key`, and unique per run so
      // repeating the command actually re-runs the handler instead of being skipped as a duplicate.
      eventKey: `manual-${randomUUID()}`,
      correlationId: stringFlag(argv, '--correlation') ?? randomUUID(),
    });
    await publish(envelope);
    return;
  }

  let payload: Record<string, unknown> = { enqueuedBy: 'queue:enqueue:test' };
  if (payloadRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(payloadRaw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fail('--payload must be a JSON object');
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      fail(`--payload is not valid JSON: ${payloadRaw}`);
    }
  }

  const envelope = jobMessageEnvelopeSchema.parse({
    type: stringFlag(argv, '--type') ?? 'job.echo',
    tenantId: tenantRaw === undefined ? null : Number(tenantRaw),
    correlationId: stringFlag(argv, '--correlation') ?? randomUUID(),
    idempotencyKey: stringFlag(argv, '--key') ?? `test:${randomUUID()}`,
    payload,
  });

  await publish(envelope);
}

async function publish(envelope: JobMessageEnvelope): Promise<void> {
  const runtime = createJobRuntime();
  const messageId = await runtime.publisher.enqueue(envelope);

  process.stdout.write(
    `${JSON.stringify({ queue: runtime.transport.queueName, messageId, envelope }, null, 2)}\n`,
  );
  if (envelope.type === ALERT_REEVALUATE_LEAD_TYPE) {
    process.stdout.write("This is the REAL handler: draining it reconciles that lead's alerts.\n");
  }
  process.stdout.write('Run `npm run queue:worker -- --idle-exit` to process it.\n');

  await closeDb();
}

await main();
