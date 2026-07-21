/**
 * The five per-dashboard drill row queries (T-050; AC-076; V-095).
 *
 * Port of `ExecutiveDrillRowQuery.cs`, `PipelineDrillRowQuery.cs`, `BrokerDrillRowQuery.cs`,
 * `RmDrillRowQuery.cs`, `LossDrillRowQuery.cs`, the five `*DrillScope` enums and `ScopesByKey`
 * maps, the store-side `ListDrillRowsAsync` bodies, and `DrillWidgetRegistry.cs:24-64`.
 *
 * ================================================================================================
 * THE RULE THIS MODULE EXISTS TO SATISFY: THE NON-EMPTY SUPERSET INVARIANT
 * ================================================================================================
 * A drill answers "which records ARE that number". The binding requirement is therefore NOT that a
 * drill's row count equals its widget's value — drills return LEAD rows while many widgets count
 * quotes, sum premium, or average days, so that equality is not expressible for most widgets. The
 * requirement is that
 *
 *     the drill population is a SUPERSET of the lead-projection of the aggregate's population.
 *
 * If a widget shows a non-zero number, its drill returns at least one row, and it never omits a
 * lead the aggregate counted. That is the property that prevents "the headline says 12, I drilled
 * in and the list is empty".
 *
 * Two consequences shape every predicate below.
 *
 * 1. A KEY'S SCOPE IS THE UNION OVER EVERY AGGREGATE THAT EMITS IT. Keys map many-to-one onto
 *    scopes, so a scope must cover ALL of its widgets, not the one it happens to be named after.
 *    Each scope below therefore documents the widget populations it must contain.
 *
 * 2. NEVER DATE-FILTER A DRILL WHOSE AGGREGATE READS THE FULL POPULATION. Measured, and it differs
 *    per dashboard (F-050-05): `broker.service.ts`, `rm.service.ts` and `loss.service.ts` all load
 *    through `leadFilterWhere`, which pushes `from`/`to`, so their ENTIRE populations are
 *    date-scoped and their drills apply the date too. `snapshot.ts:snapshotPredicates` pushes NO
 *    date at all, so the Executive/Pipeline populations are full and only their KPI cards narrow by
 *    date IN MEMORY — and on `quote.prepared_date`/`quote.decision_date`, which a lead-row drill
 *    cannot express. Applying `from`/`to` to those two dashboards' drills (which the reference does)
 *    would make every one of their drills narrower than its own headline. So they do not.
 *
 * ================================================================================================
 * MEASURED CONTRADICTIONS AGAINST THE REFERENCE — DELIBERATE, NOT DRIFT
 * ================================================================================================
 * The reference's own drill comment (`ExecutiveDashboardStore.cs:299`) claims "the same non-date +
 * date dimensions the aggregation applies, so a drill list matches its widget". It states the
 * invariant and does not achieve it. It is not ported; these are the places it fails and what is
 * done instead.
 *
 * (a) RM DIMENSION (F-050-04). `snapshotPredicates` narrows the Executive/Pipeline aggregate by the
 *     accountable owner (`rm` slot); the reference's Executive/Pipeline drills apply NO RM
 *     dimension, so an RM-filtered reference drill is WIDER than its aggregate. Wider is
 *     superset-compatible, so the reference does not VIOLATE the invariant here — but equality is
 *     strictly stronger than "wider", and it is what makes the lead-count widgets reconcile exactly.
 *     RESOLUTION: the drill applies the RM dimension, via `accountableOwnerPredicate` — the same
 *     `rm`-slot rule the aggregate uses, not the Leads list's any-assignment rule.
 *
 * (b) OPEN PIPELINE excludes leads its own aggregate counts. `openPipelineOf` sums OPEN-CATEGORY
 *     QUOTES, and a quote may be open on a lead that is not (fixture: L5 is lost, its quote Q9 is
 *     open, and the expected `openQuotePremium` includes Q9). The reference's `OpenPipeline` scope
 *     is `OpenCategories.Contains(row.ReportingCategory)` — a LEAD-category test that drops L5.
 *     RESOLUTION: open-category lead OR lead carrying an open-category quote. Pipeline's scope
 *     additionally admits `won`, because its funnel bars count `PROGRESSION_CATEGORIES`
 *     (`open, quoted, won`) and every bar carries this key.
 *
 * (c) WON excludes leads its own aggregate counts. `won_premium` sums WON QUOTES; a won quote can
 *     sit on a lead whose own category is not won (fixture: Q2 is won on L2, whose category is
 *     `quoted`). `conversion_rate` and the won-vs-lost TREND — which also carries this key — count
 *     won AND lost quotes. RESOLUTION: the Executive `Won` scope is DECIDED — won/lost at either
 *     lead or quote granularity. The Pipeline `Won` key serves only `proposal_to_win_rate`, whose
 *     denominator is SENT quotes, so its scope is sent-or-won instead.
 *
 * (d) AT RISK excludes leads its own aggregate counts. `leads_at_risk` is `atRiskLeadIds.size`,
 *     built from unresolved alerts with NO category test, so a won or lost lead carrying an
 *     unresolved alert is counted. The reference's `AtRisk` scope requires an open category.
 *     RESOLUTION: any lead carrying an unresolved alert.
 *
 * (e) OVERDUE FOLLOW-UPS is right for Broker and wrong for RM. Broker's `overdue_follow_ups` KPI
 *     counts strictly-overdue open leads, which the reference scope matches exactly. RM's key is
 *     carried by `follow_up_compliance`, whose population is open leads with a COMMITTED follow-up
 *     date — on-time ones included — so the strictly-overdue scope would omit the compliant half of
 *     its own denominator. RESOLUTION: the two scopes differ, which is why the enums are per
 *     dashboard rather than shared.
 */
import { sql } from 'kysely';

import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { listLeads } from '../leads/repository.js';
import { effectiveRmUserId, type DashboardFilter } from './filters.js';
import { accountableOwnerPredicate } from './owner.js';
import { loadDashboardSettings } from './snapshot.js';
import { BROKER_WIDGET_KEYS } from './broker.service.js';
import { EXECUTIVE_WIDGET_KEYS } from './executive.service.js';
import { LOSS_WIDGET_KEYS } from './loss.service.js';
import { PIPELINE_WIDGET_KEYS } from './pipeline.service.js';
import { RM_WIDGET_KEYS } from './rm.service.js';

import type { RawBuilder, SqlBool } from 'kysely';
import type { DrillRowQuery } from './drill.service.js';

// ---------------------------------------------------------------------------------------------
// Shared lead-level predicate vocabulary. Alias `l`, every value a bound parameter.
// ---------------------------------------------------------------------------------------------

/** `OpenCategories` — still in play. */
const OPEN_CATEGORIES = ['open', 'quoted'];
/** The funnel's progression categories (`pipeline.service.ts:93`). */
const PROGRESSION_CATEGORIES = ['open', 'quoted', 'won'];
/** Decided = won or lost. Expired/withdrawn carry a decision date and are NOT decided. */
const DECIDED_CATEGORIES = ['won', 'lost'];

/** The lead's own status reporting category is one of `categories`. */
function leadCategoryIn(tenantId: TenantId, categories: readonly string[]): RawBuilder<SqlBool> {
  return sql`exists (
    select 1 from reference_items s
     where s.tenant_id = ${tenantId}
       and s.id = l.status_id
       and coalesce(s.reporting_category, 'open') = any(${sql.val(categories as string[])}::text[])
  )`;
}

/** The lead carries at least one quote at all (the Lead-to-Quote numerator's membership test). */
function hasAnyQuote(tenantId: TenantId): RawBuilder<SqlBool> {
  return sql`exists (
    select 1 from quotes q where q.tenant_id = ${tenantId} and q.lead_id = l.id
  )`;
}

/** The lead carries at least one quote whose own reporting category is in `categories`. */
function hasQuoteInCategories(
  tenantId: TenantId,
  categories: readonly string[],
): RawBuilder<SqlBool> {
  return sql`exists (
    select 1 from quotes q
      join reference_items qs on qs.tenant_id = q.tenant_id and qs.id = q.status_id
     where q.tenant_id = ${tenantId}
       and q.lead_id = l.id
       and coalesce(qs.reporting_category, 'open') = any(${sql.val(categories as string[])}::text[])
  )`;
}

/** The lead carries at least one SENT quote (the proposal-rate denominator's membership test). */
function hasSentQuote(tenantId: TenantId): RawBuilder<SqlBool> {
  return sql`exists (
    select 1 from quotes q
     where q.tenant_id = ${tenantId} and q.lead_id = l.id and q.sent_date is not null
  )`;
}

/**
 * The lead carries at least one UNRESOLVED alert.
 *
 * Resolved alerts are history: counting them would keep a lead at risk forever, and the aggregate
 * (`snapshot.ts`) excludes them too.
 */
function hasUnresolvedAlert(tenantId: TenantId): RawBuilder<SqlBool> {
  return sql`exists (
    select 1 from alerts a
     where a.tenant_id = ${tenantId} and a.lead_id = l.id and a.resolved_at is null
  )`;
}

/** An open lead carrying a committed next follow-up date (compliance's denominator). */
function committedFollowUp(tenantId: TenantId): RawBuilder<SqlBool> {
  return sql`(${leadCategoryIn(tenantId, OPEN_CATEGORIES)} and l.next_follow_up_date is not null)`;
}

/** An open lead whose committed follow-up date has already passed. STRICTLY before today. */
function overdueFollowUp(tenantId: TenantId, today: string): RawBuilder<SqlBool> {
  return sql`(${committedFollowUp(tenantId)} and l.next_follow_up_date < ${today}::date)`;
}

/** The lead has a broker (the Broker dashboard's whole population, `broker.service.ts:266`). */
function hasBroker(): RawBuilder<SqlBool> {
  return sql`l.broker_id is not null`;
}

/** Open at lead OR quote granularity — see contradiction (b). */
function openPipeline(tenantId: TenantId, leadCategories: readonly string[]): RawBuilder<SqlBool> {
  return sql`(${leadCategoryIn(tenantId, leadCategories)} or ${hasQuoteInCategories(tenantId, OPEN_CATEGORIES)})`;
}

/**
 * Above the tenant's high-value threshold, compared as exact `numeric` IN SQL.
 *
 * The threshold arrives as a decimal STRING and is cast, never widened through a JS double: a
 * double-rounded threshold is how a lead lands on the wrong side of a high-value boundary.
 * Premium is the CURRENT quote's current version, falling back to the lead estimate, then zero —
 * the same coalesce order the reference's `MatchesScope` uses.
 */
function aboveHighValueThreshold(tenantId: TenantId, threshold: string): RawBuilder<SqlBool> {
  return sql`coalesce((
    select v.quoted_premium
      from quotes q
      join quote_versions v on v.tenant_id = q.tenant_id and v.quote_id = q.id and v.is_current
     where q.tenant_id = ${tenantId} and q.lead_id = l.id and q.is_current
     order by q.id desc
     limit 1
  ), l.estimated_premium, 0) > ${threshold}::numeric`;
}

// ---------------------------------------------------------------------------------------------
// The five scope enums (`*DrillScope`).
// ---------------------------------------------------------------------------------------------

export type ExecutiveDrillScope =
  | 'exec.all_leads'
  | 'exec.quoted'
  | 'exec.open_pipeline'
  | 'exec.decided'
  | 'exec.lost'
  | 'exec.high_value'
  | 'exec.at_risk';

export type PipelineDrillScope =
  | 'pipeline.all_leads'
  | 'pipeline.quoted'
  | 'pipeline.open_pipeline'
  | 'pipeline.sent_or_won'
  | 'pipeline.lost'
  | 'pipeline.at_risk';

export type BrokerDrillScope =
  | 'broker.all_leads'
  | 'broker.quoted'
  | 'broker.decided'
  | 'broker.lost'
  | 'broker.overdue_follow_ups';

export type RmDrillScope =
  | 'rm.all_leads'
  | 'rm.quoted'
  | 'rm.decided'
  | 'rm.lost'
  | 'rm.committed_follow_ups';

export type LossDrillScope = 'loss.all_lost' | 'loss.price_gap';

export type DashboardDrillScope =
  | ExecutiveDrillScope
  | PipelineDrillScope
  | BrokerDrillScope
  | RmDrillScope
  | LossDrillScope;

// ---------------------------------------------------------------------------------------------
// `ScopesByKey` — a widget key's drill population has exactly one home.
// ---------------------------------------------------------------------------------------------

export const EXECUTIVE_SCOPES_BY_KEY: Readonly<Record<string, ExecutiveDrillScope>> = {
  [EXECUTIVE_WIDGET_KEYS.allLeads]: 'exec.all_leads',
  [EXECUTIVE_WIDGET_KEYS.quoted]: 'exec.quoted',
  [EXECUTIVE_WIDGET_KEYS.openPipeline]: 'exec.open_pipeline',
  [EXECUTIVE_WIDGET_KEYS.won]: 'exec.decided',
  [EXECUTIVE_WIDGET_KEYS.lost]: 'exec.lost',
  [EXECUTIVE_WIDGET_KEYS.highValue]: 'exec.high_value',
  [EXECUTIVE_WIDGET_KEYS.atRisk]: 'exec.at_risk',
};

export const PIPELINE_SCOPES_BY_KEY: Readonly<Record<string, PipelineDrillScope>> = {
  // `NewLeads` and `AllLeads` share one scope in the reference too: "new leads this month" is the
  // date-scoped subset of the same population, and the drill cannot narrow to it without becoming
  // narrower than the other widgets carrying the key.
  [PIPELINE_WIDGET_KEYS.newLeads]: 'pipeline.all_leads',
  [PIPELINE_WIDGET_KEYS.allLeads]: 'pipeline.all_leads',
  [PIPELINE_WIDGET_KEYS.openPipeline]: 'pipeline.open_pipeline',
  [PIPELINE_WIDGET_KEYS.quoted]: 'pipeline.quoted',
  [PIPELINE_WIDGET_KEYS.won]: 'pipeline.sent_or_won',
  [PIPELINE_WIDGET_KEYS.lost]: 'pipeline.lost',
  [PIPELINE_WIDGET_KEYS.atRisk]: 'pipeline.at_risk',
  // Q-8's overdue-quotes action: a pre-sent draft is not a distinct lead-list scope, so the drill
  // lands on the open pipeline — the reference's rendering, preserved.
  [PIPELINE_WIDGET_KEYS.overdueQuotes]: 'pipeline.open_pipeline',
};

export const BROKER_SCOPES_BY_KEY: Readonly<Record<string, BrokerDrillScope>> = {
  [BROKER_WIDGET_KEYS.leads]: 'broker.all_leads',
  [BROKER_WIDGET_KEYS.quotes]: 'broker.quoted',
  [BROKER_WIDGET_KEYS.won]: 'broker.decided',
  [BROKER_WIDGET_KEYS.lost]: 'broker.lost',
  [BROKER_WIDGET_KEYS.overdue]: 'broker.overdue_follow_ups',
};

export const RM_SCOPES_BY_KEY: Readonly<Record<string, RmDrillScope>> = {
  [RM_WIDGET_KEYS.leads]: 'rm.all_leads',
  [RM_WIDGET_KEYS.quotes]: 'rm.quoted',
  [RM_WIDGET_KEYS.won]: 'rm.decided',
  [RM_WIDGET_KEYS.lost]: 'rm.lost',
  [RM_WIDGET_KEYS.overdue]: 'rm.committed_follow_ups',
};

export const LOSS_SCOPES_BY_KEY: Readonly<Record<string, LossDrillScope>> = {
  // The reason/trend/cover/broker/RM views differ only in which shared filter dimension the caller
  // narrowed, and reason has no filter dimension at all — so every one of them lands on the whole
  // lost list, which is also exactly the population each of those widgets aggregates.
  [LOSS_WIDGET_KEYS.countByReason]: 'loss.all_lost',
  [LOSS_WIDGET_KEYS.trendByReason]: 'loss.all_lost',
  [LOSS_WIDGET_KEYS.byCoverType]: 'loss.all_lost',
  [LOSS_WIDGET_KEYS.byBroker]: 'loss.all_lost',
  [LOSS_WIDGET_KEYS.byRm]: 'loss.all_lost',
  [LOSS_WIDGET_KEYS.priceGap]: 'loss.price_gap',
};

/** Every emitted widget key paired with its scope. The registry is built from exactly this. */
export const DASHBOARD_SCOPES_BY_KEY: Readonly<Record<string, DashboardDrillScope>> = {
  ...EXECUTIVE_SCOPES_BY_KEY,
  ...PIPELINE_SCOPES_BY_KEY,
  ...BROKER_SCOPES_BY_KEY,
  ...RM_SCOPES_BY_KEY,
  ...LOSS_SCOPES_BY_KEY,
};

// ---------------------------------------------------------------------------------------------
// Population builders: the dimensions each DASHBOARD applies, then the scope predicate.
// ---------------------------------------------------------------------------------------------

interface PopulationContext {
  readonly tenantId: TenantId;
  readonly filter: DashboardFilter;
  readonly today: string;
}

/**
 * The dimensions a dashboard's own aggregate applies, as drill predicates.
 *
 * `dateScoped` is the whole of contradiction (2) in the header: it is TRUE exactly where the
 * dashboard's aggregate population is itself date-filtered.
 */
function dimensionPredicates(
  { tenantId, filter }: PopulationContext,
  options: { readonly dateScoped: boolean; readonly rmDimension: boolean; readonly brokerType: boolean },
): RawBuilder<SqlBool>[] {
  const conditions: RawBuilder<SqlBool>[] = [];

  if (options.dateScoped && filter.from !== undefined) {
    conditions.push(sql`l.date_received >= ${filter.from}::date`);
  }
  if (options.dateScoped && filter.to !== undefined) {
    conditions.push(sql`l.date_received <= ${filter.to}::date`);
  }
  if (filter.productLineId !== undefined) {
    conditions.push(sql`l.product_line_id = ${filter.productLineId}`);
  }
  if (filter.brokerId !== undefined) {
    conditions.push(sql`l.broker_id = ${filter.brokerId}`);
  }
  if (filter.regionId !== undefined) {
    conditions.push(sql`l.region_id = ${filter.regionId}`);
  }

  // The RM dimension is the ACCOUNTABLE OWNER (`rm` slot), which is what the aggregates narrow by —
  // NOT the Leads list's any-assignment rule, which would attribute an underwriter's leads to an RM.
  const rmUserId = effectiveRmUserId(filter);
  if (options.rmDimension && rmUserId !== undefined) {
    conditions.push(accountableOwnerPredicate(tenantId, rmUserId));
  }

  if (options.brokerType && filter.brokerTypeId !== undefined) {
    conditions.push(sql`exists (
      select 1 from brokers b
       where b.tenant_id = ${tenantId} and b.id = l.broker_id
         and b.broker_type_id = ${filter.brokerTypeId}
    )`);
  }

  return conditions;
}

function executivePredicates(
  context: PopulationContext,
  scope: ExecutiveDrillScope,
  highValueThreshold: string | null,
): RawBuilder<SqlBool>[] {
  const { tenantId } = context;
  // NOT date-scoped: `snapshotPredicates` applies no date, so the Executive population is full.
  const conditions = dimensionPredicates(context, {
    dateScoped: false,
    rmDimension: true,
    brokerType: false,
  });

  switch (scope) {
    case 'exec.all_leads':
      break;
    case 'exec.quoted':
      conditions.push(hasAnyQuote(tenantId));
      break;
    case 'exec.open_pipeline':
      conditions.push(openPipeline(tenantId, OPEN_CATEGORIES));
      break;
    case 'exec.decided':
      conditions.push(
        sql`(${leadCategoryIn(tenantId, DECIDED_CATEGORIES)} or ${hasQuoteInCategories(tenantId, DECIDED_CATEGORIES)})`,
      );
      break;
    case 'exec.lost':
      conditions.push(sql`(${leadCategoryIn(tenantId, ['lost'])} or ${hasQuoteInCategories(tenantId, ['lost'])})`);
      break;
    case 'exec.at_risk':
      conditions.push(hasUnresolvedAlert(tenantId));
      break;
    case 'exec.high_value':
      conditions.push(openPipeline(tenantId, OPEN_CATEGORIES));
      // A tenant with NO configured threshold has no high-value population at all, which is what
      // the reference's `highValueThreshold is not null` guard says. `false` rather than "everything".
      conditions.push(
        highValueThreshold === null
          ? sql<SqlBool>`false`
          : aboveHighValueThreshold(tenantId, highValueThreshold),
      );
      break;
  }

  return conditions;
}

function pipelinePredicates(
  context: PopulationContext,
  scope: PipelineDrillScope,
): RawBuilder<SqlBool>[] {
  const { tenantId } = context;
  const conditions = dimensionPredicates(context, {
    dateScoped: false,
    rmDimension: true,
    brokerType: false,
  });

  switch (scope) {
    case 'pipeline.all_leads':
      break;
    case 'pipeline.quoted':
      conditions.push(hasAnyQuote(tenantId));
      break;
    case 'pipeline.open_pipeline':
      // `PROGRESSION_CATEGORIES` because every funnel bar carries this key.
      conditions.push(openPipeline(tenantId, PROGRESSION_CATEGORIES));
      break;
    case 'pipeline.sent_or_won':
      conditions.push(
        sql`(${hasSentQuote(tenantId)} or ${hasQuoteInCategories(tenantId, ['won'])} or ${leadCategoryIn(tenantId, ['won'])})`,
      );
      break;
    case 'pipeline.lost':
      conditions.push(leadCategoryIn(tenantId, ['lost']));
      break;
    case 'pipeline.at_risk':
      conditions.push(hasUnresolvedAlert(tenantId));
      break;
  }

  return conditions;
}

function brokerPredicates(context: PopulationContext, scope: BrokerDrillScope): RawBuilder<SqlBool>[] {
  const { tenantId, today } = context;
  // Date-scoped: `broker.service.ts:265` loads through `leadFilterWhere`, which pushes from/to.
  // `brokerScopedFilter` drops the RM and broker-type dimensions, so the drill drops them too.
  const conditions = dimensionPredicates(context, {
    dateScoped: true,
    rmDimension: false,
    brokerType: false,
  });
  conditions.push(hasBroker());

  switch (scope) {
    case 'broker.all_leads':
      break;
    case 'broker.quoted':
      conditions.push(hasAnyQuote(tenantId));
      break;
    case 'broker.decided':
      conditions.push(
        sql`(${leadCategoryIn(tenantId, DECIDED_CATEGORIES)} or ${hasQuoteInCategories(tenantId, DECIDED_CATEGORIES)})`,
      );
      break;
    case 'broker.lost':
      conditions.push(sql`(${leadCategoryIn(tenantId, ['lost'])} or ${hasQuoteInCategories(tenantId, ['lost'])})`);
      break;
    case 'broker.overdue_follow_ups':
      conditions.push(overdueFollowUp(tenantId, today));
      break;
  }

  return conditions;
}

function rmPredicates(context: PopulationContext, scope: RmDrillScope): RawBuilder<SqlBool>[] {
  const { tenantId } = context;
  // Date-scoped, and `rmScopedFilter` keeps `brokerTypeId` while dropping the RM dimension from the
  // shared where-clause — the owner filter is applied separately, so the drill applies both.
  const conditions = dimensionPredicates(context, {
    dateScoped: true,
    rmDimension: true,
    brokerType: true,
  });

  switch (scope) {
    case 'rm.all_leads':
      break;
    case 'rm.quoted':
      conditions.push(hasAnyQuote(tenantId));
      break;
    case 'rm.decided':
      conditions.push(
        sql`(${leadCategoryIn(tenantId, DECIDED_CATEGORIES)} or ${hasQuoteInCategories(tenantId, DECIDED_CATEGORIES)})`,
      );
      break;
    case 'rm.lost':
      conditions.push(sql`(${leadCategoryIn(tenantId, ['lost'])} or ${hasQuoteInCategories(tenantId, ['lost'])})`);
      break;
    case 'rm.committed_follow_ups':
      // WIDER than "overdue" on purpose — see contradiction (e).
      conditions.push(committedFollowUp(tenantId));
      break;
  }

  return conditions;
}

function lossPredicates(context: PopulationContext, scope: LossDrillScope): RawBuilder<SqlBool>[] {
  const { tenantId } = context;
  // Date-scoped; `lossScopedFilter` drops broker type and keeps the accountable-owner filter.
  const conditions = dimensionPredicates(context, {
    dateScoped: true,
    rmDimension: true,
    brokerType: false,
  });
  conditions.push(leadCategoryIn(tenantId, ['lost']));

  if (scope === 'loss.price_gap') {
    // Only lost leads carrying a COMPARABLE competitor premium — `> 0`, matching `priceGapPairs`.
    conditions.push(sql`l.competitor_premium > 0`);
  }

  return conditions;
}

// ---------------------------------------------------------------------------------------------
// The row query.
// ---------------------------------------------------------------------------------------------

async function predicatesFor(
  db: DbExecutor,
  scope: DashboardDrillScope,
  context: PopulationContext,
): Promise<RawBuilder<SqlBool>[]> {
  if (scope.startsWith('exec.')) {
    // ONLY the high-value scope reads the tenant threshold, so only it pays for the settings read.
    const threshold =
      scope === 'exec.high_value'
        ? (await loadDashboardSettings(db, context.tenantId)).highValueThreshold
        : null;
    return executivePredicates(context, scope as ExecutiveDrillScope, threshold);
  }
  if (scope.startsWith('pipeline.')) return pipelinePredicates(context, scope as PipelineDrillScope);
  if (scope.startsWith('broker.')) return brokerPredicates(context, scope as BrokerDrillScope);
  if (scope.startsWith('rm.')) return rmPredicates(context, scope as RmDrillScope);
  return lossPredicates(context, scope as LossDrillScope);
}

/**
 * Builds one widget's row query.
 *
 * The rows come from `listLeads` rather than from a second lead query, exactly as
 * `LeadFilterDrillRowQuery` does: that is what makes "a caller cannot see more through a drill than
 * through the Leads list" true BY CONSTRUCTION rather than by two implementations of the breadth
 * rule agreeing — and a second implementation is precisely how they would stop agreeing. The scope
 * arrives as `extraPredicates`, which are and-joined after the breadth predicate and can therefore
 * only narrow what breadth already allowed.
 */
export function dashboardDrillRowQuery(scope: DashboardDrillScope): DrillRowQuery {
  return async ({ db, tenantId, filter, caller, page, pageSize, today }) => {
    const extraPredicates = await predicatesFor(db, scope, { tenantId, filter, today });

    return listLeads(
      db,
      tenantId,
      {
        statusIds: undefined,
        // The RM dimension is applied as an accountable-owner predicate above, NOT through the
        // Leads list's any-assignment `ownerUserId`; setting both would and-join two different
        // definitions of ownership and silently return fewer rows than either.
        ownerUserId: undefined,
        brokerId: undefined,
        productLineId: undefined,
        regionId: undefined,
        requestChannelId: undefined,
        dateReceivedFrom: undefined,
        dateReceivedTo: undefined,
        myLeadsOnly: false,
        callerUserId: caller.callerUserId,
        callerHasViewAll: caller.callerHasViewAll,
        search: undefined,
        sort: { field: null, descending: false },
        page,
        pageSize,
        extraPredicates,
      },
      today,
    );
  };
}

/** Every dashboard widget key paired with its row query (`DrillWidgetRegistry.cs:37-62`). */
export function dashboardDrillQueries(): Map<string, DrillRowQuery> {
  const widgets = new Map<string, DrillRowQuery>();
  for (const [key, scope] of Object.entries(DASHBOARD_SCOPES_BY_KEY)) {
    widgets.set(key, dashboardDrillRowQuery(scope));
  }
  return widgets;
}
