/**
 * Tenant-scoped `brokers` / `broker_contacts` persistence (T-021, AC-022, AC-039).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Brokers/BrokerStore.cs`.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NO DATABASE NET UNDERNEATH
 * ========================================================================
 * The reference relied on TWO layers: an explicit `TenantId == _tenantContext.TenantId` predicate on
 * every query (BrokerStore.cs:8-22 explains why it did not trust the ambient EF query filter, which
 * is a deliberate no-op for cross-tenant Internal callers) AND EF's filter behind it. This port has
 * only ONE layer, and is stricter about it: Postgres RLS is NOT adopted (spec Q-10, human decision
 * 2026-07-20), so a forgotten predicate here is an unguarded cross-tenant read with nothing beneath
 * it to catch the mistake.
 *
 * That is why nothing in this file touches the raw executor: every function goes through
 * `forTenant(executor, tenantId)`, whose `selectFrom`/`updateTable`/`deleteFrom` apply the
 * table-qualified predicate themselves and whose `insertInto` INJECTS `tenant_id` so a row cannot be
 * written into another tenant even by an explicitly hostile body (lib/db/tenant.ts:17-27). The
 * tenant id is the branded `TenantId` the T-013 middleware verified — never a header, never a body
 * field. `brokers.test.ts` asserts the outcome per endpoint (AC-022/V-027) rather than trusting the
 * construction.
 *
 * THE CONTACT LOOKUPS ALSO CARRY `broker_id`, WHICH IS NOT DECORATION. `broker_contacts.id` is
 * unique on its own, so a lookup by `(tenant_id, id)` alone would happily resolve a contact through
 * ANOTHER broker's URL and let a caller edit it there. The reference resolves contacts within the
 * parent broker's list for the same reason (RemoveContactCommandHandler.cs:49-50).
 *
 * THE ONLY DELETE IN THIS FILE IS `deleteContact`. Brokers themselves are NEVER hard-deleted
 * (N-09, AC-075): `disableBroker` flips the status so historical leads and quotes pointing at a
 * retired broker keep resolving it. Contacts have no such requirement — nothing references a
 * contact row — and the reference removes them outright (BrokerStore.cs:151-165).
 */
import { sql } from 'kysely';

import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import type { BrokerContactDto, BrokerSummaryDto } from './schemas.js';

const BROKER_COLUMNS = ['id', 'name', 'broker_type_id', 'branch', 'status'] as const;
const CONTACT_COLUMNS = ['id', 'name', 'email', 'phone', 'is_primary'] as const;

interface BrokerRow {
  readonly id: number;
  readonly name: string;
  readonly broker_type_id: number | null;
  readonly branch: string | null;
  readonly status: string;
}

interface ContactRow {
  readonly id: number;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly is_primary: boolean;
}

function toBrokerSummary(row: BrokerRow): BrokerSummaryDto {
  return {
    // `bigint` arrives as a string from node-postgres on some paths; Number() is safe for ids
    // within the safe-integer range, which identity columns are for the life of this product.
    id: Number(row.id),
    name: row.name,
    brokerTypeId: row.broker_type_id === null ? null : Number(row.broker_type_id),
    branch: row.branch,
    status: row.status,
  };
}

function toContactDto(row: ContactRow): BrokerContactDto {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    isPrimary: row.is_primary,
  };
}

export interface ListBrokersFilters {
  readonly status: string | undefined;
  readonly brokerTypeId: number | undefined;
  readonly search: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

export interface BrokerPage {
  readonly items: BrokerSummaryDto[];
  readonly totalCount: number;
}

/**
 * `BrokerStore.ListAsync` (:34-66).
 *
 * `totalCount` is the size of the FILTERED set before paging, so a caller can compute page counts;
 * ordering is `name` then `id`, which makes paging stable across requests (an id-only order would
 * scramble the alphabetical Settings list, and no order at all would let a row appear on two pages).
 * The search is `lower(name) like %term%`, matching the reference's `Name.ToLower().Contains(...)`.
 */
export async function listBrokers(
  executor: DbExecutor,
  tenantId: TenantId,
  filters: ListBrokersFilters,
): Promise<BrokerPage> {
  const scope = forTenant(executor, tenantId);

  let query = scope.selectFrom('brokers').select(BROKER_COLUMNS);
  let countQuery = scope
    .selectFrom('brokers')
    .select(({ fn }) => fn.countAll().as('count'));

  if (filters.status !== undefined && filters.status.trim() !== '') {
    query = query.where('status', '=', filters.status);
    countQuery = countQuery.where('status', '=', filters.status);
  }
  if (filters.brokerTypeId !== undefined) {
    query = query.where('broker_type_id', '=', filters.brokerTypeId);
    countQuery = countQuery.where('broker_type_id', '=', filters.brokerTypeId);
  }
  if (filters.search !== undefined && filters.search.trim() !== '') {
    const pattern = `%${filters.search.toLowerCase()}%`;
    query = query.where(sql<boolean>`lower(name) like ${pattern}`);
    countQuery = countQuery.where(sql<boolean>`lower(name) like ${pattern}`);
  }

  const counted = await countQuery.executeTakeFirst();
  const rows = await query
    .orderBy('name')
    .orderBy('id')
    .offset((filters.page - 1) * filters.pageSize)
    .limit(filters.pageSize)
    .execute();

  return {
    items: rows.map(toBrokerSummary),
    totalCount: Number(counted?.count ?? 0),
  };
}

/** `BrokerStore.FindAsync` (:68-72). Another tenant's id resolves to `undefined`, hence a 404. */
export async function findBroker(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<BrokerSummaryDto | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('brokers')
    .select(BROKER_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? undefined : toBrokerSummary(row);
}

/**
 * `BrokerStore.NameExistsAsync` (:74-82): case-insensitive within the tenant, optionally excluding
 * one id so an update may keep its own name.
 *
 * DISABLED BROKERS COUNT (there is no `status` filter in the reference either): a disabled broker
 * still owns its name, because `uq_brokers_tenant_name` is a plain unique constraint on
 * (tenant_id, name) with no partial predicate, so re-using the name would fail at the database with
 * a raw 500 instead of this 409.
 */
export async function brokerNameExists(
  executor: DbExecutor,
  tenantId: TenantId,
  name: string,
  excludeId: number | null,
): Promise<boolean> {
  let query = forTenant(executor, tenantId)
    .selectFrom('brokers')
    .select('id')
    .where(sql<boolean>`lower(name) = lower(${name})`);

  if (excludeId !== null) {
    query = query.where('id', '!=', excludeId);
  }

  return (await query.executeTakeFirst()) !== undefined;
}

/**
 * `ReferenceDataStore.IsActiveBrokerTypeAsync` (:83-92).
 *
 * All four predicates matter: tenant (another tenant's type is not usable), id, `list_type`
 * (a region id must not pass as a broker type) and `is_active` (a retired tier may not be assigned
 * to anything new, while the brokers already pointing at it keep resolving the row — AC-036's rule,
 * applied here).
 */
export async function isActiveBrokerType(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerTypeId: number,
): Promise<boolean> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select('id')
    .where('id', '=', brokerTypeId)
    .where('list_type', '=', 'broker_type')
    .where('is_active', '=', true)
    .executeTakeFirst();

  return row !== undefined;
}

export interface InsertBrokerValues {
  readonly name: string;
  readonly brokerTypeId: number | null;
  readonly branch: string | null;
  readonly actorUserId: number;
}

/** `BrokerStore.AddAsync` (:84-89). `status` starts 'active'; only disable ever changes it. */
export async function insertBroker(
  executor: DbExecutor,
  tenantId: TenantId,
  values: InsertBrokerValues,
): Promise<BrokerSummaryDto> {
  const now = new Date().toISOString();

  const inserted = await forTenant(executor, tenantId)
    .insertInto('brokers', {
      name: values.name,
      broker_type_id: values.brokerTypeId,
      branch: values.branch,
      status: 'active',
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(BROKER_COLUMNS)
    .executeTakeFirstOrThrow();

  return toBrokerSummary(inserted);
}

export interface UpdateBrokerValues {
  readonly name: string;
  readonly brokerTypeId: number | null;
  readonly branch: string | null;
  readonly actorUserId: number;
}

/**
 * The write half of `UpdateBrokerCommandHandler.cs:57-61`.
 *
 * All three fields are written unconditionally — an absent optional field CLEARS the column, which
 * is the reference's behaviour for a full-replace PUT. `status` is deliberately absent from the
 * SET list: no update path may change it.
 */
export async function updateBroker(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  values: UpdateBrokerValues,
): Promise<BrokerSummaryDto> {
  const updated = await forTenant(executor, tenantId)
    .updateTable('brokers')
    .set({
      name: values.name,
      broker_type_id: values.brokerTypeId,
      branch: values.branch,
      updated_at: new Date().toISOString(),
      updated_by: values.actorUserId,
    })
    .where('id', '=', id)
    .returning(BROKER_COLUMNS)
    .executeTakeFirstOrThrow();

  return toBrokerSummary(updated);
}

/** `DisableBrokerCommandHandler.cs:32-33`. Sets the status; deletes nothing (N-09). */
export async function disableBroker(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  actorUserId: number,
): Promise<void> {
  await forTenant(executor, tenantId)
    .updateTable('brokers')
    .set({
      status: 'disabled',
      updated_at: new Date().toISOString(),
      updated_by: actorUserId,
    })
    .where('id', '=', id)
    .execute();
}

/** `BrokerStore.ListContactsAsync` (:93-100). Ordered by id — oldest first, which the promotion
 * rule in the service depends on. */
export async function listContacts(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number,
): Promise<BrokerContactDto[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('broker_contacts')
    .select(CONTACT_COLUMNS)
    .where('broker_id', '=', brokerId)
    .orderBy('id')
    .execute();

  return rows.map(toContactDto);
}

export interface InsertContactValues {
  readonly brokerId: number;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isPrimary: boolean;
  readonly actorUserId: number;
}

/** `BrokerStore.AddContactAsync`'s insert half (:125-126). */
export async function insertContact(
  executor: DbExecutor,
  tenantId: TenantId,
  values: InsertContactValues,
): Promise<BrokerContactDto> {
  const now = new Date().toISOString();

  const inserted = await forTenant(executor, tenantId)
    .insertInto('broker_contacts', {
      broker_id: values.brokerId,
      name: values.name,
      email: values.email,
      phone: values.phone,
      is_primary: values.isPrimary,
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(CONTACT_COLUMNS)
    .executeTakeFirstOrThrow();

  return toContactDto(inserted);
}

export interface UpdateContactValues {
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly actorUserId: number;
}

/**
 * `UpdateContactCommandHandler.cs:44-48`.
 *
 * `is_primary` is NOT in the SET list, and that is the invariant's protection at the lowest layer:
 * even a future caller who managed to smuggle the flag past the schema could not write it here.
 */
export async function updateContact(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number,
  contactId: number,
  values: UpdateContactValues,
): Promise<BrokerContactDto> {
  const updated = await forTenant(executor, tenantId)
    .updateTable('broker_contacts')
    .set({
      name: values.name,
      email: values.email,
      phone: values.phone,
      updated_at: new Date().toISOString(),
      updated_by: values.actorUserId,
    })
    .where('id', '=', contactId)
    .where('broker_id', '=', brokerId)
    .returning(CONTACT_COLUMNS)
    .executeTakeFirstOrThrow();

  return toContactDto(updated);
}

/** `BrokerStore.RemoveContactAsync`'s delete half (:155). */
export async function deleteContact(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number,
  contactId: number,
): Promise<void> {
  await forTenant(executor, tenantId)
    .deleteFrom('broker_contacts')
    .where('id', '=', contactId)
    .where('broker_id', '=', brokerId)
    .execute();
}

/**
 * Flips one contact's primary marker.
 *
 * Callers MUST demote before they promote. `uq_broker_contacts_primary`
 * (20260718003100_brokers.sql:100-102) is a partial unique index on (tenant_id, broker_id) where
 * `is_primary`, so a promote landing before the matching demote raises 23505 even though the
 * transaction as a whole would have been consistent — the reference records the same ordering
 * requirement as F-043 (BrokerStore.cs:16-20).
 */
export async function setContactPrimary(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number,
  contactId: number,
  isPrimary: boolean,
  actorUserId: number,
): Promise<void> {
  await forTenant(executor, tenantId)
    .updateTable('broker_contacts')
    .set({
      is_primary: isPrimary,
      updated_at: new Date().toISOString(),
      updated_by: actorUserId,
    })
    .where('id', '=', contactId)
    .where('broker_id', '=', brokerId)
    .execute();
}
