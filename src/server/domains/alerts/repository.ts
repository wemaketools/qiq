/**
 * Tenant-scoped `alerts` / `user_alert_views` persistence, and the evaluation-context prefetch
 * (T-033; AC-022, AC-069, AC-070; V-027, V-086, V-087).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Alerts/AlertStore.cs`.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NOTHING UNDERNEATH IT
 * ===================================================================
 * Postgres RLS is NOT adopted (spec Q-10). The reference had two layers (an explicit predicate plus
 * EF's ambient filter); this port has one. Every alias in every join below carries its OWN
 * `tenant_id` predicate — including the joins to `reference_items`, `parties` and `quote_versions`,
 * where a missing predicate would not leak rows so much as MISLABEL them: a lead's status name or a
 * quote's premium silently taken from another tenant's row with a colliding id.
 *
 * THE PREFETCH IS FOUR QUERIES PER TENANT, NOT FOUR PER LEAD
 * =========================================================
 * `buildEvaluationContext` reads leads, quotes (+ current-version premium), pending pricing
 * approvals and underwriting entry timestamps in four set-based queries and assembles the snapshot
 * graph in memory. A sweep runs every 15 minutes over every tenant, so an N+1 here would be an N+1
 * multiplied by the whole lead table, four times an hour, forever.
 *
 * MONEY NEVER BECOMES A DOUBLE ON THE WAY IN
 * ==========================================
 * Every `numeric(18,2)` is projected as `::text` and stays a string through the rules, which
 * compare and total it in exact cents. The ONLY place a premium widens to a JSON number is the wire
 * boundary in `service.ts`, where the preserved SPA contract requires a number.
 */
import { sql } from 'kysely';

import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import { InternalError } from '../../lib/errors/index.js';
import type {
  AlertCandidate,
  AlertEvaluationContext,
  AlertSeverity,
  AlertThresholds,
  AlertType,
  LeadAlertSnapshot,
  QuoteAlertSnapshot,
} from './rules/index.js';

function toId(value: number | string): number {
  return Number(value);
}

function toNullableId(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

/** `date` columns arrive as `Date` under node-postgres; the rules compare `yyyy-MM-dd` strings. */
function toDateOnlyOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// -------------------------------------------------------------------------------------------
// Thresholds
// -------------------------------------------------------------------------------------------

/**
 * The nine `tenant_settings` values the rules read.
 *
 * Deliberately NOT `business-rules`' `getTenantSettings`: that reader returns the wire DTO, in
 * which `highValueThreshold` has already been widened to a JSON `number`. The high-value comparison
 * is a business decision made ON MONEY, so this read keeps the column as `::text` and the decision
 * is made in exact cents. Every other value here is an integer count of days or hours, where a
 * `number` is exact.
 *
 * A missing row throws rather than defaulting: every tenant is provisioned settings at creation
 * (spec §11.2), so its absence is a provisioning alarm — and silently evaluating a tenant against
 * invented thresholds would raise or suppress alerts nobody configured.
 */
export async function loadAlertThresholds(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<AlertThresholds> {
  const result = await sql<{
    unassigned_lead_hours: number;
    stalled_lead_days: number;
    stalled_quote_days: number;
    quote_expiry_alert_days: number;
    pricing_approval_target_days: number;
    sla_assignment_days: number;
    sla_underwriting_days: number;
    sla_received_to_sent_days: number;
    high_value_threshold: string | null;
  }>`
    select unassigned_lead_hours, stalled_lead_days, stalled_quote_days, quote_expiry_alert_days,
           pricing_approval_target_days, sla_assignment_days, sla_underwriting_days,
           sla_received_to_sent_days, high_value_threshold::text as high_value_threshold
      from tenant_settings
     where tenant_id = ${tenantId}
  `.execute(executor);

  const row = result.rows[0];
  if (row === undefined) {
    throw new InternalError(
      `Tenant ${String(tenantId)} has no tenant_settings row; alert evaluation cannot run against ` +
        'invented thresholds (spec §11.2).',
    );
  }

  return {
    unassignedLeadHours: row.unassigned_lead_hours,
    stalledLeadDays: row.stalled_lead_days,
    stalledQuoteDays: row.stalled_quote_days,
    quoteExpiryAlertDays: row.quote_expiry_alert_days,
    pricingApprovalTargetDays: row.pricing_approval_target_days,
    slaAssignmentDays: row.sla_assignment_days,
    slaUnderwritingDays: row.sla_underwriting_days,
    slaReceivedToSentDays: row.sla_received_to_sent_days,
    highValueThreshold: row.high_value_threshold,
  };
}

// -------------------------------------------------------------------------------------------
// Evaluation context
// -------------------------------------------------------------------------------------------

/**
 * Prefetches one tenant's whole evaluation input.
 *
 * CLOSED LEADS ARE INCLUDED ON PURPOSE (`IAlertStore.BuildContextAsync`'s doc comment). The rules
 * filter them out of their MATCH sets, but reconciliation needs them in the context all the same:
 * an alert on a lead that has since closed must appear as "no longer matching" so it RESOLVES.
 * Filtering closed leads out of the query would instead make their alerts invisible to the diff and
 * leave them open forever.
 *
 * `onlyLeadId` narrows every query to one lead — the scoped re-evaluation a workflow action fires.
 */
export async function buildEvaluationContext(
  executor: DbExecutor,
  tenantId: TenantId,
  thresholds: AlertThresholds,
  options: { readonly onlyLeadId?: number | undefined; readonly now?: Date } = {},
): Promise<AlertEvaluationContext> {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const onlyLeadId = options.onlyLeadId ?? null;

  const leadRows = await sql<{
    id: number | string;
    canonical_key: string | null;
    reporting_category: string | null;
    created_at: Date | string;
    last_activity_at: Date | string | null;
    next_follow_up_date: Date | string | null;
    pricing_approval_state: string;
    estimated_premium: string | null;
    is_strategic: boolean;
  }>`
    select l.id, s.canonical_key, s.reporting_category, l.created_at, l.last_activity_at,
           l.next_follow_up_date, l.pricing_approval_state,
           l.estimated_premium::text as estimated_premium, p.is_strategic
      from leads l
      join reference_items s on s.id = l.status_id and s.tenant_id = ${tenantId}
      join parties p on p.id = l.party_id and p.tenant_id = ${tenantId}
     where l.tenant_id = ${tenantId}
       and (${onlyLeadId}::bigint is null or l.id = ${onlyLeadId}::bigint)
  `.execute(executor);

  if (leadRows.rows.length === 0) {
    return { thresholds, today, now, leads: [] };
  }

  const quoteRows = await sql<{
    id: number | string;
    lead_id: number | string;
    reporting_category: string | null;
    valid_until: Date | string | null;
    quoted_premium: string;
  }>`
    select q.id, q.lead_id, qs.reporting_category, q.valid_until,
           coalesce(v.quoted_premium, 0)::numeric(18,2)::text as quoted_premium
      from quotes q
      join reference_items qs on qs.id = q.status_id and qs.tenant_id = ${tenantId}
      left join quote_versions v
        on v.quote_id = q.id and v.tenant_id = ${tenantId} and v.is_current
     where q.tenant_id = ${tenantId}
       and (${onlyLeadId}::bigint is null or q.lead_id = ${onlyLeadId}::bigint)
  `.execute(executor);

  const pricingRows = await sql<{ lead_id: number | string; requested_at: Date | string }>`
    select pa.lead_id, max(pa.requested_at) as requested_at
      from pricing_approvals pa
     where pa.tenant_id = ${tenantId}
       and pa.state = 'pending'
       and (${onlyLeadId}::bigint is null or pa.lead_id = ${onlyLeadId}::bigint)
     group by pa.lead_id
  `.execute(executor);

  const underwritingRows = await sql<{ lead_id: number | string; acted_at: Date | string }>`
    select h.lead_id, max(h.acted_at) as acted_at
      from lead_status_history h
      join reference_items r on r.id = h.new_status_id and r.tenant_id = ${tenantId}
     where h.tenant_id = ${tenantId}
       and r.list_type = 'lead_status'
       and r.canonical_key = 'underwriting'
       and (${onlyLeadId}::bigint is null or h.lead_id = ${onlyLeadId}::bigint)
     group by h.lead_id
  `.execute(executor);

  const quotesByLead = new Map<number, QuoteAlertSnapshot[]>();
  for (const row of quoteRows.rows) {
    const leadId = toId(row.lead_id);
    const snapshot: QuoteAlertSnapshot = {
      quoteId: toId(row.id),
      leadId,
      reportingCategory: row.reporting_category,
      validUntil: toDateOnlyOrNull(row.valid_until),
      quotedPremium: row.quoted_premium,
    };
    const existing = quotesByLead.get(leadId);
    if (existing === undefined) quotesByLead.set(leadId, [snapshot]);
    else existing.push(snapshot);
  }

  const pendingSince = new Map(
    pricingRows.rows.map((row) => [toId(row.lead_id), toDate(row.requested_at)]),
  );
  const underwritingSince = new Map(
    underwritingRows.rows.map((row) => [toId(row.lead_id), toDate(row.acted_at)]),
  );

  const leads: LeadAlertSnapshot[] = leadRows.rows.map((row) => {
    const leadId = toId(row.id);
    return {
      leadId,
      statusCanonicalKey: row.canonical_key,
      reportingCategory: row.reporting_category,
      createdAt: toDate(row.created_at),
      lastActivityAt: toDateOrNull(row.last_activity_at),
      nextFollowUpDate: toDateOnlyOrNull(row.next_follow_up_date),
      pricingApprovalState: row.pricing_approval_state,
      pricingPendingSince: pendingSince.get(leadId) ?? null,
      underwritingEnteredAt: underwritingSince.get(leadId) ?? null,
      estimatedPremium: row.estimated_premium,
      isStrategicParty: row.is_strategic,
      quotes: quotesByLead.get(leadId) ?? [],
    };
  });

  return { thresholds, today, now, leads };
}

// -------------------------------------------------------------------------------------------
// Open-alert reconciliation primitives
// -------------------------------------------------------------------------------------------

/** One open `alerts` row, as the diff needs it. */
export interface OpenAlertRow {
  readonly id: number;
  readonly type: AlertType;
  readonly leadId: number;
  readonly quoteId: number | null;
}

export async function listOpenAlerts(
  executor: DbExecutor,
  tenantId: TenantId,
  onlyLeadId?: number | undefined,
): Promise<readonly OpenAlertRow[]> {
  let query = forTenant(executor, tenantId)
    .selectFrom('alerts')
    .select(['id', 'type', 'lead_id', 'quote_id'])
    .where('resolved_at', 'is', null);

  if (onlyLeadId !== undefined) query = query.where('lead_id', '=', onlyLeadId);

  const rows = (await query.execute()) as unknown as readonly {
    id: number | string;
    type: string;
    lead_id: number | string;
    quote_id: number | string | null;
  }[];

  return rows.map((row) => ({
    id: toId(row.id),
    type: row.type as AlertType,
    leadId: toId(row.lead_id),
    quoteId: toNullableId(row.quote_id),
  }));
}

/**
 * Inserts one candidate, returning true when a row was actually created.
 *
 * `ON CONFLICT ... DO NOTHING` against `uq_alerts_open_per_type_lead_quote` is what makes the sweep
 * safe under CONCURRENT or overlapping invocations, not merely under sequential re-runs. The
 * reference relies on read-then-insert alone, which is idempotent only as long as two sweeps never
 * overlap — and pg_cron plus a manual `cron:run` plus a queued re-evaluation can absolutely overlap.
 * This is a deliberate STRENGTHENING of the reference, recorded on the task.
 *
 * The conflict target must repeat the index's own `coalesce(quote_id, 0)` expression and its
 * partial `where resolved_at is null` predicate, or Postgres cannot infer the partial index.
 */
export async function insertAlertCandidate(
  executor: DbExecutor,
  tenantId: TenantId,
  candidate: AlertCandidate,
  now: Date,
): Promise<boolean> {
  const result = await sql<{ id: number | string }>`
    insert into alerts (tenant_id, type, lead_id, quote_id, severity, premium_at_risk, created_at)
    values (${tenantId}, ${candidate.type}, ${candidate.leadId}, ${candidate.quoteId},
            ${candidate.severity}, ${candidate.premiumAtRisk}::numeric, ${now})
    on conflict (tenant_id, type, lead_id, coalesce(quote_id, 0)) where resolved_at is null
    do nothing
    returning id
  `.execute(executor);

  return result.rows.length > 0;
}

/** `AlertReconciler.RuleClearedReason` — the only reason this task's code ever writes. */
export const RULE_CLEARED_REASON = 'rule_cleared';

/**
 * Resolves the given open alerts. Returns the number of rows actually updated.
 *
 * The `resolved_at is null` guard is not decoration: two overlapping sweeps can both decide the same
 * alert has cleared, and without it the second would overwrite the first's `resolved_at` with a
 * later timestamp — quietly moving a historical fact.
 */
export async function resolveAlerts(
  executor: DbExecutor,
  tenantId: TenantId,
  alertIds: readonly number[],
  now: Date,
  reason: string = RULE_CLEARED_REASON,
): Promise<number> {
  if (alertIds.length === 0) return 0;

  const result = await sql<{ id: number | string }>`
    update alerts
       set resolved_at = ${now}, resolved_reason = ${reason}
     where tenant_id = ${tenantId}
       and resolved_at is null
       and id = any(${sql.val(alertIds as unknown as number[])}::bigint[])
    returning id
  `.execute(executor);

  return result.rows.length;
}

// -------------------------------------------------------------------------------------------
// Alerts Center reads
// -------------------------------------------------------------------------------------------

export interface AlertTypeCount {
  readonly type: string;
  readonly count: number;
}

/** Open-alert counts per type — the category cards' and tab counts' single source. */
export async function countOpenAlertsByType(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<readonly AlertTypeCount[]> {
  const result = await sql<{ type: string; count: number | string }>`
    select a.type, count(*) as count
      from alerts a
     where a.tenant_id = ${tenantId} and a.resolved_at is null
     group by a.type
  `.execute(executor);

  return result.rows.map((row) => ({ type: row.type, count: toId(row.count) }));
}

export interface AlertRollup {
  /** Exact `numeric(18,2)` total, as a string. */
  readonly premiumAtRisk: string;
  readonly quoteCount: number;
}

/**
 * The Escalation Queue header rollup, DE-DUPLICATED BY (lead, quote).
 *
 * A single at-risk lead commonly carries three or four alert types at once (stalled + overdue +
 * SLA + escalation). Summing `premium_at_risk` across alert ROWS would report that lead's premium
 * three or four times — a "Premium at risk" header several times larger than the pipeline it
 * describes. So the sum is over DISTINCT (lead, quote) items, matching `AlertStore.GetRollupAsync`.
 *
 * The reference takes `g.First()`'s premium within each group; this takes `max(...)`. Those agree
 * by construction: within one (lead, quote) group every alert row was written from the same
 * premium source in the same evaluation (lead-level rules all use the lead's premium-at-risk;
 * quote-level rules all use that quote's premium). `max` is used because "first" has no meaning in
 * SQL without an ORDER BY, and a nondeterministic aggregate would make the header flicker.
 *
 * The sum happens in Postgres `numeric`, never in JavaScript.
 */
export async function getAlertRollup(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<AlertRollup> {
  const result = await sql<{ premium_at_risk: string; quote_count: number | string }>`
    with distinct_items as (
      select a.lead_id, a.quote_id, max(a.premium_at_risk) as premium_at_risk
        from alerts a
       where a.tenant_id = ${tenantId} and a.resolved_at is null
       group by a.lead_id, a.quote_id
    )
    select coalesce(sum(premium_at_risk), 0)::numeric(18,2)::text as premium_at_risk,
           count(*) filter (where quote_id is not null) as quote_count
      from distinct_items
  `.execute(executor);

  const row = result.rows[0];
  return {
    premiumAtRisk: row?.premium_at_risk ?? '0.00',
    quoteCount: row === undefined ? 0 : toId(row.quote_count),
  };
}

/** One queue row, before the wire projection. */
export interface AlertListRow {
  readonly id: number;
  readonly type: string;
  readonly severity: string;
  readonly createdAt: Date;
  readonly leadId: number;
  readonly leadRef: string;
  readonly quoteId: number | null;
  readonly quoteRef: string | null;
  readonly clientName: string;
  readonly productLineName: string;
  readonly brokerName: string | null;
  readonly premiumAtRisk: string | null;
  readonly stage: string;
  readonly priority: string;
  readonly ownerUserId: number | null;
  readonly ownerFirstName: string | null;
  readonly ownerLastName: string | null;
}

export interface AlertListFilter {
  /** Null (the "all" tab) means every type. */
  readonly types: readonly string[] | null;
  readonly ownerUserId: number | null;
  readonly productLineId: number | null;
  readonly coverTypeId: number | null;
  readonly regionId: number | null;
  readonly priority: string | null;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * The Alerts Center queue.
 *
 * COUNT AND PAGE SHARE ONE PREDICATE SET, applied in SQL — a page filtered after the fact would
 * report a `totalCount` describing rows the page does not contain.
 *
 * ORDER BY IS FULLY QUALIFIED AND TIE-BROKEN. `order by a.created_at desc, a.id desc`: qualified
 * because a bare `order by created_at` resolves to an OUTPUT-COLUMN ALIAS ahead of the real column
 * in Postgres, and tie-broken because a whole sweep writes its alerts within the same
 * `created_at` instant — without the `a.id` tiebreak, paging through them would repeat and skip
 * rows nondeterministically. (The reference orders on `created_at` alone; the tiebreak is a
 * deliberate strengthening.)
 *
 * The owner join is `left`, so an unassigned lead's alert still appears in the queue — it is
 * exactly the population `unassigned_lead` alerts describe, and an inner join would hide it.
 */
export async function listAlerts(
  executor: DbExecutor,
  tenantId: TenantId,
  filter: AlertListFilter,
): Promise<{ items: readonly AlertListRow[]; totalCount: number }> {
  const types = filter.types === null ? null : [...filter.types];
  const offset = (filter.page - 1) * filter.pageSize;

  const countResult = await sql<{ total: number | string }>`
    select count(*) as total
      from alerts a
      join leads l on l.id = a.lead_id and l.tenant_id = ${tenantId}
     where a.tenant_id = ${tenantId}
       and a.resolved_at is null
       and (${types}::text[] is null or a.type = any(${types}::text[]))
       and (${filter.productLineId}::bigint is null or l.product_line_id = ${filter.productLineId}::bigint)
       and (${filter.coverTypeId}::bigint is null or l.cover_type_id = ${filter.coverTypeId}::bigint)
       and (${filter.regionId}::bigint is null or l.region_id = ${filter.regionId}::bigint)
       and (${filter.priority}::text is null or l.priority = ${filter.priority}::text)
       and (${filter.ownerUserId}::bigint is null or exists (
             select 1 from lead_assignments la
              where la.tenant_id = ${tenantId} and la.lead_id = l.id
                and la.user_id = ${filter.ownerUserId}::bigint
           ))
  `.execute(executor);

  const totalCount = toId(countResult.rows[0]?.total ?? 0);

  const result = await sql<{
    id: number | string;
    type: string;
    severity: string;
    created_at: Date | string;
    lead_id: number | string;
    lead_ref: string;
    quote_id: number | string | null;
    quote_ref: string | null;
    client_name: string;
    product_line_name: string;
    broker_name: string | null;
    premium_at_risk: string | null;
    stage: string;
    priority: string;
    owner_user_id: number | string | null;
    owner_first_name: string | null;
    owner_last_name: string | null;
  }>`
    select a.id, a.type, a.severity, a.created_at, a.premium_at_risk::text as premium_at_risk,
           l.id as lead_id, l.lead_ref, l.priority,
           a.quote_id, q.quote_ref,
           p.name as client_name, pl.name as product_line_name, s.name as stage,
           b.name as broker_name,
           owner_user.id as owner_user_id, owner_user.first_name as owner_first_name,
           owner_user.last_name as owner_last_name
      from alerts a
      join leads l on l.id = a.lead_id and l.tenant_id = ${tenantId}
      join parties p on p.id = l.party_id and p.tenant_id = ${tenantId}
      join reference_items pl on pl.id = l.product_line_id and pl.tenant_id = ${tenantId}
      join reference_items s on s.id = l.status_id and s.tenant_id = ${tenantId}
      left join quotes q on q.id = a.quote_id and q.tenant_id = ${tenantId}
      left join brokers b on b.id = l.broker_id and b.tenant_id = ${tenantId}
      -- LATERAL WITH limit 1, NOT A PLAIN JOIN. A lead can carry more than one lead_assignments
      -- row for the RM slot, and a plain left join would then emit the SAME alert twice — a page
      -- whose row count disagrees with the totalCount computed above, which is the kind of defect
      -- that looks like a paging bug forever. Ordered by la.id so the chosen owner is stable
      -- between requests.
      left join lateral (
        select u.id, u.first_name, u.last_name
          from lead_assignments la
          join business_assignments ba
            on ba.id = la.business_assignment_id and ba.tenant_id = ${tenantId}
          join users u on u.id = la.user_id
         where la.tenant_id = ${tenantId} and la.lead_id = l.id and ba.slot = 'rm'
         order by la.id
         limit 1
      ) owner_user on true
     where a.tenant_id = ${tenantId}
       and a.resolved_at is null
       and (${types}::text[] is null or a.type = any(${types}::text[]))
       and (${filter.productLineId}::bigint is null or l.product_line_id = ${filter.productLineId}::bigint)
       and (${filter.coverTypeId}::bigint is null or l.cover_type_id = ${filter.coverTypeId}::bigint)
       and (${filter.regionId}::bigint is null or l.region_id = ${filter.regionId}::bigint)
       and (${filter.priority}::text is null or l.priority = ${filter.priority}::text)
       and (${filter.ownerUserId}::bigint is null or exists (
             select 1 from lead_assignments la2
              where la2.tenant_id = ${tenantId} and la2.lead_id = l.id
                and la2.user_id = ${filter.ownerUserId}::bigint
           ))
     order by a.created_at desc, a.id desc
     limit ${filter.pageSize} offset ${offset}
  `.execute(executor);

  const items = result.rows.map((row) => ({
    id: toId(row.id),
    type: row.type,
    severity: row.severity,
    createdAt: toDate(row.created_at),
    leadId: toId(row.lead_id),
    leadRef: row.lead_ref,
    quoteId: toNullableId(row.quote_id),
    quoteRef: row.quote_ref,
    clientName: row.client_name,
    productLineName: row.product_line_name,
    brokerName: row.broker_name,
    premiumAtRisk: row.premium_at_risk,
    stage: row.stage,
    priority: row.priority,
    ownerUserId: toNullableId(row.owner_user_id),
    ownerFirstName: row.owner_first_name,
    ownerLastName: row.owner_last_name,
  }));

  return { items, totalCount };
}

// -------------------------------------------------------------------------------------------
// Badge
// -------------------------------------------------------------------------------------------

/**
 * Alerts CREATED since this user last opened the Alerts Center, in this tenant.
 *
 * TWO MEASURED SEMANTICS THAT READ AS BUGS AND ARE NOT:
 *
 *   1. It counts alerts regardless of whether they are still open (`AlertStore.cs:214-217` has no
 *      `resolved_at is null` predicate). The badge answers "what happened since you looked", not
 *      "what is outstanding" — an alert that appeared and cleared between visits still happened.
 *   2. A user with NO `user_alert_views` row gets 0, not "every alert ever". A first-time user is
 *      shown a clean badge rather than a five-figure count of historical alerts.
 */
export async function countAlertsNewSinceLastVisit(
  executor: DbExecutor,
  tenantId: TenantId,
  userId: number,
): Promise<number> {
  const result = await sql<{ count: number | string }>`
    select count(*) as count
      from alerts a
     where a.tenant_id = ${tenantId}
       and a.created_at > (
             select v.last_opened_at from user_alert_views v
              where v.tenant_id = ${tenantId} and v.user_id = ${userId}
           )
  `.execute(executor);

  // The scalar subquery yields NULL when the user has never visited, and `created_at > NULL` is
  // NULL — so the count is 0 without a second round trip.
  return toId(result.rows[0]?.count ?? 0);
}

/** Upserts `last_opened_at` on `uq_user_alert_views_tenant_user` — one row per user per tenant. */
export async function markAlertsVisited(
  executor: DbExecutor,
  tenantId: TenantId,
  userId: number,
  now: Date,
): Promise<void> {
  await sql`
    insert into user_alert_views (tenant_id, user_id, last_opened_at)
    values (${tenantId}, ${userId}, ${now})
    on conflict (tenant_id, user_id) do update set last_opened_at = excluded.last_opened_at
  `.execute(executor);
}

/** Re-exported so callers do not have to reach into the rules module for the severity union. */
export type { AlertSeverity };
