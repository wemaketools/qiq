/**
 * Tenant Manager behaviour (T-016, AC-026, AC-027, AC-028, AC-024).
 *
 * Ports the six CQRS handlers under
 * `src/api/QuoteIQ.Application/Features/Tenants/` plus the transaction boundary that lived in
 * `src/api/QuoteIQ.Infrastructure/Tenancy/TenantStore.cs:33-47`.
 *
 * THE CREATION TRANSACTION IS THE POINT OF THIS FILE (AC-026, V-034)
 * =================================================================
 * A tenant is not "a row in `tenants`". A usable tenant is a row PLUS its per-tenant partitions
 * PLUS its default settings row PLUS its seeded reference lists. Any subset of those is a broken
 * tenant that fails later, somewhere else, in a way that looks like a different bug: writes falling
 * into a DEFAULT partition, a Lead with no status to be in, a business rule with no thresholds.
 *
 * So all four happen in ONE transaction, in the reference's order (TenantStore.CreateAsync:36-46
 * and CreateTenantCommandHandler.cs:63-85):
 *
 *   1. insert `tenants`                          TenantStore.cs:38-39
 *   2. select create_tenant_partitions(id)       TenantStore.cs:41-42   (DDL — transactional in PG)
 *   3. default `tenant_settings` row             CreateTenantCommandHandler.cs:70
 *   4. copy the global reference template        CreateTenantCommandHandler.cs:75
 *   5. audit `tenant.created`                    CreateTenantCommandHandler.cs:77-83
 *
 * Step 2 precedes steps 3-4 for a concrete reason: `tenant_settings` and `reference_items` are both
 * LIST-partitioned on `tenant_id`, and each has a DEFAULT partition safety net. Seeding BEFORE the
 * partitions exist would therefore not fail — it would quietly file the new tenant's rows in the
 * DEFAULT partition and look successful. The suite pins the partition each row landed in
 * (`tableoid::regclass`) precisely because a wrong order is otherwise invisible.
 *
 * Every failure below rolls all of it back, leaving no tenant row, no reference rows, no settings
 * row, no audit row, and no partitions.
 */
import { writeAudit } from '../audit/index.js';
import { seedTenantReferenceData } from '../reference-data/tenant-seeder.js';
import { toTenantId, withTransaction, type DbClient, type DbExecutor } from '../../lib/db/index.js';
import {
  duplicateActiveNameError,
  tenantAlreadyRemovedError,
  tenantNotFoundError,
  tenantNotRemovedError,
} from './errors.js';
import {
  activeNameExists,
  createTenantPartitions,
  findTenant,
  insertTenant,
  listTenants,
  restoreTenant,
  softRemoveTenant,
  updateTenant,
} from './repository.js';
import {
  TENANT_STATUS_REMOVED,
  type CreateTenantInput,
  type CreateTenantResultDto,
  type TenantDto,
  type UpdateTenantInput,
} from './schemas.js';

export interface TenantsDeps {
  readonly db: DbClient;
}

/** Who performed the action, for audit rows and the `*_by` stamps. */
export interface TenantActor {
  readonly userId: number;
  readonly correlationId?: string;
}

export const TENANT_CREATED_ACTION = 'tenant.created';
export const TENANT_UPDATED_ACTION = 'tenant.updated';
export const TENANT_REMOVED_ACTION = 'tenant.removed';
export const TENANT_RESTORED_ACTION = 'tenant.restored';

/** Contact-field snapshot used as the audit before/after payload (UpdateTenantCommandHandler.cs:43-49). */
function auditPayload(tenant: {
  readonly name: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}): Record<string, string | null> {
  return {
    name: tenant.name,
    contactName: tenant.contactName,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
  };
}

/** `null` for an absent optional contact field, so "" and null stay distinguishable on the wire. */
function orNull(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Default `tenant_settings` row (TenantSettingsProvisioningHook.cs:31-46). Every business-rule
 * value comes from the column defaults, which 20260718002200_tenant_settings.sql documents as being
 * kept 1:1 with the .NET property initialisers — so the row's content is identical whether it was
 * created here or by the reference.
 */
async function provisionDefaultSettings(
  executor: DbExecutor,
  tenantId: number,
  actorUserId: number,
): Promise<void> {
  const now = new Date().toISOString();
  await executor
    .insertInto('tenant_settings')
    .values({
      tenant_id: tenantId,
      created_at: now,
      created_by: actorUserId,
      updated_at: now,
      updated_by: actorUserId,
    })
    .execute();
}

/**
 * ListTenantsQueryHandler (:23-37).
 *
 * `includeRemoved` is a SECOND permission gate on top of the route's `tenants.view`: the caller
 * must also hold `tenants.view_removed` in the GLOBAL scope (:28 passes `null` as the tenant, since
 * this is a global endpoint with no ambient tenant). The 403 for that case is raised by the route,
 * which owns permission resolution.
 */
export async function listTenantsForCaller(
  deps: TenantsDeps,
  includeRemoved: boolean,
): Promise<TenantDto[]> {
  return await listTenants(deps.db, includeRemoved);
}

/**
 * GetTenantQueryHandler (:13-19).
 *
 * NOTE — PORTED AS-IS AND FLAGGED: a REMOVED tenant is returned by this endpoint to any caller with
 * `tenants.view`, even without `tenants.view_removed`. The reference's `FindAsync` applies no status
 * filter (TenantStore.cs:49-50) while its LIST path gates removed rows behind the extra permission.
 * Fetching one by id is not enumeration, so the disclosure is small, but the asymmetry is the
 * reference's and is preserved rather than silently "fixed".
 */
export async function getTenant(deps: TenantsDeps, tenantId: number): Promise<TenantDto> {
  const tenant = await findTenant(deps.db, tenantId);
  if (tenant === undefined) throw tenantNotFoundError(tenantId);
  return tenant;
}

export async function createTenant(
  deps: TenantsDeps,
  input: CreateTenantInput,
  actor: TenantActor,
): Promise<CreateTenantResultDto> {
  // CreateTenantCommandHandler.cs:49-52 — checked before the transaction opens, exactly as the
  // reference does. `uq_tenants_active_name` is the backstop if two creations race.
  if (await activeNameExists(deps.db, input.name, null)) {
    throw duplicateActiveNameError(input.name);
  }

  return await withTransaction(deps.db, async (trx) => {
    const tenant = await insertTenant(trx, {
      name: input.name,
      contactName: orNull(input.contactName),
      contactEmail: orNull(input.contactEmail),
      contactPhone: orNull(input.contactPhone),
      actorUserId: actor.userId,
    });

    const tenantId = toTenantId(tenant.id);

    await createTenantPartitions(trx, tenantId);
    await provisionDefaultSettings(trx, tenantId, actor.userId);
    await seedTenantReferenceData(trx, {
      tenantId,
      actorUserId: actor.userId,
      ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
    });

    await writeAudit(trx, {
      entityType: 'tenant',
      entityId: String(tenant.id),
      action: TENANT_CREATED_ACTION,
      actorUserId: actor.userId,
      // Global action: `audit_log.tenant_id` is nullable for exactly this (audit/types.ts), and the
      // reference wrote it with no ambient tenant because /api/v1/tenants carries no X-Tenant-Id.
      tenantId: null,
      before: null,
      after: auditPayload(tenant),
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });

    return { tenantId: tenant.id, name: tenant.name, status: tenant.status };
  });
}

/** UpdateTenantCommandHandler (:23-71). */
export async function updateTenantProfile(
  deps: TenantsDeps,
  tenantId: number,
  input: UpdateTenantInput,
  actor: TenantActor,
): Promise<TenantDto> {
  return await withTransaction(deps.db, async (trx) => {
    const existing = await findTenant(trx, tenantId);
    if (existing === undefined) throw tenantNotFoundError(tenantId);

    if (await activeNameExists(trx, input.name, tenantId)) {
      throw duplicateActiveNameError(input.name);
    }

    const updated = await updateTenant(trx, tenantId, {
      name: input.name,
      contactName: orNull(input.contactName),
      contactEmail: orNull(input.contactEmail),
      contactPhone: orNull(input.contactPhone),
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'tenant',
      entityId: String(tenantId),
      action: TENANT_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: null,
      before: auditPayload(existing),
      after: auditPayload(updated),
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });

    return updated;
  });
}

/**
 * RemoveTenantCommandHandler (:26-50). SOFT removal only — there is no hard-delete path in this
 * domain, and the suite asserts the tenant's partitioned data is untouched by it (AC-027).
 */
export async function removeTenant(
  deps: TenantsDeps,
  tenantId: number,
  actor: TenantActor,
): Promise<void> {
  await withTransaction(deps.db, async (trx) => {
    const existing = await findTenant(trx, tenantId);
    if (existing === undefined) throw tenantNotFoundError(tenantId);
    if (existing.status === TENANT_STATUS_REMOVED) throw tenantAlreadyRemovedError(tenantId);

    const removed = await softRemoveTenant(trx, tenantId, actor.userId);

    await writeAudit(trx, {
      entityType: 'tenant',
      entityId: String(tenantId),
      action: TENANT_REMOVED_ACTION,
      actorUserId: actor.userId,
      tenantId: null,
      // The reference audited only `new { tenant.Name }` (RemoveTenantCommandHandler.cs:46). This
      // port records the status transition on the before/after halves the shared writer always
      // emits (T-013), which is strictly more evidence and the same information plus the change.
      before: { name: existing.name, status: existing.status },
      after: { name: removed.name, status: removed.status },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}

/** RestoreTenantCommandHandler (:20-44). */
export async function restoreTenantById(
  deps: TenantsDeps,
  tenantId: number,
  actor: TenantActor,
): Promise<void> {
  await withTransaction(deps.db, async (trx) => {
    const existing = await findTenant(trx, tenantId);
    if (existing === undefined) throw tenantNotFoundError(tenantId);
    if (existing.status !== TENANT_STATUS_REMOVED) throw tenantNotRemovedError(tenantId);

    const restored = await restoreTenant(trx, tenantId, actor.userId);

    await writeAudit(trx, {
      entityType: 'tenant',
      entityId: String(tenantId),
      action: TENANT_RESTORED_ACTION,
      actorUserId: actor.userId,
      tenantId: null,
      before: { name: existing.name, status: existing.status },
      after: { name: restored.name, status: restored.status },
      ...(actor.correlationId === undefined
        ? {}
        : { context: { correlationId: actor.correlationId } }),
    });
  });
}
