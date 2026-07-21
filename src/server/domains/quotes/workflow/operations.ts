/**
 * The quote workflow engine (T-026; AC-024, AC-049, AC-050, AC-053..AC-055, AC-096;
 * V-063, V-064, V-068, V-069).
 *
 * Ports `QuoteOperationExecutor`, `QuoteLeadCascade` and the seven `*CommandHandler`s under
 * `Features/Quotes/**`, collapsed into one executor and seven mutation functions for the same
 * reason the lead side is: in TypeScript the C# command/handler/validator triple is pure ceremony,
 * and the only thing that actually varies between operations is the mutation body.
 *
 * ONE TRANSACTION PER OPERATION, AND THE AUDIT ROW IS INSIDE IT
 * ============================================================
 * The reference wrote its audit entry through a separate `IAuditWriter` after the save, so a crash
 * in between produced a status change with no audit trail. Here the quote mutation, every cascaded
 * sibling, the lead transition, both history tables and the `audit_log` rows share ONE transaction.
 * That is strictly stronger than the reference — and for this task it is also what makes AC-049's
 * "nothing persists" literally true: the pricing gate throws from inside the mutation, so the
 * rollback removes the quote change, the history row and the audit row together.
 *
 * THE ORDER OF CHECKS IS LOAD-BEARING, NOT INCIDENTAL
 * ==================================================
 *   1. permission   (403) — before anything is read, so a caller who may not act learns nothing
 *   2. existence    (404) — tenant-predicated, so a foreign id is indistinguishable from a missing one
 *   3. legality     (409) — with the legal-operation hint
 *   4. input rules  (422) — the operation's own validation, inside the transaction
 *
 * Swapping 1 and 2 would turn the 404 into a cross-tenant existence oracle for callers lacking the
 * permission; swapping 3 and 4 would let a caller probe a quote's validation rules — including the
 * tenant's high-value threshold, by binary search on the premium — from a status the operation is
 * not even legal from.
 *
 * QUOTE HISTORY USES THE LEAD SIDE'S `appendQuoteStatusHistory`, DELIBERATELY
 * =========================================================================
 * `leads/workflow/history.ts` already owns `appendQuoteStatusHistory` (the lead-lost/withdrawn
 * cascade writes quote history rows). This module IMPORTS it rather than defining a second
 * quote-history writer. Two append functions for one append-only table would be free to drift in
 * column set, ordering key or timestamp handling, and any fix to the shared pattern would have to
 * be applied twice and would silently be applied once.
 *
 * WHY THE LEAD CASCADES DO NOT CALL `executeLeadOperation`
 * =======================================================
 * `QuoteLeadCascade`'s header gives the reference's reason (nested transactions are impossible on
 * one connection) and the authorization reason, which is the one that still applies here: these are
 * SYSTEM-CASCADED side effects of an already-authorized quote operation, not second user-invoked
 * operations. The caller needs the quote operation's permission (e.g. `quotes.close_won`), never a
 * lead permission — and `leads.close` deliberately has no Closed Won target at all (FR-39: Closed
 * Won is reachable ONLY through quote-level mark-won). Routing the cascade through the lead
 * executor would therefore not merely be awkward; there is no lead operation for it to run.
 */
import { writeAudit } from '../../audit/index.js';
import { listSlots } from '../../assignments/repository.js';
import { findSettings } from '../../business-rules/repository.js';
import {
  findActiveReferenceItem,
  findLead,
  findReferenceItem,
  findReferenceItemByCanonicalKey,
  isEligibleOwner,
  stampLeadActivity,
  type ReferenceItemRecord,
} from '../../leads/repository.js';
import {
  appendQuoteStatusHistory,
  appendStatusHistory,
  insertFollowUp,
  findLeadWorkflowState,
  updateLeadWorkflowFields,
} from '../../leads/workflow/history.js';
import type { LeadChangedListener } from '../../leads/workflow/operations.js';
import type { EffectiveAccess } from '../../rbac/effective-permissions.js';
import { withTransaction, type DbClient, type DbExecutor, type TenantId } from '../../../lib/db/index.js';
import {
  invalidQuoteAssigneeError,
  invalidQuoteLostReasonError,
  pricingApprovalRequiredError,
  quoteIllegalTransitionError,
  quoteLeadNotFoundError,
  quoteNotFoundError,
  quoteOperationForbiddenError,
  quoteWorkflowRuleError,
} from '../errors.js';
import {
  demoteCurrentQuoteVersion,
  demoteOtherCurrentQuotes,
  deleteQuoteAssignment,
  findCurrentQuoteVersion,
  findQuote,
  findQuoteAssignment,
  insertQuoteAssignment,
  insertQuoteVersion,
  isCurrentVersionPremiumAbove,
  listOtherOpenQuotes,
  updateQuoteAssignmentUser,
  updateQuoteFields,
  type QuoteRecord,
  type QuoteWriteFields,
} from '../repository.js';
import {
  QUOTE_OPERATION_PERMISSIONS,
  QUOTE_STATUS_KEYS,
  isQuoteOperationLegal,
  legalQuoteOperations,
  resolveFixedQuoteTarget,
  type QuoteOperation,
  type QuoteOperationName,
} from './legality.js';
import type {
  AssignQuoteInput,
  MarkQuoteLostInput,
  MarkQuoteWonInput,
  ReviseQuoteInput,
  SendQuoteInput,
  SetCurrentQuoteInput,
  WithdrawQuoteInput,
} from '../schemas.js';

/** The audit action prefix: `quote.send`, `quote.mark-won`, ... (`$"quote.{operation.ToCodeValue()}"`). */
export function quoteOperationAuditAction(operation: QuoteOperationName): string {
  return `quote.${operation}`;
}

/** The lost-reason canonical key that makes a free-text comment mandatory (shared with the lead side). */
const OTHER_LOST_REASON_KEY = 'other';

/** The lead-side cascade operation codes (`QuoteLeadCascade` :38-41). */
const LEAD_START_PRICING_CASCADE = 'start-pricing';
const LEAD_QUOTE_SENT_CASCADE = 'quote-sent-first-send';
const LEAD_QUOTE_WON_CASCADE = 'quote-won';
const LEAD_QUOTE_LOST_CASCADE = 'quote-lost-after-quote';

/** `MarkQuoteWonCascadeOperationCodes.SiblingWithdrawn` (:140-143). */
const SIBLING_WITHDRAWN_OPERATION = 'withdraw-sibling-of-won';

/** The lead statuses the cascades target. */
const LEAD_PRICING_KEY = 'pricing';
const LEAD_QUOTE_SENT_KEY = 'quote_sent';
const LEAD_CLOSED_WON_KEY = 'closed_won';
const LEAD_CLOSED_LOST_KEY = 'closed_lost';

export interface QuoteWorkflowDeps {
  readonly db: DbClient;
  /**
   * The alert re-evaluation seam (T-034).
   *
   * `QuoteOperationExecutor` enqueued `IAlertReevaluationQueue.EnqueueLeadReevaluationAsync(quote.LeadId)`
   * here — note it re-evaluates the LEAD, because a quote operation always affects its parent lead.
   * An OPTIONAL callback rather than a required dependency so this task ships without the alerts
   * domain existing, and invoked AFTER the transaction commits: enqueuing work for a state that may
   * still roll back is how duplicate and phantom alerts get created.
   */
  readonly onLeadChanged?: LeadChangedListener;
}

/**
 * Who is acting.
 *
 * `access` is null ONLY for the system actor (`ICurrentUser.IsSystemActor`): the T-032 quote-expiry
 * job has no user and no grants, and is the single sanctioned caller that skips the permission
 * check. Every human path carries a resolved `EffectiveAccess`, and routes.ts fails CLOSED with a
 * 500 rather than constructing an actor without one — so "no access" can never silently mean "allow
 * everything" for a request that merely forgot to resolve it.
 */
export interface QuoteWorkflowActor {
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
  readonly quote: QuoteRecord;
  readonly currentStatus: ReferenceItemRecord;
  readonly actor: QuoteWorkflowActor;
  readonly now: string;
  /** `DateOnly.FromDateTime(DateTimeOffset.UtcNow.Date)` — today, UTC. */
  readonly today: string;
}

/**
 * What a mutation returns: the payload recorded in `quote_status_history.inputs` and the audit row,
 * plus any quote-column changes for the executor to apply alongside the status transition.
 *
 * Mutations do NOT write `status_id` themselves — the executor resolves and applies it from the
 * matrix afterwards. That separation keeps "which status does this operation land on" a property of
 * the matrix (unit-testable, exhaustively) rather than something re-decided in seven mutation bodies.
 */
interface OperationOutcome {
  readonly inputs: Record<string, unknown>;
  readonly fields?: QuoteWriteFields;
}

type Mutation = (context: OperationContext) => Promise<OperationOutcome>;

function auditContext(actor: QuoteWorkflowActor): { correlationId?: string } {
  return actor.correlationId === undefined ? {} : { correlationId: actor.correlationId };
}

/** Resolves the tenant's reference item for a canonical key, or fails loudly. */
async function requireStatusByCanonicalKey(
  trx: DbExecutor,
  tenantId: TenantId,
  listType: string,
  canonicalKey: string,
): Promise<ReferenceItemRecord> {
  const status = await findReferenceItemByCanonicalKey(trx, tenantId, listType, canonicalKey);
  if (status === undefined) {
    // A provisioning fault, not a user error: every tenant is seeded with the guarded statuses.
    // Throwing keeps the transaction from committing a record into a status that does not exist.
    throw new Error(`The tenant's canonical '${canonicalKey}' ${listType} reference item is missing.`);
  }
  return status;
}

/**
 * `QuoteLeadCascade.TransitionLeadAsync` (:96-125) — moves the LEAD, stamps its activity, appends
 * its history row and writes its audit entry, all on the caller's already-open transaction.
 *
 * No permission check of its own, deliberately: see this file's header.
 */
async function transitionLead(
  context: OperationContext,
  leadId: number,
  targetCanonicalKey: string,
  operationCode: string,
  inputs: Record<string, unknown>,
  extraFields: Parameters<typeof updateLeadWorkflowFields>[3] = {},
): Promise<void> {
  const { trx, tenantId, actor, now } = context;

  const lead = await findLead(trx, tenantId, leadId);
  if (lead === undefined) throw quoteLeadNotFoundError(leadId);

  const targetStatus = await requireStatusByCanonicalKey(
    trx,
    tenantId,
    'lead_status',
    targetCanonicalKey,
  );

  const previousStatusId = lead.statusId;

  // `updateLeadWorkflowFields` stamps `last_activity_at` as part of the same statement — the
  // reference's `LeadActivityStamper.Stamp(lead)` immediately before `SaveChangesAsync`.
  await updateLeadWorkflowFields(
    trx,
    tenantId,
    leadId,
    { ...extraFields, statusId: targetStatus.id },
    now,
    actor.userId,
  );

  await appendStatusHistory(trx, tenantId, {
    leadId,
    operation: operationCode,
    previousStatusId,
    newStatusId: targetStatus.id,
    actedBy: actor.userId,
    actedAt: now,
    inputs,
  });

  await writeAudit(trx, {
    entityType: 'lead',
    entityId: String(leadId),
    action: `lead.${operationCode}`,
    actorUserId: actor.userId,
    tenantId,
    before: { statusId: previousStatusId },
    after: { statusId: targetStatus.id, ...inputs },
    ...auditContext(actor),
  });
}

/**
 * THE ENGINE. Every quote operation — human or system — goes through exactly this path.
 *
 * Returns the quote id it acted on; the caller re-projects the detail DTO from committed state,
 * exactly as the reference re-ran `GetQuoteQuery` before returning.
 */
export async function executeQuoteOperation(
  deps: QuoteWorkflowDeps,
  operation: QuoteOperationName,
  quoteId: number,
  actor: QuoteWorkflowActor,
  mutate: Mutation,
): Promise<number> {
  // 1. Permission. The system actor (T-032's quote-expiry job) is the only caller that skips this,
  //    and it is never reachable from an HTTP route — no route constructs an actor with
  //    isSystemActor. The automatic expiry has no entry in the permission map at all, so a human
  //    caller could not name it even if a route existed.
  if (actor.isSystemActor !== true) {
    const required = QUOTE_OPERATION_PERMISSIONS[operation as QuoteOperation];
    if (required === undefined) {
      throw quoteOperationForbiddenError(String(operation));
    }
    if (actor.access === null || !actor.access.has(required)) {
      throw quoteOperationForbiddenError(required);
    }
  }

  const { tenantId } = actor;

  // Carried out of the transaction to key the post-commit alert re-evaluation (T-034). Read only
  // after `withTransaction` resolves, i.e. only once the row it names is durable.
  let quoteHistoryId: number | null = null;

  await withTransaction(deps.db, async (trx) => {
    // 2. Existence, tenant-predicated: a foreign quote id simply does not resolve.
    const quote = await findQuote(trx, tenantId, quoteId);
    if (quote === undefined) throw quoteNotFoundError(quoteId);

    const currentStatus = await findReferenceItem(trx, tenantId, quote.statusId);

    // 3. Legality, from the matrix.
    if (!isQuoteOperationLegal(operation, currentStatus?.canonicalKey ?? null)) {
      throw quoteIllegalTransitionError(
        operation,
        legalQuoteOperations(currentStatus?.canonicalKey ?? null),
      );
    }

    const previousStatusId = quote.statusId;
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // 4. The operation's own side effects and validation. A throw here rolls back everything.
    const outcome = await mutate({
      trx,
      tenantId,
      quote,
      currentStatus: currentStatus!,
      actor,
      now,
      today,
    });

    // The target status, resolved from the matrix.
    let newStatusId = previousStatusId;
    const targetKey = resolveFixedQuoteTarget(operation);
    if (targetKey !== null) {
      newStatusId = (await requireStatusByCanonicalKey(trx, tenantId, 'quote_status', targetKey)).id;
    }

    await updateQuoteFields(
      trx,
      tenantId,
      quoteId,
      { ...(outcome.fields ?? {}), statusId: newStatusId },
      now,
      actor.userId,
    );

    // "Quote activity always counts as lead activity" (`QuoteOperationExecutor` :142-146) —
    // UNCONDITIONAL, not folded into the lead cascades, because Assign/Revise/Withdraw/SetCurrent
    // never change the lead's status yet must still keep it from looking inactive to the T-032
    // inactivity sweep and the stalled-lead alert rules.
    await stampLeadActivity(trx, tenantId, quote.leadId, now, actor.userId);

    quoteHistoryId = await appendQuoteStatusHistory(trx, tenantId, {
      quoteId,
      operation,
      previousStatusId,
      newStatusId,
      actedBy: actor.userId,
      actedAt: now,
      inputs: outcome.inputs,
    });

    await writeAudit(trx, {
      entityType: 'quote',
      entityId: String(quoteId),
      action: quoteOperationAuditAction(operation),
      actorUserId: actor.userId,
      tenantId,
      before: { statusId: previousStatusId },
      after: { statusId: newStatusId, ...outcome.inputs },
      ...auditContext(actor),
    });
  });

  // AFTER the commit: alert re-evaluation must never observe a state that could still roll back.
  // The LEAD is what gets re-evaluated — a quote operation always affects its parent lead.
  // `qsh:` NAMESPACES the quote-side event key. `quote_status_history.id` and
  // `lead_status_history.id` are two independent sequences, so an unprefixed id from one would
  // eventually collide with the other on the same lead — and a collision here does not duplicate
  // work, it SILENTLY DROPS the second re-evaluation.
  const quote = await findQuote(deps.db, tenantId, quoteId);
  if (quote !== undefined && quoteHistoryId !== null) {
    await deps.onLeadChanged?.(quote.leadId, tenantId, {
      eventKey: `qsh:${String(quoteHistoryId)}`,
      ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
    });
  }

  return quoteId;
}

// ---------------------------------------------------------------------------------------------
// The seven operations. Each is a mutation body; the executor owns everything they have in common.
// ---------------------------------------------------------------------------------------------

/**
 * Assign/Reassign (`AssignQuoteCommandHandler`) — the single dialog contract over the fixed slots.
 *
 * Slot validation and assignee eligibility run INSIDE the transaction here, where the reference ran
 * them before opening one: the reference's ordering let a slot be reconfigured between the check
 * and the write, and moving them inside costs nothing while closing that window.
 *
 * There is deliberately NO accountable-owner rule — the reference states outright that "quotes have
 * no accountable-owner requirement (that is a lead-level concept)", so clearing every slot on a
 * quote is legal where the same request on a lead is rejected.
 */
export function assignQuote(
  deps: QuoteWorkflowDeps,
  quoteId: number,
  input: AssignQuoteInput,
  actor: QuoteWorkflowActor,
): Promise<number> {
  return executeQuoteOperation(deps, 'assign', quoteId, actor, async (context) => {
    const { trx, tenantId, quote, now } = context;
    const slots = await listSlots(trx, tenantId);
    const slotsById = new Map(slots.map((slot) => [slot.assignmentId, slot]));

    for (const assignment of input.assignments) {
      const slot = slotsById.get(assignment.businessAssignmentId);
      if (slot === undefined) {
        throw quoteWorkflowRuleError(
          `Business assignment ${assignment.businessAssignmentId} is not a configured assignment slot for this tenant.`,
        );
      }

      if (assignment.userId !== null) {
        const eligible = await isEligibleOwner(trx, tenantId, slot.roleId, assignment.userId);
        if (!eligible) throw invalidQuoteAssigneeError(assignment.userId);
      }
    }

    const changes: Record<string, unknown>[] = [];

    for (const assignment of input.assignments) {
      const existing = await findQuoteAssignment(
        trx,
        tenantId,
        quote.id,
        assignment.businessAssignmentId,
      );
      const previousUserId = existing?.userId ?? null;

      if (assignment.userId === null) {
        if (existing !== undefined) {
          await deleteQuoteAssignment(trx, tenantId, quote.id, assignment.businessAssignmentId);
        }
      } else if (existing === undefined) {
        await insertQuoteAssignment(trx, tenantId, {
          quoteId: quote.id,
          businessAssignmentId: assignment.businessAssignmentId,
          userId: assignment.userId,
          actorUserId: actor.userId,
          now,
        });
      } else if (existing.userId !== assignment.userId) {
        await updateQuoteAssignmentUser(trx, tenantId, existing.id, assignment.userId, now, actor.userId);
      }

      // Only slots that actually MOVED are recorded, so the history payload distinguishes a real
      // reassignment from a no-op resubmission of the dialog.
      if (previousUserId !== assignment.userId) {
        changes.push({
          businessAssignmentId: assignment.businessAssignmentId,
          previousUserId,
          newUserId: assignment.userId,
        });
      }
    }

    return {
      inputs: {
        assignments: input.assignments,
        comment: input.comment ?? null,
        roleChanges: changes,
      },
    };
  });
}

/**
 * Send quote (`SendQuoteCommandHandler`) — and the AC-049 high-value pricing gate.
 *
 * THE GATE, MEASURED FROM `SendQuoteCommandHandler.cs:85-91`
 * =========================================================
 * All FOUR conjuncts are required, and each one matters:
 *
 *   settings.RequirePricingApprovalForHighValue   the tenant switch is on
 *   && settings.HighValueThreshold is not null    a threshold is actually configured
 *   && currentVersion is not null                 a version-less quote PASSES the gate, not trips it
 *   && currentVersion.QuotedPremium > threshold   STRICTLY greater — equal to the threshold passes
 *   && lead.PricingApprovalState != Approved      approval is on the LEAD, not the quote
 *
 * It reads the CURRENT QUOTE VERSION's premium — not the lead's estimated premium, not the quote's
 * bound premium. It answers **422 PRICING_APPROVAL_REQUIRED** and NOTHING PERSISTS, which is true
 * here because the throw happens inside the executor's transaction, before any write in this
 * mutation. The comparison is done in SQL against `numeric` (`isCurrentVersionPremiumAbove`) so no
 * premium is routed through an IEEE double to decide it.
 *
 * The gate is checked BEFORE any field is written, so its "nothing persists" guarantee does not
 * depend on rollback alone — though rollback would cover it anyway.
 *
 * THE FIRST SEND MOVES THE LEAD, SUBSEQUENT SENDS DO NOT
 * =====================================================
 * "First" is inferred from the lead's reporting category not yet being `quoted`, exactly as the
 * reference infers it (:98): a prior successful send always leaves the lead at a Quoted-category
 * status, so the inference is sound and needs no extra column.
 */
export function sendQuote(
  deps: QuoteWorkflowDeps,
  quoteId: number,
  input: SendQuoteInput,
  actor: QuoteWorkflowActor,
): Promise<number> {
  return executeQuoteOperation(deps, 'send', quoteId, actor, async (context) => {
    const { trx, tenantId, quote, actor: acting, now, today } = context;

    const sentDate = input.sentDate ?? today;
    const validUntil = input.validUntil;
    const nextFollowUpDate = input.nextFollowUpDate;

    // Checked here rather than in the schema because `sentDate` defaults to TODAY, which is a
    // property of the server clock at execution time, not of the body.
    if (validUntil <= sentDate) {
      throw quoteWorkflowRuleError('Valid-until must be after the sent date.');
    }

    const lead = await findLead(trx, tenantId, quote.leadId);
    if (lead === undefined) throw quoteLeadNotFoundError(quote.leadId);

    // --- The high-value pricing gate (AC-049 / V-063). Nothing has been written yet. ---
    const settings = await findSettings(trx, tenantId);
    if (
      settings !== undefined &&
      settings.requirePricingApprovalForHighValue &&
      settings.highValueThreshold !== null
    ) {
      const state = await findLeadWorkflowState(trx, tenantId, quote.leadId);
      if (state?.pricingApprovalState !== 'approved') {
        const aboveThreshold = await isCurrentVersionPremiumAbove(
          trx,
          tenantId,
          quote.id,
          String(settings.highValueThreshold),
        );
        if (aboveThreshold) throw pricingApprovalRequiredError(quote.leadId);
      }
    }

    const leadStatus = await findReferenceItem(trx, tenantId, lead.statusId);
    const isFirstSend = leadStatus?.reportingCategory !== 'quoted';

    // The reference writes the lead's follow-up bookkeeping directly here rather than going through
    // the lead's own Log follow-up operation — Send IS the follow-up event for the lead.
    await insertFollowUp(trx, tenantId, {
      leadId: lead.id,
      followUpDate: today,
      outcomeNote: `Quote ${quote.quoteRef} sent.`,
      nextFollowUpDate,
      loggedBy: acting.userId,
      loggedAt: now,
    });

    await updateLeadWorkflowFields(
      trx,
      tenantId,
      lead.id,
      {
        lastFollowUpDate: today,
        nextFollowUpDate,
        followUpCountIncrement: 1,
      },
      now,
      acting.userId,
    );

    if (isFirstSend) {
      await transitionLead(context, lead.id, LEAD_QUOTE_SENT_KEY, LEAD_QUOTE_SENT_CASCADE, {});
    }

    return {
      inputs: { sentDate, validUntil, nextFollowUpDate, isFirstSend },
      fields: { sentDate, validUntil },
    };
  });
}

/**
 * Revise quote (`ReviseQuoteCommandHandler`) — inserts version_no + 1 marked current, demotes the
 * prior current version, and moves the quote to Revised.
 *
 * The demote happens BEFORE the insert and that ordering is now load-bearing rather than merely
 * tidy: `uq_quote_versions_current` (T-005) makes two current versions physically impossible, so
 * inserting first would fail the index instead of producing a wrong-but-committed second current
 * row. Omitted fields inherit from the prior version, so a terms-only revision keeps the premium
 * and a premium-only revision keeps the terms.
 */
export function reviseQuote(
  deps: QuoteWorkflowDeps,
  quoteId: number,
  input: ReviseQuoteInput,
  actor: QuoteWorkflowActor,
): Promise<number> {
  return executeQuoteOperation(deps, 'revise', quoteId, actor, async (context) => {
    const { trx, tenantId, quote, actor: acting, now } = context;

    const priorCurrent = await findCurrentQuoteVersion(trx, tenantId, quote.id);
    if (priorCurrent === undefined) {
      throw quoteWorkflowRuleError(`Quote ${quote.id} has no current version to revise.`);
    }

    await demoteCurrentQuoteVersion(trx, tenantId, quote.id);

    const quotedPremium = input.newQuotedPremium ?? priorCurrent.quotedPremium;
    const termsNotes = input.termsNotes ?? priorCurrent.termsNotes;
    const versionNo = priorCurrent.versionNo + 1;

    await insertQuoteVersion(trx, tenantId, {
      quoteId: quote.id,
      versionNo,
      quotedPremium,
      termsNotes,
      revisionNote: input.revisionNote,
      isCurrent: true,
      createdAt: now,
      createdBy: acting.userId,
    });

    return {
      inputs: {
        newVersionNo: versionNo,
        quotedPremium,
        termsNotes,
        revisionNote: input.revisionNote,
      },
    };
  });
}

/**
 * Mark won (`MarkQuoteWonCommandHandler`) — FR-39's ONLY path to a lead's Closed Won.
 *
 * Both inputs are OPTIONAL and default (`boundPremium` from the current version's quoted premium,
 * `decisionDate` from today), which is measured behaviour and NOT what AC-054 describes; the
 * divergence is recorded in the task file rather than silently resolved.
 *
 * A quote with no current version and no explicit bound premium is a genuine data fault, not a user
 * error — the reference throws there, and so does this (a 500, not a 422), because there is nothing
 * the caller could have sent to fix it.
 */
export function markQuoteWon(
  deps: QuoteWorkflowDeps,
  quoteId: number,
  input: MarkQuoteWonInput,
  actor: QuoteWorkflowActor,
): Promise<number> {
  return executeQuoteOperation(deps, 'mark-won', quoteId, actor, async (context) => {
    const { trx, tenantId, quote, actor: acting, now, today } = context;

    const decisionDate = `${input.decisionDate ?? today}T00:00:00.000Z`;

    const currentVersion = await findCurrentQuoteVersion(trx, tenantId, quote.id);
    const boundPremium = input.boundPremium ?? currentVersion?.quotedPremium ?? null;
    if (boundPremium === null) {
      throw new Error(
        `Quote ${quote.id} has no current version to default the bound premium from.`,
      );
    }

    await transitionLead(context, quote.leadId, LEAD_CLOSED_WON_KEY, LEAD_QUOTE_WON_CASCADE, {
      boundPremium,
      decisionDate,
    }, { decisionDate });

    // "other open quotes -> Withdrawn" (FR-38): each sibling gets its OWN history row and audit
    // entry, so the cascade is auditable per quote rather than only as a footnote on the winner.
    const siblings = await listOtherOpenQuotes(trx, tenantId, quote.leadId, quote.id);
    const siblingsWithdrawn: number[] = [];

    if (siblings.length > 0) {
      const withdrawnStatus = await requireStatusByCanonicalKey(
        trx,
        tenantId,
        'quote_status',
        QUOTE_STATUS_KEYS.withdrawn,
      );

      for (const sibling of siblings) {
        await updateQuoteFields(
          trx,
          tenantId,
          sibling.id,
          {
            statusId: withdrawnStatus.id,
            withdrawalNote: 'Automatically withdrawn: another quote on this lead was marked won.',
          },
          now,
          acting.userId,
        );

        await appendQuoteStatusHistory(trx, tenantId, {
          quoteId: sibling.id,
          operation: SIBLING_WITHDRAWN_OPERATION,
          previousStatusId: sibling.statusId,
          newStatusId: withdrawnStatus.id,
          actedBy: acting.userId,
          actedAt: now,
          inputs: { wonQuoteId: quote.id },
        });

        await writeAudit(trx, {
          entityType: 'quote',
          entityId: String(sibling.id),
          action: 'quote.withdrawn_sibling_of_won',
          actorUserId: acting.userId,
          tenantId,
          before: { statusId: sibling.statusId },
          after: { statusId: withdrawnStatus.id, wonQuoteId: quote.id },
          ...auditContext(acting),
        });

        siblingsWithdrawn.push(sibling.id);
      }
    }

    return {
      inputs: { boundPremium, decisionDate, siblingsWithdrawn },
      fields: { boundPremium, decisionDate },
    };
  });
}

/**
 * Mark lost (`MarkQuoteLostCommandHandler`).
 *
 * `alsoCloseLead` null means "compute the default" — true when no other open quote remains on the
 * lead. An explicit `true` still does NOT close the lead while another open quote remains: the
 * reference guards with `alsoCloseLead && noOtherOpenQuoteRemains` (:79), so the flag can only ever
 * SUPPRESS the close, never force one that would strand an open quote under a closed lead.
 *
 * The lead is recorded as "lost AFTER quote" (`lostBeforeQuote = false`) unconditionally here,
 * unlike the lead-level Mark lost which has to infer it — a quote was demonstrably involved.
 */
export function markQuoteLost(
  deps: QuoteWorkflowDeps,
  quoteId: number,
  input: MarkQuoteLostInput,
  actor: QuoteWorkflowActor,
): Promise<number> {
  return executeQuoteOperation(deps, 'mark-lost', quoteId, actor, async (context) => {
    const { trx, tenantId, quote, now } = context;

    const lostReason = await findActiveReferenceItem(trx, tenantId, input.lostReasonId, 'lost_reason');
    if (lostReason === undefined) throw invalidQuoteLostReasonError(input.lostReasonId);

    if (
      lostReason.canonicalKey === OTHER_LOST_REASON_KEY &&
      (input.lossComments ?? '').trim() === ''
    ) {
      throw quoteWorkflowRuleError("Loss comments are required when the lost reason is 'Other'.");
    }

    const otherOpen = await listOtherOpenQuotes(trx, tenantId, quote.leadId, quote.id);
    const noOtherOpenQuoteRemains = otherOpen.length === 0;
    const alsoCloseLead = input.alsoCloseLead ?? noOtherOpenQuoteRemains;

    let leadClosed = false;
    if (alsoCloseLead && noOtherOpenQuoteRemains) {
      await transitionLead(
        context,
        quote.leadId,
        LEAD_CLOSED_LOST_KEY,
        LEAD_QUOTE_LOST_CASCADE,
        { lostReasonId: input.lostReasonId, lostBeforeQuote: false },
        {
          lostReasonId: input.lostReasonId,
          lostBeforeQuote: false,
          decisionDate: now,
        },
      );
      leadClosed = true;
    }

    return {
      inputs: {
        lostReasonId: input.lostReasonId,
        competitor: input.competitor ?? null,
        competitorPremium: input.competitorPremium ?? null,
        lossComments: input.lossComments ?? null,
        alsoCloseLead,
        leadClosed,
      },
      fields: {
        lostReasonId: input.lostReasonId,
        competitor: input.competitor ?? null,
        competitorPremium: input.competitorPremium ?? null,
        lossComments: input.lossComments ?? null,
        decisionDate: now,
      },
    };
  });
}

/** Withdraw quote (`WithdrawQuoteCommandHandler`) — the lead is never touched. */
export function withdrawQuote(
  deps: QuoteWorkflowDeps,
  quoteId: number,
  input: WithdrawQuoteInput,
  actor: QuoteWorkflowActor,
): Promise<number> {
  return executeQuoteOperation(deps, 'withdraw', quoteId, actor, () =>
    Promise.resolve({
      inputs: { withdrawalNote: input.withdrawalNote },
      fields: { withdrawalNote: input.withdrawalNote },
    }),
  );
}

/**
 * Set current (`SetCurrentQuoteCommandHandler`) — PRD 7.3's multi-option-quoting marker.
 *
 * Demotes every OTHER quote of the lead, then promotes this one. The demote-then-promote ORDER is
 * load-bearing now that `uq_quotes_current` exists (this task's migration): promoting first would
 * violate the index against the incumbent rather than replacing it.
 *
 * The quote's own workflow status is untouched — `set-current` is `targetMode: 'unchanged'`, so the
 * executor writes back the same `statusId` it read.
 */
export function setCurrentQuote(
  deps: QuoteWorkflowDeps,
  quoteId: number,
  _input: SetCurrentQuoteInput,
  actor: QuoteWorkflowActor,
): Promise<number> {
  return executeQuoteOperation(deps, 'set-current', quoteId, actor, async (context) => {
    const { trx, tenantId, quote, actor: acting, now } = context;

    await demoteOtherCurrentQuotes(trx, tenantId, quote.leadId, quote.id, now, acting.userId);

    return { inputs: { leadId: quote.leadId }, fields: { isCurrent: true } };
  });
}

/**
 * `QuoteLeadCascade.MoveLeadToPricingIfPreQuotingAsync` — create quote's lead-side side effect.
 *
 * Exported for `service.ts`'s create path, which runs OUTSIDE `executeQuoteOperation` (there is no
 * quote yet to operate on). The no-op condition is the LEAD legality matrix's own `start-pricing`
 * rule rather than a hand-written status list, so a lead already at or past Pricing is left alone
 * by construction and the two definitions of "pre-Pricing" cannot drift apart.
 */
export async function moveLeadToPricingIfPreQuoting(
  trx: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  actor: QuoteWorkflowActor,
  now: string,
  isLeadStartPricingLegal: (canonicalKey: string | null, category: string | null) => boolean,
): Promise<boolean> {
  const lead = await findLead(trx, tenantId, leadId);
  if (lead === undefined) throw quoteLeadNotFoundError(leadId);

  const currentStatus = await findReferenceItem(trx, tenantId, lead.statusId);
  if (
    !isLeadStartPricingLegal(
      currentStatus?.canonicalKey ?? null,
      currentStatus?.reportingCategory ?? null,
    )
  ) {
    return false;
  }

  await transitionLead(
    { trx, tenantId, actor, now } as OperationContext,
    leadId,
    LEAD_PRICING_KEY,
    LEAD_START_PRICING_CASCADE,
    {},
  );
  return true;
}
