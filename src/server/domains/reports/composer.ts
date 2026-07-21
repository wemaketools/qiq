/**
 * Report content composition (T-040; AC-083; V-106; spec FR-64, PRD 17.1/19.1).
 *
 * Port of `QuoteIQ.Application/Features/Reports/ReportContentComposer.cs`.
 *
 * ONE COMPOSER, TWO CONSUMERS — WHICH IS WHY THE CSV CANNOT DISAGREE WITH THE PRINT VIEW
 * =====================================================================================
 * `GET /reports/{key}` and `GET /reports/{key}/csv` both call `composeReport`. The CSV is the
 * `primaryTable` of the SAME composition the print view renders, under the SAME filter, from the
 * SAME query. AC-083 asks that "each report CSV matches the print data under the same filters"; two
 * compositions would make that a claim two implementations happen to satisfy today. One composition
 * makes it structural.
 *
 * THE FIVE DASHBOARD-BACKED REPORTS CALL THE DASHBOARD SERVICES, NOT NEW QUERIES
 * =============================================================================
 * Executive, Pipeline, Broker, RM and Loss project the EXISTING dashboard payloads (T-036/T-037)
 * into print sections. Nothing is recomputed. That also carries breadth for free: those services
 * already narrow by `leads.view_all` (AC-076(c)), so a restricted caller's printed report shows the
 * same population as their screen — a report cannot become the way around the breadth ruling.
 *
 * EVERY CATALOG KEY HAS A BRANCH, AND THERE IS NO DEFAULT SUCCESS BRANCH
 * =====================================================================
 * The `default` throws `NotFoundError`. This codebase has already shipped a registry whose entries
 * resolved to nothing (31 drill widget keys, one wired), missed because the tests exercised the key
 * that worked. `reports.test.ts` therefore renders EVERY key in `REPORT_CATALOG` through the real
 * endpoint and asserts each returns sections — not a representative sample.
 */
import { NotFoundError } from '../../lib/errors/index.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import type { DashboardFilter } from '../dashboards/filters.js';
import type { DashboardActor } from '../dashboards/executive.service.js';
import { getExecutiveOverview } from '../dashboards/executive.service.js';
import { getPipelineDashboard } from '../dashboards/pipeline.service.js';
import { getBrokerPerformance } from '../dashboards/broker.service.js';
import { getRmPerformance } from '../dashboards/rm.service.js';
import { getLossAnalysis } from '../dashboards/loss.service.js';
import { loadDashboardSettings } from '../dashboards/snapshot.js';
import { listAlertsForTenant } from '../alerts/service.js';
import { MAX_ALERTS_PAGE_SIZE } from '../alerts/schemas.js';
import { findSettings } from '../business-rules/repository.js';
import type { Money } from '../dashboards/money.js';
import { REPORT_KEYS } from './catalog.js';
import {
  formatReportDays,
  formatReportValue,
  type ReportCellDto,
  type ReportColumnDto,
  type ReportKpiDto,
  type ReportSectionDto,
  type ReportTableDto,
} from './contracts.js';
import {
  buildPipelineAgingReport,
  buildSlaTurnaroundReport,
  type SlaReportSettings,
} from './sla.js';
import {
  loadInternalTenantOverview,
  loadSlaReportSnapshot,
  loadTenantConfigurationSnapshot,
} from './store.js';

/** The composed body: the ordered print sections plus the ONE table the CSV flattens. */
export interface ReportContent {
  readonly sections: readonly ReportSectionDto[];
  readonly primaryTable: ReportTableDto | null;
}

export interface ReportsComposerDeps {
  readonly db: DbExecutor;
}

/** Everything a composition needs about the caller, all resolved server-side by the route. */
export interface ReportActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  /** `leads.view_all` — narrows every lead population below, aggregate and table alike. */
  readonly canViewAllLeads: boolean;
}

function dashboardActor(actor: ReportActor): DashboardActor {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    canViewAllLeads: actor.canViewAllLeads,
  };
}

// ---------------------------------------------------------------------------------------------
// Cell/section builders (`ReportContentComposer`'s projection helpers, :310-333).
// ---------------------------------------------------------------------------------------------

function col(header: string, type: ReportColumnDto['type'] = 'text'): ReportColumnDto {
  return { header, type };
}

function table(
  title: string,
  columns: readonly ReportColumnDto[],
  rows: readonly (readonly ReportCellDto[])[],
): ReportTableDto {
  return { title, columns, rows };
}

function kpiSection(key: string, title: string, kpis: readonly ReportKpiDto[]): ReportSectionDto {
  return { key, title, kpis, table: null };
}

function tableSection(key: string, body: ReportTableDto): ReportSectionDto {
  return { key, title: body.title, kpis: [], table: body };
}

/**
 * The widening of an exact `numeric` string into the JSON number the wire contract declares.
 *
 * THE LAST PLACE money is widened, and it happens here rather than in the store so every comparison
 * and sum upstream runs on exact decimal strings (CLAUDE.md: money never through a JS double).
 */
function moneyCell(value: Money | null): number | null {
  return value === null ? null : Number(value);
}

/** `Percent` (:318) — a fraction rendered as a one-decimal percentage NUMBER, not a string. */
function percentCell(fraction: number | null): number | null {
  return fraction === null ? null : Math.round(fraction * 1000) / 10;
}

/** `Days` (:320) — one decimal place. */
function daysCell(days: number | null): number | null {
  return days === null ? null : Math.round(days * 10) / 10;
}

/** A dashboard KPI projected into a report KPI, display value formatted server-side. */
function dashboardKpi(
  kpi: {
    readonly key: string;
    readonly label: string;
    readonly leadOrQuote: string;
    readonly kind: string;
    readonly value: number | null;
  },
  currencyCode: string,
): ReportKpiDto {
  return {
    key: kpi.key,
    label: kpi.label,
    // FR-54: whether this number counts LEADS or QUOTES survives into the printed document.
    leadOrQuote: kpi.leadOrQuote,
    kind: kpi.kind,
    value: kpi.value,
    displayValue: formatReportValue(kpi.value, kpi.kind, currencyCode),
  };
}

// ---------------------------------------------------------------------------------------------
// The ten compositions.
// ---------------------------------------------------------------------------------------------

async function composeExecutive(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
  now: Date,
): Promise<ReportContent> {
  const dto = await getExecutiveOverview(deps, dashboardActor(actor), filter, now);

  const highValue = table(
    'High-Value Opportunities',
    [
      col('Lead ref'),
      col('Client'),
      col('Product line'),
      col('Premium', 'number'),
      col('Stage'),
      col('Owner'),
    ],
    dto.highValueOpportunities.map((row) => [
      row.leadRef,
      row.clientName,
      row.productLineName,
      row.premium,
      row.stageName,
      row.ownerName,
    ]),
  );

  return {
    sections: [
      kpiSection(
        'kpis',
        'Key Performance Indicators',
        dto.kpis.map((kpi) => dashboardKpi(kpi, dto.currencyCode)),
      ),
      tableSection('high-value', highValue),
    ],
    primaryTable: highValue,
  };
}

async function composePipeline(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
  now: Date,
): Promise<ReportContent> {
  const dto = await getPipelineDashboard(deps, dashboardActor(actor), filter, now);

  const funnel = table(
    'Stage Conversion',
    [col('Stage'), col('Reached', 'number'), col('Conversion from top', 'number')],
    dto.stageConversionFunnel.map((stage) => [
      stage.stageName,
      stage.reachedCount,
      percentCell(stage.conversionFromTop),
    ]),
  );

  const atRisk = table(
    'At-Risk Pipeline',
    [
      col('Lead ref'),
      col('Client'),
      col('Premium', 'number'),
      col('Stage'),
      col('Age (days)', 'number'),
      col('Risk reason'),
    ],
    dto.atRiskPipeline.map((row) => [
      row.leadRef,
      row.clientName,
      row.premium,
      row.stageName,
      row.ageDays,
      row.riskReason,
    ]),
  );

  return {
    sections: [
      kpiSection(
        'kpis',
        'Key Performance Indicators',
        dto.kpis.map((kpi) => dashboardKpi(kpi, dto.currencyCode)),
      ),
      tableSection('stage-conversion', funnel),
      tableSection('at-risk', atRisk),
    ],
    // The FUNNEL is the CSV, not the at-risk table (:101). Measured, and deliberate: the funnel is
    // what a conversion report is about.
    primaryTable: funnel,
  };
}

async function composeBroker(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
  now: Date,
): Promise<ReportContent> {
  const dto = await getBrokerPerformance(deps, dashboardActor(actor), filter, now);

  const brokers = table(
    'Broker Performance',
    [
      col('Broker'),
      col('Tier'),
      col('Quotes', 'number'),
      col('Conversion %', 'number'),
      col('Won premium', 'number'),
      col('Avg TAT (days)', 'number'),
      col('Top loss reason'),
    ],
    dto.table.map((row) => [
      row.brokerName,
      row.tierName,
      row.quoteVolume,
      percentCell(row.conversionRate),
      row.wonPremium,
      daysCell(row.avgTurnaroundDays),
      row.topLossReason,
    ]),
  );

  return {
    sections: [
      kpiSection(
        'kpis',
        'Key Performance Indicators',
        dto.kpis.map((kpi) => dashboardKpi(kpi, dto.currencyCode)),
      ),
      tableSection('broker-table', brokers),
    ],
    primaryTable: brokers,
  };
}

async function composeRm(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
  now: Date,
): Promise<ReportContent> {
  const dto = await getRmPerformance(deps, dashboardActor(actor), filter, now);

  const watchlist = table(
    'Performance Watchlist',
    [
      col('RM'),
      col('Quotes', 'number'),
      col('Won premium', 'number'),
      col('Conversion %', 'number'),
      col('Avg TAT (days)', 'number'),
      col('Overdue', 'number'),
      col('Suggested action'),
    ],
    dto.watchlist.map((row) => [
      row.name,
      row.quoteVolume,
      row.wonPremium,
      percentCell(row.conversionRate),
      daysCell(row.avgTurnaroundDays),
      row.overdueFollowUps,
      row.suggestedAction.label,
    ]),
  );

  const turnaround = table(
    'Turnaround by RM',
    [col('RM'), col('Avg TAT (days)', 'number'), col('Beyond target')],
    dto.turnaroundByRm.rows.map((row) => [
      row.rmName,
      daysCell(row.avgTurnaroundDays),
      row.beyondTarget ? 'Yes' : 'No',
    ]),
  );

  return {
    sections: [
      kpiSection(
        'kpis',
        'Key Performance Indicators',
        dto.kpis.map((kpi) => dashboardKpi(kpi, dto.currencyCode)),
      ),
      tableSection('watchlist', watchlist),
      tableSection('turnaround-by-rm', turnaround),
    ],
    primaryTable: watchlist,
  };
}

async function composeLoss(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
  now: Date,
): Promise<ReportContent> {
  const dto = await getLossAnalysis(deps, dashboardActor(actor), filter, now);

  const byReason = table(
    'Lost Premium by Reason',
    [col('Reason'), col('Premium lost', 'number')],
    dto.lostPremiumByReason.rows.map((row) => [row.reasonName, row.amount]),
  );

  const competitors = table(
    'Competitor Analysis',
    [
      col('Competitor'),
      col('Deals lost', 'number'),
      col('Premium lost', 'number'),
      col('Avg price gap %', 'number'),
    ],
    dto.competitorAnalysis.rows.map((row) => [
      row.competitor,
      row.dealsLost,
      row.premiumLost,
      percentCell(row.avgPriceGapPct),
    ]),
  );

  return {
    sections: [
      kpiSection(
        'kpis',
        'Key Performance Indicators',
        // `LossKpi` (:313-316): a TEXT kpi (e.g. the top loss reason) has no numeric value, so it
        // renders its text and reports kind `count` with a null value rather than pretending to be
        // a number.
        dto.kpis.map((kpi) =>
          kpi.kind === 'text'
            ? {
                key: kpi.key,
                label: kpi.label,
                leadOrQuote: kpi.leadOrQuote,
                kind: 'count',
                value: null,
                displayValue: kpi.textValue ?? '—',
              }
            : dashboardKpi(kpi, dto.currencyCode),
        ),
      ),
      tableSection('loss-by-reason', byReason),
      tableSection('competitor', competitors),
    ],
    primaryTable: byReason,
  };
}

/** The tenant thresholds the SLA and Aging reports read, in one place so the two cannot disagree. */
async function slaSettings(
  deps: ReportsComposerDeps,
  tenantId: TenantId,
): Promise<SlaReportSettings> {
  const [dashboardSettings, settings] = await Promise.all([
    loadDashboardSettings(deps.db, tenantId),
    findSettings(deps.db, tenantId),
  ]);

  return {
    currencyCode: dashboardSettings.currencyCode,
    slaAssignmentDays: settings?.slaAssignmentDays ?? 1,
    slaUnderwritingDays: settings?.slaUnderwritingDays ?? 3,
    slaReceivedToSentDays: dashboardSettings.slaReceivedToSentDays,
  };
}

async function composeSla(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
  now: Date,
): Promise<ReportContent> {
  const [settings, snapshot] = await Promise.all([
    slaSettings(deps, actor.tenantId),
    loadSlaReportSnapshot(deps.db, actor.tenantId, filter, {
      callerUserId: actor.userId,
      callerHasViewAll: actor.canViewAllLeads,
    }),
  ]);

  const dto = buildSlaTurnaroundReport(snapshot, settings, now);

  const metricKpis: readonly ReportKpiDto[] = dto.metrics.map((metric) => ({
    key: metric.key,
    label: metric.label,
    leadOrQuote: null,
    kind: 'days',
    value: metric.averageDays,
    displayValue: formatReportDays(metric.averageDays),
  }));

  const breaches = table(
    'SLA Breaches by Stage',
    [col('Stage'), col('Breaches', 'number'), col('Target (days)', 'number')],
    dto.breachesByStage.map((row) => [row.stage, row.breachCount, row.targetDays]),
  );

  const delayQueue = table(
    'Underwriting Delay Queue',
    [
      col('Lead ref'),
      col('Client'),
      col('Owner'),
      col('Days in underwriting', 'number'),
      col('Target (days)', 'number'),
      col('Premium at risk', 'number'),
    ],
    dto.underwritingDelayQueue.map((row) => [
      row.leadRef,
      row.clientName,
      row.ownerName,
      row.daysInUnderwriting,
      row.targetDays,
      moneyCell(row.premiumAtRisk),
    ]),
  );

  const byProduct = table(
    'Turnaround by Product Line',
    [col('Product line'), col('Avg turnaround (days)', 'number')],
    dto.turnaroundByProductLine.map((row) => [
      row.productLineName,
      daysCell(row.averageTurnaroundDays),
    ]),
  );

  return {
    sections: [
      kpiSection('sla-metrics', 'SLA / Turnaround Metrics', metricKpis),
      tableSection('breaches-by-stage', breaches),
      tableSection('underwriting-delay-queue', delayQueue),
      tableSection('turnaround-by-product', byProduct),
    ],
    // The DELAY QUEUE is the CSV (:220) — the actionable list, not the summary bars.
    primaryTable: delayQueue,
  };
}

async function composeAging(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
  now: Date,
): Promise<ReportContent> {
  const [settings, snapshot] = await Promise.all([
    slaSettings(deps, actor.tenantId),
    loadSlaReportSnapshot(deps.db, actor.tenantId, filter, {
      callerUserId: actor.userId,
      callerHasViewAll: actor.canViewAllLeads,
    }),
  ]);

  const dto = buildPipelineAgingReport(snapshot, settings, now.toISOString().slice(0, 10));

  const body = table(
    'Open Items by Age',
    [
      col('Lead ref'),
      col('Client'),
      col('Stage'),
      col('Age (days)', 'number'),
      col('Age bucket'),
      col('Owner'),
      col('Premium', 'number'),
    ],
    dto.rows.map((row) => [
      row.leadRef,
      row.clientName,
      row.stageName,
      row.ageDays,
      row.ageBucket,
      row.ownerName,
      moneyCell(row.premium),
    ]),
  );

  return { sections: [tableSection('aging', body)], primaryTable: body };
}

/**
 * `ComposeEscalationAsync` (:240-263) — REUSES the T-024 alerts queue rather than recomputing
 * escalation conditions, so the report and the Alerts Center agree on what "escalated" means.
 *
 * MEASURED DIVERGENCE, FLAGGED: the reference requested 500 rows (`MaxRows`, :17). This port's
 * alerts service clamps `pageSize` to `MAX_ALERTS_PAGE_SIZE` (200) — a ceiling the reference does
 * not have, added because `pageSize` reaches SQL as a LIMIT. Asking for 500 here would be SILENTLY
 * truncated to 200, so the cap is requested explicitly and named. A tenant with more than 200 open
 * escalations would see a shorter queue than the reference printed; raising the alerts cap is
 * T-033's surface, not this task's, and T-034 is live on it.
 */
async function composeEscalation(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  filter: DashboardFilter,
): Promise<ReportContent> {
  const [settings, alerts] = await Promise.all([
    loadDashboardSettings(deps.db, actor.tenantId),
    listAlertsForTenant(
      deps,
      {
        tab: 'escalated',
        productLineId: filter.productLineId,
        regionId: filter.regionId,
        page: 1,
        pageSize: MAX_ALERTS_PAGE_SIZE,
      },
      { userId: actor.userId, tenantId: actor.tenantId },
    ),
  ]);

  const premiumAtRisk = alerts.items.reduce((total, item) => total + (item.premiumAtRisk ?? 0), 0);

  const rollup: ReportKpiDto = {
    key: 'premium_at_risk',
    label: 'Premium at Risk',
    leadOrQuote: null,
    kind: 'currency',
    value: premiumAtRisk,
    displayValue: formatReportValue(premiumAtRisk, 'currency', settings.currencyCode),
  };

  const body = table(
    'Escalation Queue',
    [
      col('Lead ref'),
      col('Client'),
      col('Alert'),
      col('Severity'),
      col('Stage'),
      col('Priority'),
      col('Premium at risk', 'number'),
      col('Owner'),
    ],
    alerts.items.map((item) => [
      item.leadRef,
      item.clientName,
      item.type,
      item.severity,
      item.stage,
      item.priority,
      item.premiumAtRisk,
      item.ownerName,
    ]),
  );

  return {
    sections: [kpiSection('rollup', 'Escalation Summary', [rollup]), tableSection('queue', body)],
    primaryTable: body,
  };
}

async function composeTenantConfiguration(
  deps: ReportsComposerDeps,
  actor: ReportActor,
): Promise<ReportContent> {
  const snapshot = await loadTenantConfigurationSnapshot(deps.db, actor.tenantId);

  const referenceLists = table(
    'Reference Lists',
    [col('List'), col('Active values', 'number'), col('Total values', 'number')],
    snapshot.referenceLists.map((row) => [row.listType, row.activeCount, row.totalCount]),
  );

  const businessRules = table(
    'Business Rules',
    [col('Rule'), col('Value')],
    snapshot.businessRules.map((row) => [row.name, row.value]),
  );

  return {
    sections: [
      tableSection('reference-lists', referenceLists),
      tableSection('business-rules', businessRules),
    ],
    primaryTable: referenceLists,
  };
}

async function composeInternalOverview(deps: ReportsComposerDeps): Promise<ReportContent> {
  const rows = await loadInternalTenantOverview(deps.db);

  const body = table(
    'Tenants',
    [
      col('Tenant'),
      col('Status'),
      col('Active users', 'number'),
      col('Leads', 'number'),
      col('Open leads', 'number'),
      col('Quotes', 'number'),
    ],
    rows.map((row) => [
      row.tenantName,
      row.status,
      row.activeUsers,
      row.leadCount,
      row.openLeadCount,
      row.quoteCount,
    ]),
  );

  return { sections: [tableSection('tenants', body)], primaryTable: body };
}

/**
 * Dispatches a report key to its content.
 *
 * `now` is injected rather than read from a clock inside, so a whole report is a pure function of
 * (data, filter, instant) and an integration test can assert exact ages, breach counts and totals
 * instead of shapes.
 */
export async function composeReport(
  deps: ReportsComposerDeps,
  actor: ReportActor,
  key: string,
  filter: DashboardFilter,
  now: Date = new Date(),
): Promise<ReportContent> {
  switch (key) {
    case REPORT_KEYS.executiveWeekly:
      return await composeExecutive(deps, actor, filter, now);
    case REPORT_KEYS.pipelineConversion:
      return await composePipeline(deps, actor, filter, now);
    case REPORT_KEYS.brokerPerformance:
      return await composeBroker(deps, actor, filter, now);
    case REPORT_KEYS.rmPerformance:
      return await composeRm(deps, actor, filter, now);
    case REPORT_KEYS.lossAnalysis:
      return await composeLoss(deps, actor, filter, now);
    case REPORT_KEYS.slaTurnaround:
      return await composeSla(deps, actor, filter, now);
    case REPORT_KEYS.pipelineAging:
      return await composeAging(deps, actor, filter, now);
    case REPORT_KEYS.escalationQueue:
      return await composeEscalation(deps, actor, filter);
    case REPORT_KEYS.tenantConfiguration:
      return await composeTenantConfiguration(deps, actor);
    case REPORT_KEYS.internalTenantOverview:
      return await composeInternalOverview(deps);
    default:
      throw new NotFoundError(`Unknown report '${key}'.`, { code: 'REPORT_UNKNOWN' });
  }
}
