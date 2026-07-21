/**
 * Quote create/detail/list/draft-edit behaviour (T-026; AC-050, AC-052, AC-053, AC-055).
 *
 * Ports `CreateQuoteCommandHandler`, `GetQuoteQueryHandler`, `ListQuotesForLeadQueryHandler` and
 * `UpdateDraftQuoteCommandHandler`.
 *
 * QUOTES ARE LEAD-SUBORDINATE, AND THE ROUTE TABLE IS WHAT ENFORCES IT (AC-052)
 * ============================================================================
 * There is exactly one creation entry point, `POST /leads/{id}/quotes`, and `createQuote` takes the
 * lead id as a required parameter rather than reading it from the body. A standalone `POST /quotes`
 * is not merely absent from routes.ts — there is no service function it could call, because every
 * path here needs a lead to resolve its status legality, its defaults and its reference generator.
 *
 * EVERY MUTATION AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024)
 * ==============================================================
 * Same discipline as the leads core and the quote workflow executor: the reference wrote its audit
 * row through a separate `IAuditWriter` after the save, so a crash in between produced a change
 * with no audit trail.
 *
 * THE THREE-WAY EDIT GATE IS THE REFERENCE'S, AND ITS MIDDLE ARM IS THE INTERESTING ONE
 * ====================================================================================
 * `updateQuote` reproduces `UpdateDraftQuoteCommandHandler.cs:73-85` exactly:
 *
 *   terminal status  -> requires `quotes.correct_closed`; 403 without it, SUCCEEDS with it.
 *                       The PUT route IS the audited corrections path (AC-055); there is no
 *                       separate corrections endpoint in the reference.
 *   not Draft        -> 409 `QUOTE_DRAFT_EDIT_ONLY`, unconditionally. No permission makes a direct
 *                       edit of a Sent/Revised quote legal — the path is Revise (FR-49).
 *   Draft            -> proceeds.
 *
 * The order matters: terminal is checked FIRST, so a closed quote never falls into the draft-only
 * arm and never gets a 409 that would hide the correction affordance from a caller who holds it.
 */
import { writeAudit } from '../audit/index.js';
import { findSettings } from '../business-rules/repository.js';
import {
  findActiveReferenceItem,
  findLead,
  findLeadAssignment,
  findReferenceItem,
  findReferenceItemByCanonicalKey,
  stampLeadActivity,
} from '../leads/repository.js';
import { isLeadOperationLegal } from '../leads/workflow/legality.js';
import { listSlots } from '../assignments/repository.js';
import type { EffectiveAccess } from '../rbac/effective-permissions.js';
import type { PermissionCode } from '../rbac/permission-catalog.js';
import { InternalError } from '../../lib/errors/index.js';
import { withTransaction, type DbClient, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import {
  closedQuoteRequiresCorrectionError,
  draftEditOnlyError,
  invalidQuoteCoverTypeError,
  invalidQuoteProductLineError,
  leadClosedCannotCreateQuoteError,
  quoteLeadNotFoundError,
  quoteNotFoundError,
  quoteRuleError,
} from './errors.js';
import { generateQuoteRef } from './quote-ref.js';
import {
  findCurrentQuoteVersion,
  findQuote,
  hasAnyQuoteForLead,
  insertQuote,
  insertQuoteAssignment,
  insertQuoteVersion,
  listQuoteStatusHistory,
  listQuoteVersions,
  listQuotesForLead as listQuoteRows,
  updateQuoteFields,
  updateQuoteVersionPremium,
} from './repository.js';
import type {
  CreateQuoteInput,
  QuoteDto,
  QuoteListItemDto,
  UpdateQuoteInput,
} from './schemas.js';
import {
  QUOTE_STATUS_KEYS,
  availableQuoteOperations,
  isLegalToCreateQuote,
} from './workflow/legality.js';
import { moveLeadToPricingIfPreQuoting, type QuoteWorkflowActor } from './workflow/operations.js';
import type { LeadChangedListener } from '../leads/workflow/operations.js';

export const QUOTE_CREATED_ACTION = 'quote.created';
export const QUOTE_UPDATED_ACTION = 'quote.updated';

export interface QuotesDeps {
  readonly db: DbClient;
  /** The T-034 alert re-evaluation seam; see `LeadWorkflowDeps.onLeadChanged`. */
  readonly onLeadChanged?: LeadChangedListener;
}

/** The caller, as every quote service function needs them. */
export interface QuotesActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly access: EffectiveAccess;
  readonly correlationId?: string;
}

function auditContext(actor: QuotesActor): { correlationId?: string } {
  return actor.correlationId === undefined ? {} : { correlationId: actor.correlationId };
}

function workflowActorOf(actor: QuotesActor): QuoteWorkflowActor {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    access: actor.access,
    ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
  };
}

/**
 * Validates the product line / cover type pair (`CreateQuoteCommandHandler.cs:81-95`).
 *
 * The cover type must be active AND belong to the product line — both conditions collapse into ONE
 * error code, undifferentiated on purpose: an inactive cover type, a wrong list type, a mismatched
 * product line and ANOTHER TENANT'S id must all answer identically, or the difference becomes a
 * cross-tenant existence oracle (N-01).
 */
async function requireProductLineAndCoverType(
  executor: DbExecutor,
  tenantId: TenantId,
  productLineId: number,
  coverTypeId: number,
): Promise<void> {
  const productLine = await findActiveReferenceItem(executor, tenantId, productLineId, 'product_line');
  if (productLine === undefined) throw invalidQuoteProductLineError(productLineId);

  const coverType = await findActiveReferenceItem(executor, tenantId, coverTypeId, 'cover_type');
  if (coverType === undefined || coverType.productLineId !== productLineId) {
    throw invalidQuoteCoverTypeError(coverTypeId, productLineId);
  }
}

/**
 * `CreateQuoteCommandHandler` — the sole creation path (AC-052).
 *
 * Order of checks reproduces the reference: lead existence (404) before lead-status legality (409)
 * before reference-value validation (422) before the prepared-date rule (422), with the transaction
 * opened only once everything the caller could have got wrong has been checked.
 */
export async function createQuote(
  deps: QuotesDeps,
  leadId: number,
  input: CreateQuoteInput,
  actor: QuotesActor,
): Promise<QuoteDto> {
  const { db } = deps;
  const { tenantId } = actor;

  const lead = await findLead(db, tenantId, leadId);
  if (lead === undefined) throw quoteLeadNotFoundError(leadId);

  const leadStatus = await findReferenceItem(db, tenantId, lead.statusId);
  if (!isLegalToCreateQuote(leadStatus?.reportingCategory ?? null)) {
    throw leadClosedCannotCreateQuoteError(leadId);
  }

  // "default from the lead, editable" (FR-46).
  const productLineId = input.productLineId ?? lead.productLineId;
  const coverTypeId = input.coverTypeId ?? lead.coverTypeId;
  await requireProductLineAndCoverType(db, tenantId, productLineId, coverTypeId);

  const today = new Date().toISOString().slice(0, 10);
  const preparedDate = input.preparedDate ?? today;
  if (preparedDate < lead.dateReceived) {
    throw quoteRuleError("Prepared date cannot precede the lead's date received.");
  }

  const settings = await findSettings(db, tenantId);
  if (settings === undefined) {
    throw new InternalError(`Tenant ${tenantId} has no tenant_settings row; cannot generate a quote reference.`);
  }

  const quoteId = await withTransaction(db, async (trx) => {
    const now = new Date().toISOString();

    // Allocated inside the transaction: the sequence's row lock is held until COMMIT, which is the
    // whole mechanism preventing two concurrent creates from minting the same reference.
    const quoteRef = await generateQuoteRef(trx, tenantId, settings.quoteRefFormat);

    const draftStatus = await findReferenceItemByCanonicalKey(
      trx,
      tenantId,
      'quote_status',
      QUOTE_STATUS_KEYS.draft,
    );
    if (draftStatus === undefined) {
      throw new Error("The tenant's canonical 'draft' quote status reference item is missing.");
    }

    // The lead's FIRST quote becomes its current one by default (FR-50). Explicit re-marking for
    // multi-option quoting is the Set current operation's job, not this path's.
    const isFirstQuote = !(await hasAnyQuoteForLead(trx, tenantId, leadId));

    const quote = await insertQuote(trx, tenantId, {
      leadId,
      quoteRef,
      statusId: draftStatus.id,
      isCurrent: isFirstQuote,
      productLineId,
      coverTypeId,
      preparedDate,
      validUntil: input.validUntil ?? null,
      notes: input.notes ?? null,
      actorUserId: actor.userId,
      now,
    });

    await insertQuoteVersion(trx, tenantId, {
      quoteId: quote.id,
      versionNo: 1,
      quotedPremium: input.quotedPremium,
      termsNotes: null,
      revisionNote: null,
      isCurrent: true,
      createdAt: now,
      createdBy: actor.userId,
    });

    // Defaults the quote's slot assignees from the LEAD's: leads and quotes share the same
    // `business_assignments` slot rows, so each of the lead's RM/Underwriter assignees is copied
    // under the same `businessAssignmentId`.
    for (const slot of await listSlots(trx, tenantId)) {
      const leadAssignment = await findLeadAssignment(trx, tenantId, leadId, slot.assignmentId);
      if (leadAssignment === undefined) continue;

      await insertQuoteAssignment(trx, tenantId, {
        quoteId: quote.id,
        businessAssignmentId: slot.assignmentId,
        userId: leadAssignment.userId,
        actorUserId: actor.userId,
        now,
      });
    }

    await moveLeadToPricingIfPreQuoting(
      trx,
      tenantId,
      leadId,
      workflowActorOf(actor),
      now,
      (canonicalKey, category) => isLeadOperationLegal('start-pricing', canonicalKey, category),
    );

    // Quote creation is quote activity, so it counts as lead activity (FR-36/§11.5) even when the
    // Pricing cascade above was a no-op because the lead is already at or past Pricing.
    await stampLeadActivity(trx, tenantId, leadId, now, actor.userId);

    await writeAudit(trx, {
      entityType: 'quote',
      entityId: String(quote.id),
      action: QUOTE_CREATED_ACTION,
      actorUserId: actor.userId,
      tenantId,
      before: null,
      after: {
        quoteRef: quote.quoteRef,
        leadId: quote.leadId,
        productLineId: quote.productLineId,
        coverTypeId: quote.coverTypeId,
        quotedPremium: input.quotedPremium,
      },
      ...auditContext(actor),
    });

    return quote.id;
  });

  // Quote creation appends no status-history row, so the new quote's id is the event identity.
  // `quote:` namespaces it away from the two history-id key spaces (see the quote workflow).
  await deps.onLeadChanged?.(leadId, tenantId, {
    eventKey: `quote:${String(quoteId)}`,
    ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
  });

  return await getQuoteById(deps, quoteId, actor);
}

/**
 * `GetQuoteQueryHandler` — the full detail projection including versions, history and
 * `availableOperations`.
 *
 * `availableOperations` is computed SERVER-SIDE from the matrix and the caller's effective
 * permissions (AC-050). It is a UI affordance and never an authorization decision: the executor
 * re-checks both legality and permission, and the integration suite proves an operation absent from
 * this list still fails 409/403 when called directly.
 */
export async function getQuoteById(
  deps: QuotesDeps,
  quoteId: number,
  actor: QuotesActor,
): Promise<QuoteDto> {
  const { db } = deps;
  const { tenantId } = actor;

  const quote = await findQuote(db, tenantId, quoteId);
  if (quote === undefined) throw quoteNotFoundError(quoteId);

  const status = await findReferenceItem(db, tenantId, quote.statusId);
  const productLine = await findReferenceItem(db, tenantId, quote.productLineId);
  const coverType = await findReferenceItem(db, tenantId, quote.coverTypeId);

  const versions = await listQuoteVersions(db, tenantId, quoteId);
  const history = await listQuoteStatusHistory(db, tenantId, quoteId);

  return {
    id: quote.id,
    quoteRef: quote.quoteRef,
    leadId: quote.leadId,
    statusId: quote.statusId,
    statusName: status?.name ?? '',
    statusCanonicalKey: status?.canonicalKey ?? null,
    isCurrent: quote.isCurrent,
    productLineId: quote.productLineId,
    productLineName: productLine?.name ?? '',
    coverTypeId: quote.coverTypeId,
    coverTypeName: coverType?.name ?? '',
    preparedDate: quote.preparedDate,
    sentDate: quote.sentDate,
    validUntil: quote.validUntil,
    decisionDate: quote.decisionDate,
    boundPremium: quote.boundPremium,
    lostReasonId: quote.lostReasonId,
    competitor: quote.competitor,
    competitorPremium: quote.competitorPremium,
    lossComments: quote.lossComments,
    withdrawalNote: quote.withdrawalNote,
    notes: quote.notes,
    versions,
    history: history.map((row) => ({
      operation: row.operation,
      previousStatusId: row.previousStatusId,
      newStatusId: row.newStatusId,
      actedBy: row.actedBy,
      actedAt: row.actedAt,
    })),
    availableOperations: availableQuoteOperations(status?.canonicalKey ?? null, (permission) =>
      actor.access.has(permission as PermissionCode),
    ),
  };
}

/**
 * `ListQuotesForLeadQueryHandler` — the lead's Quotes card (FR-44).
 *
 * Answers a BARE ARRAY, not a `{ items, totalCount }` envelope — measured; see the note on
 * `QuoteListItemDto`. The lead's own existence is NOT re-checked here, matching the reference: a
 * missing or foreign lead id simply yields an empty list, because the tenant-predicated query finds
 * no quotes for it. That is not an existence oracle — the empty answer is identical either way.
 */
export async function listQuotesForLead(
  deps: QuotesDeps,
  leadId: number,
  actor: QuotesActor,
): Promise<QuoteListItemDto[]> {
  return await listQuoteRows(deps.db, actor.tenantId, leadId);
}

/**
 * `UpdateDraftQuoteCommandHandler` — the Draft edit AND the audited closed-quote correction path.
 *
 * See this file's header for the three-way gate. The audit row carries a real before/after diff
 * including the current version's premium, because the premium lives on `quote_versions` rather
 * than on the quote row and would otherwise vanish from the correction trail entirely.
 */
export async function updateQuote(
  deps: QuotesDeps,
  quoteId: number,
  input: UpdateQuoteInput,
  actor: QuotesActor,
): Promise<QuoteDto> {
  const { db } = deps;
  const { tenantId } = actor;

  await withTransaction(db, async (trx) => {
    const quote = await findQuote(trx, tenantId, quoteId);
    if (quote === undefined) throw quoteNotFoundError(quoteId);

    const currentStatus = await findReferenceItem(trx, tenantId, quote.statusId);

    if (currentStatus?.isTerminal === true) {
      // The corrections gate. 403, not 409 — an authorization verdict about the caller, not a
      // complaint about the body. Holding `quotes.correct_closed` makes this path SUCCEED.
      if (!actor.access.has('quotes.correct_closed')) {
        throw closedQuoteRequiresCorrectionError(quoteId);
      }
    } else if (currentStatus?.canonicalKey !== QUOTE_STATUS_KEYS.draft) {
      throw draftEditOnlyError(quoteId);
    }

    await requireProductLineAndCoverType(trx, tenantId, input.productLineId, input.coverTypeId);

    const currentVersion = await findCurrentQuoteVersion(trx, tenantId, quoteId);
    const before = {
      productLineId: quote.productLineId,
      coverTypeId: quote.coverTypeId,
      preparedDate: quote.preparedDate,
      validUntil: quote.validUntil,
      notes: quote.notes,
      quotedPremium: currentVersion?.quotedPremium ?? null,
    };

    const now = new Date().toISOString();

    await updateQuoteFields(
      trx,
      tenantId,
      quoteId,
      {
        productLineId: input.productLineId,
        coverTypeId: input.coverTypeId,
        preparedDate: input.preparedDate,
        validUntil: input.validUntil ?? null,
        notes: input.notes ?? null,
      },
      now,
      actor.userId,
    );

    if (currentVersion !== undefined) {
      // The premium is a property of the CURRENT VERSION, so a draft edit rewrites that version in
      // place rather than minting a new one — minting is Revise's job, and doing it here would make
      // every draft correction look like a revision in the version history.
      await updateQuoteVersionPremium(trx, tenantId, currentVersion.id, input.quotedPremium);
    }

    // A direct edit is quote activity, so it counts as lead activity (FR-36/§11.5).
    await stampLeadActivity(trx, tenantId, quote.leadId, now, actor.userId);

    await writeAudit(trx, {
      entityType: 'quote',
      entityId: String(quoteId),
      action: QUOTE_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId,
      before,
      after: {
        productLineId: input.productLineId,
        coverTypeId: input.coverTypeId,
        preparedDate: input.preparedDate,
        validUntil: input.validUntil ?? null,
        notes: input.notes ?? null,
        quotedPremium: input.quotedPremium,
      },
      ...auditContext(actor),
    });
  });

  return await getQuoteById(deps, quoteId, actor);
}
