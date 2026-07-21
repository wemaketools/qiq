/**
 * The lead workflow engine (T-025; AC-024, AC-047..AC-051, AC-096; V-061..V-064, V-066).
 *
 * Ports `LeadOperationExecutor` plus the twelve `*CommandHandler`s under
 * `Features/Leads/Workflow/*`, collapsed into one executor and twelve small mutation functions
 * because in TypeScript the C# per-operation command/handler/validator triple is pure ceremony —
 * the only thing that actually varies between operations is the mutation body.
 *
 * ONE TRANSACTION PER OPERATION, AND THE AUDIT ROW IS INSIDE IT
 * ============================================================
 * The reference wrote its audit entry through a separate `IAuditWriter` after the save, so a crash
 * in between produced a status change with no audit trail. Here the lead mutation, the
 * `lead_status_history` row and the `audit_log` row share one transaction — strictly stronger than
 * the reference, and the pattern every other domain in this port already uses. A validation failure
 * discovered inside a mutation throws, which rolls the whole thing back: an operation never
 * half-applies.
 *
 * THE ORDER OF CHECKS IS LOAD-BEARING, NOT INCIDENTAL
 * ==================================================
 *   1. permission   (403) — before anything is read, so a caller who may not act learns nothing
 *   2. existence    (404) — tenant-predicated, so a foreign id is indistinguishable from a missing one
 *   3. legality     (409) — with the legal-operation hint
 *   4. input rules  (422) — the operation's own validation, inside the transaction
 *
 * Swapping 1 and 2 would turn the 404 into a cross-tenant existence oracle for callers lacking the
 * permission; swapping 3 and 4 would let a caller probe a lead's validation rules from a status the
 * operation is not even legal from.
 *
 * PERMISSION IS RE-CHECKED HERE EVEN THOUGH THE ROUTE GUARD ALREADY CHECKED IT
 * ===========================================================================
 * `LeadWorkflowEndpoints.cs:27-28` calls this "defense in depth" and it is kept: the guard protects
 * the HTTP surface, this protects the OPERATION. A future non-HTTP caller — the T-032 expiry job, a
 * queue handler, a cascade — reaches the executor without passing any route guard, and the system
 * actor path below is the ONLY sanctioned way past it.
 */
import { writeAudit } from '../../audit/index.js';
import { listSlots } from '../../assignments/repository.js';
import { listUsersHoldingPermission } from '../../assignments/eligible-repository.js';
import { withTransaction, type DbClient, type DbExecutor, type TenantId } from '../../../lib/db/index.js';
import type { EffectiveAccess } from '../../rbac/effective-permissions.js';
import { leadNotFoundError } from '../errors.js';
import {
  findLead,
  findLeadAssignment,
  findActiveReferenceItem,
  findReferenceItem,
  findReferenceItemByCanonicalKey,
  insertLeadAssignment,
  isEligibleOwner,
  updateLeadAssignmentUser,
  type LeadRecord,
  type ReferenceItemRecord,
} from '../repository.js';
import {
  approverNotEligibleError,
  illegalTransitionError,
  invalidAssigneeError,
  invalidLostReasonError,
  noPendingPricingApprovalError,
  noPriorOpenStatusError,
  operationForbiddenError,
  workflowRuleError,
} from './errors.js';
import {
  appendQuoteStatusHistory,
  appendStatusHistory,
  applyQuoteCascade,
  decidePricingApproval,
  deleteLeadAssignment,
  findLeadWorkflowState,
  findPendingPricingApproval,
  insertFollowUp,
  insertPricingApproval,
  listOpenQuotesForLead,
  listStatusHistory,
  updateLeadWorkflowFields,
  type LeadWorkflowFields,
} from './history.js';
import {
  LEAD_OPERATION_PERMISSIONS,
  isLeadOperationLegal,
  legalLeadOperations,
  resolveFixedLeadTarget,
  type LeadOperation,
  type LeadOperationName,
} from './legality.js';
import type {
  AssignLeadInput,
  LogFollowUpInput,
  MarkLeadLostInput,
  OptionalNoteInput,
  RejectPricingInput,
  RequestPricingApprovalInput,
  ReopenLeadInput,
  SendToUnderwritingInput,
  WithdrawLeadInput,
} from './schemas.js';

/** The audit action prefix: `lead.assign`, `lead.mark-lost`, ... (`$"lead.{operation.ToCodeValue()}"`). */
export function leadOperationAuditAction(operation: LeadOperationName): string {
  return `lead.${operation}`;
}

/** The reporting categories that count as "still open" (`ReportingCategory.Open`/`Quoted`). */
const OPEN_CATEGORIES = new Set(['open', 'quoted']);

/** `QuoteStatusKeys.Lost`/`Withdrawn`, and the cascade operation codes recorded on quote history. */
const QUOTE_LOST_KEY = 'lost';
const QUOTE_WITHDRAWN_KEY = 'withdrawn';
const LEAD_LOST_CASCADE_OPERATION = 'cascade-lead-lost';
const LEAD_WITHDRAWN_CASCADE_OPERATION = 'cascade-lead-withdrawn';

/** The lost-reason canonical key that makes a free-text comment mandatory. */
const OTHER_LOST_REASON_KEY = 'other';

/**
 * What changed, as reported to the alert re-evaluation seam (T-034).
 *
 * `eventKey` IDENTIFIES THIS STATE CHANGE AND NO OTHER. It becomes the event component of the
 * queued message's idempotency key, and the drain loop SKIPS a message whose key is already
 * claimed — so a key that collides between two operations on one lead does not "deduplicate", it
 * permanently drops the second re-evaluation. Every producer therefore derives it from a database
 * identity value (a `lead_status_history.id`, a `quote_status_history.id`, a quote id), never from
 * the clock and never from the operation name.
 */
export interface LeadChangeEvent {
  readonly eventKey: string;
  /** §15: propagated from the originating request into the message and its job_run row. */
  readonly correlationId?: string | undefined;
}

/** The callback shape shared by the lead workflow, the quote workflow and quote creation. */
export type LeadChangedListener = (
  leadId: number,
  tenantId: TenantId,
  event: LeadChangeEvent,
) => void | Promise<void>;

export interface LeadWorkflowDeps {
  readonly db: DbClient;
  /**
   * The alert re-evaluation seam (T-034).
   *
   * `LeadOperationExecutor` enqueued `IAlertReevaluationQueue.EnqueueLeadReevaluationAsync` here.
   * It is an OPTIONAL callback rather than a required dependency so this task can ship without the
   * alerts domain existing, and it is invoked AFTER the transaction commits: enqueuing work for a
   * state that may still roll back is how duplicate and phantom alerts get created. A throw from
   * it must never undo a committed operation, so it is deliberately not awaited into the caller's
   * error path — see `executeLeadOperation`.
   */
  readonly onLeadChanged?: LeadChangedListener;
}

/**
 * Who is acting.
 *
 * `access` is null ONLY for the system actor (`ICurrentUser.IsSystemActor`): the T-032 expiry job
 * has no user and no grants, and is the single sanctioned caller that skips the permission check.
 * Every human path carries a resolved `EffectiveAccess`, so "no access" can never silently mean
 * "allow everything" for a request that merely forgot to resolve it — routes.ts fails closed with a
 * 500 rather than constructing an actor without one.
 */
export interface LeadWorkflowActor {
  readonly userId: number | null;
  readonly tenantId: TenantId;
  readonly access: EffectiveAccess | null;
  readonly isSystemActor?: boolean;
  readonly correlationId?: string;
}

/** What a mutation sees. */
interface OperationContext {
  readonly trx: DbExecutor;
  readonly tenantId: TenantId;
  readonly lead: LeadRecord;
  readonly currentStatus: ReferenceItemRecord;
  readonly actor: LeadWorkflowActor;
  readonly now: string;
}

/**
 * What a mutation returns: the payload recorded in `lead_status_history.inputs` and the audit row,
 * plus any lead-column changes for the executor to apply alongside the status transition.
 *
 * Mutations do NOT write `status_id` themselves — the executor resolves and applies it from the
 * matrix afterwards. That separation is what keeps "which status does this operation land on" a
 * property of the matrix (unit-testable, exhaustively) rather than something re-decided twelve
 * times in twelve mutation bodies.
 */
interface OperationOutcome {
  readonly inputs: Record<string, unknown>;
  readonly fields?: LeadWorkflowFields;
}

type Mutation = (context: OperationContext) => Promise<OperationOutcome>;

function auditContext(actor: LeadWorkflowActor): { correlationId?: string } {
  return actor.correlationId === undefined ? {} : { correlationId: actor.correlationId };
}

/**
 * A-13's "returns the lead to its last open status", resolved from history
 * (`ResolveReopenTargetStatusIdAsync`, :181-208).
 *
 * Builds the full chronological status timeline — the first row's PREVIOUS status, then every row's
 * NEW status, i.e. what the lead's status was after every recorded operation — and walks it
 * backwards from the entry immediately before the current one, returning the most recent status
 * whose reporting category is open or quoted.
 *
 * Starting at `length - 2` rather than `length - 1` is the whole trick: the last entry IS the
 * terminal status being reopened from, and including it would resolve every reopen to a no-op.
 */
async function resolveReopenTargetStatusId(
  trx: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<number | null> {
  const history = await listStatusHistory(trx, tenantId, leadId);
  if (history.length === 0) return null;

  const timeline: (number | null)[] = [history[0]!.previousStatusId];
  for (const row of history) timeline.push(row.newStatusId);

  for (let index = timeline.length - 2; index >= 0; index -= 1) {
    const statusId = timeline[index];
    if (statusId === null || statusId === undefined) continue;

    const status = await findReferenceItem(trx, tenantId, statusId);
    if (status !== undefined && status.reportingCategory !== null &&
      OPEN_CATEGORIES.has(status.reportingCategory)) {
      return status.id;
    }
  }

  return null;
}

/** Resolves the tenant's reference item for a canonical lead status, or fails loudly. */
async function requireStatusByCanonicalKey(
  trx: DbExecutor,
  tenantId: TenantId,
  canonicalKey: string,
): Promise<ReferenceItemRecord> {
  const status = await findReferenceItemByCanonicalKey(trx, tenantId, 'lead_status', canonicalKey);
  if (status === undefined) {
    // A provisioning fault, not a user error: every tenant is seeded with the guarded statuses.
    // Throwing keeps the transaction from committing a lead into a status that does not exist.
    throw new Error(`The tenant's canonical '${canonicalKey}' lead status reference item is missing.`);
  }
  return status;
}

/**
 * THE ENGINE. Every operation — human or system — goes through exactly this path.
 *
 * Returns the lead id it acted on; the caller re-projects the detail DTO from committed state.
 */
export async function executeLeadOperation(
  deps: LeadWorkflowDeps,
  operation: LeadOperationName,
  leadId: number,
  actor: LeadWorkflowActor,
  mutate: Mutation,
): Promise<number> {
  // 1. Permission. The system actor (T-032's expiry job) is the only caller that skips this, and it
  //    is never reachable from an HTTP route — no route constructs an actor with isSystemActor.
  if (actor.isSystemActor !== true) {
    // `expire_automatic` has NO entry in the permission map, exactly as on the quote side: a human
    // caller cannot name an operation it has no permission for, so the lookup failing IS the
    // rejection. Widening the parameter to `LeadOperationName` (T-032 needs to pass the system-only
    // expiry through this same engine) makes that lookup partial, so it is checked rather than
    // trusted — otherwise `undefined` would flow into `access.has()` and quietly answer false for a
    // different reason.
    const required = LEAD_OPERATION_PERMISSIONS[operation as LeadOperation];
    if (required === undefined) {
      throw operationForbiddenError(String(operation));
    }
    if (actor.access === null || !actor.access.has(required)) {
      throw operationForbiddenError(required);
    }
  }

  const { tenantId } = actor;

  // Carried out of the transaction to key the post-commit alert re-evaluation (T-034). It is read
  // ONLY after `withTransaction` resolves — i.e. only after the row it names is durable.
  let statusHistoryId: number | null = null;

  await withTransaction(deps.db, async (trx) => {
    // 2. Existence, tenant-predicated: a foreign lead id simply does not resolve.
    const lead = await findLead(trx, tenantId, leadId);
    if (lead === undefined) throw leadNotFoundError(leadId);

    const currentStatus = await findReferenceItem(trx, tenantId, lead.statusId);

    // 3. Legality, from the matrix.
    if (
      !isLeadOperationLegal(
        operation,
        currentStatus?.canonicalKey ?? null,
        currentStatus?.reportingCategory ?? null,
      )
    ) {
      throw illegalTransitionError(
        operation,
        legalLeadOperations(
          currentStatus?.canonicalKey ?? null,
          currentStatus?.reportingCategory ?? null,
        ),
      );
    }

    const previousStatusId = lead.statusId;
    const now = new Date().toISOString();

    // 4. The operation's own side effects and validation. A throw here rolls back everything.
    const outcome = await mutate({
      trx,
      tenantId,
      lead,
      currentStatus: currentStatus!,
      actor,
      now,
    });

    // The target status, resolved from the matrix (or, for reopen, from history).
    let newStatusId = previousStatusId;
    if (operation === 'reopen') {
      const resolved = await resolveReopenTargetStatusId(trx, tenantId, leadId);
      if (resolved === null) throw noPriorOpenStatusError(leadId);
      newStatusId = resolved;
    } else {
      const targetKey = resolveFixedLeadTarget(operation, currentStatus?.canonicalKey ?? null);
      if (targetKey !== null) {
        newStatusId = (await requireStatusByCanonicalKey(trx, tenantId, targetKey)).id;
      }
    }

    await updateLeadWorkflowFields(
      trx,
      tenantId,
      leadId,
      { ...(outcome.fields ?? {}), statusId: newStatusId },
      now,
      actor.userId,
    );

    statusHistoryId = await appendStatusHistory(trx, tenantId, {
      leadId,
      operation,
      previousStatusId,
      newStatusId,
      actedBy: actor.userId,
      actedAt: now,
      inputs: outcome.inputs,
    });

    await writeAudit(trx, {
      entityType: 'lead',
      entityId: String(leadId),
      action: leadOperationAuditAction(operation),
      actorUserId: actor.userId,
      tenantId,
      before: { statusId: previousStatusId },
      after: { statusId: newStatusId, ...outcome.inputs },
      ...auditContext(actor),
    });
  });

  // AFTER the commit: alert re-evaluation must never observe a state that could still roll back.
  // The history row's id is the event key — `{leadId}:{statusHistoryId}` per AC-071 — so two
  // operations on one lead are two units of work while a redelivery of either is one.
  if (statusHistoryId !== null) {
    await deps.onLeadChanged?.(leadId, tenantId, {
      eventKey: String(statusHistoryId),
      ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
    });
  }

  return leadId;
}

// ---------------------------------------------------------------------------------------------
// The twelve operations. Each is a mutation body; the executor owns everything they have in common.
// ---------------------------------------------------------------------------------------------

/** The note-only transitions: start-information-gathering, start-pricing, start-negotiation. */
function noteOnly(input: OptionalNoteInput): Mutation {
  return () => Promise.resolve({ inputs: { note: input.note ?? null } });
}

export function startInformationGathering(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: OptionalNoteInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'start-information-gathering', leadId, actor, noteOnly(input));
}

export function startPricing(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: OptionalNoteInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'start-pricing', leadId, actor, noteOnly(input));
}

export function startNegotiation(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: OptionalNoteInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'start-negotiation', leadId, actor, noteOnly(input));
}

/**
 * Assign/Reassign (`AssignLeadCommandHandler`) — the single dialog contract over the fixed slots.
 *
 * Slot validation and assignee eligibility run INSIDE the transaction here, where the reference ran
 * them before opening one. That is deliberate: the reference's ordering let a slot be reconfigured
 * between the check and the write, and moving them inside costs nothing while closing that window.
 *
 * The accountable-owner rule is checked AFTER the assignment writes, not before, because it is a
 * rule about the RESULTING state: clearing the RM slot and setting it in the same request is legal,
 * and only the end state decides whether the lead still has an owner.
 */
export function assignLead(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: AssignLeadInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'assign', leadId, actor, async (context) => {
    const { trx, tenantId, now } = context;
    const slots = await listSlots(trx, tenantId);
    const slotsById = new Map(slots.map((slot) => [slot.assignmentId, slot]));

    for (const assignment of input.assignments) {
      const slot = slotsById.get(assignment.businessAssignmentId);
      if (slot === undefined) {
        throw workflowRuleError(
          `Business assignment ${assignment.businessAssignmentId} is not a configured assignment slot for this tenant.`,
        );
      }

      if (assignment.userId !== null) {
        const eligible = await isEligibleOwner(trx, tenantId, slot.roleId, assignment.userId);
        if (!eligible) throw invalidAssigneeError(assignment.userId);
      }
    }

    const changes: Record<string, unknown>[] = [];

    for (const assignment of input.assignments) {
      const existing = await findLeadAssignment(
        trx,
        tenantId,
        leadId,
        assignment.businessAssignmentId,
      );
      const previousUserId = existing?.userId ?? null;

      if (assignment.userId === null) {
        if (existing !== undefined) {
          await deleteLeadAssignment(trx, tenantId, leadId, assignment.businessAssignmentId);
        }
      } else if (existing === undefined) {
        await insertLeadAssignment(trx, tenantId, {
          leadId,
          businessAssignmentId: assignment.businessAssignmentId,
          userId: assignment.userId,
          actorUserId: actor.userId,
          now,
        });
      } else if (existing.userId !== assignment.userId) {
        await updateLeadAssignmentUser(
          trx,
          tenantId,
          existing.id,
          assignment.userId,
          now,
          actor.userId,
        );
      }

      // "Audited per changed role" (FR-35): only slots that actually MOVED are recorded, so the
      // history payload distinguishes a real reassignment from a no-op resubmission of the dialog.
      if (previousUserId !== assignment.userId) {
        changes.push({
          businessAssignmentId: assignment.businessAssignmentId,
          previousUserId,
          newUserId: assignment.userId,
        });
      }
    }

    const rmSlot = slots.find((slot) => slot.slot === 'rm');
    const fields: LeadWorkflowFields = {};

    if (rmSlot !== undefined) {
      const owner = await findLeadAssignment(trx, tenantId, leadId, rmSlot.assignmentId);
      if (owner === undefined) {
        throw workflowRuleError('The accountable owner role cannot be left unassigned.');
      }

      const state = await findLeadWorkflowState(trx, tenantId, leadId);
      // First assignment only: `date_assigned` is the SLA clock's start and must not restart on a
      // later reassignment, or every reassignment would silently reset the assignment SLA.
      if (state?.dateAssigned === null) {
        return {
          inputs: { assignments: input.assignments, comment: input.comment ?? null, roleChanges: changes },
          fields: { ...fields, dateAssigned: now },
        };
      }
    }

    return {
      inputs: { assignments: input.assignments, comment: input.comment ?? null, roleChanges: changes },
      fields,
    };
  });
}

/**
 * Send to underwriting (`SendToUnderwritingCommandHandler`).
 *
 * If the tenant has NOT configured an Underwriter slot the status transition still proceeds and no
 * assignment is touched — the reference's explicit choice (:20-24): PRD's primary requirement is the
 * transition, and a tenant that has not configured the slot should not be blocked from using the
 * workflow at all.
 */
export function sendToUnderwriting(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: SendToUnderwritingInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'send-to-underwriting', leadId, actor, async (context) => {
    const { trx, tenantId, now } = context;
    const underwriterSlot = (await listSlots(trx, tenantId)).find(
      (slot) => slot.slot === 'underwriter',
    );

    if (underwriterSlot !== undefined) {
      const eligible = await isEligibleOwner(
        trx,
        tenantId,
        underwriterSlot.roleId,
        input.underwritingOwnerUserId,
      );
      if (!eligible) throw invalidAssigneeError(input.underwritingOwnerUserId);

      const existing = await findLeadAssignment(
        trx,
        tenantId,
        leadId,
        underwriterSlot.assignmentId,
      );
      if (existing === undefined) {
        await insertLeadAssignment(trx, tenantId, {
          leadId,
          businessAssignmentId: underwriterSlot.assignmentId,
          userId: input.underwritingOwnerUserId,
          actorUserId: actor.userId,
          now,
        });
      } else {
        await updateLeadAssignmentUser(
          trx,
          tenantId,
          existing.id,
          input.underwritingOwnerUserId,
          now,
          actor.userId,
        );
      }
    }

    return {
      inputs: {
        underwritingOwnerUserId: input.underwritingOwnerUserId,
        note: input.note ?? null,
      },
    };
  });
}

/**
 * Request pricing approval (`RequestPricingApprovalCommandHandler`).
 *
 * The nominated approver must hold `pricing.approve` — PRD 10.4's "searchable dropdown of users with
 * the pricing-approval permission" is an authorization rule, not merely a UI filter, so it is
 * enforced here rather than trusted from the dropdown.
 *
 * A second request while one is Pending is REJECTED: PRD describes reject-then-re-request as the
 * rework loop and never two simultaneous pending requests, which would make "the pending approval"
 * ambiguous for both the approve path and the pending-approval alert.
 */
export function requestPricingApproval(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: RequestPricingApprovalInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'request-pricing-approval', leadId, actor, async (context) => {
    const { trx, tenantId, now } = context;

    const eligible = await listUsersHoldingPermission(trx, 'pricing.approve', tenantId, null);
    if (!eligible.some((user) => user.userId === input.approverUserId)) {
      throw approverNotEligibleError(input.approverUserId);
    }

    const state = await findLeadWorkflowState(trx, tenantId, leadId);
    if (state?.pricingApprovalState === 'pending') {
      throw workflowRuleError('A pricing-approval request is already pending for this lead.');
    }

    if (actor.userId === null) {
      // `pricing_approvals.requested_by` is NOT NULL: a request with no requester is not a request.
      throw workflowRuleError('A pricing-approval request requires an acting user.');
    }

    await insertPricingApproval(trx, tenantId, {
      leadId,
      requestedBy: actor.userId,
      requestedAt: now,
      approverId: input.approverUserId,
      proposedPremium: input.proposedPremium ?? null,
      requestNote: input.note ?? null,
    });

    return {
      inputs: {
        approverUserId: input.approverUserId,
        proposedPremium: input.proposedPremium ?? null,
        note: input.note ?? null,
      },
      fields: { pricingApprovalState: 'pending' },
    };
  });
}

/** Approve/reject pricing — the same decision write with a different terminal state. */
function decidePricing(
  operation: 'approve-pricing' | 'reject-pricing',
  state: 'approved' | 'rejected',
  decisionNote: string | null,
  rejectionReason: string | null,
): Mutation {
  return async (context) => {
    const { trx, tenantId, lead, actor, now } = context;

    const pending = await findPendingPricingApproval(trx, tenantId, lead.id);
    if (pending === undefined) throw noPendingPricingApprovalError(lead.id);

    const decided = await decidePricingApproval(trx, tenantId, {
      id: pending.id,
      state,
      decidedBy: actor.userId,
      decidedAt: now,
      decisionNote,
      rejectionReason,
    });
    // Lost the compare-and-set race: another caller decided this request first. Answering the same
    // "no pending request" the second caller would have got had it arrived a moment later.
    if (!decided) throw noPendingPricingApprovalError(lead.id);

    return {
      inputs: {
        operation,
        approverUserId: pending.approverId,
        note: decisionNote,
        rejectionReason,
      },
      fields: { pricingApprovalState: state },
    };
  };
}

export function approvePricing(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: OptionalNoteInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(
    deps,
    'approve-pricing',
    leadId,
    actor,
    decidePricing('approve-pricing', 'approved', input.note ?? null, null),
  );
}

export function rejectPricing(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: RejectPricingInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(
    deps,
    'reject-pricing',
    leadId,
    actor,
    decidePricing('reject-pricing', 'rejected', null, input.rejectionReason),
  );
}

/**
 * Log follow-up (`LogFollowUpCommandHandler`).
 *
 * The "next follow-up required, and in the future" rule applies ONLY while the lead's reporting
 * category is `quoted` — i.e. open past Quote Sent (AC-051). It cannot live in the schema because
 * it depends on the lead's current status, and it is checked against TODAY rather than the request
 * timestamp so a follow-up scheduled for later today is correctly rejected as not-in-the-future.
 */
export function logFollowUp(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: LogFollowUpInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'log-follow-up', leadId, actor, async (context) => {
    const { trx, tenantId, currentStatus, now } = context;
    const today = now.slice(0, 10);
    const followUpDate = input.followUpDate ?? today;
    const nextFollowUpDate = input.nextFollowUpDate ?? null;

    if (currentStatus.reportingCategory === 'quoted') {
      if (nextFollowUpDate === null) {
        throw workflowRuleError(
          'A next follow-up date is required while the lead is open past Quote Sent.',
        );
      }
      if (nextFollowUpDate <= today) {
        throw workflowRuleError(
          'The next follow-up date must be in the future while the lead is open past Quote Sent.',
        );
      }
    }

    await insertFollowUp(trx, tenantId, {
      leadId,
      followUpDate,
      outcomeNote: input.outcomeNote,
      nextFollowUpDate,
      loggedBy: actor.userId,
      loggedAt: now,
    });

    return {
      inputs: { followUpDate, outcomeNote: input.outcomeNote, nextFollowUpDate },
      fields: {
        lastFollowUpDate: followUpDate,
        nextFollowUpDate,
        followUpCountIncrement: 1,
      },
    };
  });
}

/**
 * `QuoteCascadeService.CascadeAsync` — every OPEN quote of the lead moves to the target status,
 * each with its own history row and audit entry.
 *
 * A ONE-WAY cascade with no path back into lead mutation: a quote moved by this function never
 * re-triggers a lead closure (only an explicit user-invoked quote operation does that), so there is
 * no recursion to guard against.
 */
async function cascadeOpenQuotes(
  context: OperationContext,
  targetCanonicalKey: string,
  operationCode: string,
  withdrawalNote: string | null,
): Promise<number[]> {
  const { trx, tenantId, lead, actor, now } = context;

  const openQuotes = await listOpenQuotesForLead(trx, tenantId, lead.id);
  if (openQuotes.length === 0) return [];

  const targetStatus = await findReferenceItemByCanonicalKey(
    trx,
    tenantId,
    'quote_status',
    targetCanonicalKey,
  );
  if (targetStatus === undefined) {
    throw new Error(
      `The tenant's canonical '${targetCanonicalKey}' quote status reference item is missing.`,
    );
  }

  for (const quote of openQuotes) {
    await applyQuoteCascade(trx, tenantId, {
      quoteId: quote.id,
      statusId: targetStatus.id,
      withdrawalNote,
      now,
      actorUserId: actor.userId,
    });

    await appendQuoteStatusHistory(trx, tenantId, {
      quoteId: quote.id,
      operation: operationCode,
      previousStatusId: quote.statusId,
      newStatusId: targetStatus.id,
      actedBy: actor.userId,
      actedAt: now,
      inputs: { leadId: lead.id },
    });

    await writeAudit(trx, {
      entityType: 'quote',
      entityId: String(quote.id),
      action: `quote.${operationCode}`,
      actorUserId: actor.userId,
      tenantId,
      before: { statusId: quote.statusId },
      after: { statusId: targetStatus.id, leadId: lead.id },
      ...auditContext(actor),
    });
  }

  return openQuotes.map((quote) => quote.id);
}

/**
 * Mark lost (`MarkLeadLostCommandHandler`).
 *
 * `lostBeforeQuote` is computed from whether the lead EVER reached a `quoted`-category status —
 * current status first, then its history. The reference inferred it this way because quotes did not
 * exist yet and left a note to replace it with a direct "any quote was ever sent" check; the
 * inference is kept because it is still the correct answer for a lead that reached Quote Sent and
 * had its quote deleted, and because PRD 7.3's split is defined over the LEAD's lifecycle.
 */
export function markLeadLost(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: MarkLeadLostInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'mark-lost', leadId, actor, async (context) => {
    const { trx, tenantId, currentStatus, now } = context;

    const lostReason = await findActiveReferenceItem(
      trx,
      tenantId,
      input.lostReasonId,
      'lost_reason',
    );
    if (lostReason === undefined) throw invalidLostReasonError(input.lostReasonId);

    if (
      lostReason.canonicalKey === OTHER_LOST_REASON_KEY &&
      (input.lossComments ?? '').trim() === ''
    ) {
      throw workflowRuleError("Loss comments are required when the lost reason is 'Other'.");
    }

    let quoteWasEverSent = currentStatus.reportingCategory === 'quoted';
    if (!quoteWasEverSent) {
      for (const row of await listStatusHistory(trx, tenantId, leadId)) {
        if (row.newStatusId === null) continue;
        const status = await findReferenceItem(trx, tenantId, row.newStatusId);
        if (status?.reportingCategory === 'quoted') {
          quoteWasEverSent = true;
          break;
        }
      }
    }

    const cascadedQuoteIds = await cascadeOpenQuotes(
      context,
      QUOTE_LOST_KEY,
      LEAD_LOST_CASCADE_OPERATION,
      null,
    );

    return {
      inputs: {
        lostReasonId: input.lostReasonId,
        competitor: input.competitor ?? null,
        competitorPremium: input.competitorPremium ?? null,
        lossComments: input.lossComments ?? null,
        lostBeforeQuote: !quoteWasEverSent,
        cascadedQuoteIds,
      },
      fields: {
        lostReasonId: input.lostReasonId,
        competitor: input.competitor ?? null,
        competitorPremium: input.competitorPremium ?? null,
        lossComments: input.lossComments ?? null,
        decisionDate: now,
        lostBeforeQuote: !quoteWasEverSent,
      },
    };
  });
}

/** Withdraw (`WithdrawLeadCommandHandler`) — closes the lead and cascades its open quotes. */
export function withdrawLead(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: WithdrawLeadInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'withdraw', leadId, actor, async (context) => {
    const cascadedQuoteIds = await cascadeOpenQuotes(
      context,
      QUOTE_WITHDRAWN_KEY,
      LEAD_WITHDRAWN_CASCADE_OPERATION,
      'Automatically withdrawn: the lead was withdrawn.',
    );

    return {
      inputs: { withdrawalNote: input.withdrawalNote, cascadedQuoteIds },
      fields: { withdrawalNote: input.withdrawalNote, decisionDate: context.now },
    };
  });
}

/**
 * Reopen (`ReopenLeadCommandHandler`) — records the reason; the TARGET comes from history, resolved
 * by the executor, because "the last open status" is not a function of the current status alone.
 */
export function reopenLead(
  deps: LeadWorkflowDeps,
  leadId: number,
  input: ReopenLeadInput,
  actor: LeadWorkflowActor,
): Promise<number> {
  return executeLeadOperation(deps, 'reopen', leadId, actor, () =>
    Promise.resolve({ inputs: { reopenReason: input.reopenReason } }),
  );
}
