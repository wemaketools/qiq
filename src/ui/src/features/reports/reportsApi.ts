import { apiGet } from '../../api/client';
import { downloadExport } from '../exports/exportsApi';
import type { IconName } from '../../components/common/Icon';

/**
 * Reports backend contract (`src/api/QuoteIQ.Api/Endpoints/ReportEndpoints.cs`, spec FR-64/FR-65, T-040):
 * `GET /reports` returns the caller-visible catalog, `GET /reports/{key}` returns the print-ready report
 * view (header metadata + sections), and `GET /reports/{key}/csv` streams the per-report CSV through the
 * shared T-039 export/blob path. Fetch-wrapper module, matching the established convention
 * (`executiveApi.ts`/`exportsApi.ts`) rather than RTK Query.
 */

/** Wire shape of `ReportDescriptorDto` — one catalog card. */
export interface ReportDescriptor {
  key: string;
  name: string;
  description: string;
  icon: string;
  audience: string;
}

/** Wire shape of `ReportCatalogDto`. */
export interface ReportCatalog {
  reports: ReportDescriptor[];
}

/** Wire shape of `ReportHeaderDto` (spec FR-65 metadata block). */
export interface ReportHeader {
  tenantName: string;
  reportDate: string;
  dataPeriod: string;
  currency: string;
  lastRefreshed: string;
  filtersEcho: string[];
}

/** Wire shape of `ReportKpiDto`. */
export interface ReportKpi {
  key: string;
  label: string;
  leadOrQuote: string | null;
  kind: string;
  value: number | null;
  displayValue: string;
}

/** Wire shape of `ReportColumnDto`. */
export interface ReportColumn {
  header: string;
  type: string;
}

/** Wire shape of `ReportTableDto`; cells align to `columns` by index. */
export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Array<Array<string | number | null>>;
}

/** Wire shape of `ReportSectionDto`. */
export interface ReportSection {
  key: string;
  title: string;
  kpis: ReportKpi[];
  table: ReportTable | null;
}

/** Wire shape of `ReportViewDto`. */
export interface ReportView {
  key: string;
  name: string;
  header: ReportHeader;
  sections: ReportSection[];
}

/** The subset of `IconName`s the reports catalog uses; falls back to the generic report glyph for anything unknown. */
export function toIconName(icon: string): IconName {
  const known: IconName[] = [
    'overview',
    'pipeline',
    'brokers',
    'rm-performance',
    'loss-analysis',
    'alerts',
    'settings',
    'tenant-manager',
    'calendar',
    'reports',
  ];
  return (known as string[]).includes(icon) ? (icon as IconName) : 'reports';
}

/** Fetches the caller-visible report catalog (spec FR-64/AC-063). */
export function fetchReportCatalog(): Promise<ReportCatalog> {
  return apiGet<ReportCatalog>('/reports');
}

/** Fetches one print-ready report view (spec FR-64/FR-65). */
export function fetchReportView(key: string): Promise<ReportView> {
  return apiGet<ReportView>(`/reports/${encodeURIComponent(key)}`);
}

/** Builds the per-report CSV path (spec FR-64/FR-65, reusing the T-039 export writers). */
export function buildReportCsvPath(key: string): string {
  return `/reports/${encodeURIComponent(key)}/csv?format=csv`;
}

/** Downloads a report's CSV through the shared blob/download path (spec FR-65). */
export function downloadReportCsv(key: string): Promise<void> {
  return downloadExport(buildReportCsvPath(key), `${key}.csv`);
}
