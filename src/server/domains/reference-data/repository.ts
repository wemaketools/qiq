/**
 * Tenant-scoped `reference_items` persistence (T-019, AC-022, AC-035, AC-036).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/ReferenceData/ReferenceDataStore.cs`.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NO DATABASE NET UNDERNEATH
 * ========================================================================
 * The reference relied on TWO layers: an explicit `TenantId == _tenantContext.TenantId` predicate on
 * every query (ReferenceDataStore.cs:9-23 explains why it did not trust the ambient EF query filter,
 * which is a deliberate no-op for cross-tenant Internal callers) AND EF's filter behind it. This
 * port has only ONE layer, and it is stricter about it: Postgres RLS is NOT adopted (spec Q-10,
 * human decision 2026-07-20), so a forgotten predicate here is an unguarded cross-tenant read with
 * nothing beneath it to catch the mistake.
 *
 * That is why nothing in this file touches the raw executor: every function goes through
 * `forTenant(executor, tenantId)`, whose `selectFrom`/`updateTable`/`insertInto` apply the
 * table-qualified predicate themselves and whose `insertInto` INJECTS `tenant_id` so a row cannot be
 * written into another tenant even by an explicitly hostile body (lib/db/tenant.ts:17-27). The
 * tenant id is the branded `TenantId` the T-013 middleware verified — never a header, never a body
 * field. `reference-data.test.ts` asserts the outcome per endpoint (AC-022/V-027) rather than
 * trusting the construction.
 *
 * NO DELETE FUNCTION EXISTS IN THIS FILE, AND THERE MUST NOT BE ONE (AC-036, spec §11.2). Disabling
 * (`is_active = false`) is the only removal path, so a historical Lead or Quote pointing at a value
 * keeps resolving it forever; only pickers filter it out.
 */
import { sql } from 'kysely';

import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import type { ReferenceItemDto } from './schemas.js';

/** Columns every reference-data response projects — exactly `ReferenceItemDto`'s fields. */
const ITEM_COLUMNS = [
  'id',
  'list_type',
  'name',
  'display_order',
  'is_active',
  'is_broker_channel',
  'product_line_id',
  'reporting_category',
  'canonical_key',
  'is_terminal',
] as const;

interface ItemRow {
  readonly id: number;
  readonly list_type: string;
  readonly name: string;
  readonly display_order: number;
  readonly is_active: boolean;
  readonly is_broker_channel: boolean | null;
  readonly product_line_id: number | null;
  readonly reporting_category: string | null;
  readonly canonical_key: string | null;
  readonly is_terminal: boolean;
}

export function toReferenceItemDto(row: ItemRow): ReferenceItemDto {
  return {
    // `bigint` arrives as a string from node-postgres on some paths; Number() is safe for ids
    // within the safe-integer range, which identity columns are for the life of this product.
    id: Number(row.id),
    listType: row.list_type,
    name: row.name,
    displayOrder: row.display_order,
    isActive: row.is_active,
    isBrokerChannel: row.is_broker_channel,
    productLineId: row.product_line_id === null ? null : Number(row.product_line_id),
    reportingCategory: row.reporting_category,
    canonicalKey: row.canonical_key,
    isTerminal: row.is_terminal,
  };
}

/**
 * `ReferenceDataStore.ListAsync` (:35-45).
 *
 * `includeDisabled: false` is the PICKER contract (AC-036): disabled rows are withheld from the
 * options a new record may choose from. `true` is the management screen and the historical-resolution
 * read, which must still see them. Ordering is `display_order` then `id`, so the reorder endpoint's
 * result is what a caller reads back.
 */
export async function listItems(
  executor: DbExecutor,
  tenantId: TenantId,
  listType: string,
  includeDisabled: boolean,
): Promise<ReferenceItemDto[]> {
  let query = forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select(ITEM_COLUMNS)
    .where('list_type', '=', listType);

  if (!includeDisabled) {
    query = query.where('is_active', '=', true);
  }

  const rows = await query.orderBy('display_order').orderBy('id').execute();
  return rows.map(toReferenceItemDto);
}

/**
 * `ReferenceDataStore.FindAsync` (:56-60).
 *
 * NOTE THE ABSENT `list_type` PREDICATE — ported deliberately. The reference's update and disable
 * commands address an item by id ALONE (UpdateItemCommand.cs:13, DisableItemCommand.cs:10) and the
 * endpoint only parses the route's `{listType}` without passing it down (ReferenceDataEndpoints.cs:69,83).
 * So `PUT /settings/reference-data/region/{id}` where `{id}` is a broker type SUCCEEDS in the
 * reference, editing the broker type. That is a contract quirk, not a security hole — the tenant
 * predicate still applies, so it can only ever reach the caller's own rows — and it is preserved
 * rather than silently tightened, because tightening it would turn a currently-200 SPA request into
 * a 404. Flagged in the task file.
 */
export async function findItem(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<ReferenceItemDto | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select(ITEM_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? undefined : toReferenceItemDto(row);
}

/**
 * `ReferenceDataStore.NameExistsAsync` (:62-70): case-insensitive within one (tenant, list_type),
 * optionally excluding one id so an update may keep its own name.
 *
 * DISABLED ROWS COUNT (there is no `is_active` filter in the reference either): a disabled value
 * still owns its name, because `uq_reference_items_tenant_list_name` is a plain unique constraint on
 * (tenant_id, list_type, name) with no partial predicate, so re-using the name would fail at the
 * database with a raw 500 instead of this 422.
 */
export async function nameExists(
  executor: DbExecutor,
  tenantId: TenantId,
  listType: string,
  name: string,
  excludeId: number | null,
): Promise<boolean> {
  let query = forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select('id')
    .where('list_type', '=', listType)
    .where(sql<boolean>`lower(name) = lower(${name})`);

  if (excludeId !== null) {
    query = query.where('id', '!=', excludeId);
  }

  return (await query.executeTakeFirst()) !== undefined;
}

/**
 * `ReferenceDataStore.IsActiveProductLineAsync` (:72-81).
 *
 * ACTIVE is the operative word and is AC-036's server-side enforcement: once a product line is
 * disabled, no new or edited cover type may point at it, while the cover types already pointing at
 * it keep resolving the row.
 */
export async function isActiveProductLine(
  executor: DbExecutor,
  tenantId: TenantId,
  productLineId: number,
): Promise<boolean> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select('id')
    .where('id', '=', productLineId)
    .where('list_type', '=', 'product_line')
    .where('is_active', '=', true)
    .executeTakeFirst();

  return row !== undefined;
}

export interface InsertItemValues {
  readonly listType: string;
  readonly name: string;
  readonly isBrokerChannel: boolean | null;
  readonly productLineId: number | null;
  readonly reportingCategory: string | null;
  readonly actorUserId: number;
}

/**
 * `ReferenceDataStore.AddAsync` (:154-159) with the fields CreateItemCommandHandler.cs:65-78 set.
 *
 * `display_order` is 0 and `canonical_key`/`is_terminal` are null/false UNCONDITIONALLY: a
 * tenant-created row is never canonical and never terminal, which is what keeps the guarded taxonomy
 * closed (only the tenant-creation seed writes those columns). New items therefore all sort at the
 * head of the list until the tenant reorders — the reference's behaviour, preserved.
 */
export async function insertItem(
  executor: DbExecutor,
  tenantId: TenantId,
  values: InsertItemValues,
): Promise<ReferenceItemDto> {
  const now = new Date().toISOString();

  const inserted = await forTenant(executor, tenantId)
    .insertInto('reference_items', {
      list_type: values.listType,
      name: values.name,
      display_order: 0,
      is_active: true,
      is_broker_channel: values.isBrokerChannel,
      product_line_id: values.productLineId,
      reporting_category: values.reportingCategory,
      canonical_key: null,
      is_terminal: false,
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(ITEM_COLUMNS)
    .executeTakeFirstOrThrow();

  return toReferenceItemDto(inserted);
}

export interface UpdateItemValues {
  readonly name: string;
  readonly isBrokerChannel: boolean | null;
  readonly productLineId: number | null;
  readonly reportingCategory: string | null;
  readonly actorUserId: number;
}

/**
 * The write half of UpdateItemCommandHandler.cs:89-105. Which of these values differ from the
 * existing row is decided in the service, not here: this function writes exactly what it is given,
 * so the guard ("a canonical status keeps its reporting category") lives in one place rather than
 * being half-enforced by a repository default.
 */
export async function updateItem(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  values: UpdateItemValues,
): Promise<ReferenceItemDto> {
  const updated = await forTenant(executor, tenantId)
    .updateTable('reference_items')
    .set({
      name: values.name,
      is_broker_channel: values.isBrokerChannel,
      product_line_id: values.productLineId,
      reporting_category: values.reportingCategory,
      updated_at: new Date().toISOString(),
      updated_by: values.actorUserId,
    })
    .where('id', '=', id)
    .returning(ITEM_COLUMNS)
    .executeTakeFirstOrThrow();

  return toReferenceItemDto(updated);
}

/** DisableItemCommandHandler.cs:41-42. Sets the flag; deletes nothing. */
export async function disableItem(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  actorUserId: number,
): Promise<void> {
  await forTenant(executor, tenantId)
    .updateTable('reference_items')
    .set({
      is_active: false,
      updated_at: new Date().toISOString(),
      updated_by: actorUserId,
    })
    .where('id', '=', id)
    .execute();
}

/**
 * ReorderItemsCommandHandler.cs:42-47, one statement instead of a per-row loop.
 *
 * `display_order` becomes the item's INDEX in `orderedIds` (0-based, matching the reference's
 * `for (var index = 0; ...)`), applied only to rows that are in this tenant AND this list — the
 * service has already proved the id set is exactly the list's active set, and the predicates here
 * mean that even a proof bug could not move another list's or another tenant's row.
 */
export async function applyDisplayOrder(
  executor: DbExecutor,
  tenantId: TenantId,
  listType: string,
  orderedIds: readonly number[],
  actorUserId: number,
): Promise<void> {
  const now = new Date().toISOString();

  for (const [index, id] of orderedIds.entries()) {
    await forTenant(executor, tenantId)
      .updateTable('reference_items')
      .set({ display_order: index, updated_at: now, updated_by: actorUserId })
      .where('id', '=', id)
      .where('list_type', '=', listType)
      .execute();
  }
}
