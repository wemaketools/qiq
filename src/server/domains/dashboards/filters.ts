/**
 * The shared dashboard filter (T-035; AC-075; V-093; spec FR-54, AC-053).
 *
 * Port of `src/api/QuoteIQ.Application/Dashboards/DashboardFilter.cs` and the query-string binding
 * in `DashboardEndpoints.cs:41-125`.
 *
 * ============================================================================================
 * MEASURED CONTRADICTION AGAINST THE TASK BRIEF AND AC-075 — READ THIS BEFORE ADDING A FILTER
 * ============================================================================================
 * T-035's scope and AC-075/V-093 name FIFTEEN filter dimensions: "date range, product line, cover
 * type, broker, RM/team, broker type, region, client type, segment, industry, lead status, quote
 * status, aging bucket, SLA status, lost reason".
 *
 * THE REFERENCE IMPLEMENTS EIGHT. `DashboardFilter.cs:9-17` is a closed record of exactly
 * `From, To, ProductLineId, BrokerId, RmUserId, RegionId, TeamOrRmId, BrokerTypeId`, every one of
 * the five dashboard endpoints binds exactly those eight query parameters and nothing else
 * (`DashboardEndpoints.cs:42-43, 55-56, 68-69, 81-82, 94-95`), and the drill endpoint binds the
 * same eight plus `widget`/`page`/`pageSize` (:107-108). There is no `coverTypeId`, `clientTypeId`,
 * `segmentId`, `industryId`, `statusId`, `agingBucket`, `slaStatus` or `lostReasonId` anywhere on
 * the dashboard wire, and the SPA sends none of them.
 *
 * The eight measured parameters are implemented here, verbatim, because they are the preserved
 * wire contract. The other seven are FLAGGED for the orchestrator, NOT silently invented: adding
 * seven query parameters that no reference endpoint accepted, no dashboard consumes and no client
 * sends would be speculative surface with no consumer to validate it against — and getting one of
 * them subtly wrong is exactly the class of defect this domain cannot afford. If the seven are
 * genuinely wanted they are a scoped follow-up with their own acceptance criteria, per dimension.
 *
 * TENANT SCOPE IS NOT ONE OF THE DIMENSIONS
 * =========================================
 * It is not optional and it does not come from the wire, so it is a required argument of every
 * predicate builder below rather than a nullable field of the filter. RLS is not adopted (Q-10),
 * so these predicates are the only thing between a caller and another tenant's pipeline — there is
 * nothing underneath them to catch an omission.
 */
import { sql } from 'kysely';

import { z } from 'zod';

import type { TenantId } from '../../lib/db/index.js';
import type { ListLeadsFilter } from '../leads/repository.js';

import type { RawBuilder, SqlBool } from 'kysely';

/**
 * `long?` query parameters. Absent stays absent — `undefined`, never 0 — because 0 is a valid-
 * looking id that would silently match nothing and render an empty dashboard as if it were real.
 */
const optionalId = z
  .string()
  .regex(/^\d+$/, { message: 'DASHBOARD_FILTER_INVALID|Filter ids must be positive integers.' })
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value > 0, {
    message: 'DASHBOARD_FILTER_INVALID|Filter ids must be positive integers.',
  })
  .optional();

/** `DateOnly?` — the reference's `yyyy-MM-dd` model binding. */
const optionalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'DASHBOARD_FILTER_INVALID|Date filters must be yyyy-MM-dd.',
  })
  .optional();

/** The eight measured dashboard filter parameters, named exactly as the reference binds them. */
export const dashboardFilterSchema = z.object({
  from: optionalDate,
  to: optionalDate,
  productLineId: optionalId,
  brokerId: optionalId,
  rmUserId: optionalId,
  regionId: optionalId,
  teamOrRmId: optionalId,
  brokerTypeId: optionalId,
});

export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;

/** `DashboardFilter.Empty` (:20) — the "Clear filters" state, every dimension unset. */
export const EMPTY_DASHBOARD_FILTER: DashboardFilter = {
  from: undefined,
  to: undefined,
  productLineId: undefined,
  brokerId: undefined,
  rmUserId: undefined,
  regionId: undefined,
  teamOrRmId: undefined,
  brokerTypeId: undefined,
};

/**
 * The RM dimension the stores actually filter on: `filter.TeamOrRmId ?? filter.RmUserId`
 * (LossAnalysisStore.cs:201, RmPerformanceStore.cs:16-17).
 *
 * The RM Performance filter bar sends `teamOrRmId`; every other dashboard sends `rmUserId`. They
 * are the same dimension under two names, and `teamOrRmId` WINS when both are present. Resolving
 * that precedence in one named function is the point — five dashboards each writing `?? ` in their
 * own query is five chances to write it the other way round and quietly filter by the wrong user.
 */
export function effectiveRmUserId(filter: DashboardFilter): number | undefined {
  return filter.teamOrRmId ?? filter.rmUserId;
}

/**
 * Projects the shared filter onto the Leads list filter (`LeadFilterDrillRowQuery.cs:31-47`).
 *
 * The mapping is measured, not guessed: date range -> `dateReceived` range, product line / broker /
 * region straight through, and the RM dimension -> `ownerUserId`, which the leads repository
 * implements as an EXISTS over `lead_assignments` rather than a column compare.
 *
 * `brokerTypeId` HAS NO PROJECTION HERE, and that is the reference's behaviour, not an omission:
 * the Leads list filter has no broker-type dimension, so the reference's drill row query does not
 * pass one either. Broker type is applied by the RM/Broker dashboards' own snapshot queries
 * against `brokers.broker_type_id` (see `leadFilterPredicates`), which is where the join lives.
 * Silently dropping it in the drill would make a drill set WIDER than the aggregate it came from,
 * so the omission is documented and asserted rather than left to be rediscovered.
 */
export function leadListFilterFrom(
  filter: DashboardFilter,
  caller: { readonly callerUserId: number; readonly callerHasViewAll: boolean },
  page: number,
  pageSize: number,
): ListLeadsFilter {
  return {
    statusIds: undefined,
    ownerUserId: effectiveRmUserId(filter),
    brokerId: filter.brokerId,
    productLineId: filter.productLineId,
    regionId: filter.regionId,
    requestChannelId: undefined,
    dateReceivedFrom: filter.from,
    dateReceivedTo: filter.to,
    myLeadsOnly: false,
    callerUserId: caller.callerUserId,
    callerHasViewAll: caller.callerHasViewAll,
    search: undefined,
    sort: { field: null, descending: false },
    page,
    pageSize,
  };
}

/**
 * Whether any dimension is set. Used by callers that can take a cheaper unfiltered path; NOT used
 * to skip the tenant predicate, which is unconditional.
 */
export function isEmptyFilter(filter: DashboardFilter): boolean {
  return Object.values(filter).every((value) => value === undefined);
}

// ---------------------------------------------------------------------------------------------
// SQL predicates — ONE mapping, reused by dashboards, drill and exports (P-12, N-04).
// ---------------------------------------------------------------------------------------------

/**
 * Every lead-side predicate for a filter, TENANT PREDICATE FIRST AND ALWAYS.
 *
 * The tenant condition is pushed unconditionally and is not derived from the filter, so there is
 * no code path — no empty filter, no "fast path", no early return — on which it can be absent.
 * That is deliberate: an aggregate is not a list, and a cross-tenant leak here would not show up
 * as a foreign row a reviewer might notice, only as a number that is quietly too big.
 *
 * `leadAlias` is a caller-supplied SQL identifier, never user input; it is the alias the caller
 * gave the `leads` table in its own FROM clause. Every value below is a bound parameter.
 *
 * Set-based by construction (N-04): these are predicates for ONE query, not per-row lookups.
 */
export function leadFilterPredicates(
  tenantId: TenantId,
  filter: DashboardFilter,
  leadAlias = 'l',
): RawBuilder<SqlBool>[] {
  const alias = sql.ref(leadAlias);
  const conditions: RawBuilder<SqlBool>[] = [sql`${alias}.tenant_id = ${tenantId}`];

  if (filter.from !== undefined) {
    conditions.push(sql`${alias}.date_received >= ${filter.from}::date`);
  }
  if (filter.to !== undefined) {
    conditions.push(sql`${alias}.date_received <= ${filter.to}::date`);
  }
  if (filter.productLineId !== undefined) {
    conditions.push(sql`${alias}.product_line_id = ${filter.productLineId}`);
  }
  if (filter.brokerId !== undefined) {
    conditions.push(sql`${alias}.broker_id = ${filter.brokerId}`);
  }
  if (filter.regionId !== undefined) {
    conditions.push(sql`${alias}.region_id = ${filter.regionId}`);
  }

  // The RM dimension is an assignment, not a column: a lead's accountable owner lives in
  // `lead_assignments`. The subquery carries its OWN tenant predicate — a join that inherited
  // tenancy only from the outer query would be one refactor away from not having it at all.
  const rmUserId = effectiveRmUserId(filter);
  if (rmUserId !== undefined) {
    conditions.push(sql`exists (
      select 1 from lead_assignments la
       where la.tenant_id = ${tenantId}
         and la.lead_id = ${alias}.id
         and la.user_id = ${rmUserId}
    )`);
  }

  // Broker type is a property of the BROKER, reached through the lead's broker
  // (RmPerformanceStore.cs:40-49). A lead with no broker matches no broker-type filter, which the
  // EXISTS gives for free — a LEFT JOIN plus `= id` would have needed an explicit null guard.
  if (filter.brokerTypeId !== undefined) {
    conditions.push(sql`exists (
      select 1 from brokers b
       where b.tenant_id = ${tenantId}
         and b.id = ${alias}.broker_id
         and b.broker_type_id = ${filter.brokerTypeId}
    )`);
  }

  return conditions;
}

/** The same predicates folded into a single `and`-joined WHERE body. */
export function leadFilterWhere(
  tenantId: TenantId,
  filter: DashboardFilter,
  leadAlias = 'l',
): RawBuilder<SqlBool> {
  return sql.join(leadFilterPredicates(tenantId, filter, leadAlias), sql` and `);
}

/**
 * THE BREADTH PREDICATE (P-03, AC-076), applied in SQL exactly as the leads list applies it.
 *
 * Without `leads.view_all` a caller sees only leads they are assigned to — in the AGGREGATE as
 * well as in the drill. Post-filtering a computed aggregate is not merely slower, it is impossible
 * to do correctly: by the time you have a sum you can no longer subtract the rows the caller
 * should not have seen. So breadth narrows the population BEFORE the aggregation, which is what
 * makes AC-076's "drill reconciles with its aggregate" true for a restricted caller too.
 */
export function breadthPredicate(
  tenantId: TenantId,
  caller: { readonly callerUserId: number; readonly callerHasViewAll: boolean },
  leadAlias = 'l',
): RawBuilder<SqlBool> | null {
  if (caller.callerHasViewAll) return null;
  const alias = sql.ref(leadAlias);
  return sql`exists (
    select 1 from lead_assignments la
     where la.tenant_id = ${tenantId}
       and la.lead_id = ${alias}.id
       and la.user_id = ${caller.callerUserId}
  )`;
}
