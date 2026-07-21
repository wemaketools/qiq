/**
 * Reports: the on-demand catalog, the print-ready report views and the per-report CSV/XLSX downloads
 * (T-040; spec FR-64/FR-65, P-12, §12).
 *
 * ON DEMAND ONLY. There is deliberately no scheduling, no distribution list and no cron entry
 * anywhere in this domain: Q-14/A-13 excluded scheduled report distribution from scope, and spec
 * FR-64 says "No scheduling" outright.
 */
export {
  REPORT_CATALOG,
  REPORT_KEYS,
  findReport,
  reportsVisibleTo,
  type ReportDescriptor,
  type ReportKey,
} from './catalog.js';
export {
  NO_VALUE,
  describeReportFilters,
  describeReportPeriod,
  formatReportDays,
  formatReportValue,
  type ReportCatalogDto,
  type ReportCellDto,
  type ReportColumnDto,
  type ReportDescriptorDto,
  type ReportHeaderDto,
  type ReportKpiDto,
  type ReportSectionDto,
  type ReportTableDto,
  type ReportViewDto,
} from './contracts.js';
export {
  buildPipelineAgingReport,
  buildSlaTurnaroundReport,
  pipelineAgingReportBucket,
  type PipelineAgingReportDto,
  type SlaReportSettings,
  type SlaTurnaroundReportDto,
} from './sla.js';
export {
  loadInternalTenantOverview,
  loadSlaReportSnapshot,
  loadTenantConfigurationSnapshot,
  type SlaReportSnapshot,
} from './store.js';
export { composeReport, type ReportActor, type ReportContent } from './composer.js';
export {
  REPORT_FORBIDDEN_CODE,
  REPORT_UNKNOWN_CODE,
  authorizeReport,
  getReportCsv,
  getReportView,
  listReportCatalog,
  type ReportsActor,
  type ReportsDeps,
} from './service.js';
export { reportRoutes } from './routes.js';

import { getDb } from '../../lib/db/index.js';
import type { ReportsDeps } from './service.js';

/**
 * Production wiring for the report endpoints.
 *
 * Mirrors `defaultExportsDeps()`. `getDb()` returns the process-wide pool and captures no request
 * state; the tenant, the caller's breadth and every permission fact come per request from the
 * verified `TenantContext` and the permission resolver — a report that took its tenant from
 * composition would print one tenant's book for every caller.
 */
export function defaultReportsDeps(): ReportsDeps {
  return { db: getDb() };
}
