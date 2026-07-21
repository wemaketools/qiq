/**
 * Business-assignment slot behaviour (T-020, AC-022, AC-024, AC-038).
 *
 * Ports `GetBusinessAssignmentsQueryHandler` and `UpdateBusinessAssignmentsCommandHandler`
 * (src/api/QuoteIQ.Application/Features/BusinessAssignments/).
 *
 * WHAT THE TWO SLOTS MEAN DOWNSTREAM (P-07) — the reason this is not merely a settings table
 * =========================================================================================
 * The `rm` slot's role defines who may be a lead's ACCOUNTABLE OWNER; the `underwriter` slot's role
 * defines who Send-to-underwriting and quote assignment may target. The workflow tasks resolve
 * eligible assignees from these rows, and `lead_assignments`/`quote_assignments` reference the slot
 * ROW rather than the role — which is why changing a slot's configured role keeps existing
 * assignees attached (repository.ts) while clearing one is refused whenever live assignees remain.
 *
 * THE OPERATION ORDER IS OBSERVABLE AND IS THE REFERENCE'S (:41-84)
 * ================================================================
 *   1. validate the payload         (different roles)      -> 422 VALIDATION_FAILED
 *   2. validate every role referenced (exists/active/visible) -> 422 ROLE_INVALID
 *   3. refuse to clear a slot with live assignees          -> 409 ASSIGNMENT_ROLE_IN_USE
 *   4. replace both slots, then audit
 * A request that both names an invalid role AND clears an in-use slot reports the 422, not the 409.
 *
 * THE WRITE AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024, V-031)
 * ================================================================
 * The reference audited AFTER `SaveChangesAsync` through a separate writer (:86-94), so a crash in
 * between silently repointed who owns every lead in the tenant with no record of it. Here steps 2-4
 * are one transaction, so the role checks cannot go stale mid-operation either.
 */
import { writeAudit } from '../audit/index.js';
import { findRole } from '../rbac/admin-repository.js';
import { withTransaction, type DbClient, type TenantId } from '../../lib/db/index.js';
import {
  assignmentRoleInvalidError,
  assignmentSlotInUseError,
  businessAssignmentNotFoundError,
} from './errors.js';
import {
  listUsersHoldingPermission,
  listUsersHoldingRole,
} from './eligible-repository.js';
import { hasLiveAssignments, listSlots, replaceSlots, type AssignmentSlotRow } from './repository.js';
import {
  RM_SLOT,
  UNDERWRITER_SLOT,
  slotLabel,
  type BusinessAssignmentEntryDto,
  type BusinessAssignmentsDto,
  type EligibleAssigneeDto,
  type UpdateBusinessAssignmentsInput,
} from './schemas.js';

export interface AssignmentsDeps {
  readonly db: DbClient;
}

/** Who performed the action and in which verified tenant. */
export interface AssignmentsActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  /** True when the caller entered via `global.view_any_tenant` rather than membership (T-013). */
  readonly isCrossTenant: boolean;
  readonly correlationId?: string;
}

export const BUSINESS_ASSIGNMENTS_UPDATED_ACTION = 'business_assignments.updated';

/** The reference's audit `entity_type` (UpdateBusinessAssignmentsCommandHandler.cs:89). */
export const BUSINESS_ASSIGNMENTS_ENTITY_TYPE = 'business_assignments';

function auditContext(actor: AssignmentsActor): { context?: { correlationId: string } } {
  return actor.correlationId === undefined ? {} : { context: { correlationId: actor.correlationId } };
}

/**
 * The DTO as a jsonb-safe record: an unconfigured slot audits as `null`, a configured one as its
 * `{assignmentId, roleId, roleName}` triple. `roleName` is included even though `roleId` identifies
 * the role, because an audit row must stay readable after the role has been renamed.
 */
function auditPayload(
  dto: BusinessAssignmentsDto,
): Record<string, Record<string, string | number> | null> {
  const entry = (
    value: BusinessAssignmentEntryDto | null,
  ): Record<string, string | number> | null =>
    value === null
      ? null
      : { assignmentId: value.assignmentId, roleId: value.roleId, roleName: value.roleName };

  return { rmRole: entry(dto.rmRole), underwritingRole: entry(dto.underwritingRole) };
}

/** `BusinessAssignmentsDto.FromRows` (:18-25). An unconfigured slot is `null`, never an error. */
function toDto(rows: readonly AssignmentSlotRow[]): BusinessAssignmentsDto {
  const entry = (slot: string): BusinessAssignmentsDto['rmRole'] => {
    const row = rows.find((candidate) => candidate.slot === slot);
    return row === undefined
      ? null
      : { assignmentId: row.assignmentId, roleId: row.roleId, roleName: row.roleName };
  };

  return { rmRole: entry(RM_SLOT), underwritingRole: entry(UNDERWRITER_SLOT) };
}

/** `GetBusinessAssignmentsQueryHandler` (:14-20). */
export async function getBusinessAssignments(
  deps: AssignmentsDeps,
  actor: AssignmentsActor,
): Promise<BusinessAssignmentsDto> {
  return toDto(await listSlots(deps.db, actor.tenantId));
}

/**
 * `UpdateBusinessAssignmentsCommandHandler` (:41-96).
 *
 * Payload validation (the two slots must name different roles) has already run at the route
 * boundary (schemas.ts), matching the reference's validator-then-handler order.
 */
export async function updateBusinessAssignments(
  deps: AssignmentsDeps,
  input: UpdateBusinessAssignmentsInput,
  actor: AssignmentsActor,
): Promise<BusinessAssignmentsDto> {
  return await withTransaction(deps.db, async (trx) => {
    // Step 2: every DISTINCT referenced role must exist, be active, and be visible to this tenant.
    // De-duplicated exactly as the reference does (:50-54) so naming one role twice — which the
    // validator already rejected — could not double-report.
    const referencedRoleIds = [...new Set([input.rmRoleId, input.underwritingRoleId])].filter(
      (roleId): roleId is number => roleId !== null,
    );

    for (const roleId of referencedRoleIds) {
      const role = await findRole(trx, roleId);
      // `TenantConfinement.IsAccessible` (:59): a GLOBAL role (tenant_id null) is usable by every
      // tenant — Internal-managed defaults are meant to be — a cross-tenant caller may use any, and
      // otherwise the role must belong to the acting tenant. All three failures collapse into ONE
      // message so this endpoint cannot be used to probe another tenant's roles (errors.ts).
      const visible =
        role !== undefined &&
        role.isActive &&
        (role.tenantId === null || actor.isCrossTenant || role.tenantId === actor.tenantId);

      if (!visible) throw assignmentRoleInvalidError(roleId);
    }

    const existing = await listSlots(trx, actor.tenantId);
    const before = toDto(existing);

    // Step 3: a slot being CLEARED loses its row, orphaning any lead/quote assignee that references
    // it — refused while live assignees exist. Changing a slot's ROLE keeps the row (and its
    // assignees) intact, so it needs no such check (:76-84).
    for (const row of existing) {
      const requested = row.slot === RM_SLOT ? input.rmRoleId : input.underwritingRoleId;
      if (requested !== null) continue;
      if (await hasLiveAssignments(trx, actor.tenantId, row.assignmentId)) {
        throw assignmentSlotInUseError(row.roleName, slotLabel(row.slot));
      }
    }

    const updated = await replaceSlots(
      trx,
      actor.tenantId,
      input.rmRoleId,
      input.underwritingRoleId,
      existing,
      actor.userId,
    );
    const after = toDto(updated);

    await writeAudit(trx, {
      entityType: BUSINESS_ASSIGNMENTS_ENTITY_TYPE,
      // The reference used the TENANT ID as the entity id (:90) — the configuration is the tenant's,
      // not any one slot row's, and a replace may create, update and delete rows at once.
      entityId: String(actor.tenantId),
      action: BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: auditPayload(before),
      after: auditPayload(after),
      ...auditContext(actor),
    });

    return after;
  });
}

/**
 * The permission that defines an eligible PRICING APPROVER
 * (`PermissionCatalog.Pricing.Approve`, GetEligibleApproversQueryHandler.cs:25).
 *
 * Approvers are picked by PERMISSION rather than by a configured slot role, and the reference is
 * explicit about why (GetEligibleApproversQuery.cs:9-11): pricing approval is not itself a
 * lead/quote-assignable responsibility, so it has no slot. Anything that "simplifies" this into a
 * third slot would contradict the two-slot model.
 */
export const PRICING_APPROVE_PERMISSION = 'pricing.approve';

/**
 * `GetEligibleAssigneesQueryHandler` (:23-39): the active tenant members holding the role
 * configured for one assignment SLOT, for the Assign / Send-to-underwriting / quote-assign pickers.
 *
 * THE SLOT IS RESOLVED FROM THIS TENANT'S ROWS FIRST, AND THAT IS THE ISOLATION BOUNDARY (:26-27).
 * `listSlots` is tenant-predicated, so an `assignmentId` belonging to another tenant simply is not
 * in the list and yields the SAME 404 as a nonexistent one. Were this looked up by id alone, a
 * caller could enumerate another tenant's members by guessing slot ids — which is why the 404 is
 * raised here rather than left to the reader returning an empty array.
 */
export async function getEligibleAssignees(
  deps: AssignmentsDeps,
  assignmentId: number,
  search: string | null,
  actor: AssignmentsActor,
): Promise<EligibleAssigneeDto[]> {
  const slots = await listSlots(deps.db, actor.tenantId);
  const slot = slots.find((row) => row.assignmentId === assignmentId);
  if (slot === undefined) throw businessAssignmentNotFoundError(assignmentId);

  return await listUsersHoldingRole(deps.db, slot.roleId, actor.tenantId, search);
}

/**
 * `GetEligibleApproversQueryHandler` (:21-29): the active tenant members holding `pricing.approve`
 * by ANY grant path, for the pricing-approval picker.
 *
 * Takes no assignment id and touches no slot row — see `PRICING_APPROVE_PERMISSION`.
 */
export async function getEligibleApprovers(
  deps: AssignmentsDeps,
  search: string | null,
  actor: AssignmentsActor,
): Promise<EligibleAssigneeDto[]> {
  return await listUsersHoldingPermission(
    deps.db,
    PRICING_APPROVE_PERMISSION,
    actor.tenantId,
    search,
  );
}
