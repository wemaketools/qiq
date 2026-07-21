/**
 * The accountable-owner (RM) dimension for the RM Performance and Loss Analysis dashboards
 * (T-037; AC-075).
 *
 * MEASURED DIVERGENCE FROM THE SHARED `leadFilterPredicates` RM PREDICATE — READ BEFORE UNIFYING
 * =============================================================================================
 * T-035's shared predicate resolves the RM dimension as "the lead has ANY assignment to this user"
 * (`filters.ts`, an EXISTS over `lead_assignments` on `user_id` alone). These two dashboards do
 * something narrower, and the reference is explicit about it: both stores resolve the ACCOUNTABLE
 * OWNER by joining `lead_assignments -> business_assignments` and requiring
 * `businessAssignment.Slot == BusinessAssignmentSlot.RelationshipManager`
 * (`RmPerformanceStore.GetAccountableOwnersAsync` :375-386, `LossAnalysisStore` :239-250).
 *
 * The difference is real, not cosmetic. `business_assignments` has TWO slots — `rm` and
 * `underwriter` — so a lead on which a user is the UNDERWRITER matches the shared predicate and
 * does NOT match this one. Using the shared predicate here would silently attribute another
 * person's leads to an RM on the RM performance ranking, which is the single number this dashboard
 * exists to produce.
 *
 * They are therefore kept apart, named, and documented rather than merged. The shared predicate
 * stays correct for the drill (which asks "which leads is this user involved in"); this one is
 * correct for attribution ("whose book is this").
 *
 * Every value is a bound parameter, and both the assignment and the slot lookup carry their OWN
 * tenant predicate: a join that inherited tenancy from the outer query would be one refactor away
 * from not having it at all.
 */
import { sql } from 'kysely';

import type { TenantId } from '../../lib/db/index.js';

import type { RawBuilder, SqlBool } from 'kysely';

/** The `rm` slot discriminator as stored in `business_assignments.slot`. */
export const RM_SLOT = 'rm';

/**
 * `lead.<alias>` is owned by `userId` through the RM slot.
 *
 * The subquery is an EXISTS rather than a join so a lead with two RM-slot assignments (which the
 * schema does not forbid) contributes ONE row, not two — a join here would double every one of that
 * lead's quotes in the RM's totals.
 */
export function accountableOwnerPredicate(
  tenantId: TenantId,
  userId: number,
  leadAlias = 'l',
): RawBuilder<SqlBool> {
  const alias = sql.ref(leadAlias);
  return sql`exists (
    select 1
      from lead_assignments la
      join business_assignments ba
        on ba.tenant_id = ${tenantId}
       and ba.id = la.business_assignment_id
     where la.tenant_id = ${tenantId}
       and la.lead_id = ${alias}.id
       and la.user_id = ${userId}
       and ba.slot = ${RM_SLOT}
  )`;
}

/**
 * The SQL that projects each lead's accountable owner id and name, for the grouping dimension
 * itself (as opposed to filtering by it). Left-joined by the caller: a lead with no RM-slot
 * assignment has a NULL owner and is excluded from per-RM grouping — but still counts in the
 * tenant-wide totals, exactly as the reference's `owner.UserId == 0 ? null` mapping does.
 */
export function accountableOwnerJoin(tenantId: TenantId, leadAlias = 'l'): RawBuilder<unknown> {
  const alias = sql.ref(leadAlias);
  return sql`left join lateral (
    select u.id as user_id, u.first_name, u.last_name
      from lead_assignments la
      join business_assignments ba
        on ba.tenant_id = ${tenantId}
       and ba.id = la.business_assignment_id
      join users u on u.id = la.user_id
     where la.tenant_id = ${tenantId}
       and la.lead_id = ${alias}.id
       and ba.slot = ${RM_SLOT}
     order by u.id
     limit 1
  ) owner on true`;
}
