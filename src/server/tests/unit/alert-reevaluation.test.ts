/**
 * The targeted alert re-evaluation seam, without a database (T-034; AC-071; V-089).
 *
 * What is pinned here is the part that has NO database in it: the idempotency-key construction, the
 * envelope shape, and — most importantly — the two failure properties the seam must have:
 *
 *   1. A PUBLISH FAILURE MUST NOT PROPAGATE. The seam runs AFTER the business transaction has
 *      committed. If it threw, the caller would see a 500 for an operation that already succeeded,
 *      and would very likely retry it. The reference (`AlertReevaluationQueue`) degrades to a no-op
 *      when no background client is registered for exactly this reason; here the degradation is a
 *      swallowed error plus the 15-minute sweep, which converges anyway.
 *
 *   2. THE KEY MUST BE UNIQUE PER EVENT, NOT PER LEAD. The drain loop SKIPS a message whose
 *      idempotency key is already claimed. A key of `{leadId}` alone would therefore mean the
 *      SECOND workflow action on a lead is never re-evaluated — a silent, permanent staleness bug
 *      that no "is it idempotent?" test would catch, because dropping work looks exactly like
 *      deduplicating it. The event component is what separates redelivery from a new event.
 */
import { describe, expect, it, vi } from 'vitest';

import { InMemoryQueueTransport } from '../../jobs/queue/in-memory-adapter.js';
import {
  ALERT_REEVALUATE_LEAD_TYPE,
  alertReevaluationKey,
  buildAlertReevaluationMessage,
  createAlertReevaluationSeam,
} from '../../jobs/queue/alert-reevaluate-lead.js';
import { jobMessageEnvelopeSchema, type QueuePublisher } from '../../jobs/types.js';
import { toTenantId } from '../../lib/db/index.js';
import type { Logger } from '../../lib/logging/index.js';

const TENANT = toTenantId(7);

/** A Logger that writes nowhere, so a spy can assert what WOULD have been logged. */
function silentLogger(): Logger {
  const log: Logger = {
    context: {},
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
}

describe('alertReevaluationKey', () => {
  it('is {leadId}:{eventKey}, matching AC-071 for the lead-workflow event', () => {
    expect(alertReevaluationKey(42, '7')).toBe('42:7');
  });

  it('differs between two events on the SAME lead, so a later action is not skipped as a duplicate', () => {
    expect(alertReevaluationKey(42, '7')).not.toBe(alertReevaluationKey(42, '8'));
  });

  it('differs between two leads sharing an event id, so one lead cannot suppress another', () => {
    expect(alertReevaluationKey(42, '7')).not.toBe(alertReevaluationKey(43, '7'));
  });
});

describe('buildAlertReevaluationMessage', () => {
  it('produces an envelope the wire schema accepts', () => {
    const envelope = buildAlertReevaluationMessage({
      tenantId: TENANT,
      leadId: 42,
      eventKey: '7',
      correlationId: 'corr-abc',
    });

    expect(jobMessageEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).toEqual({
      type: ALERT_REEVALUATE_LEAD_TYPE,
      tenantId: 7,
      correlationId: 'corr-abc',
      idempotencyKey: '42:7',
      payload: { leadId: 42 },
    });
  });

  it('carries ids only — never a lead ref, party name or premium (§15)', () => {
    const envelope = buildAlertReevaluationMessage({
      tenantId: TENANT,
      leadId: 42,
      eventKey: '7',
      correlationId: 'corr-abc',
    });

    expect(Object.keys(envelope.payload)).toEqual(['leadId']);
  });

  it('mints a correlation id when the caller has none, rather than emitting an untraceable message', () => {
    const envelope = buildAlertReevaluationMessage({ tenantId: TENANT, leadId: 42, eventKey: '7' });

    expect(envelope.correlationId).toMatch(/^[A-Za-z0-9._:-]+$/u);
    expect(envelope.correlationId.length).toBeGreaterThan(0);
  });
});

describe('createAlertReevaluationSeam', () => {
  it('enqueues one message per lead change', async () => {
    const transport = new InMemoryQueueTransport();
    const seam = createAlertReevaluationSeam({ publisher: transport, logger: silentLogger() });

    await seam(42, TENANT, { eventKey: '7', correlationId: 'corr-abc' });

    const delivered = await transport.read({ visibilityTimeoutSeconds: 30, quantity: 10 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.body).toMatchObject({
      type: ALERT_REEVALUATE_LEAD_TYPE,
      tenantId: 7,
      idempotencyKey: '42:7',
      payload: { leadId: 42 },
    });
  });

  it('SWALLOWS a publish failure: a committed workflow operation must not fail because the queue did', async () => {
    const boom = new Error('pgmq unreachable');
    const publisher: QueuePublisher = { enqueue: () => Promise.reject(boom) };
    const logger = silentLogger();
    const errorSpy = vi.spyOn(logger, 'error');

    const seam = createAlertReevaluationSeam({ publisher, logger });

    await expect(seam(42, TENANT, { eventKey: '7' })).resolves.toBeUndefined();
    // Silently swallowing would be worse than throwing: the failure has to be observable.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
