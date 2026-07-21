/**
 * RFC-4180 CSV writer (T-039; AC-081, AC-082; V-102; spec FR-65, P-12).
 *
 * Port of `QuoteIQ.Infrastructure/Exports/CsvExportWriter.cs`.
 */
import {
  formatNumberCell,
  formatUniversalTime,
  guardExportCell,
  type ExportCell,
  type ExportColumnType,
  type ExportDocument,
} from './document.js';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const CSV_FILE_EXTENSION = 'csv';

/**
 * The UTF-8 byte-order mark. Excel decodes a BOM-less CSV with the system code page, so a party
 * name with any non-ASCII character arrives mojibaked; the reference emits it for the same reason.
 */
export const UTF8_BOM: Uint8Array = new Uint8Array([0xef, 0xbb, 0xbf]);

/**
 * RFC-4180 record separator.
 *
 * DELIBERATE, DOCUMENTED DIVERGENCE: the reference used `StringBuilder.AppendLine`, whose separator
 * is `Environment.NewLine` — so the same code emitted LF on its Linux containers and CRLF on a
 * developer's Windows box, and the file's bytes were a function of the HOST rather than the data.
 * That is not a contract anything can be pinned against. CRLF is chosen because RFC-4180 specifies
 * it and because a quoted field may itself contain a bare LF, which makes CRLF the strictly more
 * parseable record separator of the two.
 */
const CRLF = '\r\n';

/**
 * Text is GUARDED; numbers and dates are rendered as typed, culture-invariant values and are NOT
 * guarded — see `guardExportCell` for why guarding them would corrupt real data for no gain.
 */
function formatCell(type: ExportColumnType, value: ExportCell): string {
  switch (type) {
    case 'number':
      return typeof value === 'number' ? formatNumberCell(value) : '';
    case 'date':
      return typeof value === 'string' ? value : '';
    default:
      return guardExportCell(typeof value === 'string' ? value : null);
  }
}

/**
 * RFC-4180 field escaping: wrap in double quotes and double any embedded quote when the field
 * contains a quote, a comma, a CR or an LF.
 */
function escapeField(field: string): string {
  if (!/["\r\n,]/.test(field)) return field;
  return `"${field.replaceAll('"', '""')}"`;
}

/**
 * A metadata line. The VALUE is guarded as well as quoted: the tenant name and the filter echo both
 * carry tenant- and caller-controlled text, so an injection payload placed in either would execute
 * from the header block just as readily as from a data cell.
 */
function metaLine(label: string, value: string): string {
  return `${escapeField(label)},${escapeField(guardExportCell(value))}${CRLF}`;
}

export function writeCsv(document: ExportDocument): Uint8Array {
  const { metadata } = document;
  let text = '';

  // --- Metadata header block (spec FR-65), one label/value pair per line. ---
  text += metaLine('Report', document.title);
  text += metaLine('Tenant', metadata.tenantName);
  text += metaLine('Generated at', formatUniversalTime(metadata.generatedAt));
  text += metaLine('Data period', metadata.dataPeriod);
  text += metaLine('Currency', metadata.currency);
  text += metaLine('Last refreshed', metadata.lastRefreshed);
  for (const filter of metadata.filtersEcho) {
    text += metaLine('Filter', filter);
  }

  // Blank separator line between the metadata block and the data table.
  text += CRLF;

  // --- Column header row. Guarded too: a column caption can be a tenant reference-data label. ---
  text += `${document.columns
    .map((column) => escapeField(guardExportCell(column.header)))
    .join(',')}${CRLF}`;

  // --- Data rows. ---
  for (const row of document.rows) {
    const fields = document.columns.map((column, index) =>
      escapeField(formatCell(column.type, row[index] ?? null)),
    );
    text += `${fields.join(',')}${CRLF}`;
  }

  const body = new TextEncoder().encode(text);
  const result = new Uint8Array(UTF8_BOM.length + body.length);
  result.set(UTF8_BOM, 0);
  result.set(body, UTF8_BOM.length);
  return result;
}
