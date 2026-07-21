/**
 * Exports: the tenant-scoped CSV/XLSX download surface over the Leads list, the Parties list and
 * the dashboard drill populations (T-039; spec FR-65, P-12, P-13, Q-9/A-16, Q-18).
 *
 * There is deliberately no async/queued export path: Q-18 resolved MVP exports as synchronous with
 * a documented size limit (`MAX_EXPORT_ROWS`), and the queued scale path is noted, not built.
 */
export {
  formatNumberCell,
  formatUniversalTime,
  guardExportCell,
  type ExportCell,
  type ExportColumn,
  type ExportColumnType,
  type ExportDocument,
  type ExportFormat,
  type ExportMetadata,
} from './document.js';
export { CSV_CONTENT_TYPE, CSV_FILE_EXTENSION, UTF8_BOM, writeCsv } from './csv.js';
export { XLSX_CONTENT_TYPE, XLSX_FILE_EXTENSION, writeXlsx } from './excel.js';
export { exportRoutes, parseExportFormat } from './routes.js';
export {
  CROSS_TENANT_EXPORT_FORBIDDEN_CODE,
  EXPORT_ACTION,
  EXPORT_TOO_LARGE_CODE,
  MAX_EXPORT_ROWS,
  assertExportAuthorized,
  exportDashboard,
  exportLeads,
  exportParties,
  type ExportActor,
  type ExportFile,
  type ExportsDeps,
} from './service.js';

import { getDb } from '../../lib/db/index.js';
import type { ExportsDeps } from './service.js';

/**
 * Production wiring for the export endpoints.
 *
 * Mirrors `defaultDashboardsDeps()`, and like it leaves `drillWidgets` unset so the DEFAULT
 * registry applies — the same one the on-screen drill resolves against. Passing a private registry
 * here would be how the exported population and the drilled population start to disagree.
 */
export function defaultExportsDeps(): ExportsDeps {
  return { db: getDb() };
}
