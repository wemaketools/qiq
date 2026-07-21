/**
 * The fixed report catalog (T-040; AC-083; V-106; spec FR-64, PRD 19.1).
 *
 * Port of `QuoteIQ.Application/Features/Reports/ReportCatalog.cs` and `ReportKeys.cs`.
 *
 * A REGISTRY WHOSE ENTRIES MUST ALL RESOLVE
 * =========================================
 * This file is a registry, and this codebase has already paid for a registry whose entries did not
 * resolve: 31 dashboard drill widget keys were catalogued and one was wired, so every chevron 404'd
 * and three implementors missed it because the tests pointed at the key that worked. A report
 * catalog is the same shape — ten cards, each promising a rendered document. So `composer.ts`
 * dispatches on exactly these keys with no default success branch, and `reports.test.ts` renders
 * EVERY key in this list through the real endpoint rather than a representative one.
 *
 * KEYS ARE STABLE, NAMES ARE NOT (ReportKeys.cs:8-11)
 * ==================================================
 * The `key` is the `{key}` path segment of `/reports/{key}` and `/reports/{key}/csv` and never
 * changes; renaming a report changes `name`. Same rule as the guarded reference-data canonical keys.
 */
import type { PermissionCode } from '../rbac/permission-catalog.js';

/** The stable wire keys (`ReportKeys.cs:12-21`). */
export const REPORT_KEYS = {
  executiveWeekly: 'executive-weekly',
  pipelineConversion: 'pipeline-conversion',
  brokerPerformance: 'broker-performance',
  rmPerformance: 'rm-performance',
  lossAnalysis: 'loss-analysis',
  slaTurnaround: 'sla-turnaround',
  pipelineAging: 'pipeline-aging',
  escalationQueue: 'escalation-queue',
  tenantConfiguration: 'tenant-configuration',
  internalTenantOverview: 'internal-tenant-overview',
} as const;

export type ReportKey = (typeof REPORT_KEYS)[keyof typeof REPORT_KEYS];

/**
 * One catalog row (`ReportDescriptor`).
 *
 * `permission` is the report's ADDITIONAL binding permission, over and above the base `reports.view`
 * the route group requires. Every reference descriptor sets one — the `null` case exists because the
 * reference's type allows it, not because any report uses it, and `reports-catalog.test.ts` pins
 * that an unpermissioned caller therefore sees an EMPTY catalog rather than the full ten.
 *
 * `isCrossTenant` is true only for the internal report, whose data spans tenants and whose CSV
 * additionally requires `global.cross_tenant_export` (spec FR-65).
 */
export interface ReportDescriptor {
  readonly key: ReportKey;
  readonly name: string;
  readonly description: string;
  /** The SPA `Icon` glyph name (`reportsApi.ts:78-89` accepts these and falls back to `reports`). */
  readonly icon: string;
  readonly permission: PermissionCode | null;
  readonly audience: string;
  readonly isCrossTenant: boolean;
}

/**
 * The catalog, in display order (`ReportCatalog.All`, :47-88).
 *
 * The per-report permission bindings are the REFERENCE's, carried over verbatim. Two are worth
 * stating because they look like mistakes and are not:
 *
 *   - SLA/Turnaround binds `dashboards.view_pipeline`, not a permission of its own. There is
 *     deliberately no standalone SLA dashboard or nav entry (spec FR-60); the report is the surface,
 *     and it inherits the dashboard it is surfaced beside.
 *   - Pipeline Aging binds the same, for the same reason: its population is the open pipeline.
 *
 * No entry describes a schedule or a distribution list. Reporting is ON DEMAND ONLY (spec FR-64,
 * Q-14/A-13): there is no scheduling endpoint anywhere in this domain.
 */
export const REPORT_CATALOG: readonly ReportDescriptor[] = [
  {
    key: REPORT_KEYS.executiveWeekly,
    name: 'Executive Weekly Report',
    description: 'KPIs, pipeline health, premium at risk & wins for ExCo.',
    icon: 'overview',
    permission: 'dashboards.view_executive',
    audience: 'Leadership / ExCo',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.pipelineConversion,
    name: 'Pipeline & Conversion',
    description: 'Stage conversion, aging and source mix.',
    icon: 'pipeline',
    permission: 'dashboards.view_pipeline',
    audience: 'Sales operations',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.brokerPerformance,
    name: 'Broker Performance',
    description: 'Volume, conversion, won premium and loss reasons by partner.',
    icon: 'brokers',
    permission: 'dashboards.view_broker_performance',
    audience: 'Sales operations',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.rmPerformance,
    name: 'RM Performance',
    description: 'Quotes handled, conversion, turnaround and follow-up discipline.',
    icon: 'rm-performance',
    permission: 'dashboards.view_rm_performance',
    audience: 'Sales leadership',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.lossAnalysis,
    name: 'Loss Analysis',
    description: 'Lost premium by reason, competitor and product line.',
    icon: 'loss-analysis',
    permission: 'dashboards.view_loss_analysis',
    audience: 'Sales operations',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.slaTurnaround,
    name: 'SLA / Turnaround',
    description: 'Request-to-quote and underwriting SLA performance.',
    icon: 'calendar',
    permission: 'dashboards.view_pipeline',
    audience: 'Sales operations',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.pipelineAging,
    name: 'Pipeline Aging',
    description: 'Open items by age, stage, owner and premium.',
    icon: 'pipeline',
    permission: 'dashboards.view_pipeline',
    audience: 'Sales operations',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.escalationQueue,
    name: 'Escalation Queue',
    description: 'Escalated and stalled items requiring immediate action.',
    icon: 'alerts',
    permission: 'alerts.view',
    audience: 'Sales leadership',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.tenantConfiguration,
    name: 'Tenant Configuration',
    description: 'Reference lists and business-rule snapshot for this tenant.',
    icon: 'settings',
    permission: 'tenants.manage_settings',
    audience: 'Tenant administrators',
    isCrossTenant: false,
  },
  {
    key: REPORT_KEYS.internalTenantOverview,
    name: 'Internal Tenant Overview',
    description: 'Tenant status, active users and lead/quote volumes across all tenants.',
    icon: 'tenant-manager',
    permission: 'global.cross_tenant_reporting',
    audience: 'Internal / platform',
    isCrossTenant: true,
  },
];

/** `ReportCatalog.Find` (:92) — ORDINAL match, so `Loss-Analysis` is not `loss-analysis`. */
export function findReport(key: string): ReportDescriptor | undefined {
  return REPORT_CATALOG.find((report) => report.key === key);
}

/**
 * `ReportCatalog.VisibleTo` (:99-100) — the subset a caller may open.
 *
 * Takes a PREDICATE rather than a permission set so the caller passes the same resolved
 * `EffectiveAccess.has` the route guard used; a second string-set built here would be a second
 * answer to "what may this caller do".
 */
export function reportsVisibleTo(
  has: (permission: PermissionCode) => boolean,
): readonly ReportDescriptor[] {
  return REPORT_CATALOG.filter(
    (report) => report.permission === null || has(report.permission),
  );
}
