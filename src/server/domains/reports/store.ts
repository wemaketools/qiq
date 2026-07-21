/**
 * The report reads that are NOT already a dashboard payload (T-040; AC-022, AC-083; V-027, V-106).
 *
 * Port of `QuoteIQ.Infrastructure/Reports/ReportStore.cs`: the SLA/aging snapshot, the tenant
 * configuration snapshot, and the cross-tenant internal overview.
 *
 * The five dashboard-backed reports are NOT here. They call the dashboard services directly
 * (`composer.ts`), which is the whole point: a report that re-queried the pipeline would be a second
 * population for the same numbers, and the first time either side changed the printed report and the
 * on-screen dashboard would quietly disagree — with no way for a reader to tell which is right.
 *
 * BREADTH: A DELIBERATE, RECORDED DIVERGENCE FROM THE REFERENCE
 * ============================================================
 * `ReportStore.LeadQuery` (:199-253) applies tenant + product line + broker + region + date range
 * and NOTHING ELSE. It has no notion of `leads.view_all`: in the reference, any caller holding
 * `dashboards.view_pipeline` got every lead in the tenant through the SLA and Aging reports.
 *
 * This port narrows both by the caller's resolved breadth (`breadthPredicate`, the same predicate
 * the Leads list, the drill, the dashboards and the exports use). The human's AC-076(c) ruling —
 * that aggregates narrow by `leads.view_all` — is what makes this load-bearing: a report is a BULK
 * read, so leaving it unnarrowed would make it the most convenient way around that ruling, handing a
 * restricted caller the whole tenant's book in one printable document. `reports.test.ts` mutates the
 * predicate away and asserts the restricted caller's row count changes.
 *
 * WHAT IS PRESERVED, NOT FIXED: the reference applies NEITHER the RM dimension (`rmUserId`/
 * `teamOrRmId`) NOR `brokerTypeId` to this snapshot, though both are accepted on the wire and both
 * ARE applied by the dashboard-backed reports (whose services apply them). The asymmetry is real and
 * measured; changing it would silently alter what the SLA and Aging reports report. FLAGGED, not
 * resolved here.
 */
import { sql } from 'kysely';

import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import type { Money } from '../dashboards/money.js';
import { breadthPredicate, type DashboardFilter } from '../dashboards/filters.js';
import type { DashboardCaller } from '../dashboards/snapshot.js';
import { LEAD_STATUS_KEYS } from '../leads/workflow/legality.js';

import type { RawBuilder, SqlBool } from 'kysely';

/** `SlaLeadRow` (IReportStore.cs:11-29). */
export interface SlaLeadRow {
  readonly leadId: number;
  readonly leadRef: string;
  readonly partyName: string;
  readonly ownerName: string | null;
  readonly productLineId: number;
  readonly productLineName: string;
  readonly coverTypeName: string;
  readonly statusCanonicalKey: string;
  readonly statusName: string;
  readonly reportingCategory: string;
  /** `yyyy-MM-dd`. */
  readonly dateReceived: string;
  readonly createdAt: Date;
  readonly dateAssigned: Date | null;
  readonly estimatedPremium: Money | null;
  readonly currentQuotedPremium: Money | null;
  readonly hasQuote: boolean;
  readonly underwritingEnteredAt: Date | null;
  readonly underwritingExitedAt: Date | null;
}

/** `SlaQuoteRow` (IReportStore.cs:32-40). */
export interface SlaQuoteRow {
  readonly quoteId: number;
  readonly leadId: number;
  readonly productLineId: number;
  readonly productLineName: string;
  readonly leadDateReceived: string;
  readonly preparedDate: string;
  readonly sentDate: string | null;
  /** `decision_date` reduced to a UTC date, matching `DateOnly.FromDateTime(...UtcDateTime)`. */
  readonly decisionDate: string | null;
}

export interface SlaReportSnapshot {
  readonly leads: readonly SlaLeadRow[];
  readonly quotes: readonly SlaQuoteRow[];
}

export interface ReferenceListSummaryRow {
  readonly listType: string;
  readonly activeCount: number;
  readonly totalCount: number;
}

export interface BusinessRuleRow {
  readonly name: string;
  readonly value: string;
}

export interface TenantConfigurationSnapshot {
  readonly referenceLists: readonly ReferenceListSummaryRow[];
  readonly businessRules: readonly BusinessRuleRow[];
}

/** `InternalTenantOverviewRow` (IReportStore.cs:57-64). */
export interface InternalTenantOverviewRow {
  readonly tenantId: number;
  readonly tenantName: string;
  readonly status: string;
  readonly activeUsers: number;
  readonly leadCount: number;
  readonly openLeadCount: number;
  readonly quoteCount: number;
}

function toId(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * The SLA/aging lead predicates. TENANT FIRST AND UNCONDITIONALLY, breadth second.
 *
 * The tenant condition is not derived from the filter and no code path omits it. RLS is not adopted
 * (Q-10), so this predicate is the only thing between a caller and another tenant's pipeline.
 */
function slaLeadPredicates(
  tenantId: TenantId,
  filter: DashboardFilter,
  caller: DashboardCaller,
): RawBuilder<SqlBool>[] {
  const conditions: RawBuilder<SqlBool>[] = [sql`l.tenant_id = ${tenantId}`];

  const breadth = breadthPredicate(tenantId, caller);
  if (breadth !== null) conditions.push(breadth);

  // Exactly the four dimensions `ReportStore.LeadQuery` applies (:227-250) — see the file header on
  // the RM/broker-type asymmetry, which is measured and preserved.
  if (filter.productLineId !== undefined) {
    conditions.push(sql`l.product_line_id = ${filter.productLineId}`);
  }
  if (filter.brokerId !== undefined) {
    conditions.push(sql`l.broker_id = ${filter.brokerId}`);
  }
  if (filter.regionId !== undefined) {
    conditions.push(sql`l.region_id = ${filter.regionId}`);
  }
  if (filter.from !== undefined) {
    conditions.push(sql`l.date_received >= ${filter.from}::date`);
  }
  if (filter.to !== undefined) {
    conditions.push(sql`l.date_received <= ${filter.to}::date`);
  }

  return conditions;
}

interface SlaLeadDbRow {
  readonly lead_id: string | number;
  readonly lead_ref: string;
  readonly party_name: string;
  readonly owner_first_name: string | null;
  readonly owner_last_name: string | null;
  readonly product_line_id: string | number;
  readonly product_line_name: string;
  readonly cover_type_name: string;
  readonly status_canonical_key: string | null;
  readonly status_name: string;
  readonly reporting_category: string;
  readonly date_received: string;
  readonly created_at: Date;
  readonly date_assigned: Date | null;
  readonly estimated_premium: string | null;
  readonly current_quoted_premium: string | null;
  readonly has_quote: boolean;
}

interface UnderwritingWindowRow {
  readonly lead_id: string | number;
  readonly acted_at: Date;
  readonly new_canonical_key: string | null;
}

/**
 * `ReportStore.BuildSlaSnapshotAsync` (:33-112).
 *
 * A FIXED THREE QUERIES — leads, quotes, status history — regardless of tenant size. Nothing here
 * issues a query per lead; a report fans out by nature and is exactly where an N+1 stops being a
 * performance note and becomes a timeout (CLAUDE.md, N-04).
 */
export async function loadSlaReportSnapshot(
  db: DbExecutor,
  tenantId: TenantId,
  filter: DashboardFilter,
  caller: DashboardCaller,
): Promise<SlaReportSnapshot> {
  const where = sql.join(slaLeadPredicates(tenantId, filter, caller), sql` and `);

  const leadRows = await sql<SlaLeadDbRow>`
    select
      l.id                                     as lead_id,
      l.lead_ref                               as lead_ref,
      p.name                                   as party_name,
      owner.first_name                         as owner_first_name,
      owner.last_name                          as owner_last_name,
      l.product_line_id                        as product_line_id,
      pl.name                                  as product_line_name,
      ct.name                                  as cover_type_name,
      s.canonical_key                          as status_canonical_key,
      s.name                                   as status_name,
      coalesce(s.reporting_category, 'open')   as reporting_category,
      l.date_received::text                    as date_received,
      l.created_at                             as created_at,
      l.date_assigned                          as date_assigned,
      l.estimated_premium::text                as estimated_premium,
      current_quote.quoted_premium::text       as current_quoted_premium,
      exists (
        select 1 from quotes q
         where q.tenant_id = l.tenant_id and q.lead_id = l.id
      )                                        as has_quote
    from leads l
    join parties p
      on p.tenant_id = l.tenant_id and p.id = l.party_id
    join reference_items pl
      on pl.tenant_id = l.tenant_id and pl.id = l.product_line_id
    join reference_items ct
      on ct.tenant_id = l.tenant_id and ct.id = l.cover_type_id
    join reference_items s
      on s.tenant_id = l.tenant_id and s.id = l.status_id
    left join lateral (
      -- The ACCOUNTABLE owner is the assignee in the tenant's 'rm' slot, never merely an attached
      -- user: a lead's underwriter is not its RM (GetAccountableOwnersAsync, :293-315).
      select u.first_name, u.last_name
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
      select v.quoted_premium
        from quotes q
        join quote_versions v
          on v.tenant_id = q.tenant_id and v.quote_id = q.id and v.is_current
       where q.tenant_id = l.tenant_id and q.lead_id = l.id and q.is_current
       order by q.id
       limit 1
    ) current_quote on true
    where ${where}
    order by l.id
  `.execute(db);

  const leadIds = leadRows.rows.map((row) => toId(row.lead_id));

  if (leadIds.length === 0) {
    return { leads: [], quotes: [] };
  }

  interface SlaQuoteDbRow {
    readonly quote_id: string | number;
    readonly lead_id: string | number;
    readonly product_line_id: string | number;
    readonly product_line_name: string;
    readonly lead_date_received: string;
    readonly prepared_date: string;
    readonly sent_date: string | null;
    readonly decision_date: string | null;
  }

  const quoteRows = await sql<SlaQuoteDbRow>`
    select
      q.id                                                as quote_id,
      q.lead_id                                           as lead_id,
      q.product_line_id                                   as product_line_id,
      pl.name                                             as product_line_name,
      l.date_received::text                               as lead_date_received,
      q.prepared_date::text                               as prepared_date,
      q.sent_date::text                                   as sent_date,
      ((q.decision_date at time zone 'utc')::date)::text  as decision_date
    from quotes q
    join leads l on l.tenant_id = q.tenant_id and l.id = q.lead_id
    join reference_items pl
      on pl.tenant_id = q.tenant_id and pl.id = q.product_line_id
    where q.tenant_id = ${tenantId}
      and q.lead_id = any(${sql.val(leadIds)}::bigint[])
    order by q.id
  `.execute(db);

  // `GetUnderwritingWindowsAsync` (:255-291): the LAST entry into underwriting, and the FIRST event
  // after it. "Last" matters — a lead that re-entered underwriting is measured from its current
  // visit, not from a stale one months ago.
  const historyRows = await sql<UnderwritingWindowRow>`
    select
      h.lead_id       as lead_id,
      h.acted_at      as acted_at,
      s.canonical_key as new_canonical_key
    from lead_status_history h
    left join reference_items s
      on s.tenant_id = h.tenant_id and s.id = h.new_status_id
    where h.tenant_id = ${tenantId}
      and h.lead_id = any(${sql.val(leadIds)}::bigint[])
    order by h.lead_id, h.acted_at
  `.execute(db);

  const windows = new Map<number, { entered: Date; exited: Date | null }>();
  const byLead = new Map<number, UnderwritingWindowRow[]>();
  for (const row of historyRows.rows) {
    const leadId = toId(row.lead_id);
    const existing = byLead.get(leadId);
    if (existing === undefined) byLead.set(leadId, [row]);
    else existing.push(row);
  }

  for (const [leadId, ordered] of byLead) {
    let enteredAt: Date | null = null;
    for (const row of ordered) {
      if (row.new_canonical_key === LEAD_STATUS_KEYS.underwriting) enteredAt = row.acted_at;
    }
    if (enteredAt === null) continue;

    const entered: Date = enteredAt;
    const exited =
      ordered.find((row) => row.acted_at.getTime() > entered.getTime())?.acted_at ?? null;
    windows.set(leadId, { entered, exited });
  }

  const leads: SlaLeadRow[] = leadRows.rows.map((row) => {
    const window = windows.get(toId(row.lead_id));
    return {
      leadId: toId(row.lead_id),
      leadRef: row.lead_ref,
      partyName: row.party_name,
      ownerName:
        row.owner_first_name === null || row.owner_last_name === null
          ? null
          : `${row.owner_first_name} ${row.owner_last_name}`,
      productLineId: toId(row.product_line_id),
      productLineName: row.product_line_name,
      coverTypeName: row.cover_type_name,
      statusCanonicalKey: row.status_canonical_key ?? '',
      statusName: row.status_name,
      reportingCategory: row.reporting_category,
      dateReceived: row.date_received,
      createdAt: row.created_at,
      dateAssigned: row.date_assigned,
      // Money stays an exact `numeric` STRING until the DTO boundary.
      estimatedPremium: row.estimated_premium,
      currentQuotedPremium: row.current_quoted_premium,
      hasQuote: row.has_quote,
      underwritingEnteredAt: window?.entered ?? null,
      underwritingExitedAt: window?.exited ?? null,
    };
  });

  const quotes: SlaQuoteRow[] = quoteRows.rows.map((row) => ({
    quoteId: toId(row.quote_id),
    leadId: toId(row.lead_id),
    productLineId: toId(row.product_line_id),
    productLineName: row.product_line_name,
    leadDateReceived: row.lead_date_received,
    preparedDate: row.prepared_date,
    sentDate: row.sent_date,
    decisionDate: row.decision_date,
  }));

  return { leads, quotes };
}

/**
 * `ReportStore.BuildTenantConfigurationAsync` (:114-150).
 *
 * The reference-list counts are ACTIVE-over-TOTAL rather than active-only, and that difference is
 * the report's whole point on this row: a disabled reference value must remain displayable for the
 * historical records that still carry it (CLAUDE.md), so an administrator needs to see that a list
 * has 12 values of which 9 are active — not a bare 9 that hides three still in use on old leads.
 */
export async function loadTenantConfigurationSnapshot(
  db: DbExecutor,
  tenantId: TenantId,
): Promise<TenantConfigurationSnapshot> {
  interface RefRow {
    readonly list_type: string;
    readonly active_count: string | number;
    readonly total_count: string | number;
  }

  // `order by ri.list_type` is QUALIFIED. An unqualified `order by list_type` against a
  // `... as list_type` output column is the alias-shadowing trap Postgres resolves in favour of the
  // output column, and report row order is user-visible.
  const refRows = await sql<RefRow>`
    select
      ri.list_type                                as list_type,
      count(*) filter (where ri.is_active)        as active_count,
      count(*)                                    as total_count
    from reference_items ri
    where ri.tenant_id = ${tenantId}
    group by ri.list_type
    order by ri.list_type
  `.execute(db);

  interface SettingsRow {
    readonly currency_code: string;
    readonly high_value_threshold: string | null;
    readonly quote_expiry_alert_days: number | string;
    readonly aging_amber_days: number | string;
    readonly aging_red_days: number | string;
    readonly duplicate_check_days: number | string;
    readonly lead_inactivity_expiry_days: number | string;
    readonly pricing_approval_target_days: number | string;
    readonly sla_assignment_days: number | string;
    readonly sla_underwriting_days: number | string;
    readonly sla_received_to_sent_days: number | string;
    readonly max_attachment_mb: number | string;
    readonly lead_ref_format: string;
    readonly quote_ref_format: string;
  }

  const settingsRows = await sql<SettingsRow>`
    select
      ts.currency_code                as currency_code,
      ts.high_value_threshold::text   as high_value_threshold,
      ts.quote_expiry_alert_days      as quote_expiry_alert_days,
      ts.aging_amber_days             as aging_amber_days,
      ts.aging_red_days               as aging_red_days,
      ts.duplicate_check_days         as duplicate_check_days,
      ts.lead_inactivity_expiry_days  as lead_inactivity_expiry_days,
      ts.pricing_approval_target_days as pricing_approval_target_days,
      ts.sla_assignment_days          as sla_assignment_days,
      ts.sla_underwriting_days        as sla_underwriting_days,
      ts.sla_received_to_sent_days    as sla_received_to_sent_days,
      ts.max_attachment_mb            as max_attachment_mb,
      ts.lead_ref_format              as lead_ref_format,
      ts.quote_ref_format             as quote_ref_format
    from tenant_settings ts
    where ts.tenant_id = ${tenantId}
    limit 1
  `.execute(db);

  const referenceLists = refRows.rows.map((row) => ({
    listType: row.list_type,
    activeCount: toId(row.active_count),
    totalCount: toId(row.total_count),
  }));

  const settings = settingsRows.rows[0];
  if (settings === undefined) {
    // A tenant with no settings row emits NO business rules rather than fabricated defaults
    // (`if (settings is not null)`, :132). A configuration report that invents the configuration is
    // worse than one that shows it is missing.
    return { referenceLists, businessRules: [] };
  }

  const int = (value: number | string): string => String(toId(value));

  const businessRules: BusinessRuleRow[] = [
    { name: 'Display currency', value: settings.currency_code },
    {
      name: 'High-value threshold',
      // `"N0"` on the exact `numeric` string, never through a double.
      value:
        settings.high_value_threshold === null
          ? 'Not set'
          : Number(settings.high_value_threshold).toLocaleString('en-US', {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            }),
    },
    { name: 'Quote expiry alert (days)', value: int(settings.quote_expiry_alert_days) },
    { name: 'Aging amber (days)', value: int(settings.aging_amber_days) },
    { name: 'Aging red (days)', value: int(settings.aging_red_days) },
    { name: 'Duplicate check window (days)', value: int(settings.duplicate_check_days) },
    { name: 'Lead inactivity expiry (days)', value: int(settings.lead_inactivity_expiry_days) },
    { name: 'Pricing approval target (days)', value: int(settings.pricing_approval_target_days) },
    { name: 'SLA assignment (days)', value: int(settings.sla_assignment_days) },
    { name: 'SLA underwriting (days)', value: int(settings.sla_underwriting_days) },
    { name: 'SLA received-to-sent (days)', value: int(settings.sla_received_to_sent_days) },
    { name: 'Max attachment size (MB)', value: int(settings.max_attachment_mb) },
    { name: 'Lead reference format', value: settings.lead_ref_format },
    { name: 'Quote reference format', value: settings.quote_ref_format },
  ];

  return { referenceLists, businessRules };
}

/**
 * `ReportStore.BuildInternalTenantOverviewAsync` (:152-197) — THE ONE DELIBERATELY UNSCOPED READ.
 *
 * Every other query in this file carries a tenant predicate; this one spans every tenant on purpose,
 * which is why it is reachable ONLY behind `global.cross_tenant_reporting` (enforced by the catalog
 * descriptor's binding permission) and why its CSV additionally requires `global.cross_tenant_export`
 * (spec FR-65). Those two gates are the entirety of what stands between this function and a
 * cross-tenant disclosure, so they are asserted directly in `reports.test.ts` rather than inferred.
 *
 * Three set-based aggregates joined in memory, not a per-tenant fan-out.
 */
export async function loadInternalTenantOverview(
  db: DbExecutor,
): Promise<readonly InternalTenantOverviewRow[]> {
  interface OverviewRow {
    readonly tenant_id: string | number;
    readonly tenant_name: string;
    readonly status: string;
    readonly active_users: string | number;
    readonly lead_count: string | number;
    readonly open_lead_count: string | number;
    readonly quote_count: string | number;
  }

  const rows = await sql<OverviewRow>`
    select
      t.id                                     as tenant_id,
      t.name                                   as tenant_name,
      t.status                                 as status,
      coalesce(u.active_users, 0)              as active_users,
      coalesce(l.lead_count, 0)                as lead_count,
      coalesce(l.open_lead_count, 0)           as open_lead_count,
      coalesce(q.quote_count, 0)               as quote_count
    from tenants t
    left join (
      select ut.tenant_id as tenant_id, count(*) as active_users
        from user_tenants ut
        join users us on us.id = ut.user_id
       where us.is_active
       group by ut.tenant_id
    ) u on u.tenant_id = t.id
    left join (
      select
        le.tenant_id as tenant_id,
        count(*)     as lead_count,
        count(*) filter (
          where coalesce(ri.reporting_category, 'open') in ('open', 'quoted')
        )            as open_lead_count
        from leads le
        left join reference_items ri
          on ri.tenant_id = le.tenant_id and ri.id = le.status_id
       group by le.tenant_id
    ) l on l.tenant_id = t.id
    left join (
      select qu.tenant_id as tenant_id, count(*) as quote_count
        from quotes qu
       group by qu.tenant_id
    ) q on q.tenant_id = t.id
    order by t.name, t.id
  `.execute(db);

  return rows.rows.map((row) => ({
    tenantId: toId(row.tenant_id),
    tenantName: row.tenant_name,
    status: row.status,
    activeUsers: toId(row.active_users),
    leadCount: toId(row.lead_count),
    openLeadCount: toId(row.open_lead_count),
    quoteCount: toId(row.quote_count),
  }));
}
