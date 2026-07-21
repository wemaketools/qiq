/**
 * Tenant reference-data behaviour (T-019, AC-022, AC-024, AC-035, AC-036).
 *
 * Ports the five CQRS handlers under `src/api/QuoteIQ.Application/Features/ReferenceData/`:
 * ListItems, CreateItem, UpdateItem, DisableItem, ReorderItems.
 *
 * THE GUARDED-STATUS INVARIANTS, AND WHY THEY ARE HERE RATHER THAN IN SQL
 * ======================================================================
 * Three of P-04's guards are UPDATE-time rules about how a row may CHANGE, not row-local
 * invariants, so no CHECK constraint can express them (20260718002000_reference_items.sql:19-22
 * says exactly this, and the reference splits them the same way):
 *
 *   1. A TERMINAL STATUS CANNOT BE DISABLED. A tenant that disables `closed_won` has a workflow
 *      with no way to record a win, and every conversion metric silently reads zero from then on.
 *   2. A CANONICAL STATUS'S REPORTING CATEGORY CANNOT CHANGE. Dashboards resolve `won`/`lost` by
 *      `canonical_key` and then aggregate by `reporting_category`; re-pointing the canonical `won`
 *      row at the `lost` category inverts a headline number without touching a single Quote.
 *   3. A NON-CANONICAL STATUS MAY ONLY EVER SIT IN `open` OR `quoted`. Terminal categories are
 *      reachable only through the seeded canonical rows, so a tenant cannot mint a second, rival
 *      "won" that half the reporting layer counts and half does not.
 *
 * `canonical_key` and `is_terminal` need no rule at all because no request shape can carry them
 * (schemas.ts): they are write-only to the tenant-creation seed.
 *
 * EVERY MUTATION AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024, V-031)
 * =====================================================================
 * The reference wrote its audit row through a separate `IAuditWriter` call AFTER `SaveChangesAsync`
 * (e.g. CreateItemCommandHandler.cs:80-88), so a crash in between produced a change with no audit
 * trail. Here each operation opens one transaction covering the read, the write and the audit row —
 * strictly stronger, and the pattern every other domain in this port already uses (tenants/service.ts).
 */
import { writeAudit } from '../audit/index.js';
import { withTransaction, type DbClient, type TenantId } from '../../lib/db/index.js';
import {
  canonicalFieldsImmutableError,
  duplicateNameError,
  invalidIntermediateCategoryError,
  invalidProductLineError,
  productLineRequiredError,
  referenceItemNotFoundError,
  reorderSetMismatchError,
  reportingCategoryRequiredError,
  terminalStatusCannotBeDisabledError,
} from './errors.js';
import {
  carriesBrokerChannelFlag,
  isIntermediateReportingCategory,
  isStatusListType,
  parseReferenceListType,
  requiresProductLine,
  type ReferenceListType,
} from './list-types.js';
import {
  applyDisplayOrder,
  disableItem,
  findItem,
  insertItem,
  isActiveProductLine,
  listItems,
  nameExists,
  updateItem,
} from './repository.js';
import type { CreateItemInput, ReferenceItemDto, UpdateItemInput } from './schemas.js';

export interface ReferenceDataDeps {
  readonly db: DbClient;
}

/** Who performed the action and in which verified tenant, for audit rows and the `*_by` stamps. */
export interface ReferenceDataActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly correlationId?: string;
}

export const REFERENCE_ITEM_CREATED_ACTION = 'reference_item.created';
export const REFERENCE_ITEM_UPDATED_ACTION = 'reference_item.updated';
export const REFERENCE_ITEM_DISABLED_ACTION = 'reference_item.disabled';
export const REFERENCE_ITEM_REORDERED_ACTION = 'reference_item.reordered';

/** The mutable field snapshot the update audit row records on both halves (:87,112). */
function auditPayload(item: ReferenceItemDto): Record<string, string | number | boolean | null> {
  return {
    name: item.name,
    isBrokerChannel: item.isBrokerChannel,
    productLineId: item.productLineId,
    reportingCategory: item.reportingCategory,
  };
}

function auditContext(actor: ReferenceDataActor): { context?: { correlationId: string } } {
  return actor.correlationId === undefined ? {} : { context: { correlationId: actor.correlationId } };
}

/** `null` for an absent optional field, so "omitted" and "explicitly null" behave identically. */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** ListItemsQueryHandler (:14-18). */
export async function listReferenceItems(
  deps: ReferenceDataDeps,
  listType: ReferenceListType,
  includeDisabled: boolean,
  actor: ReferenceDataActor,
): Promise<ReferenceItemDto[]> {
  return await listItems(deps.db, actor.tenantId, listType, includeDisabled);
}

/**
 * CreateItemCommandHandler (:30-91).
 *
 * Rule order is the reference's and is observable: duplicate name is checked BEFORE the cover-type
 * and status guards, so a duplicate cover type with a bad product line reports the duplicate.
 */
export async function createReferenceItem(
  deps: ReferenceDataDeps,
  listType: ReferenceListType,
  input: CreateItemInput,
  actor: ReferenceDataActor,
): Promise<ReferenceItemDto> {
  return await withTransaction(deps.db, async (trx) => {
    if (await nameExists(trx, actor.tenantId, listType, input.name, null)) {
      throw duplicateNameError(input.name);
    }

    const productLineId = orNull(input.productLineId);
    if (requiresProductLine(listType)) {
      if (productLineId === null) throw productLineRequiredError();
      if (!(await isActiveProductLine(trx, actor.tenantId, productLineId))) {
        throw invalidProductLineError(productLineId);
      }
    }

    const reportingCategory = orNull(input.reportingCategory);
    if (isStatusListType(listType) && !isIntermediateReportingCategory(reportingCategory)) {
      // Guard 3. Reached for a WELL-FORMED terminal category ('won'), which the schema accepts —
      // the schema only knows the six legal categories, not which two a tenant may choose.
      throw invalidIntermediateCategoryError();
    }

    const created = await insertItem(trx, actor.tenantId, {
      listType,
      name: input.name,
      // Each optional field is narrowed to the ONE list type it means something on
      // (CreateItemCommandHandler.cs:71-75), so a broker flag posted to a region is dropped rather
      // than stored on a row where nothing will ever read it.
      isBrokerChannel: carriesBrokerChannelFlag(listType) ? orNull(input.isBrokerChannel) : null,
      productLineId: requiresProductLine(listType) ? productLineId : null,
      reportingCategory: isStatusListType(listType) ? reportingCategory : null,
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'reference_item',
      entityId: String(created.id),
      action: REFERENCE_ITEM_CREATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: { listType: created.listType, ...auditPayload(created) },
      ...auditContext(actor),
    });

    return created;
  });
}

/**
 * UpdateItemCommandHandler (:32-116).
 *
 * The item is addressed by id alone — see repository.ts's `findItem` for why the route's list type
 * is deliberately not part of the lookup. All per-type decisions below are therefore made from the
 * STORED row's list type, never from the route.
 */
export async function updateReferenceItem(
  deps: ReferenceDataDeps,
  id: number,
  input: UpdateItemInput,
  actor: ReferenceDataActor,
): Promise<ReferenceItemDto> {
  return await withTransaction(deps.db, async (trx) => {
    const existing = await findItem(trx, actor.tenantId, id);
    // Undefined here means "no such id IN THIS TENANT" — a row belonging to another tenant was
    // already filtered out by the tenant predicate, so it is indistinguishable from a nonexistent
    // one and yields the identical 404 (N-01, AC-022).
    if (existing === undefined) throw referenceItemNotFoundError(id);

    if (await nameExists(trx, actor.tenantId, existing.listType, input.name, id)) {
      throw duplicateNameError(input.name);
    }

    const storedListType = parseReferenceListType(existing.listType);
    const isStatus = storedListType !== null && isStatusListType(storedListType);
    const isCanonical = existing.canonicalKey !== null;
    const requested = orNull(input.reportingCategory);

    // Guard 2: a canonical row's category is immutable. The comparison is against the STORED value,
    // so a client that echoes the row back unchanged (which the SPA does — ReferenceDataTab.tsx:337
    // resends `item.reportingCategory` for canonical rows) passes, and only an actual change fails.
    if (isCanonical && requested !== existing.reportingCategory) {
      throw canonicalFieldsImmutableError();
    }

    if (!isCanonical && isStatus) {
      if (requested === null) throw reportingCategoryRequiredError();
      // Guard 3 again, on every edit — not just at creation. Without this, a status could be created
      // as 'open' and then quietly promoted to 'won' by a follow-up PUT.
      if (!isIntermediateReportingCategory(requested)) throw invalidIntermediateCategoryError();
    }

    const requestedProductLineId = orNull(input.productLineId);
    const isCoverType = storedListType !== null && requiresProductLine(storedListType);
    if (isCoverType) {
      if (requestedProductLineId === null) throw productLineRequiredError();
      if (!(await isActiveProductLine(trx, actor.tenantId, requestedProductLineId))) {
        throw invalidProductLineError(requestedProductLineId);
      }
    }

    const updated = await updateItem(trx, actor.tenantId, id, {
      name: input.name,
      // Fields the stored list type does not own KEEP their existing value rather than being
      // nulled by an absent body field (UpdateItemCommandHandler.cs:90-95): a PUT is not permitted
      // to clear a column it has no business setting.
      isBrokerChannel:
        storedListType !== null && carriesBrokerChannelFlag(storedListType)
          ? orNull(input.isBrokerChannel)
          : existing.isBrokerChannel,
      productLineId: isCoverType ? requestedProductLineId : existing.productLineId,
      // Only a NON-canonical status may have its category written at all; a canonical row keeps the
      // stored value even though the guard above proved the request matched it.
      reportingCategory: !isCanonical && isStatus ? requested : existing.reportingCategory,
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'reference_item',
      entityId: String(id),
      action: REFERENCE_ITEM_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: auditPayload(existing),
      after: auditPayload(updated),
      ...auditContext(actor),
    });

    return updated;
  });
}

/**
 * DisableItemCommandHandler (:23-49).
 *
 * IDEMPOTENT BY DESIGN: an already-disabled item returns success WITHOUT a second audit row (:36-38).
 * A retried request therefore cannot inflate the audit trail — which matters under Vercel, where a
 * duplicate delivery is normal rather than exceptional.
 */
export async function disableReferenceItem(
  deps: ReferenceDataDeps,
  id: number,
  actor: ReferenceDataActor,
): Promise<void> {
  await withTransaction(deps.db, async (trx) => {
    const existing = await findItem(trx, actor.tenantId, id);
    if (existing === undefined) throw referenceItemNotFoundError(id);

    // Guard 1, and it is checked BEFORE the already-disabled short-circuit, exactly as the reference
    // orders it (:31-38): a terminal status reports the refusal even if it were somehow inactive,
    // rather than silently answering 200.
    if (existing.isTerminal) throw terminalStatusCannotBeDisabledError();

    if (!existing.isActive) return;

    await disableItem(trx, actor.tenantId, id, actor.userId);

    await writeAudit(trx, {
      entityType: 'reference_item',
      entityId: String(id),
      action: REFERENCE_ITEM_DISABLED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { listType: existing.listType, name: existing.name, isActive: true },
      after: { listType: existing.listType, name: existing.name, isActive: false },
      ...auditContext(actor),
    });
  });
}

/**
 * ReorderItemsCommandHandler (:28-54).
 *
 * STRICT SET EQUALITY AGAINST THE ACTIVE ITEMS, AND THE DUPLICATE CHECK IS NOT REDUNDANT
 * =====================================================================================
 * `orderedIds` must be exactly the list's ACTIVE ids: no duplicates, no omissions, nothing from
 * another list or tenant. The separate size check exists because a duplicate id can MASK a missing
 * one — `[a, a]` against `{a, b}` has the right length and, without it, would leave `b`'s
 * display_order stale while reporting success (the reference makes the same point at :33-35).
 *
 * DISABLED ITEMS ARE EXCLUDED, NOT MERELY OPTIONAL. Their `display_order` is inert — nothing renders
 * them in an orderable list — so reorder leaves it untouched, and a request that INCLUDES a disabled
 * id is a set mismatch. Pinned by the reference's own
 * `Reorder_WhenDisabledItemOmitted_ShouldSucceed_ActiveOnlyContract`.
 */
export async function reorderReferenceItems(
  deps: ReferenceDataDeps,
  listType: ReferenceListType,
  orderedIds: readonly number[],
  actor: ReferenceDataActor,
): Promise<void> {
  await withTransaction(deps.db, async (trx) => {
    const active = await listItems(trx, actor.tenantId, listType, false);
    const activeIds = new Set(active.map((item) => item.id));

    const requestedIds = new Set(orderedIds);
    if (requestedIds.size !== orderedIds.length || requestedIds.size !== activeIds.size) {
      throw reorderSetMismatchError();
    }
    for (const id of activeIds) {
      if (!requestedIds.has(id)) throw reorderSetMismatchError();
    }

    await applyDisplayOrder(trx, actor.tenantId, listType, orderedIds, actor.userId);

    await writeAudit(trx, {
      entityType: 'reference_item',
      // The reference used the LIST TYPE as the entity id here (:50) — a reorder is a change to the
      // list, not to any one row. Preserved so an audit reader can find it the same way.
      entityId: listType,
      action: REFERENCE_ITEM_REORDERED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: { orderedIds: active.map((item) => item.id) },
      after: { orderedIds: [...orderedIds] },
      ...auditContext(actor),
    });
  });
}
