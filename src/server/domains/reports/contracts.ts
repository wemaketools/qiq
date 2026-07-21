/**
 * The report wire contract and its server-side formatting (T-040; AC-083; V-106; spec FR-64/FR-65).
 *
 * Port of `ReportContracts.cs`, `ReportFormatting.cs` and `ReportFilterDescription.cs`. The field
 * names are the SPA's (`src/ui/src/features/reports/reportsApi.ts:14-74`) and are preserved exactly:
 * this is a shipped contract with a live consumer (A-3).
 *
 * WHY A REPORT FORMATS ITS NUMBERS SERVER-SIDE WHEN THE DASHBOARDS DO NOT
 * ======================================================================
 * A print-ready report is a STATIC DOCUMENT: it is rendered once, printed, and read off paper where
 * no client-side formatter runs. So each KPI carries both the raw `value` (for any client that wants
 * to re-format) and a server-rendered `displayValue`. The dashboards defer formatting to the SPA
 * because they are live and interactive; the report cannot.
 *
 * THE COLUMN TYPES ARE THE EXPORT COLUMN TYPES, DELIBERATELY
 * ==========================================================
 * `text` / `number` / `date` are exactly `ExportColumnType` (T-039), so a report table flattens into
 * a CSV through the SHARED writer without a per-report projection. That is what makes "the CSV
 * matches the print view" true by construction rather than by two implementations agreeing —
 * `service.ts` maps a `ReportColumnDto` to an `ExportColumn` one-for-one and hands the SAME rows to
 * `writeCsv`, which applies the ONE formula-injection guard that already exists.
 */
import type { DashboardFilter } from '../dashboards/filters.js';

/** `ReportDescriptorDto` (:4) — the catalog card. NO permission code: that is authorization, not display data. */
export interface ReportDescriptorDto {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly audience: string;
}

/** `ReportCatalogDto` (:7) — `GET /reports`. */
export interface ReportCatalogDto {
  readonly reports: readonly ReportDescriptorDto[];
}

/**
 * `ReportHeaderDto` (:16-22) — the FR-65/AC-064 metadata block.
 *
 * Built from the SAME `ExportMetadata` builder the exports use, so a report's header block and an
 * export's header block cannot drift. `reportDate` is the ISO instant (`DateTimeOffset` on the
 * wire); `lastRefreshed` is the reference's `"u"` format, which `formatUniversalTime` already owns.
 */
export interface ReportHeaderDto {
  readonly tenantName: string;
  readonly reportDate: string;
  readonly dataPeriod: string;
  readonly currency: string;
  readonly lastRefreshed: string;
  readonly filtersEcho: readonly string[];
}

export type ReportColumnType = 'text' | 'number' | 'date';

/** `ReportColumnDto` (:25). */
export interface ReportColumnDto {
  readonly header: string;
  readonly type: ReportColumnType;
}

/**
 * A report cell. Aligned to `columns` by index.
 *
 * MONEY ARRIVES HERE AS A JS NUMBER, and that is the wire contract's doing, not a slip: the SPA
 * declares `Array<Array<string | number | null>>` and the reference serialised `decimal` as a JSON
 * number. The widening happens once, at this boundary, exactly as it does on every dashboard DTO —
 * the exact `numeric` string is carried right up to it.
 */
export type ReportCellDto = string | number | null;

/** `ReportTableDto` (:31-34). */
export interface ReportTableDto {
  readonly title: string;
  readonly columns: readonly ReportColumnDto[];
  readonly rows: readonly (readonly ReportCellDto[])[];
}

export type ReportKpiKind = 'currency' | 'percent' | 'count' | 'days';

/**
 * `ReportKpiDto` (:37) — one KPI.
 *
 * `leadOrQuote` is PRESERVED from the dashboard KPI it came from (spec FR-54): a report must be
 * explicit about whether a number counts Leads or Quotes, and dropping the label on the way into a
 * printed document is precisely where that distinction gets lost.
 */
export interface ReportKpiDto {
  readonly key: string;
  readonly label: string;
  readonly leadOrQuote: string | null;
  readonly kind: string;
  readonly value: number | null;
  readonly displayValue: string;
}

/** `ReportSectionDto` (:48-52) — a titled block that is a KPI grid, a table, or both. */
export interface ReportSectionDto {
  readonly key: string;
  readonly title: string;
  readonly kpis: readonly ReportKpiDto[];
  readonly table: ReportTableDto | null;
}

/** `ReportViewDto` (:55-59) — `GET /reports/{key}`. */
export interface ReportViewDto {
  readonly key: string;
  readonly name: string;
  readonly header: ReportHeaderDto;
  readonly sections: readonly ReportSectionDto[];
}

/** The reference's "no data" rendering (`ReportFormatting.cs:23`): an EM DASH, not "0" and not "". */
export const NO_VALUE = '—';

/**
 * `.NET "N0"` / `"N1"` under the invariant culture: group separators, fixed fraction digits.
 *
 * `en-US` is the invariant culture's separator pair (`,` group, `.` decimal). Intl rounds half away
 * from zero, matching .NET's numeric formatting.
 */
function fixed(value: number, digits: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * `ReportFormatting.FormatValue` (:20-33).
 *
 * NOTE WHAT IS NOT DONE HERE: no guarding, no quoting, no escaping. This produces DISPLAY text for
 * the JSON payload the print view renders. The CSV path does not use these strings at all — it
 * carries the raw typed cells through the shared export writer, which owns the one injection guard.
 * Formatting a number into a string and THEN guarding it is how `-500.00` becomes `'-500.00`.
 */
export function formatReportValue(
  value: number | null,
  kind: string,
  currencyCode: string,
): string {
  if (value === null) return NO_VALUE;

  switch (kind) {
    case 'currency':
      return `${currencyCode} ${fixed(value, 0)}`;
    case 'percent':
      return `${fixed(value * 100, 1)}%`;
    case 'days':
      return `${fixed(value, 1)} days`;
    default:
      return fixed(value, 0);
  }
}

/** `ReportFormatting.FormatDays` (:36-38). */
export function formatReportDays(days: number | null): string {
  return days === null ? NO_VALUE : `${fixed(days, 1)} days`;
}

/** `ReportFilterDescription.DescribePeriod` (:13-24). */
export function describeReportPeriod(filter: DashboardFilter): string {
  if (filter.from === undefined && filter.to === undefined) return 'All time';
  return `${filter.from ?? '…'} to ${filter.to ?? '…'}`;
}

/**
 * `ReportFilterDescription.DescribeFilters` (:26-64) — the echoed active filters.
 *
 * `from`/`to` are deliberately ABSENT: they are already carried by `dataPeriod`, and echoing them
 * twice in one header block is how a reader ends up unsure which of the two is authoritative.
 */
export function describeReportFilters(filter: DashboardFilter): readonly string[] {
  const echo: string[] = [];
  if (filter.productLineId !== undefined) echo.push(`Product line id: ${String(filter.productLineId)}`);
  if (filter.brokerId !== undefined) echo.push(`Broker id: ${String(filter.brokerId)}`);
  if (filter.rmUserId !== undefined) echo.push(`RM id: ${String(filter.rmUserId)}`);
  if (filter.regionId !== undefined) echo.push(`Region id: ${String(filter.regionId)}`);
  if (filter.teamOrRmId !== undefined) echo.push(`Team/RM id: ${String(filter.teamOrRmId)}`);
  if (filter.brokerTypeId !== undefined) echo.push(`Broker type id: ${String(filter.brokerTypeId)}`);
  return echo.length === 0 ? ['None'] : echo;
}
