/**
 * Lead intake/detail/edit/bulk-reassign behaviour (T-024; AC-021, AC-022, AC-024, AC-042..AC-046).
 *
 * Ports `CreateLeadCommandHandler`, `GetLeadQueryHandler`, `UpdateLeadCommandHandler`,
 * `ListLeadsQueryHandler`, `BulkReassignCommandHandler` and `DuplicateLeadChecker`.
 *
 * THERE ARE TWO DIFFERENT DUPLICATE MECHANISMS AND THEY BEHAVE DIFFERENTLY — MEASURED
 * ==================================================================================
 * This is the single most misread part of the feature, so it is stated plainly:
 *
 *   1. DUPLICATE LEAD (same party + product line, still open, inside the tenant's
 *      `duplicate_check_days` window) is CONFIRM-GATED, not silently non-blocking. The reference
 *      returns `RequiresConfirmation` with `lead: null` and NOTHING PERSISTED
 *      (CreateLeadCommandHandler.cs:184-193), which `LeadEndpoints.cs:85-88` renders as **409**.
 *      The caller re-submits with `createAnyway: true` to proceed. That is the "proceed semantics"
 *      AC-044 asks for — a warning the user must acknowledge, not one they never see. The check
 *      runs BEFORE the transaction precisely so that nothing is written when it trips.
 *
 *   2. DUPLICATE EXTERNAL REF and DUPLICATE PARTY NAME are genuinely NON-BLOCKING. They are
 *      searched for AFTER the row is written (:289-293) and merely annotate an already-successful
 *      result. This port keeps that ORDER rather than merely the status code: a version that
 *      searched first and chose not to reject would pass a status-only test while being one
 *      refactor away from becoming blocking. `leads-core.test.ts` asserts the row PHYSICALLY
 *      PERSISTS alongside the warning, both ways.
 *
 * The task brief described (1) as non-blocking; the reference is unambiguous that it is confirm-
 * gated, and the reference is what is ported. Recorded as a contradiction in the task file.
 *
 * EVERY MUTATION AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024, V-031)
 * =====================================================================
 * The reference wrote its audit row through a separate `IAuditWriter` after the save, so a crash in
 * between produced a change with no audit trail. Here each mutation opens one transaction covering
 * the write and the audit row — strictly stronger, and the pattern every other domain in this port
 * already uses.
 *
 * BREADTH IS RESOLVED SERVER-SIDE, FROM THE CALLER'S GRANTS, NEVER FROM THE WIRE
 * =============================================================================
 * `ListLeadsQuery`'s doc comment (:6-13) is explicit that the breadth booleans are resolved by the
 * handler via the permission resolver rather than passed in by the caller, "so a client cannot
 * widen its own visibility by lying about these on the wire". `listLeadsForTenant` takes an
 * `EffectiveAccess` and reads `canViewAll('leads')` from it; `myLeads` is the only breadth-related
 * input a caller supplies, and it can only ever NARROW (see repository.ts).
 */
import { writeAudit } from '../audit/index.js';
import { findSettings } from '../business-rules/repository.js';
import { normalizePartyName } from '../parties/name-matching.js';
import {
  findSimilarPartyNames,
  insertParty,
  isActiveReferenceItem as isActivePartyReference,
} from '../parties/repository.js';
import type { EffectiveAccess } from '../rbac/effective-permissions.js';
import { InternalError } from '../../lib/errors/index.js';
import { withTransaction, type DbClient, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import {
  closedLeadRequiresCorrectionError,
  externalRefNotEnabledError,
  invalidBrokerError,
  invalidCoverTypeError,
  invalidOwnerError,
  invalidPartyError,
  invalidProductLineError,
  invalidRegionError,
  invalidRequestChannelError,
  leadNotFoundError,
  leadRuleError,
} from './errors.js';
import { derivePriority, generateLeadRef } from './lead-ref.js';
import { availableLeadOperations } from './workflow/legality.js';
import type { LeadChangedListener } from './workflow/operations.js';
import {
  externalRefExists,
  findAccountableOwners,
  findActiveBroker,
  findActiveReferenceItem,
  findBrokerName,
  findLead,
  findLeadAssignment,
  findOpenDuplicateLeads,
  findPartyName,
  findReferenceItem,
  findReferenceItemByCanonicalKey,
  findRmSlotAssignment,
  insertLead,
  insertLeadAssignment,
  insertLeadNote,
  isActiveRegion,
  isEligibleOwner,
  listLeadNotes,
  listLeads as listLeadRows,
  stampLeadActivity,
  stampPartyActivity,
  updateLead as updateLeadRow,
  updateLeadAssignmentUser,
  type LeadRecord,
  type LeadWriteValues,
} from './repository.js';
import {
  DUPLICATE_EXTERNAL_REF_WARNING,
  DUPLICATE_LEAD_WARNING,
  DUPLICATE_PARTY_NAME_WARNING,
  LEAD_POLICY_TERM_OTHER,
  LEAD_SORT_FIELDS,
  NEW_STATUS_CANONICAL_KEY,
  todayUtc,
  type BulkReassignInput,
  type BulkReassignResultDto,
  type CreateLeadInput,
  type CreateLeadOutcomeDto,
  type LeadDto,
  type LeadListDto,
  type LeadSortField,
  type LeadSource,
  type LeadWarningDto,
  type ListLeadsQuery,
  type UpdateLeadInput,
  type UpdateLeadOutcomeDto,
} from './schemas.js';

export interface LeadsDeps {
  readonly db: DbClient;
  /**
   * The T-034 alert re-evaluation seam. Present HERE because `app.ts` mounts
   * `leadWorkflowRoutes(deps.leads)` — the workflow routes take their deps from this same slot, so
   * without it the twelve `POST /leads/{id}/operations/{op}` routes would run with the seam absent
   * and every alert would clear only on the 15-minute sweep, with every test still green.
   */
  readonly onLeadChanged?: LeadChangedListener;
}

/** Who acted, in which verified tenant, with what effective access. */
export interface LeadsActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly access: EffectiveAccess;
  readonly correlationId?: string;
}

/**
 * What `createLead` actually needs from an actor — and NOTHING MORE (T-030).
 *
 * Deliberately narrower than `LeadsActor`: creation never consults `access` (breadth is a LIST
 * concern), and `userId` is NULLABLE here because API intake has no application user behind it.
 * `_currentUser.UserId` is `long?` in the reference and lands in nullable `created_by`/
 * `actor_user_id` columns (CreateLeadCommandHandler.cs:284, audit_log.actor_user_id), so an
 * API-ingested lead genuinely records no creating user rather than borrowing someone else's id.
 *
 * `LeadsActor` is structurally assignable to this, so every browser call site is unchanged.
 */
export interface LeadCreationActor {
  readonly userId: number | null;
  readonly tenantId: TenantId;
  readonly correlationId?: string;
  /**
   * OPTIONAL, and its absence is meaningful (T-025).
   *
   * `availableOperations` on the create response is the legality matrix intersected with the
   * caller's effective permissions. API intake runs as an OAuth client-credentials credential with
   * no application user behind it, so there is no permission set to intersect and the reference
   * deliberately hands `ComputeAvailableOperations` an EMPTY set — the intake response surfaces no
   * operations at all (CreateLeadCommandHandler.cs:322-328). Omitting `access` reproduces exactly
   * that; a browser caller passes the full `LeadsActor` and gets the real list.
   */
  readonly access?: EffectiveAccess;
  /**
   * `ICurrentUser.ActorLabel` (:48-53) — how a NON-USER actor identifies itself on its audit rows.
   *
   * Required whenever `userId` is null, and the audit assertion helper enforces exactly that: "an
   * audit row that cannot say who acted is not evidence of anything". The reference uses this same
   * field to record `"system"` for the background jobs; API intake records its credential, which is
   * what keeps an ingested lead attributable after the fact (N-09, AC-075).
   *
   * It carries a credential's database id — NEVER key material, and never the `key_id` either.
   */
  readonly actorLabel?: string;
}

/**
 * Where a lead came in from (`SourceOverride`/`IntakeCredentialId`, CreateLeadCommand.cs:62-63).
 *
 * Passed as a separate argument rather than a body field ON PURPOSE: `source` and
 * `intakeCredentialId` decide attribution and must be unspoofable (P-06). If they lived on
 * `CreateLeadInput` a browser caller could POST `source: 'api'` and forge provenance.
 */
export interface LeadOrigin {
  readonly source: LeadSource;
  readonly intakeCredentialId: number | null;
}

/** `SourceOverride ?? LeadSource.Browser` (CreateLeadCommandHandler.cs:256). */
const BROWSER_ORIGIN: LeadOrigin = { source: 'browser', intakeCredentialId: null };

/**
 * The create input as the SERVICE sees it: `createLeadSchema`'s shape with the owner nullable.
 *
 * The browser schema requires `ownerUserId`; the API intake schema does not (CreateLeadValidator
 * .cs:38-45 attaches the `NotNull` rule only `When(SourceOverride != Api)`). Widening it here
 * rather than in `createLeadSchema` keeps the browser route's 422 for a missing owner intact.
 */
export type CreateLeadServiceInput = Omit<CreateLeadInput, 'ownerUserId'> & {
  readonly ownerUserId: number | null;
};

export const LEAD_CREATED_ACTION = 'lead.created';
export const LEAD_UPDATED_ACTION = 'lead.updated';
export const LEAD_REASSIGNED_ACTION = 'lead.reassigned';
export const PARTY_CREATED_ACTION = 'party.created';

/** `ListLeadsQueryHandler`: page floors at 1, a non-positive page size falls back to 25. */
const DEFAULT_PAGE_SIZE = 25;

function auditContext(actor: {
  readonly correlationId?: string;
  readonly actorLabel?: string;
}): { context?: { correlationId: string }; actorLabel?: string } {
  return {
    ...(actor.correlationId === undefined ? {} : { context: { correlationId: actor.correlationId } }),
    // Carried on every audit row this actor writes, not just some of them: a non-user actor whose
    // label reached only one of two rows would leave the other unattributable.
    ...(actor.actorLabel === undefined ? {} : { actorLabel: actor.actorLabel }),
  };
}

function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** `string.IsNullOrWhiteSpace(...) ? null : value` — the reference's external-ref normalisation. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}


/**
 * The tenant's business rules, which every lead create/edit consults (ref format, high-value
 * threshold, duplicate window, manual-external-ref switch).
 *
 * A MISSING row is a PROVISIONING fault, not a client error: `tenant_settings` is seeded for every
 * tenant at creation, so reaching here without one means the tenant was created around the API. It
 * fails CLOSED with a 500 rather than silently substituting defaults, because a default
 * `leadRefFormat` would mint references in the wrong format that no later fix could recall.
 */
async function requireSettings(executor: DbExecutor, tenantId: TenantId) {
  const settings = await findSettings(executor, tenantId);
  if (settings === undefined) {
    throw new InternalError(`Tenant ${String(tenantId)} has no business-rules settings row.`);
  }
  return settings;
}

/** `SortSpec.Parse`: bare key ascending, `-` prefix descending, unrecognised key -> default order. */
export function parseLeadSort(sort: string | undefined): {
  field: LeadSortField | null;
  descending: boolean;
} {
  if (sort === undefined || sort.trim() === '') return { field: null, descending: false };

  const descending = sort.startsWith('-');
  const raw = descending ? sort.slice(1) : sort;
  const field = (LEAD_SORT_FIELDS as readonly string[]).includes(raw)
    ? (raw as LeadSortField)
    : null;

  return { field, descending };
}

/**
 * The database-backed guards, IN THE REFERENCE'S ORDER (CreateLeadCommandHandler.cs:108-156,
 * UpdateLeadCommandHandler.cs:81-116).
 *
 * The order is OBSERVABLE: a body with both a bad region and a bad product line reports the REGION.
 * Preserved exactly, because the SPA highlights the field named in the response.
 */
async function assertReferenceValues(
  executor: DbExecutor,
  tenantId: TenantId,
  input: {
    requestChannelId: number;
    brokerId?: number | null | undefined;
    regionId: number;
    productLineId: number;
    coverTypeId: number;
  },
): Promise<void> {
  const requestChannel = await findActiveReferenceItem(
    executor,
    tenantId,
    input.requestChannelId,
    'request_channel',
  );
  if (requestChannel === undefined) throw invalidRequestChannelError(input.requestChannelId);

  const brokerId = orNull(input.brokerId);

  // `isBrokerChannel && BrokerId is null` (:120-125). Note `?? false`: a NULL flag is not a broker
  // channel, so a tenant that never set the flag does not suddenly require a broker on every lead.
  if ((requestChannel.isBrokerChannel ?? false) && brokerId === null) {
    throw leadRuleError('Broker is required for a broker-flagged request channel.');
  }

  if (brokerId !== null && (await findActiveBroker(executor, tenantId, brokerId)) === undefined) {
    throw invalidBrokerError(brokerId);
  }

  if (!(await isActiveRegion(executor, tenantId, input.regionId))) {
    throw invalidRegionError(input.regionId);
  }

  const productLine = await findActiveReferenceItem(
    executor,
    tenantId,
    input.productLineId,
    'product_line',
  );
  if (productLine === undefined) throw invalidProductLineError(input.productLineId);

  // The cover-type/product-line DEPENDENCY (:144-149): active, of the right list type, AND
  // belonging to the selected product line. A cover type from a different product line fails with
  // the same code as a nonexistent one — deliberately undifferentiated (LeadErrors.cs:5-11).
  const coverType = await findActiveReferenceItem(
    executor,
    tenantId,
    input.coverTypeId,
    'cover_type',
  );
  if (coverType === undefined || coverType.productLineId !== input.productLineId) {
    throw invalidCoverTypeError(input.coverTypeId, input.productLineId);
  }

}

/** `DuplicateLeadChecker.FindDuplicatesAsync` (:27-34): the window is `today - duplicate_check_days`. */
function duplicateWindowStart(duplicateCheckDays: number, today: string): string {
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - duplicateCheckDays);
  return since.toISOString().slice(0, 10);
}

/**
 * `GetLeadQueryHandler` (:50-107) — the full detail projection.
 *
 * `availableOperations` (T-025) is `LeadDto.ComputeAvailableOperations`: the legality matrix for
 * this lead's CURRENT status intersected with `access`'s effective permissions. It is a UI
 * affordance and nothing more — `executeLeadOperation` re-derives legality and re-checks the
 * per-operation permission server-side, so an operation absent from this list still fails 409/403
 * when called directly. A caller with no resolved access (API intake) gets an empty list.
 */
async function projectLeadDetail(
  executor: DbExecutor,
  tenantId: TenantId,
  lead: LeadRecord,
  access?: EffectiveAccess,
): Promise<LeadDto> {
  const [partyName, productLine, coverType, status, notes] = await Promise.all([
    findPartyName(executor, tenantId, lead.partyId),
    findReferenceItem(executor, tenantId, lead.productLineId),
    findReferenceItem(executor, tenantId, lead.coverTypeId),
    findReferenceItem(executor, tenantId, lead.statusId),
    listLeadNotes(executor, tenantId, lead.id),
  ]);

  const brokerName =
    lead.brokerId === null ? null : await findBrokerName(executor, tenantId, lead.brokerId);

  const owners = await findAccountableOwners(executor, tenantId, [lead.id]);
  const today = todayUtc();

  return {
    id: lead.id,
    leadRef: lead.leadRef,
    externalRef: lead.externalRef,
    partyId: lead.partyId,
    partyName: partyName ?? '',
    requestChannelId: lead.requestChannelId,
    brokerId: lead.brokerId,
    brokerName,
    regionId: lead.regionId,
    productLineId: lead.productLineId,
    productLineName: productLine?.name ?? '',
    coverTypeId: lead.coverTypeId,
    coverTypeName: coverType?.name ?? '',
    sumInsured: lead.sumInsured,
    estimatedPremium: lead.estimatedPremium,
    policyTerm: lead.policyTerm,
    policyTermOther: lead.policyTermOther,
    priority: lead.priority,
    isExistingClient: lead.isExistingClient,
    statusId: lead.statusId,
    statusName: status?.name ?? '',
    statusCanonicalKey: status?.canonicalKey ?? null,
    dateReceived: lead.dateReceived,
    source: lead.source,
    owner: owners.get(lead.id) ?? null,
    notes,
    availableOperations: availableLeadOperations(
      status?.canonicalKey ?? null,
      status?.reportingCategory ?? null,
      (permission) => access?.has(permission) ?? false,
    ),
    lastFollowUpDate: lead.lastFollowUpDate,
    nextFollowUpDate: lead.nextFollowUpDate,
    // `ComputeIsNextFollowUpOverdue` (LeadDto.cs:73-76): set, strictly before today, AND still open.
    // A CLOSED lead's stale next-follow-up date must never show the Overdue chip.
    isNextFollowUpOverdue:
      lead.nextFollowUpDate !== null &&
      lead.nextFollowUpDate < today &&
      (status?.reportingCategory === 'open' || status?.reportingCategory === 'quoted'),
  };
}

/** The mutable-field snapshot the audit rows diff (UpdateLeadCommandHandler.cs:118-123). */
function auditPayload(lead: LeadRecord): Record<string, string | number | boolean | null> {
  return {
    isExistingClient: lead.isExistingClient,
    dateReceived: lead.dateReceived,
    requestChannelId: lead.requestChannelId,
    brokerId: lead.brokerId,
    regionId: lead.regionId,
    externalRef: lead.externalRef,
    productLineId: lead.productLineId,
    coverTypeId: lead.coverTypeId,
    sumInsured: lead.sumInsured,
    estimatedPremium: lead.estimatedPremium,
    policyTerm: lead.policyTerm,
    policyTermOther: lead.policyTermOther,
    priority: lead.priority,
  };
}

/**
 * `CreateLeadCommandHandler.Handle` (:99-341).
 *
 * Sequence, and every step's position is the reference's:
 *   1. reference-value guards        — BEFORE any write, so an invalid request never creates a
 *                                      party, even an inline one (:31-39 states this explicitly)
 *   2. external-ref-enabled guard
 *   3. owner eligibility
 *   4. duplicate-LEAD check          — returns the 409 confirm envelope, nothing persisted
 *   5. ONE transaction: inline party -> ref allocation -> lead -> assignment -> note -> audit
 *   6. external-ref warning search   — AFTER the write, so it cannot block
 */
export async function createLead(
  deps: LeadsDeps,
  input: CreateLeadServiceInput,
  actor: LeadCreationActor,
  origin: LeadOrigin = BROWSER_ORIGIN,
): Promise<CreateLeadOutcomeDto> {
  const { tenantId } = actor;

  // An inline party does not exist yet, so only an EXISTING party id can be checked here.
  if (input.partyId !== null && input.partyId !== undefined) {
    const partyName = await findPartyName(deps.db, tenantId, input.partyId);
    if (partyName === null) throw invalidPartyError(input.partyId);
  }

  await assertReferenceValues(deps.db, tenantId, input);
  const settings = await requireSettings(deps.db, tenantId);

  const externalRef = blankToNull(input.externalRef);
  if (externalRef !== null && !settings.manualExternalRefEnabled) {
    throw externalRefNotEnabledError();
  }

  // The accountable owner must hold the tenant's RM-slot ROLE (:162-179).
  //
  // BOTH the slot lookup AND the eligibility check are skipped when no owner was named
  // (CreateLeadCommandHandler.cs:158-179 guards the whole block with `command.OwnerUserId is not
  // null`). Skipping only the eligibility check would still 422 an ownerless API intake in a tenant
  // that has not configured an RM role — which is precisely the unattended tenant the ownerless
  // path exists for.
  const ownerUserId = input.ownerUserId;
  let rmSlot: Awaited<ReturnType<typeof findRmSlotAssignment>>;
  if (ownerUserId !== null) {
    rmSlot = await findRmSlotAssignment(deps.db, tenantId);
    if (rmSlot === undefined) throw leadRuleError('No RM role is configured for this tenant.');
    if (!(await isEligibleOwner(deps.db, tenantId, rmSlot.roleId, ownerUserId))) {
      throw invalidOwnerError(ownerUserId);
    }
  }

  // Duplicate-LEAD check (:184-193) — only against an EXISTING party (an inline party cannot
  // already have an open duplicate) and only when the caller has not already confirmed.
  if (
    input.partyId !== null &&
    input.partyId !== undefined &&
    input.createAnyway !== true
  ) {
    const since = duplicateWindowStart(settings.duplicateCheckDays, todayUtc());
    const duplicates = await findOpenDuplicateLeads(
      deps.db,
      tenantId,
      input.partyId,
      input.productLineId,
      since,
    );

    if (duplicates.length > 0) {
      return {
        lead: null,
        warnings: [{ code: DUPLICATE_LEAD_WARNING, details: { duplicates } }],
        requiresConfirmation: true,
      };
    }
  }

  const now = new Date().toISOString();

  return await withTransaction(deps.db, async (trx) => {
    const warnings: LeadWarningDto[] = [];
    let partyId: number;

    if (input.inlineParty !== null && input.inlineParty !== undefined) {
      // `CreatePartyCommand` via the mediator (:200-217). Inlined here rather than calling the
      // parties service, because that service opens its OWN transaction and the party must be
      // atomic with the lead: a later failure inside this transaction must never leave an orphaned
      // party behind (`CreateLead_WithInlineParty_ShouldCreatePartyAndLeadAtomically`).
      const inline = input.inlineParty;

      if (!(await isActivePartyReference(trx, tenantId, inline.partyTypeId, 'party_type'))) {
        throw leadRuleError(
          `Party type ${inline.partyTypeId} is not an active party-type reference value for this tenant.`,
        );
      }

      const party = await insertParty(trx, tenantId, {
        name: normalizePartyName(inline.name),
        partyTypeId: inline.partyTypeId,
        segmentId: orNull(inline.segmentId),
        industryId: orNull(inline.industryId),
        regionId: orNull(inline.regionId),
        isStrategic: inline.isStrategic ?? false,
        contactName: orNull(inline.contactName),
        contactEmail: orNull(inline.contactEmail),
        contactPhone: orNull(inline.contactPhone),
        actorUserId: actor.userId,
      });

      partyId = party.id;

      await writeAudit(trx, {
        entityType: 'party',
        entityId: String(party.id),
        action: PARTY_CREATED_ACTION,
        actorUserId: actor.userId,
        tenantId,
        before: null,
        after: { name: party.name, partyTypeId: party.partyTypeId },
        ...auditContext(actor),
      });

      // The inline party's own duplicate-NAME warning, forwarded onto the lead response (:215-216).
      const matches = await findSimilarPartyNames(trx, tenantId, party.name, party.id);
      if (matches.length > 0) {
        warnings.push({ code: DUPLICATE_PARTY_NAME_WARNING, details: { matches } });
      }
    } else {
      partyId = input.partyId as number;
    }

    const leadRef = await generateLeadRef(trx, tenantId, settings.leadRefFormat);

    // Status is ALWAYS the canonical `new` item (:225-230) — creation never auto-transitions to
    // Assigned even though it stores an owner. T-025's Assign operation is what transitions it.
    const newStatus = await findReferenceItemByCanonicalKey(
      trx,
      tenantId,
      'lead_status',
      NEW_STATUS_CANONICAL_KEY,
    );
    if (newStatus === undefined) {
      throw leadRuleError("The tenant's canonical 'new' lead status reference item is missing.");
    }

    // An explicit priority wins; otherwise it is DERIVED from the high-value threshold (:232).
    const priority =
      orNull(input.priority) ?? derivePriority(orNull(input.estimatedPremium), settings.highValueThreshold);

    const lead = await insertLead(trx, tenantId, {
      partyId,
      leadRef,
      externalRef,
      dateReceived: input.dateReceived,
      requestChannelId: input.requestChannelId,
      brokerId: orNull(input.brokerId),
      regionId: input.regionId,
      productLineId: input.productLineId,
      coverTypeId: input.coverTypeId,
      sumInsured: orNull(input.sumInsured),
      estimatedPremium: orNull(input.estimatedPremium),
      policyTerm: input.policyTerm,
      // Other-text is only stored when the term IS `other` (:249) — a term change cannot leave
      // orphaned free text behind.
      policyTermOther: input.policyTerm === LEAD_POLICY_TERM_OTHER ? orNull(input.policyTermOther) : null,
      priority,
      isExistingClient: input.isExistingClient,
      statusId: newStatus.id,
      source: origin.source,
      intakeCredentialId: origin.intakeCredentialId,
      lastActivityAt: now,
      actorUserId: actor.userId,
    });

    // "Ownerless (API intake) leads get no accountable-owner assignment — they stay unassigned
    // until someone claims them" (:262-264). The unassigned-lead alert (T-032) is what surfaces
    // them, so writing a placeholder assignment here would silence that alert.
    if (ownerUserId !== null && rmSlot !== undefined) {
      await insertLeadAssignment(trx, tenantId, {
        leadId: lead.id,
        businessAssignmentId: rmSlot.assignmentId,
        userId: ownerUserId,
        actorUserId: actor.userId,
        now,
      });
    }

    // The intake note becomes the lead's FIRST activity note (:276-287).
    const intakeNotes = blankToNull(input.intakeNotes);
    if (intakeNotes !== null) {
      await insertLeadNote(trx, tenantId, {
        leadId: lead.id,
        body: intakeNotes,
        createdBy: actor.userId,
        now,
      });
    }

    await writeAudit(trx, {
      entityType: 'lead',
      entityId: String(lead.id),
      action: LEAD_CREATED_ACTION,
      actorUserId: actor.userId,
      tenantId,
      before: null,
      after: {
        leadRef: lead.leadRef,
        partyId: lead.partyId,
        productLineId: lead.productLineId,
        coverTypeId: lead.coverTypeId,
        priority: lead.priority,
        ownerUserId,
      },
      ...auditContext(actor),
    });

    // Lead creation is party activity (:307-314).
    await stampPartyActivity(trx, tenantId, partyId, now);

    // AFTER the write and AFTER the audit, so it cannot block either (:289-293).
    if (lead.externalRef !== null && (await externalRefExists(trx, tenantId, lead.externalRef, lead.id))) {
      warnings.push({
        code: DUPLICATE_EXTERNAL_REF_WARNING,
        details: { externalRef: lead.externalRef },
      });
    }

    return {
      lead: await projectLeadDetail(trx, tenantId, lead, actor.access),
      warnings,
      requiresConfirmation: false,
    };
  });
}

/** `GetLeadQueryHandler`. A foreign-tenant id resolves to the SAME 404 as a missing one (N-01). */
export async function getLeadById(
  deps: LeadsDeps,
  id: number,
  actor: LeadsActor,
): Promise<LeadDto> {
  const lead = await findLead(deps.db, actor.tenantId, id);
  if (lead === undefined) throw leadNotFoundError(id);

  return await projectLeadDetail(deps.db, actor.tenantId, lead, actor.access);
}

/**
 * `UpdateLeadCommandHandler` (:56-160).
 *
 * The existence check comes BEFORE the reference guards, and the CLOSED-LEAD check before both
 * (:64-79) — observable: editing another tenant's lead with an invalid body answers 404, and
 * editing a closed lead without the correction permission answers 403 even if the body is invalid.
 */
export async function updateLeadById(
  deps: LeadsDeps,
  id: number,
  input: UpdateLeadInput,
  actor: LeadsActor,
): Promise<UpdateLeadOutcomeDto> {
  const { tenantId } = actor;

  const existing = await findLead(deps.db, tenantId, id);
  if (existing === undefined) throw leadNotFoundError(id);

  // FR-40 "closed records read-only except authorized correction process" (:70-79).
  const currentStatus = await findReferenceItem(deps.db, tenantId, existing.statusId);
  if (currentStatus?.isTerminal === true && !actor.access.has('leads.correct_closed')) {
    throw closedLeadRequiresCorrectionError(id);
  }

  await assertReferenceValues(deps.db, tenantId, input);

  const settings = await requireSettings(deps.db, tenantId);
  const externalRef = blankToNull(input.externalRef);
  if (externalRef !== null && !settings.manualExternalRefEnabled) {
    throw externalRefNotEnabledError();
  }

  const now = new Date().toISOString();

  return await withTransaction(deps.db, async (trx) => {
    const values: LeadWriteValues = {
      isExistingClient: input.isExistingClient,
      dateReceived: input.dateReceived,
      requestChannelId: input.requestChannelId,
      brokerId: orNull(input.brokerId),
      regionId: input.regionId,
      externalRef,
      productLineId: input.productLineId,
      coverTypeId: input.coverTypeId,
      sumInsured: orNull(input.sumInsured),
      estimatedPremium: orNull(input.estimatedPremium),
      policyTerm: input.policyTerm,
      policyTermOther:
        input.policyTerm === LEAD_POLICY_TERM_OTHER ? orNull(input.policyTermOther) : null,
      priority: input.priority,
      actorUserId: actor.userId,
    };

    const lead = await updateLeadRow(trx, tenantId, id, values, now);

    await writeAudit(trx, {
      entityType: 'lead',
      entityId: String(lead.id),
      action: LEAD_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId,
      before: auditPayload(existing),
      after: auditPayload(lead),
      ...auditContext(actor),
    });

    const warnings: LeadWarningDto[] = [];
    // Same post-write ordering as create, so edit's warning is non-blocking for the same reason.
    if (lead.externalRef !== null && (await externalRefExists(trx, tenantId, lead.externalRef, lead.id))) {
      warnings.push({
        code: DUPLICATE_EXTERNAL_REF_WARNING,
        details: { externalRef: lead.externalRef },
      });
    }

    return { lead: await projectLeadDetail(trx, tenantId, lead, actor.access), warnings };
  });
}

/** `ListLeadsQueryHandler` (:26-43) plus `LeadEndpoints.ListLeadsAsync`'s defaults (:56). */
export async function listLeadsForTenant(
  deps: LeadsDeps,
  query: ListLeadsQuery,
  actor: LeadsActor,
): Promise<LeadListDto> {
  const page = query.page === undefined || query.page < 1 ? 1 : query.page;
  const pageSize =
    query.pageSize === undefined || query.pageSize < 1 ? DEFAULT_PAGE_SIZE : query.pageSize;

  const { items, totalCount } = await listLeadRows(
    deps.db,
    actor.tenantId,
    {
      statusIds: query.status,
      ownerUserId: query.ownerUserId,
      brokerId: query.brokerId,
      productLineId: query.productLineId,
      regionId: query.regionId,
      requestChannelId: query.requestChannelId,
      dateReceivedFrom: query.dateReceivedFrom,
      dateReceivedTo: query.dateReceivedTo,
      myLeadsOnly: query.myLeads ?? false,
      callerUserId: actor.userId,
      // SERVER-RESOLVED, from the caller's grants — never from the request (ListLeadsQuery.cs:6-13).
      callerHasViewAll: actor.access.canViewAll('leads'),
      search: query.search,
      sort: parseLeadSort(query.sort),
      page,
      pageSize,
    },
    todayUtc(),
  );

  return { items, totalCount, page, pageSize };
}

/**
 * `BulkReassignCommandHandler` (:46-115).
 *
 * ALL-OR-NOTHING: every lead must exist for this tenant and the new owner must be eligible, or
 * nothing changes — one transaction wraps the whole batch, so a foreign/nonexistent lead id in
 * position 5 rolls back the four reassignments already applied. The isolation test asserts exactly
 * that, because a partial batch would be a cross-tenant write that "only" half-succeeded.
 *
 * ONE AUDIT ENTRY PER LEAD, NOT ONE PER BATCH (:16, :104-110), each carrying the mandatory note.
 */
export async function bulkReassignLeads(
  deps: LeadsDeps,
  input: BulkReassignInput,
  actor: LeadsActor,
): Promise<BulkReassignResultDto> {
  const { tenantId } = actor;

  const rmSlot = await findRmSlotAssignment(deps.db, tenantId);
  if (rmSlot === undefined) throw leadRuleError('No RM role is configured for this tenant.');

  if (!(await isEligibleOwner(deps.db, tenantId, rmSlot.roleId, input.newOwnerUserId))) {
    throw invalidOwnerError(input.newOwnerUserId);
  }

  const now = new Date().toISOString();

  return await withTransaction(deps.db, async (trx) => {
    for (const leadId of input.leadIds) {
      const lead = await findLead(trx, tenantId, leadId);
      if (lead === undefined) throw leadNotFoundError(leadId);

      // Reassignment is lead activity (:80-84), stamped inside the same transaction.
      await stampLeadActivity(trx, tenantId, leadId, now, actor.userId);

      const existing = await findLeadAssignment(trx, tenantId, leadId, rmSlot.assignmentId);
      if (existing === undefined) {
        await insertLeadAssignment(trx, tenantId, {
          leadId,
          businessAssignmentId: rmSlot.assignmentId,
          userId: input.newOwnerUserId,
          actorUserId: actor.userId,
          now,
        });
      } else {
        await updateLeadAssignmentUser(
          trx,
          tenantId,
          existing.id,
          input.newOwnerUserId,
          now,
          actor.userId,
        );
      }

      await writeAudit(trx, {
        entityType: 'lead',
        entityId: String(leadId),
        action: LEAD_REASSIGNED_ACTION,
        actorUserId: actor.userId,
        tenantId,
        before: { ownerUserId: existing?.userId ?? null },
        after: { ownerUserId: input.newOwnerUserId, note: input.note, leadIds: [...input.leadIds] },
        ...auditContext(actor),
      });
    }

    return { reassignedCount: input.leadIds.length };
  });
}
