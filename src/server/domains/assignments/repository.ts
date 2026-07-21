/**
 * Tenant-scoped `business_assignments` persistence (T-020, AC-022, AC-038).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/BusinessAssignments/BusinessAssignmentStore.cs`.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NO DATABASE NET UNDERNEATH
 * ========================================================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20). Everything touching
 * `business_assignments`, `lead_assignments` and `quote_assignments` here goes through
 * `forTenant(executor, tenantId)` with the branded `TenantId` the T-013 middleware verified, so the
 * predicate is applied by the helper and is table-qualified (it survives the roles join below).
 *
 * THE ONE QUERY THAT IS *NOT* `forTenant`-SCOPED, AND WHY THAT IS CORRECT
 * ======================================================================
 * Role lookup for validation reuses `rbac/admin-repository.ts`'s `findRole`, which reads `roles`
 * with the RAW executor. `roles` carries a NULLABLE `tenant_id` because a role may be tenant-scoped
 * OR global/Internal, and `forTenant` emits `tenant_id = $1`, which would silently drop every
 * GLOBAL role — making an Internal-managed default role unassignable to a slot, which the reference
 * explicitly permits (`TenantConfinement.IsAccessible` treats a null tenant as visible to all).
 * Confinement for that row is therefore applied in service.ts, deliberately, and translated into the
 * same uniform `ROLE_INVALID` a nonexistent id gets.
 *
 * ROWS ARE DELETED HERE, WHICH IS UNUSUAL IN THIS SCHEMA
 * =====================================================
 * Clearing a slot DELETES its row (`ApplySlot`, BusinessAssignmentStore.cs:69-76) rather than
 * soft-disabling it — this is configuration, not a business record, so N-09's no-hard-delete rule
 * does not apply. The delete is what makes the in-use check in service.ts load-bearing:
 * `lead_assignments.business_assignment_id` and `quote_assignments.business_assignment_id`
 * reference this row's id, so deleting a slot that live assignees point at would orphan them.
 */
import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import { RM_SLOT, UNDERWRITER_SLOT, type AssignmentSlot } from './schemas.js';

/** `BusinessAssignmentRow(Id, Slot, RoleId, RoleName)` — the store's projection. */
export interface AssignmentSlotRow {
  readonly assignmentId: number;
  readonly slot: AssignmentSlot;
  readonly roleId: number;
  readonly roleName: string;
}

/**
 * `BusinessAssignmentStore.QueryRows` (:88-93): the tenant's slot rows joined to their role names,
 * ordered by slot.
 *
 * THE JOIN IS INNER, MATCHING THE REFERENCE. A slot row whose role has been hard-deleted therefore
 * disappears from the response rather than rendering with a blank name. That state is unreachable
 * in practice — the User Manager deactivates roles, never deletes them
 * (rbac/admin-repository.ts's `deactivateRole`) — and an inner join is the honest reading of "the
 * role configured for this slot" when there is no role.
 *
 * `order by slot` puts `rm` before `underwriter` alphabetically, which happens to be the DTO's own
 * field order; nothing depends on it, since the DTO addresses slots by name.
 */
export async function listSlots(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<AssignmentSlotRow[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('business_assignments')
    .innerJoin('roles', 'roles.id', 'business_assignments.role_id')
    .select([
      'business_assignments.id as assignment_id',
      'business_assignments.slot as slot',
      'business_assignments.role_id as role_id',
      'roles.name as role_name',
    ])
    .orderBy('business_assignments.slot')
    .execute();

  return rows.map((row) => ({
    assignmentId: Number(row.assignment_id),
    slot: row.slot as AssignmentSlot,
    roleId: Number(row.role_id),
    roleName: row.role_name,
  }));
}

/**
 * `BusinessAssignmentStore.HasLiveAssignmentsAsync` (:51-64): is any lead or quote still assigned
 * against this slot row?
 *
 * BOTH TABLES ARE CHECKED, AND BOTH ARE TENANT-PREDICATED. The tenant predicate is not merely
 * defensive here: `business_assignments.id` is only unique WITHIN a tenant (the PK is
 * `(tenant_id, id)`, 20260718002300_business_assignments.sql:59), so an unscoped lookup by
 * assignment id alone could match another tenant's assignee rows and block — or, read the other
 * way, fail to block — the wrong tenant's slot clear.
 */
export async function hasLiveAssignments(
  executor: DbExecutor,
  tenantId: TenantId,
  assignmentId: number,
): Promise<boolean> {
  const scope = forTenant(executor, tenantId);

  const leadAssignment = await scope
    .selectFrom('lead_assignments')
    .select('id')
    .where('business_assignment_id', '=', assignmentId)
    .executeTakeFirst();
  if (leadAssignment !== undefined) return true;

  const quoteAssignment = await scope
    .selectFrom('quote_assignments')
    .select('id')
    .where('business_assignment_id', '=', assignmentId)
    .executeTakeFirst();

  return quoteAssignment !== undefined;
}

/**
 * `BusinessAssignmentStore.ApplySlot` (:66-86) for one slot.
 *
 *   roleId === null  -> delete the slot row, if any (the caller has already proven it is unused)
 *   row exists       -> UPDATE its role_id, keeping the row id, so every `lead_assignments` /
 *                       `quote_assignments` row pointing at this slot stays attached and the
 *                       tenant's existing assignees survive a role change
 *   no row           -> INSERT
 *
 * That update-in-place is the whole reason the reference does not simply delete-and-reinsert both
 * slots: reinserting would mint a new id and silently detach every live assignee.
 */
async function applySlot(
  executor: DbExecutor,
  tenantId: TenantId,
  slot: AssignmentSlot,
  roleId: number | null,
  existing: readonly AssignmentSlotRow[],
  actorUserId: number,
): Promise<void> {
  const scope = forTenant(executor, tenantId);
  const current = existing.find((row) => row.slot === slot);
  const now = new Date().toISOString();

  if (roleId === null) {
    if (current !== undefined) {
      await scope.deleteFrom('business_assignments').where('id', '=', current.assignmentId).execute();
    }
    return;
  }

  if (current !== undefined) {
    if (current.roleId === roleId) return;
    await scope
      .updateTable('business_assignments')
      .set({ role_id: roleId, updated_at: now, updated_by: actorUserId })
      .where('id', '=', current.assignmentId)
      .execute();
    return;
  }

  await scope
    .insertInto('business_assignments', {
      slot,
      role_id: roleId,
      created_at: now,
      created_by: actorUserId,
      updated_at: now,
      updated_by: actorUserId,
    })
    .execute();
}

/**
 * `BusinessAssignmentStore.ReplaceAsync` (:33-48): applies both slots and returns the stored
 * result, so the response reflects the DATABASE rather than echoing the request.
 *
 * Full replace, not patch: an omitted slot arrives as `null` from the schema and clears that slot.
 */
export async function replaceSlots(
  executor: DbExecutor,
  tenantId: TenantId,
  rmRoleId: number | null,
  underwritingRoleId: number | null,
  existing: readonly AssignmentSlotRow[],
  actorUserId: number,
): Promise<AssignmentSlotRow[]> {
  await applySlot(executor, tenantId, RM_SLOT, rmRoleId, existing, actorUserId);
  await applySlot(executor, tenantId, UNDERWRITER_SLOT, underwritingRoleId, existing, actorUserId);

  return await listSlots(executor, tenantId);
}
