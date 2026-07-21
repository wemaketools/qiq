/**
 * The export writers: the CSV formula-injection guard, the RFC-4180 CSV writer and the exceljs
 * XLSX writer (T-039; AC-081, AC-082; V-102).
 *
 * Port of `QuoteIQ.Domain.Tests/Exports/CsvInjectionGuardTests.cs`,
 * `QuoteIQ.Infrastructure.Tests/Exports/CsvExportWriterTests.cs` and `ExcelExportWriterTests.cs`.
 *
 * WHY EVERY ASSERTION HERE IS ON BYTES OR ON A PARSED CELL VALUE
 * =============================================================
 * "A file was produced" cannot tell a working export from a broken one, and "the guard function was
 * called" cannot tell a guarded cell from an unguarded one. Each test below decodes what the writer
 * actually emitted — the CSV text, or the workbook re-parsed through exceljs — and asserts the
 * literal characters. That is the only form of this test that dies when the guard is removed.
 *
 * THE GUARD IS PINNED FROM BOTH SIDES
 * ===================================
 * Under-guarding ships formula injection. OVER-guarding is its own defect: a premium of -500.00
 * quoted into `'-500` is a corrupted number in every downstream consumer, and a party name
 * containing a comma that gets a spurious prefix is a corrupted name. Both directions are asserted.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import {
  guardExportCell,
  type ExportColumn,
  type ExportDocument,
  type ExportMetadata,
} from '../../domains/exports/document.js';
import { CSV_CONTENT_TYPE, UTF8_BOM, writeCsv } from '../../domains/exports/csv.js';
import { XLSX_CONTENT_TYPE, writeXlsx } from '../../domains/exports/excel.js';

/** A fixed instant so the metadata block is byte-comparable. */
const GENERATED_AT = new Date('2026-07-20T09:08:07.654Z');

const METADATA: ExportMetadata = {
  tenantName: 'Acme Insurance',
  generatedAt: GENERATED_AT,
  dataPeriod: '2026-01-01 to 2026-03-31',
  currency: 'BWP',
  lastRefreshed: '2026-07-20 09:08:07Z',
  filtersEcho: ['Status ids: 1, 2', 'My leads only'],
};

const COLUMNS: readonly ExportColumn[] = [
  { header: 'Party', type: 'text' },
  { header: 'Premium', type: 'number' },
  { header: 'Date received', type: 'date' },
];

function documentOf(rows: readonly (readonly (string | number | null)[])[]): ExportDocument {
  return { title: 'Leads export', metadata: METADATA, columns: COLUMNS, rows };
}

function csvText(document: ExportDocument): string {
  return new TextDecoder('utf-8').decode(writeCsv(document));
}

/** The data rows of the emitted CSV, i.e. everything after the metadata block and header row. */
function csvDataLines(document: ExportDocument): string[] {
  const lines = csvText(document).split('\r\n');
  const headerIndex = lines.findIndex((line) => line.startsWith('Party,'));
  return lines.slice(headerIndex + 1).filter((line) => line !== '');
}

/** The first data cell (the text column) exactly as written. */
function firstTextCell(value: string | null): string {
  return csvDataLines(documentOf([[value, null, null]]))[0]?.split(',')[0] ?? '';
}

async function parseWorkbook(bytes: Uint8Array): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  // `bytes.buffer` is the whole allocation; slice to this view so a pooled buffer cannot leak in.
  await workbook.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const sheet = workbook.getWorksheet(1);
  if (sheet === undefined) throw new Error('workbook has no worksheet');
  return sheet;
}

// -------------------------------------------------------------------------------------------
// The guard itself.
// -------------------------------------------------------------------------------------------

describe('guardExportCell (T-039, AC-081, V-102)', () => {
  /**
   * The OWASP "CSV Injection" trigger set: the four documented formula characters plus a leading
   * TAB and CARRIAGE RETURN, which some spreadsheet parsers also treat as a command/formula start.
   * The reference guards all six (`CsvInjectionGuard.cs:24`) and so does this port.
   */
  it.each([
    ['equals', '=cmd|\'/c calc\'!A1', "'=cmd|'/c calc'!A1"],
    ['plus', '+1+1', "'+1+1"],
    ['minus', '-1+1', "'-1+1"],
    ['at', '@SUM(1+1)', "'@SUM(1+1)"],
    ['hyperlink', '=HYPERLINK("http://evil","x")', '\'=HYPERLINK("http://evil","x")'],
    ['leading tab', '\t=1+1', "'\t=1+1"],
    ['leading carriage return', '\r=1+1', "'\r=1+1"],
  ])('prefixes a %s payload with a single quote', (_label, input, expected) => {
    expect(guardExportCell(input)).toBe(expected);
  });

  it.each([
    ['plain text', 'Acme Insurance'],
    ['a name containing a comma', 'Acme, Insurance Ltd'],
    ['a name containing a double quote', 'Acme "Prime" Ltd'],
    ['a name containing an embedded newline', 'Acme Ltd\nSecond line'],
    ['a numeric-looking string', '1500.00'],
    ['a name whose dangerous character is not leading', 'Acme = Insurance'],
    ['a name whose minus is not leading', 'Acme-Insurance'],
  ])('leaves %s untouched', (_label, input) => {
    expect(guardExportCell(input)).toBe(input);
  });

  it('renders null and undefined as the empty string, never the text "null"', () => {
    expect(guardExportCell(null)).toBe('');
    expect(guardExportCell(undefined)).toBe('');
    expect(guardExportCell('')).toBe('');
  });
});

// -------------------------------------------------------------------------------------------
// CSV writer.
// -------------------------------------------------------------------------------------------

describe('writeCsv metadata header block (T-039, AC-082)', () => {
  it('emits a UTF-8 BOM so Excel decodes the file as UTF-8', () => {
    const bytes = writeCsv(documentOf([]));
    expect([...bytes.slice(0, 3)]).toEqual([...UTF8_BOM]);
  });

  it('writes report, tenant, generated-at, period, currency, last-refreshed and each filter', () => {
    const lines = csvText(documentOf([])).split('\r\n');

    expect(lines.slice(0, 8)).toEqual([
      // `TextDecoder('utf-8')` strips the BOM; the BOM BYTES are asserted separately above.
      'Report,Leads export',
      'Tenant,Acme Insurance',
      'Generated at,2026-07-20 09:08:07Z',
      'Data period,2026-01-01 to 2026-03-31',
      'Currency,BWP',
      'Last refreshed,2026-07-20 09:08:07Z',
      'Filter,"Status ids: 1, 2"',
      'Filter,My leads only',
    ]);
  });

  it('separates the metadata block from the data table with a blank line and a header row', () => {
    const lines = csvText(documentOf([])).split('\r\n');

    expect(lines[8]).toBe('');
    expect(lines[9]).toBe('Party,Premium,Date received');
  });

  it('guards an injection-laden tenant name in the metadata block too', () => {
    const document: ExportDocument = {
      ...documentOf([]),
      metadata: { ...METADATA, tenantName: '=cmd|\'/c calc\'!A1' },
    };

    // Unquoted, correctly: the payload contains no comma, double quote, CR or LF, so RFC-4180 has
    // nothing to escape. The GUARD is what makes it inert, and that is what is asserted.
    expect(csvText(document)).toContain("Tenant,'=cmd|'/c calc'!A1\r\n");
  });

  it('declares the CSV content type with an explicit charset', () => {
    expect(CSV_CONTENT_TYPE).toBe('text/csv; charset=utf-8');
  });
});

describe('writeCsv text cells are guarded (T-039, AC-081, V-102)', () => {
  it.each([
    ['=cmd|\'/c calc\'!A1', '\'=cmd|\'/c calc\'!A1'],
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(1+1)', "'@SUM(1+1)"],
  ])('writes %s as the guarded literal %s', (input, expected) => {
    expect(firstTextCell(input)).toBe(expected);
  });

  it('guards AND RFC-4180 quotes a dangerous value that also contains a comma', () => {
    // Both defences must apply: the guard makes it inert, the quoting keeps the row parseable.
    expect(csvDataLines(documentOf([['=HYPERLINK("http://evil","x"),Acme', null, null]]))[0]).toBe(
      '"\'=HYPERLINK(""http://evil"",""x""),Acme",,',
    );
  });

  it('guards a leading tab and a leading carriage return, quoting them as RFC-4180 requires', () => {
    expect(csvDataLines(documentOf([['\t=1+1', null, null]]))[0]).toBe("'\t=1+1,,");
    expect(csvDataLines(documentOf([['\r=1+1', null, null]]))[0]).toBe('"\'\r=1+1",,');
  });

  it('guards the column headers, so a tenant-named column cannot inject either', () => {
    const document: ExportDocument = {
      ...documentOf([]),
      columns: [{ header: '=1+1', type: 'text' }],
    };

    expect(csvText(document)).toContain("'=1+1");
  });
});

describe('writeCsv does NOT corrupt legitimate values (T-039, V-102)', () => {
  it('leaves a plain name untouched and unquoted', () => {
    expect(firstTextCell('Acme Insurance')).toBe('Acme Insurance');
  });

  it('quotes but does not guard a name containing a comma', () => {
    expect(csvDataLines(documentOf([['Acme, Insurance Ltd', null, null]]))[0]).toBe(
      '"Acme, Insurance Ltd",,',
    );
  });

  it('doubles but does not guard an embedded double quote', () => {
    expect(csvDataLines(documentOf([['Acme "Prime" Ltd', null, null]]))[0]).toBe(
      '"Acme ""Prime"" Ltd",,',
    );
  });

  it('preserves an embedded newline inside a quoted field', () => {
    const text = csvText(documentOf([['Acme Ltd\nSecond line', null, null]]));
    expect(text).toContain('"Acme Ltd\nSecond line",,');
  });

  it('writes a NEGATIVE premium as a bare number, never as a guarded string', () => {
    // THE OVER-GUARD PIN. A number column can only ever emit `-?digits(.digits)?`, which no
    // spreadsheet evaluates as a formula, so guarding it would corrupt real money for nothing.
    const line = csvDataLines(documentOf([['Acme', -500, null]]))[0];

    expect(line).toBe('Acme,-500,');
    expect(line).not.toContain("'-500");
  });

  it.each([
    [1500, '1500'],
    [1500.5, '1500.5'],
    [1500.25, '1500.25'],
    [-500.75, '-500.75'],
    [0, '0'],
  ])('formats the number %s as %s (invariant, no group separators)', (value, expected) => {
    expect(csvDataLines(documentOf([['Acme', value, null]]))[0]).toBe(`Acme,${expected},`);
  });

  it('writes date cells as yyyy-MM-dd and null cells as empty', () => {
    expect(csvDataLines(documentOf([['Acme', null, '2026-03-01']]))[0]).toBe('Acme,,2026-03-01');
    expect(csvDataLines(documentOf([[null, null, null]]))[0]).toBe(',,');
  });

  it('emits one line per row, in the order given', () => {
    const lines = csvDataLines(
      documentOf([
        ['First', 1, '2026-01-01'],
        ['Second', 2, '2026-01-02'],
      ]),
    );

    expect(lines).toEqual(['First,1,2026-01-01', 'Second,2,2026-01-02']);
  });
});

// -------------------------------------------------------------------------------------------
// Excel writer. Every assertion re-parses the produced bytes: what exceljs ACTUALLY wrote.
// -------------------------------------------------------------------------------------------

describe('writeXlsx (T-039, AC-082, Q-9)', () => {
  it('produces a workbook that parses as valid XLSX with the metadata block and header row', async () => {
    const sheet = await parseWorkbook(
      await writeXlsx(documentOf([['Acme', 1500, '2026-03-01']])),
    );

    expect(sheet.getCell('A1').value).toBe('Report');
    expect(sheet.getCell('B1').value).toBe('Leads export');
    expect(sheet.getCell('A2').value).toBe('Tenant');
    expect(sheet.getCell('B2').value).toBe('Acme Insurance');
    expect(sheet.getCell('A3').value).toBe('Generated at');
    expect(sheet.getCell('B3').value).toBe('2026-07-20 09:08:07Z');
    expect(sheet.getCell('A4').value).toBe('Data period');
    expect(sheet.getCell('B4').value).toBe('2026-01-01 to 2026-03-31');
    expect(sheet.getCell('A5').value).toBe('Currency');
    expect(sheet.getCell('B5').value).toBe('BWP');
    expect(sheet.getCell('A6').value).toBe('Last refreshed');
    expect(sheet.getCell('B6').value).toBe('2026-07-20 09:08:07Z');
    expect(sheet.getCell('B7').value).toBe('Status ids: 1, 2');
    expect(sheet.getCell('B8').value).toBe('My leads only');

    // Row 9 is the blank separator; row 10 is the frozen header row.
    expect(sheet.getCell('A10').value).toBe('Party');
    expect(sheet.getCell('B10').value).toBe('Premium');
    expect(sheet.getCell('C10').value).toBe('Date received');
  });

  it('writes a guarded TEXT cell as a literal string, never as a formula', async () => {
    const sheet = await parseWorkbook(
      await writeXlsx(documentOf([['=HYPERLINK("http://evil","x")', null, null]])),
    );
    const cell = sheet.getCell('A11');

    // MEASURED, not assumed: the written cell carries the guard prefix and its type is String.
    expect(cell.value).toBe('\'=HYPERLINK("http://evil","x")');
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.formula).toBeUndefined();
  });

  it.each([
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(1+1)', "'@SUM(1+1)"],
    ['\t=1+1', "'\t=1+1"],
  ])('guards the %s payload in the workbook too', async (input, expected) => {
    const sheet = await parseWorkbook(await writeXlsx(documentOf([[input, null, null]])));

    expect(sheet.getCell('A11').value).toBe(expected);
    expect(sheet.getCell('A11').type).toBe(ExcelJS.ValueType.String);
  });

  it('writes a NEGATIVE premium as a real number cell, not a guarded string', async () => {
    const sheet = await parseWorkbook(
      await writeXlsx(documentOf([['Acme', -500, '2026-03-01']])),
    );
    const cell = sheet.getCell('B11');

    expect(cell.value).toBe(-500);
    expect(cell.type).toBe(ExcelJS.ValueType.Number);
  });

  it('leaves a legitimate name containing a comma and a quote unmodified', async () => {
    const sheet = await parseWorkbook(
      await writeXlsx(documentOf([['Acme, "Prime" Ltd', null, null]])),
    );

    expect(sheet.getCell('A11').value).toBe('Acme, "Prime" Ltd');
  });

  it('writes date cells as text in the yyyy-MM-dd contract, and null cells as empty', async () => {
    const sheet = await parseWorkbook(
      await writeXlsx(documentOf([['Acme', null, '2026-03-01'], [null, null, null]])),
    );

    expect(sheet.getCell('C11').value).toBe('2026-03-01');
    expect(sheet.getCell('B11').value).toBeNull();
    expect(sheet.getCell('A12').value).toBeNull();
  });

  it('freezes the header row so the table stays readable while scrolling', async () => {
    const sheet = await parseWorkbook(await writeXlsx(documentOf([])));

    expect(sheet.views[0]?.state).toBe('frozen');
    expect((sheet.views[0] as { ySplit?: number }).ySplit).toBe(10);
  });

  it('declares the OpenXML spreadsheet content type', () => {
    expect(XLSX_CONTENT_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
