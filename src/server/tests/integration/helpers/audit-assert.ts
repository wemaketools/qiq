/**
 * Shared audit assertion helper (T-013, AC-024, V-031).
 *
 * V-031 requires ONE helper that every domain suite calls for its audited operations, so the
 * evaluator can cross-check the operation inventory against the call sites. Keeping the shape
 * checks here — rather than re-asserting them per suite — is what makes "actor, timestamp, tenant
 * context, and jsonb before/after payloads" a single enforced contract instead of a per-suite
 * opinion that drifts.
 *
 * `assertAudited` insists on EXACTLY ONE matching row. "At least one" would let a double-write
 * (the classic retry/idempotency bug) pass silently.
 */
import { expect } from 'vitest';

import type { QueryFn } from './rbac-fixtures.js';

export interface AuditRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly action: string;
  readonly actor_user_id: string | null;
  readonly actor_label: string | null;
  readonly acted_at: Date;
  readonly details: Record<string, unknown> | null;
}

export interface AuditExpectation {
  readonly action: string;
  readonly entityType?: string;
  readonly entityId?: string;
  /** Application users.id of the expected actor. */
  readonly actorUserId?: number | string;
  /** `null` asserts a deliberately global (untenanted) audit row. */
  readonly tenantId?: number | string | null;
  /** Deep-equality assertions on the jsonb payload halves. */
  readonly before?: unknown;
  readonly after?: unknown;
}

export async function findAuditRows(
  query: QueryFn,
  where: { action: string; entityId?: string; tenantId?: number | string | null },
): Promise<AuditRow[]> {
  const clauses = ['action = $1'];
  const params: unknown[] = [where.action];

  if (where.entityId !== undefined) {
    params.push(where.entityId);
    clauses.push(`entity_id = $${params.length}`);
  }
  if (where.tenantId !== undefined && where.tenantId !== null) {
    params.push(where.tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }

  return await query<AuditRow>(
    // `order by a.id` is QUALIFIED: a bare `order by id` would resolve to the `id::text as id`
    // output alias and sort audit rows as STRINGS ('10' before '9'), not in append order (T-048).
    `select a.id::text as id, a.tenant_id::text as tenant_id, a.entity_type, a.entity_id, a.action,
            a.actor_user_id::text as actor_user_id, a.actor_label, a.acted_at, a.details
       from audit_log a
      where ${clauses.join(' and ')}
      order by a.id`,
    params,
  );
}

/**
 * Asserts exactly one `audit_log` row matches, and that it carries the required fields.
 *
 * The before/after keys are asserted to be PRESENT on every row — even when the caller does not
 * pin their values — because T-003's evaluator recorded that obligation against this task: the
 * documented `details->'before'` / `details->'after'` mapping has to be enforced by a test, or it
 * is only a comment.
 */
export async function assertAudited(
  query: QueryFn,
  expectation: AuditExpectation,
): Promise<AuditRow> {
  const rows = await findAuditRows(query, {
    action: expectation.action,
    ...(expectation.entityId === undefined ? {} : { entityId: expectation.entityId }),
    ...(expectation.tenantId === undefined ? {} : { tenantId: expectation.tenantId }),
  });

  expect(rows, `expected exactly one '${expectation.action}' audit row`).toHaveLength(1);
  const row = rows[0] as AuditRow;

  if (expectation.entityType !== undefined) expect(row.entity_type).toBe(expectation.entityType);
  if (expectation.entityId !== undefined) expect(row.entity_id).toBe(expectation.entityId);
  if (expectation.actorUserId !== undefined) {
    expect(row.actor_user_id).toBe(String(expectation.actorUserId));
  }
  if (expectation.tenantId !== undefined) {
    expect(row.tenant_id).toBe(expectation.tenantId === null ? null : String(expectation.tenantId));
  }

  // Actor and timestamp are always required: an audit row that cannot say who acted, or when, is
  // not evidence of anything.
  expect(row.acted_at).toBeInstanceOf(Date);
  expect(row.actor_user_id === null && row.actor_label === null).toBe(false);

  // The before/after contract (AC-024, T-003 obligation).
  expect(row.details, 'audit details must be present').not.toBeNull();
  const details = row.details as Record<string, unknown>;
  expect(Object.hasOwn(details, 'before'), "audit details must carry a 'before' key").toBe(true);
  expect(Object.hasOwn(details, 'after'), "audit details must carry an 'after' key").toBe(true);

  if (expectation.before !== undefined) expect(details['before']).toEqual(expectation.before);
  if (expectation.after !== undefined) expect(details['after']).toEqual(expectation.after);

  return row;
}
