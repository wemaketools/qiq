/**
 * `tenants` registry persistence (T-016, AC-026, AC-027, AC-028).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Tenancy/TenantStore.cs`. Every function takes a
 * `DbExecutor` rather than a client, so the same code runs standalone and inside the
 * tenant-creation transaction (lib/db/types.ts's stated repository contract).
 *
 * THERE IS NO DELETE FUNCTION IN THIS FILE, AND THERE MUST NOT BE (AC-027, N-09). Removal is
 * `status = 'removed'` plus `removed_at`/`removed_by`; history, audit rows and every row in the
 * tenant's partitions stay exactly where they are. The absence of a hard-delete path is asserted by
 * the suite, not merely intended.
 *
 * The `tenants` table is global/unpartitioned (20260718001000_tenants.sql), so these queries
 * legitimately use the raw executor rather than `forTenant(...)` — Tenant Manager is the
 * cross-tenant surface (spec §374).
 */
import { sql } from 'kysely';

import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { TENANT_STATUS_ACTIVE, TENANT_STATUS_REMOVED, type TenantDto } from './schemas.js';

/** The columns every Tenant Manager response projects. */
const TENANT_COLUMNS = [
  'id',
  'name',
  'contact_name',
  'contact_email',
  'contact_phone',
  'status',
  'removed_at',
] as const;

interface TenantRecord {
  readonly id: number;
  readonly name: string;
  readonly contact_name: string | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
  readonly status: string;
  /** `timestamptz`; node-postgres hands back a `Date` even though the generated type says string. */
  readonly removed_at: string | Date | null;
}

/**
 * `DateTimeOffset?` -> ISO 8601. The reference emitted .NET's round-trip form
 * (`2026-07-19T18:00:00.0000000+00:00`); this emits the JS/JSON form (`...Z`). Both parse
 * identically with `new Date(...)`, which is all the SPA does with the field.
 */
function toIsoOrNull(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toTenantDto(record: TenantRecord): TenantDto {
  return {
    id: Number(record.id),
    name: record.name,
    contactName: record.contact_name,
    contactEmail: record.contact_email,
    contactPhone: record.contact_phone,
    status: record.status,
    removedAt: toIsoOrNull(record.removed_at),
  };
}

/**
 * TenantStore.ActiveNameExistsAsync (:23-31): case-insensitive, ACTIVE tenants only, optionally
 * excluding one id so an update may keep its own name. Removed tenants do not reserve their name —
 * the same rule the partial unique index enforces underneath.
 */
export async function activeNameExists(
  executor: DbExecutor,
  name: string,
  excludeTenantId: number | null,
): Promise<boolean> {
  let query = executor
    .selectFrom('tenants')
    .select('id')
    .where('status', '=', TENANT_STATUS_ACTIVE)
    .where(sql<boolean>`lower(name) = lower(${name})`);

  if (excludeTenantId !== null) {
    query = query.where('id', '!=', excludeTenantId);
  }

  return (await query.executeTakeFirst()) !== undefined;
}

export interface InsertTenantValues {
  readonly name: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly actorUserId: number;
}

/**
 * Inserts the tenant row. `created_by`/`updated_by` carry the acting user and the timestamps are
 * server-set, mirroring AuditSaveChangesInterceptor.StampAuditFields (:44-53) — the reference
 * stamped these on every `IAuditableEntity` rather than in the handler.
 */
export async function insertTenant(
  executor: DbExecutor,
  values: InsertTenantValues,
): Promise<TenantDto> {
  const now = new Date().toISOString();

  const inserted = await executor
    .insertInto('tenants')
    .values({
      name: values.name,
      contact_name: values.contactName,
      contact_email: values.contactEmail,
      contact_phone: values.contactPhone,
      status: TENANT_STATUS_ACTIVE,
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(TENANT_COLUMNS)
    .executeTakeFirstOrThrow();

  return toTenantDto(inserted);
}

/**
 * `SELECT create_tenant_partitions(id)` (TenantStore.cs:41-42).
 *
 * Called with the SAME executor as the tenant insert, which is what makes the partition DDL part
 * of the creation transaction: PostgreSQL DDL is transactional, so a later failure discards the
 * partitions along with the tenant row.
 *
 * The function is SECURITY INVOKER by design (20260718001500_partition_function.sql header) — it
 * creates tables, so it must run with the caller's rights. The connection therefore has to OWN the
 * partitioned parents: PostgreSQL requires ownership of the parent table to attach a partition, and
 * no grantable privilege confers that. A previous version of this comment claimed CREATE on `public`
 * was the requirement and that T-014 had to preserve it when hardening roles; that was false on both
 * counts — CREATE on schema is necessary but nowhere near sufficient (a role with it still gets
 * `must be owner of table alerts`), and T-014 no longer hardens any role because Postgres RLS is not
 * adopted (spec Q-10, human decision 2026-07-20). Today the app connects as the owner, so this holds.
 */
export async function createTenantPartitions(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<void> {
  await sql`select create_tenant_partitions(${tenantId})`.execute(executor);
}

export async function findTenant(
  executor: DbExecutor,
  tenantId: number,
): Promise<TenantDto | undefined> {
  const row = await executor
    .selectFrom('tenants')
    .select(TENANT_COLUMNS)
    .where('id', '=', tenantId)
    .executeTakeFirst();

  return row === undefined ? undefined : toTenantDto(row);
}

/**
 * TenantStore.ListAsync (:55-64): ordered by name, and filtered to active tenants unless the caller
 * asked for — and was permitted — removed ones.
 */
export async function listTenants(
  executor: DbExecutor,
  includeRemoved: boolean,
): Promise<TenantDto[]> {
  let query = executor.selectFrom('tenants').select(TENANT_COLUMNS).orderBy('name');
  if (!includeRemoved) {
    query = query.where('status', '=', TENANT_STATUS_ACTIVE);
  }
  return (await query.execute()).map(toTenantDto);
}

export interface UpdateTenantValues {
  readonly name: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly actorUserId: number;
}

export async function updateTenant(
  executor: DbExecutor,
  tenantId: number,
  values: UpdateTenantValues,
): Promise<TenantDto> {
  const updated = await executor
    .updateTable('tenants')
    .set({
      name: values.name,
      contact_name: values.contactName,
      contact_email: values.contactEmail,
      contact_phone: values.contactPhone,
      updated_at: new Date().toISOString(),
      updated_by: values.actorUserId,
    })
    .where('id', '=', tenantId)
    .returning(TENANT_COLUMNS)
    .executeTakeFirstOrThrow();

  return toTenantDto(updated);
}

/**
 * SOFT removal (RemoveTenantCommandHandler.cs:39-43). Sets the status and stamps who removed it and
 * when. No row is deleted, here or anywhere else in this domain.
 */
export async function softRemoveTenant(
  executor: DbExecutor,
  tenantId: number,
  actorUserId: number,
): Promise<TenantDto> {
  const now = new Date().toISOString();

  const removed = await executor
    .updateTable('tenants')
    .set({
      status: TENANT_STATUS_REMOVED,
      removed_at: now,
      removed_by: actorUserId,
      updated_at: now,
      updated_by: actorUserId,
    })
    .where('id', '=', tenantId)
    .returning(TENANT_COLUMNS)
    .executeTakeFirstOrThrow();

  return toTenantDto(removed);
}

/** Reactivation (RestoreTenantCommandHandler.cs:33-35): status back to active, stamps cleared. */
export async function restoreTenant(
  executor: DbExecutor,
  tenantId: number,
  actorUserId: number,
): Promise<TenantDto> {
  const restored = await executor
    .updateTable('tenants')
    .set({
      status: TENANT_STATUS_ACTIVE,
      removed_at: null,
      removed_by: null,
      updated_at: new Date().toISOString(),
      updated_by: actorUserId,
    })
    .where('id', '=', tenantId)
    .returning(TENANT_COLUMNS)
    .executeTakeFirstOrThrow();

  return toTenantDto(restored);
}
