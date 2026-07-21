/**
 * Workflow persistence: status history, follow-ups, pricing approvals, the lead's own workflow
 * columns, and the lead->quotes closure cascade (T-025; AC-048, AC-049, AC-051, V-062, V-066).
 *
 * Ports `ILeadWorkflowStore`/`LeadWorkflowStore`, the workflow-owned writes inside
 * `LeadOperationExecutor`, and `Infrastructure/Workflow/QuoteCascadeService`.
 *
 * EVERY FUNCTION TAKES AN EXECUTOR AND IS TENANT-SCOPED THROUGH `forTenant`
 * ========================================================================
 * Same contract as `leads/repository.ts`: nothing here opens its own transaction, so a caller can
 * hand in the operation's open transaction and have the mutation, its history row and its audit row
 * commit or roll back together. `forTenant` is not optional decoration — with RLS not adopted (Q-10)
 * it is the ONLY thing standing between a lead id and another tenant's row.
 *
 * `lead_status_history` IS APPEND-ONLY BY APPLICATION DISCIPLINE
 * =============================================================
 * There is deliberately no update or delete function in this module, and the migration deliberately
 * carries no guard trigger (see `20260718003500_lead_workflow.sql`'s header: the live reference
 * database has none either, and adding one would be a real behavioural divergence). The absence of
 * a mutator here is therefore the enforcement mechanism, which is exactly why `appendStatusHistory`
 * is an insert with no sibling.
 */
import { forTenant, type DbExecutor, type TenantId } from '../../../lib/db/index.js';

import type { Json } from '../../../lib/db/generated/supabase-types.js';

/** One `lead_status_history` row as the workflow reads it back. */
export interface LeadStatusHistoryRecord {
  readonly id: number;
  readonly operation: string;
  readonly previousStatusId: number | null;
  readonly newStatusId: number | null;
  readonly actedBy: number | null;
  readonly actedAt: string;
}

/**
 * `ILeadWorkflowStore.AddHistoryAsync` — the append-only transition record (AC-048).
 *
 * RETURNS THE NEW ROW'S ID (T-034). That id is the only value in the system that identifies THIS
 * transition and no other, which is what makes it the alert re-evaluation idempotency key's event
 * component (`{leadId}:{statusHistoryId}`, AC-071). Anything derived from the operation name, the
 * lead id or the wall clock either collides between two rapid operations — silently suppressing the
 * second re-evaluation — or fails to match on redelivery.
 */
export async function appendStatusHistory(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    leadId: number;
    operation: string;
    previousStatusId: number | null;
    newStatusId: number | null;
    actedBy: number | null;
    actedAt: string;
    inputs: unknown;
  },
): Promise<number> {
  const row = await forTenant(trx, tenantId)
    .insertInto('lead_status_history', {
      lead_id: values.leadId,
      operation: values.operation,
      previous_status_id: values.previousStatusId,
      new_status_id: values.newStatusId,
      acted_by: values.actedBy,
      acted_at: values.actedAt,
      inputs: (values.inputs ?? null) as Json,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return Number(row.id);
}

/**
 * `ILeadWorkflowStore.ListHistoryAsync` — oldest first, in APPEND order.
 *
 * ORDER BY `id`, NOT BY `acted_at` (T-048)
 * ========================================
 * `id` is the table's identity column, so it is assigned by the database at INSERT and increases
 * strictly with append order. `acted_at` is not: it is the operation's `new Date().toISOString()`,
 * a wall-clock value the APPLICATION supplies. A wall clock ties at millisecond resolution and,
 * across an NTP or VM host correction, can step BACKWARDS — and `(acted_at, id)` faithfully
 * reproduces that regression as a reordered audit trail.
 *
 * That is not cosmetic here. `resolveReopenTargetStatusId` walks this list BACKWARDS for the most
 * recent open status, so a reordered read resolves Reopen to the WRONG status; the integration test
 * "resolves reopen from the append order even when the clock ran backwards" pins exactly that, and
 * fails against a timestamp-ordered read.
 *
 * `acted_at` remains the user-visible "when", and it is deliberately still application-sourced: the
 * same `now` stamps the history row, the lead's `last_activity_at`/`updated_at` and the audit row,
 * so moving only this column to a database clock would desynchronise a record from the row it
 * describes. The timestamp is DISPLAY data; `id` is the ORDER. Quote status history is the same
 * table shape and must be read the same way.
 */
export async function listStatusHistory(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<LeadStatusHistoryRecord[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('lead_status_history')
    .select(['id', 'operation', 'previous_status_id', 'new_status_id', 'acted_by', 'acted_at'])
    .where('lead_id', '=', leadId)
    .orderBy('id')
    .execute();

  return rows.map((row) => ({
    id: Number(row.id),
    operation: row.operation,
    previousStatusId: row.previous_status_id === null ? null : Number(row.previous_status_id),
    newStatusId: row.new_status_id === null ? null : Number(row.new_status_id),
    actedBy: row.acted_by === null ? null : Number(row.acted_by),
    actedAt: String(row.acted_at),
  }));
}

/** `ILeadWorkflowStore.AddFollowUpAsync` — one logged follow-up (AC-051). */
export async function insertFollowUp(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    leadId: number;
    followUpDate: string;
    outcomeNote: string;
    nextFollowUpDate: string | null;
    loggedBy: number | null;
    loggedAt: string;
  },
): Promise<void> {
  await forTenant(trx, tenantId)
    .insertInto('follow_ups', {
      lead_id: values.leadId,
      follow_up_date: values.followUpDate,
      outcome_note: values.outcomeNote,
      next_follow_up_date: values.nextFollowUpDate,
      logged_by: values.loggedBy,
      logged_at: values.loggedAt,
    })
    .execute();
}

/** `ILeadWorkflowStore.AddPricingApprovalAsync` — one approval REQUEST, state `pending`. */
export async function insertPricingApproval(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    leadId: number;
    requestedBy: number;
    requestedAt: string;
    approverId: number;
    proposedPremium: number | null;
    requestNote: string | null;
  },
): Promise<void> {
  await forTenant(trx, tenantId)
    .insertInto('pricing_approvals', {
      lead_id: values.leadId,
      requested_by: values.requestedBy,
      requested_at: values.requestedAt,
      approver_id: values.approverId,
      proposed_premium: values.proposedPremium === null ? null : String(values.proposedPremium),
      request_note: values.requestNote,
      state: 'pending',
    })
    .execute();
}

/** `ILeadWorkflowStore.FindPendingPricingApprovalAsync` — the newest still-pending request, if any. */
export async function findPendingPricingApproval(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<{ id: number; approverId: number } | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('pricing_approvals')
    .select(['id', 'approver_id'])
    .where('lead_id', '=', leadId)
    .where('state', '=', 'pending')
    .orderBy('requested_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : { id: Number(row.id), approverId: Number(row.approver_id) };
}

/**
 * The decision write (`pending.State = ...; SavePricingApprovalAsync`).
 *
 * `where state = 'pending'` is repeated here even though the caller just read the row: it makes the
 * transition compare-and-set, so two concurrent approve calls cannot both decide the same request.
 * Returns whether a row actually moved.
 */
export async function decidePricingApproval(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    id: number;
    state: 'approved' | 'rejected';
    decidedBy: number | null;
    decidedAt: string;
    decisionNote: string | null;
    rejectionReason: string | null;
  },
): Promise<boolean> {
  const result = await forTenant(trx, tenantId)
    .updateTable('pricing_approvals')
    .set({
      state: values.state,
      decided_by: values.decidedBy,
      decided_at: values.decidedAt,
      decision_note: values.decisionNote,
      rejection_reason: values.rejectionReason,
    })
    .where('id', '=', values.id)
    .where('state', '=', 'pending')
    .executeTakeFirst();

  return Number(result.numUpdatedRows ?? 0n) > 0;
}

/** The lead columns the workflow operations own. Every field is optional; only what is passed is written. */
export interface LeadWorkflowFields {
  readonly statusId?: number;
  readonly pricingApprovalState?: 'none' | 'pending' | 'approved' | 'rejected';
  readonly dateAssigned?: string | null;
  readonly decisionDate?: string | null;
  readonly lostReasonId?: number | null;
  readonly lostBeforeQuote?: boolean | null;
  readonly competitor?: string | null;
  readonly competitorPremium?: number | null;
  readonly lossComments?: string | null;
  readonly withdrawalNote?: string | null;
  readonly lastFollowUpDate?: string | null;
  readonly nextFollowUpDate?: string | null;
  readonly followUpCountIncrement?: number;
}

/**
 * Applies an operation's field changes AND stamps `last_activity_at` in one statement
 * (`LeadActivityStamper.Stamp(lead)` immediately before `SaveChangesAsync`).
 *
 * The stamp is not optional and not a separate call: `last_activity_at` is what the inactivity
 * expiry sweep and the stalled-lead alert rules scan on, so an operation that changed a lead
 * without stamping it would leave the lead looking untouched and expirable.
 */
export async function updateLeadWorkflowFields(
  trx: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  fields: LeadWorkflowFields,
  now: string,
  actorUserId: number | null,
): Promise<void> {
  const values: Record<string, unknown> = {
    last_activity_at: now,
    updated_at: now,
    updated_by: actorUserId,
  };

  if (fields.statusId !== undefined) values['status_id'] = fields.statusId;
  if (fields.pricingApprovalState !== undefined) {
    values['pricing_approval_state'] = fields.pricingApprovalState;
  }
  if (fields.dateAssigned !== undefined) values['date_assigned'] = fields.dateAssigned;
  if (fields.decisionDate !== undefined) values['decision_date'] = fields.decisionDate;
  if (fields.lostReasonId !== undefined) values['lost_reason_id'] = fields.lostReasonId;
  if (fields.lostBeforeQuote !== undefined) values['lost_before_quote'] = fields.lostBeforeQuote;
  if (fields.competitor !== undefined) values['competitor'] = fields.competitor;
  if (fields.competitorPremium !== undefined) {
    values['competitor_premium'] =
      fields.competitorPremium === null ? null : String(fields.competitorPremium);
  }
  if (fields.lossComments !== undefined) values['loss_comments'] = fields.lossComments;
  if (fields.withdrawalNote !== undefined) values['withdrawal_note'] = fields.withdrawalNote;
  if (fields.lastFollowUpDate !== undefined) values['last_follow_up_date'] = fields.lastFollowUpDate;
  if (fields.nextFollowUpDate !== undefined) values['next_follow_up_date'] = fields.nextFollowUpDate;

  let builder = forTenant(trx, tenantId).updateTable('leads').set(values);

  if (fields.followUpCountIncrement !== undefined) {
    // Incremented in SQL rather than read-modify-written in TypeScript: two follow-ups logged
    // concurrently would otherwise both read the same count and one increment would vanish.
    const increment = fields.followUpCountIncrement;
    builder = builder.set((eb) => ({
      follow_up_count: eb('follow_up_count', '+', increment),
    }));
  }

  await builder.where('id', '=', leadId).execute();
}

/**
 * The lead columns the WORKFLOW reads but `LeadRecord` does not carry (T-024 projected only the
 * intake/list facts). Kept as its own narrow read rather than widening `LeadRecord`, so the leads
 * core and the sibling intake task are untouched by this task's needs.
 */
export interface LeadWorkflowState {
  readonly dateAssigned: string | null;
  readonly pricingApprovalState: string;
  readonly followUpCount: number;
}

export async function findLeadWorkflowState(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<LeadWorkflowState | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('leads')
    .select(['date_assigned', 'pricing_approval_state', 'follow_up_count'])
    .where('id', '=', leadId)
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : {
        dateAssigned: row.date_assigned === null ? null : String(row.date_assigned),
        pricingApprovalState: String(row.pricing_approval_state),
        followUpCount: Number(row.follow_up_count),
      };
}

/**
 * `LeadStore.RemoveAssignmentAsync` — the clear-the-slot half of the Assign/Reassign contract.
 *
 * A hard delete, matching the reference: an assignment row is current state, not history. The
 * record that a slot WAS held and by whom lives in `lead_status_history.inputs`, which is why
 * removing the row loses nothing auditable.
 */
export async function deleteLeadAssignment(
  trx: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  businessAssignmentId: number,
): Promise<void> {
  await forTenant(trx, tenantId)
    .deleteFrom('lead_assignments')
    .where('lead_id', '=', leadId)
    .where('business_assignment_id', '=', businessAssignmentId)
    .execute();
}

/** One open quote of a lead, for the closure cascade. */
export interface OpenQuoteRecord {
  readonly id: number;
  readonly statusId: number;
}

/**
 * `QuoteStore.ListOpenQuotesForLeadAsync` (:138-149): the lead's quotes whose status carries an
 * OPEN or QUOTED reporting category.
 *
 * "Open" is a property of the status's reporting CATEGORY, never of a canonical key list — that is
 * what lets a tenant add its own intermediate quote status and still have it cascade correctly.
 */
export async function listOpenQuotesForLead(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<OpenQuoteRecord[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('quotes')
    .innerJoin('reference_items', 'reference_items.id', 'quotes.status_id')
    .select(['quotes.id as id', 'quotes.status_id as status_id'])
    .where('quotes.lead_id', '=', leadId)
    .where('reference_items.reporting_category', 'in', ['open', 'quoted'])
    .orderBy('quotes.id')
    .execute();

  return rows.map((row) => ({ id: Number(row.id), statusId: Number(row.status_id) }));
}

/** Moves one cascaded quote and, for the withdrawn cascade, records why (`QuoteCascadeService`). */
export async function applyQuoteCascade(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    quoteId: number;
    statusId: number;
    withdrawalNote: string | null;
    now: string;
    actorUserId: number | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = {
    status_id: values.statusId,
    updated_at: values.now,
    updated_by: values.actorUserId,
  };
  if (values.withdrawalNote !== null) set['withdrawal_note'] = values.withdrawalNote;

  await forTenant(trx, tenantId)
    .updateTable('quotes')
    .set(set)
    .where('id', '=', values.quoteId)
    .execute();
}

/**
 * The cascaded quote's own history row — the cascade is auditable per quote, not only per lead.
 *
 * Returns the new row's id for the same reason `appendStatusHistory` does: it is the event
 * component of the quote-side alert re-evaluation idempotency key (T-034).
 */
export async function appendQuoteStatusHistory(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    quoteId: number;
    operation: string;
    previousStatusId: number | null;
    newStatusId: number | null;
    actedBy: number | null;
    actedAt: string;
    inputs: unknown;
  },
): Promise<number> {
  const row = await forTenant(trx, tenantId)
    .insertInto('quote_status_history', {
      quote_id: values.quoteId,
      operation: values.operation,
      previous_status_id: values.previousStatusId,
      new_status_id: values.newStatusId,
      acted_by: values.actedBy,
      acted_at: values.actedAt,
      inputs: (values.inputs ?? null) as Json,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return Number(row.id);
}
