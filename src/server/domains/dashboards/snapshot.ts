/**
 * The tenant-scoped Executive/Pipeline dashboard snapshot (T-036; AC-022, AC-071, AC-077; N-04).
 *
 * Port of `ExecutiveDashboardStore.BuildSnapshotAsync` and `PipelineDashboardStore.BuildSnapshotAsync`,
 * which are the same query twice with slightly different projections.
 *
 * ONE SNAPSHOT, NOT TWO
 * =====================
 * The reference keeps two stores whose lead queries differ only in which two columns they project.
 * They are merged here because the two dashboards REPORT OVERLAPPING NUMBERS — Open Pipeline
 * Premium and Lead-to-Quote Rate appear on both — and those numbers are read side by side. Two
 * queries that are meant to select the same population are two chances to select different ones,
 * and the resulting discrepancy would present as "the dashboards disagree", which is unfalsifiable
 * from the UI and expensive to chase. One query cannot disagree with itself.
 *
 * PREFETCH-THEN-COMPUTE IS SET-BASED, NOT N+1 (CLAUDE.md, N-04)
 * ============================================================
 * This module runs a FIXED FOUR queries — leads, quotes, stages, alerts — regardless of how many
 * leads the tenant has. Nothing below issues a query per row. The aggregation then happens over
 * the materialised rows so that every formula is the pure function from `metrics/index.ts` rather
 * than a re-derivation in SQL (AC-074: the same definition must be assertable by a unit test and by
 * the endpoint).
 *
 * ================================================================================================
 * MEASURED CONTRADICTION AGAINST THIS TASK'S BRIEF — THE SNAPSHOT IS NOT DATE-FILTERED
 * ================================================================================================
 * T-036's scope says both dashboards "honor the full shared filter bar (T-035 filter applier)".
 * The reference does NOT apply `from`/`to` to the snapshot population. `ExecutiveDashboardStore`'s
 * `ApplyNonDateDimensions` (:249-267) applies EXACTLY product line, broker and region; the date
 * range is consumed only by `ResolvePeriod` as the KPI comparison window, and every non-KPI widget
 * (aging, the eight-week trend, the six-month stacks, the high-value table, the at-risk table)
 * deliberately reads the WHOLE population as-of today.
 *
 * That is not an oversight — those widgets would be meaningless otherwise. A six-month stacked
 * column chart restricted to a one-month filter would render five empty columns, and "open quotes
 * aging" is a statement about what is open NOW, not about what was received in March.
 *
 * So `leadFilterWhere()` from T-035 is deliberately NOT used here: it also pushes `from`/`to` and
 * `brokerTypeId`, and using it would silently change what five shipped widgets report. FLAGGED for
 * the orchestrator rather than resolved unilaterally.
 *
 * `brokerTypeId` IS ACCEPTED ON THE WIRE AND IGNORED BY THESE TWO DASHBOARDS, which is likewise
 * measured: neither store references it. It is applied by the Broker/RM dashboards' own snapshot
 * queries (T-037). Also FLAGGED.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { ZERO_MONEY, type Money } from './money.js';
import { breadthPredicate, effectiveRmUserId, type DashboardFilter } from './filters.js';

/**
 * The caller's SERVER-RESOLVED visibility breadth. Never read from the wire — a client that could
 * assert its own `callerHasViewAll` would widen every aggregate on this page by asking.
 */
export interface DashboardCaller {
  readonly callerUserId: number;
  readonly callerHasViewAll: boolean;
}

/** The two reporting categories that mean "still in play" (`OpenCategories`). */
export const OPEN_REPORTING_CATEGORIES: readonly string[] = ['open', 'quoted'];

export function isOpenCategory(category: string): boolean {
  return OPEN_REPORTING_CATEGORIES.includes(category);
}

export interface SnapshotLead {
  readonly leadId: number;
  readonly leadRef: string;
  readonly partyName: string;
  readonly partyType: string;
  readonly brokerId: number | null;
  readonly brokerName: string | null;
  readonly productLineId: number;
  readonly productLineName: string;
  readonly requestChannelName: string | null;
  readonly statusName: string;
  readonly statusCanonicalKey: string | null;
  readonly reportingCategory: string;
  readonly estimatedPremium: Money | null;
  readonly dateReceived: string;
  readonly nextFollowUpDate: string | null;
  readonly ownerUserId: number | null;
  readonly ownerName: string | null;
  /** Any quote at all, current or not — the Lead-to-Quote numerator counts LEADS. */
  readonly hasQuote: boolean;
  /** The premium of the lead's `is_current` quote's current version, or null when it has none. */
  readonly currentQuotedPremium: Money | null;
}

export interface SnapshotQuote {
  readonly quoteId: number;
  readonly leadId: number;
  readonly statusCanonicalKey: string | null;
  readonly reportingCategory: string;
  /** The CURRENT version's quoted premium; 0.00 when a quote somehow has no current version. */
  readonly currentPremium: Money;
  readonly boundPremium: Money | null;
  readonly preparedDate: string;
  readonly sentDate: string | null;
  readonly validUntil: string | null;
  /** `decision_date` reduced to a UTC date, matching `DateOnly.FromDateTime(...UtcDateTime)`. */
  readonly decisionDate: string | null;
  readonly leadDateReceived: string;
}

export interface SnapshotStage {
  readonly stageName: string;
  readonly stageCanonicalKey: string | null;
  readonly reportingCategory: string;
}

export interface DashboardSnapshot {
  readonly leads: readonly SnapshotLead[];
  readonly quotes: readonly SnapshotQuote[];
  readonly stages: readonly SnapshotStage[];
  /** Lead ids carrying at least one UNRESOLVED alert. */
  readonly atRiskLeadIds: ReadonlySet<number>;
  /** Quote ids named by at least one unresolved alert. */
  readonly atRiskQuoteIds: ReadonlySet<number>;
  /** Distinct open alert types per lead, used to pick a row's primary risk reason. */
  readonly openAlertTypesByLead: ReadonlyMap<number, readonly string[]>;
  /**
   * Unresolved alert ROW counts per type, over THIS snapshot's lead population (T-050).
   *
   * MEASURED DIVERGENCE, FLAGGED. The reference — and this port until now — read these from
   * `countOpenAlertsByType`, which is tenant-wide and honours neither the dashboard filter nor the
   * caller's breadth. That makes every widget carrying them (`sla_breaches` and five of the eight
   * Immediate Actions) unreconcilable: a restricted caller saw "SLA Breaches 7" and drilled into an
   * empty list, which is precisely the failure AC-076 forbids. Counting over the snapshot's own
   * leads costs no extra query — the alert rows are already loaded for the at-risk sets.
   */
  readonly openAlertCountsByType: ReadonlyMap<string, number>;
}

/**
 * The snapshot's lead predicates. TENANT FIRST AND UNCONDITIONALLY.
 *
 * The tenant condition is not derived from the filter and there is no code path that omits it. An
 * aggregate is not a list: a cross-tenant leak here does not surface as a foreign row someone might
 * notice, only as a number that is quietly too big.
 */
function snapshotPredicates(
  tenantId: TenantId,
  filter: DashboardFilter,
  caller: DashboardCaller,
): RawBuilder<SqlBool>[] {
  const conditions: RawBuilder<SqlBool>[] = [sql`l.tenant_id = ${tenantId}`];

  // BREADTH NARROWS THE AGGREGATE, NOT ONLY THE DRILL (AC-076, T-050).
  //
  // Without `leads.view_all` a caller sees only the leads they are assigned to — here, before the
  // aggregation, because after it there is no way back: once you have a sum you can no longer
  // subtract the rows the caller should not have seen. Applying it only to the drill would leave a
  // user staring at a headline they cannot reconcile by clicking it, which is the exact failure
  // this rule exists to prevent.
  const breadth = breadthPredicate(tenantId, caller);
  if (breadth !== null) conditions.push(breadth);

  if (filter.productLineId !== undefined) {
    conditions.push(sql`l.product_line_id = ${filter.productLineId}`);
  }
  if (filter.brokerId !== undefined) {
    conditions.push(sql`l.broker_id = ${filter.brokerId}`);
  }
  if (filter.regionId !== undefined) {
    conditions.push(sql`l.region_id = ${filter.regionId}`);
  }

  // The RM dimension narrows to leads whose ACCOUNTABLE OWNER is that user — the `rm` business
  // assignment slot — not to leads the user is merely attached to. A lead's underwriter is not its
  // RM, and counting an underwriter's leads in an RM filter would inflate that RM's pipeline.
  //
  // Resolved through T-035's `effectiveRmUserId` so all five dashboards agree on the precedence of
  // `teamOrRmId` over `rmUserId`. The reference's Executive/Pipeline stores read `filter.RmUserId`
  // directly and would ignore a lone `teamOrRmId`; no client sends one to these two endpoints, so
  // the behaviours coincide for every real caller. Documented divergence, FLAGGED.
  const rmUserId = effectiveRmUserId(filter);
  if (rmUserId !== undefined) {
    conditions.push(sql`owner.user_id = ${rmUserId}`);
  }

  return conditions;
}

interface LeadRow {
  readonly lead_id: string | number;
  readonly lead_ref: string;
  readonly party_name: string;
  readonly party_type: string | null;
  readonly broker_id: string | number | null;
  readonly broker_name: string | null;
  readonly product_line_id: string | number;
  readonly product_line_name: string;
  readonly request_channel_name: string | null;
  readonly status_name: string;
  readonly status_canonical_key: string | null;
  readonly reporting_category: string;
  readonly estimated_premium: string | null;
  readonly date_received: string;
  readonly next_follow_up_date: string | null;
  readonly owner_user_id: string | number | null;
  readonly owner_first_name: string | null;
  readonly owner_last_name: string | null;
  readonly has_quote: boolean;
  readonly current_quoted_premium: string | null;
}

function toId(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function toIdOrNull(value: string | number | null): number | null {
  return value === null ? null : toId(value);
}

/**
 * Loads everything both dashboards aggregate over.
 *
 * `today` is passed in rather than read from a clock so the whole payload is a pure function of
 * (data, filter, instant) and can be asserted to an exact value in a test.
 */
export async function loadDashboardSnapshot(
  db: DbExecutor,
  tenantId: TenantId,
  filter: DashboardFilter,
  caller: DashboardCaller,
): Promise<DashboardSnapshot> {
  const where = sql.join(snapshotPredicates(tenantId, filter, caller), sql` and `);

  // ---------------------------------------------------------------------------------------------
  // Leads. One statement: the accountable owner, the current quote's premium and the has-any-quote
  // flag all arrive as correlated aggregates rather than as follow-up queries per lead.
  //
  // Every join is tenant-qualified ON BOTH SIDES. Inheriting tenancy from the outer query alone
  // would be one refactor away from not having it at all, and reference data is per-tenant here.
  // ---------------------------------------------------------------------------------------------
  const leadRows = await sql<LeadRow>`
    select
      l.id                                     as lead_id,
      l.lead_ref                               as lead_ref,
      p.name                                   as party_name,
      pt.name                                  as party_type,
      l.broker_id                              as broker_id,
      b.name                                   as broker_name,
      l.product_line_id                        as product_line_id,
      pl.name                                  as product_line_name,
      rc.name                                  as request_channel_name,
      s.name                                   as status_name,
      s.canonical_key                          as status_canonical_key,
      coalesce(s.reporting_category, 'open')   as reporting_category,
      l.estimated_premium::text                as estimated_premium,
      l.date_received::text                    as date_received,
      l.next_follow_up_date::text              as next_follow_up_date,
      owner.user_id                            as owner_user_id,
      owner.first_name                         as owner_first_name,
      owner.last_name                          as owner_last_name,
      exists (
        select 1 from quotes q
         where q.tenant_id = l.tenant_id and q.lead_id = l.id
      )                                        as has_quote,
      current_quote.quoted_premium::text       as current_quoted_premium
    from leads l
    join parties p
      on p.tenant_id = l.tenant_id and p.id = l.party_id
    left join reference_items pt
      on pt.tenant_id = p.tenant_id and pt.id = p.party_type_id
    join reference_items pl
      on pl.tenant_id = l.tenant_id and pl.id = l.product_line_id
    join reference_items s
      on s.tenant_id = l.tenant_id and s.id = l.status_id
    left join reference_items rc
      on rc.tenant_id = l.tenant_id and rc.id = l.request_channel_id
    left join brokers b
      on b.tenant_id = l.tenant_id and b.id = l.broker_id
    left join lateral (
      -- The accountable owner is the assignee in the tenant's 'rm' SLOT. Ordered and limited so a
      -- lead that carries two rm-slot assignment rows resolves deterministically to one owner
      -- rather than throwing (the reference's ToDictionary would) or picking arbitrarily.
      select la.user_id, u.first_name, u.last_name
        from lead_assignments la
        join business_assignments ba
          on ba.tenant_id = la.tenant_id and ba.id = la.business_assignment_id
        join users u on u.id = la.user_id
       where la.tenant_id = l.tenant_id
         and la.lead_id = l.id
         and ba.slot = 'rm'
       order by la.id
       limit 1
    ) owner on true
    left join lateral (
      -- The lead's CURRENT quote's CURRENT version premium. Both is_current markers are required:
      -- the first picks the lead's primary quote, the second its live revision.
      select v.quoted_premium
        from quotes q
        join quote_versions v
          on v.tenant_id = q.tenant_id and v.quote_id = q.id and v.is_current
       where q.tenant_id = l.tenant_id and q.lead_id = l.id and q.is_current
       order by q.id desc
       limit 1
    ) current_quote on true
    where ${where}
    order by l.id
  `.execute(db);

  const leads: SnapshotLead[] = leadRows.rows.map((row) => ({
    leadId: toId(row.lead_id),
    leadRef: row.lead_ref,
    partyName: row.party_name,
    partyType: row.party_type ?? '',
    brokerId: toIdOrNull(row.broker_id),
    brokerName: row.broker_name,
    productLineId: toId(row.product_line_id),
    productLineName: row.product_line_name,
    requestChannelName: row.request_channel_name,
    statusName: row.status_name,
    statusCanonicalKey: row.status_canonical_key,
    reportingCategory: row.reporting_category,
    // Money stays a STRING all the way through; widening happens once, at the DTO boundary.
    estimatedPremium: row.estimated_premium,
    dateReceived: row.date_received,
    nextFollowUpDate: row.next_follow_up_date,
    ownerUserId: toIdOrNull(row.owner_user_id),
    ownerName:
      row.owner_first_name === null || row.owner_last_name === null
        ? null
        : `${row.owner_first_name} ${row.owner_last_name}`,
    hasQuote: row.has_quote,
    currentQuotedPremium: row.current_quoted_premium,
  }));

  const leadIds = leads.map((lead) => lead.leadId);
  if (leadIds.length === 0) {
    // No leads means no quotes and no alerts by construction; the stages list is still needed so
    // the funnel and heatmap render their (empty) rows rather than vanishing.
    return {
      leads,
      quotes: [],
      stages: await loadStages(db, tenantId),
      atRiskLeadIds: new Set(),
      atRiskQuoteIds: new Set(),
      openAlertTypesByLead: new Map(),
      openAlertCountsByType: new Map(),
    };
  }

  interface QuoteRow {
    readonly quote_id: string | number;
    readonly lead_id: string | number;
    readonly status_canonical_key: string | null;
    readonly reporting_category: string;
    readonly current_premium: string | null;
    readonly bound_premium: string | null;
    readonly prepared_date: string;
    readonly sent_date: string | null;
    readonly valid_until: string | null;
    readonly decision_date: string | null;
    readonly lead_date_received: string;
  }

  const quoteRows = await sql<QuoteRow>`
    select
      q.id                                                as quote_id,
      q.lead_id                                           as lead_id,
      s.canonical_key                                     as status_canonical_key,
      coalesce(s.reporting_category, 'open')              as reporting_category,
      v.quoted_premium::text                              as current_premium,
      q.bound_premium::text                               as bound_premium,
      q.prepared_date::text                               as prepared_date,
      q.sent_date::text                                   as sent_date,
      q.valid_until::text                                 as valid_until,
      ((q.decision_date at time zone 'utc')::date)::text  as decision_date,
      l.date_received::text                               as lead_date_received
    from quotes q
    join leads l on l.tenant_id = q.tenant_id and l.id = q.lead_id
    join reference_items s on s.tenant_id = q.tenant_id and s.id = q.status_id
    left join quote_versions v
      on v.tenant_id = q.tenant_id and v.quote_id = q.id and v.is_current
    where q.tenant_id = ${tenantId}
      and q.lead_id = any(${sql.val(leadIds)}::bigint[])
    order by q.id
  `.execute(db);

  const quotes: SnapshotQuote[] = quoteRows.rows.map((row) => ({
    quoteId: toId(row.quote_id),
    leadId: toId(row.lead_id),
    statusCanonicalKey: row.status_canonical_key,
    reportingCategory: row.reporting_category,
    // A quote with no current version contributes 0.00, matching the reference's dictionary miss.
    currentPremium: row.current_premium ?? ZERO_MONEY,
    boundPremium: row.bound_premium,
    preparedDate: row.prepared_date,
    sentDate: row.sent_date,
    validUntil: row.valid_until,
    decisionDate: row.decision_date,
    leadDateReceived: row.lead_date_received,
  }));

  interface AlertRow {
    readonly lead_id: string | number;
    readonly quote_id: string | number | null;
    readonly type: string;
  }

  // UNRESOLVED alerts only. A resolved alert is history: counting it would keep a lead "at risk"
  // forever and make the at-risk tables monotonically grow.
  const alertRows = await sql<AlertRow>`
    select a.lead_id as lead_id, a.quote_id as quote_id, a.type as type
      from alerts a
     where a.tenant_id = ${tenantId}
       and a.resolved_at is null
       and a.lead_id = any(${sql.val(leadIds)}::bigint[])
  `.execute(db);

  const atRiskLeadIds = new Set<number>();
  const atRiskQuoteIds = new Set<number>();
  const openAlertTypesByLead = new Map<number, string[]>();
  const openAlertCountsByType = new Map<string, number>();

  for (const row of alertRows.rows) {
    const leadId = toId(row.lead_id);
    atRiskLeadIds.add(leadId);
    openAlertCountsByType.set(row.type, (openAlertCountsByType.get(row.type) ?? 0) + 1);

    const quoteId = toIdOrNull(row.quote_id);
    if (quoteId !== null) atRiskQuoteIds.add(quoteId);

    const types = openAlertTypesByLead.get(leadId);
    if (types === undefined) {
      openAlertTypesByLead.set(leadId, [row.type]);
    } else if (!types.includes(row.type)) {
      types.push(row.type);
    }
  }

  return {
    leads,
    quotes,
    stages: await loadStages(db, tenantId),
    atRiskLeadIds,
    atRiskQuoteIds,
    openAlertTypesByLead,
    openAlertCountsByType,
  };
}

/**
 * The tenant's ACTIVE lead statuses, which are the funnel's and the heatmap's row headers.
 *
 * Read from `reference_items` rather than inferred from the statuses the leads happen to occupy:
 * a stage with no leads in it must still render as an empty funnel bar, because "nothing has
 * reached Negotiation" is exactly the finding the chart exists to surface.
 *
 * `order by ri.name` is qualified. An unqualified `order by name` against a `... as name` output
 * column is the alias-shadowing trap Postgres resolves in favour of the OUTPUT column.
 */
async function loadStages(db: DbExecutor, tenantId: TenantId): Promise<SnapshotStage[]> {
  interface StageRow {
    readonly stage_name: string;
    readonly stage_canonical_key: string | null;
    readonly reporting_category: string;
  }

  const rows = await sql<StageRow>`
    select
      ri.name                                   as stage_name,
      ri.canonical_key                          as stage_canonical_key,
      coalesce(ri.reporting_category, 'open')   as reporting_category
    from reference_items ri
    where ri.tenant_id = ${tenantId}
      and ri.list_type = 'lead_status'
      and ri.is_active
    order by ri.display_order, ri.name
  `.execute(db);

  return rows.rows.map((row) => ({
    stageName: row.stage_name,
    stageCanonicalKey: row.stage_canonical_key,
    reportingCategory: row.reporting_category,
  }));
}

/** The tenant settings the dashboards read, with money kept as an exact decimal STRING. */
export interface DashboardSettings {
  readonly currencyCode: string;
  /** `numeric(18,2)` as a string, or null when the tenant has configured no threshold at all. */
  readonly highValueThreshold: Money | null;
  readonly slaReceivedToSentDays: number;
}

/**
 * Reads the dashboard-relevant tenant settings.
 *
 * DELIBERATELY NOT `findSettings()` from the business-rules repository, which widens
 * `high_value_threshold` to a JS `number` at its DTO boundary (`repository.ts:91`). That widening is
 * correct THERE — the settings API's wire contract is a JSON number — but this module COMPARES the
 * threshold against premium, and a comparison between a double-rounded threshold and exact cents is
 * how a lead lands on the wrong side of a high-value boundary. The T-008 money pins cannot see a
 * `Number()` written in consumer code; this is the consumer, so it reads the column as text.
 *
 * A tenant with no settings row falls back to the schema defaults rather than failing, which keeps a
 * partially-provisioned tenant's dashboard renderable.
 */
export async function loadDashboardSettings(
  db: DbExecutor,
  tenantId: TenantId,
): Promise<DashboardSettings> {
  interface SettingsRow {
    readonly currency_code: string;
    readonly high_value_threshold: string | null;
    readonly sla_received_to_sent_days: number | string;
  }

  const rows = await sql<SettingsRow>`
    select
      ts.currency_code                 as currency_code,
      ts.high_value_threshold::text    as high_value_threshold,
      ts.sla_received_to_sent_days     as sla_received_to_sent_days
    from tenant_settings ts
    where ts.tenant_id = ${tenantId}
    limit 1
  `.execute(db);

  const row = rows.rows[0];
  if (row === undefined) {
    return { currencyCode: 'BWP', highValueThreshold: null, slaReceivedToSentDays: 5 };
  }

  return {
    currencyCode: row.currency_code,
    highValueThreshold: row.high_value_threshold,
    slaReceivedToSentDays: Number(row.sla_received_to_sent_days),
  };
}
