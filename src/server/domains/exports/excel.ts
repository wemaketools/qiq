/**
 * XLSX writer over `exceljs` (T-039; AC-082; Q-9/A-16; spec FR-65).
 *
 * Port of `QuoteIQ.Infrastructure/Exports/ExcelExportWriter.cs`, whose ClosedXML dependency Q-9
 * replaced with `exceljs`.
 */
import ExcelJS from 'exceljs';

import {
  formatUniversalTime,
  guardExportCell,
  type ExportCell,
  type ExportColumnType,
  type ExportDocument,
} from './document.js';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLSX_FILE_EXTENSION = 'xlsx';

/** `#,##0.##` — full amounts in tables (NFR-08/AC-074), grouped for readability on screen. */
const FULL_AMOUNT_NUMBER_FORMAT = '#,##0.##';

/**
 * Writes a hardened TEXT cell.
 *
 * MEASURED, NOT ASSUMED (the point the brief insists on): `exceljs` only produces a formula cell
 * when the value is the object form `{ formula: '...' }`. Assigning a plain string — even one
 * starting with `=` — stores it as a shared string, and the re-parsed cell comes back with
 * `type === ValueType.String` and `formula === undefined`. So exceljs does NOT need the guard to
 * keep Excel from evaluating the cell on open.
 *
 * The guard is applied anyway, for two reasons the unit tests pin. First, defence in depth: the
 * apostrophe is not special in the XLSX format (Excel's text-prefix is a `quotePrefix` cell-format
 * attribute, not a character), so it survives as a literal and neutralises any downstream consumer
 * that re-exports the sheet to CSV — which is exactly how an injected cell escapes a "safe" format.
 * Second, parity: the CSV and XLSX renderings of the same export must not disagree about the
 * characters in a cell, or reconciling the two files becomes impossible.
 */
function setTextCell(cell: ExcelJS.Cell, value: string | null): void {
  cell.value = guardExportCell(value);
}

function writeCell(cell: ExcelJS.Cell, type: ExportColumnType, value: ExportCell): void {
  switch (type) {
    case 'number':
      if (typeof value !== 'number') return;
      cell.value = value;
      cell.numFmt = FULL_AMOUNT_NUMBER_FORMAT;
      cell.alignment = { horizontal: 'right' };
      return;
    case 'date':
      if (typeof value !== 'string') return;
      // Written as TEXT in the `yyyy-MM-dd` contract rather than as a serial date: the value is a
      // calendar date with no time and no zone, and materialising it into a JS `Date` to hand
      // exceljs a serial would pin it to a local midnight — the same off-by-one day the
      // repositories cast `::text` to avoid.
      cell.value = value;
      return;
    default:
      // A null text cell is left UNTOUCHED so it round-trips as an empty cell rather than as an
      // empty string, which is a different thing to every spreadsheet consumer.
      if (typeof value !== 'string') return;
      setTextCell(cell, value);
  }
}

function writeMetaRow(sheet: ExcelJS.Worksheet, row: number, label: string, value: string): number {
  const labelCell = sheet.getCell(row, 1);
  labelCell.value = label;
  labelCell.font = { bold: true };
  setTextCell(sheet.getCell(row, 2), value);
  return row + 1;
}

/**
 * ASYNC, unlike `writeCsv`: `exceljs` serialises the workbook zip through a stream, so
 * `xlsx.writeBuffer()` is the only way to get the bytes and it returns a promise. The whole export
 * path is already async, so this costs nothing but it is why the two writers do not share a
 * synchronous signature.
 */
export async function writeXlsx(document: ExportDocument): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Export');
  const { metadata } = document;

  let row = 1;
  row = writeMetaRow(sheet, row, 'Report', document.title);
  row = writeMetaRow(sheet, row, 'Tenant', metadata.tenantName);
  row = writeMetaRow(sheet, row, 'Generated at', formatUniversalTime(metadata.generatedAt));
  row = writeMetaRow(sheet, row, 'Data period', metadata.dataPeriod);
  row = writeMetaRow(sheet, row, 'Currency', metadata.currency);
  row = writeMetaRow(sheet, row, 'Last refreshed', metadata.lastRefreshed);
  for (const filter of metadata.filtersEcho) {
    row = writeMetaRow(sheet, row, 'Filter', filter);
  }

  row += 1; // one blank separator row

  const headerRow = row;
  document.columns.forEach((column, index) => {
    const cell = sheet.getCell(headerRow, index + 1);
    setTextCell(cell, column.header);
    cell.font = { bold: true };
  });
  sheet.views = [{ state: 'frozen', ySplit: headerRow }];
  row += 1;

  for (const dataRow of document.rows) {
    document.columns.forEach((column, index) => {
      writeCell(sheet.getCell(row, index + 1), column.type, dataRow[index] ?? null);
    });
    row += 1;
  }

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
