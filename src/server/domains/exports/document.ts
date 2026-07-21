/**
 * The format-agnostic export model and the CSV/spreadsheet formula-injection guard
 * (T-039; AC-081, AC-082; V-102; spec FR-65, P-12, §16).
 *
 * Port of `QuoteIQ.Domain/Exports/ExportDocument.cs` and `QuoteIQ.Domain/Exports/CsvInjectionGuard.cs`.
 *
 * ONE DOCUMENT MODEL, TWO WRITERS
 * ===============================
 * `csv.ts` and `excel.ts` both consume this shape, so the column order, the captions and the
 * metadata header block are defined exactly once regardless of the negotiated format. A CSV whose
 * columns disagree with its XLSX sibling is a defect no consumer can report intelligibly, and two
 * projections of the same rows is how that happens.
 */

/** `?format=xlsx` selects Excel; anything else (including omitted) means CSV (ExportEndpoints.cs:88-92). */
export type ExportFormat = 'csv' | 'xlsx';

/**
 * The value semantics of a column (`ExportColumnType`).
 *
 * ONLY `text` CELLS ARE GUARDED, AND THAT IS DELIBERATE — see `guardExportCell` below.
 */
export type ExportColumnType = 'text' | 'number' | 'date';

export interface ExportColumn {
  readonly header: string;
  readonly type: ExportColumnType;
}

/**
 * A cell's value, aligned by index to its column:
 *   `text`   -> `string | null`
 *   `number` -> `number | null`
 *   `date`   -> a `yyyy-MM-dd` string, or `null`
 *
 * Dates travel as the same `yyyy-MM-dd` strings the list DTOs already carry (the repositories cast
 * `date` columns with an explicit `::text`, precisely so no local-midnight `Date` can shift a row
 * into the previous day). Re-materialising them into a `Date` here only to format them back would
 * reintroduce exactly that hazard on a reporting surface where an off-by-one day is invisible.
 */
export type ExportCell = string | number | null;

/**
 * The metadata header block written above the data table of every export (spec FR-65/AC-064:
 * "headers include tenant name, report date, data period, currency, last-refreshed"). The active
 * filters are echoed too, so a saved file is self-describing about which rows it does and does not
 * contain — which is what makes "this export honours the filters" auditable after the fact.
 */
export interface ExportMetadata {
  readonly tenantName: string;
  readonly generatedAt: Date;
  readonly dataPeriod: string;
  readonly currency: string;
  readonly lastRefreshed: string;
  readonly filtersEcho: readonly string[];
}

export interface ExportDocument {
  readonly title: string;
  readonly metadata: ExportMetadata;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly (readonly ExportCell[])[];
}

/**
 * The OWASP "CSV Injection" trigger set (`CsvInjectionGuard.DangerousLeadingChars`, :24).
 *
 * The four documented formula characters plus a leading TAB (0x09) and CARRIAGE RETURN (0x0D),
 * which some spreadsheet parsers also treat as the start of a formula/command.
 */
const DANGEROUS_LEADING_CHARS: readonly string[] = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralises formula injection by prefixing a single quote, so the spreadsheet treats the value as
 * a literal string rather than a formula.
 *
 * WHICH CELLS GO THROUGH HERE, AND WHICH DELIBERATELY DO NOT
 * ==========================================================
 * GUARDED — every `text` cell, every column HEADER, and every value in the metadata header block
 * (the tenant name and the filter echo both carry tenant- and caller-controlled text). In practice
 * that is every party name, broker name, product line, cover type, status name, priority, owner
 * name, lead ref, reference-data label and lost reason an export can emit: all of them are text
 * columns, and none is excluded.
 *
 * NOT GUARDED — `number` and `date` cells, because their writers emit TYPED values, not arbitrary
 * strings. A number column can only ever produce `-?digits(.digits)?` and a date column only
 * `yyyy-MM-dd`; neither is a formula any spreadsheet will evaluate. Guarding them would be the
 * OTHER failure: a negative premium rendered as `'-500` is corrupted money in every downstream
 * consumer, and an export is a reporting surface where that is immediately visible. The unit tests
 * pin the guard from both directions for exactly this reason.
 *
 * Null/empty input returns the empty string so a cell never reads the literal "null".
 */
export function guardExportCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return DANGEROUS_LEADING_CHARS.includes(value[0] ?? '') ? `'${value}` : value;
}

/**
 * .NET's round-trip-ish "u" format (`DateTimeOffset.ToString("u", InvariantCulture)`):
 * `yyyy-MM-dd HH:mm:ssZ`, always UTC, no fractional seconds.
 *
 * Used for the `Generated at` / `Last refreshed` metadata lines so the header block is
 * byte-comparable with the reference's output (A-3).
 */
export function formatUniversalTime(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/**
 * The reference's `decimal.ToString("0.##", InvariantCulture)`: invariant decimal point, NO group
 * separators, at most two fraction digits, trailing zeros trimmed. `1500m` renders `1500`,
 * `1500.50m` renders `1500.5`, `-500m` renders `-500`.
 *
 * `toFixed(2)` first, so the value is pinned to the two decimal places `numeric(18,2)` stores
 * before any trimming, and never renders in exponent notation.
 */
export function formatNumberCell(value: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(2).replace(/\.?0+$/, '');
}
