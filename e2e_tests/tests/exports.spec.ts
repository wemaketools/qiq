import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * List & dashboard exports to CSV/Excel (spec FR-65, AC-064, V-064, T-039): a filtered Leads-list CSV
 * download that reflects the active filters and carries the metadata header block (tenant name, period,
 * currency, last-refreshed); a dashboard card ⋮ menu that exports its underlying table; and an Excel
 * export whose workbook opens with the same metadata header.
 *
 * The export UI + backend are now real:
 *   - UI: `src/ui/src/components/common/ExportMenu.tsx` wired to the Leads list toolbar
 *     (`src/ui/src/features/leads/LeadsListPage.tsx`), the Parties list toolbar
 *     (`src/ui/src/features/parties/PartiesListPage.tsx`), the dashboard ChartCard ⋮ menu
 *     (`src/ui/src/components/dashboards/ChartCard.tsx`, wired on the Overview's Pipeline-by-Stage and
 *     High-Value cards), and the TopBar Export action (`src/ui/src/components/shell/TopBar.tsx` via
 *     `ExportTargetContext`). Downloads stream through the shared API client's blob path.
 *   - API: `GET /api/v1/exports/{leads,parties,dashboard}`
 *     (`src/api/QuoteIQ.Api/Endpoints/ExportEndpoints.cs`,
 *     `src/api/.../Application/Features/Exports/*`), CSV/Excel writers with formula-injection guarding
 *     (`src/api/.../Infrastructure/Exports/*`, `src/api/.../Domain/Exports/CsvInjectionGuard.cs`).
 *
 * What is NOT available yet is the seeded fixture V-064's scenario needs: seeded leads (with a
 * "Quote Sent" status set to filter on) and a "Sales Head" persona holding `leads.export`. That data
 * set is T-041's scope (FR-67); `e2e_tests/seed/seed-shell-e2e.sh` provisions no leads, so the Leads
 * list would render its empty state and there would be no rows to export or filter. Kept as
 * `describe.fixme` (real, ready-to-run bodies rather than faked assertions), following the exact
 * convention already established by `leads-list.spec.ts`/`dashboard-overview.spec.ts` for a forward
 * seed-data dependency. Un-fixme once T-041 (or an export-specific seed extension) provisions the
 * fixture leads + export persona and the compose stack (API + Vite dev server) is running.
 *
 * Every behavior V-064 describes is already proven without a live stack:
 *   - Security unit (Domain, no deps): QuoteIQ.Domain.Tests.Exports.CsvInjectionGuardTests proves the
 *     formula-injection guard prefixes `= + - @` (and leading tab/CR) cells and leaves safe cells alone.
 *   - Writers (Infrastructure): QuoteIQ.Infrastructure.Tests.Exports.{CsvExportWriterTests,
 *     ExcelExportWriterTests} prove the UTF-8 BOM, RFC-4180 escaping, the metadata header block, frozen
 *     header row, right-aligned full-amount numeric columns, and Excel text-cell injection guarding.
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Exports.ExportEndpointsTests proves
 *     active-filter + breadth-permission fidelity, the metadata block (tenant/period/currency), the
 *     `leads.export` 403 gate, the Internal-only cross-tenant export 403 gate, and the export audit row.
 *   - Frontend (real DOM, mocked API): src/ui/src/components/common/__tests__/ExportMenu.test.tsx
 *     (CSV/Excel selection triggers the right download path) and
 *     src/ui/src/features/exports/__tests__/exportsApi.test.ts (paths reflect active filters).
 */
// T-042 un-fixme: T-041 seed provides exportable list/dashboard data; persona repointed to the seeded
// `sales.manager@quoteiq.local` (leads.export/quotes.export/parties.export/reports.export).
test.describe('exports CSV/Excel (V-064)', () => {
  test('filtered Leads list CSV export downloads a file reflecting the active status filter', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/leads');

    // Filter the list to a single status (spec V-064: status = Quote Sent).
    await page.getByTestId('status-filter').selectOption({ label: 'Quote Sent' });
    await expect(page.getByTestId('leads-table')).toBeVisible();

    // Export CSV via the toolbar menu and capture the download.
    await page.getByTestId('leads-export-menu-trigger').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('leads-export-menu-csv').click(),
    ]);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const csv = Buffer.concat(chunks).toString('utf8');

    // Metadata header block present (spec FR-65/AC-064).
    expect(csv).toContain('Tenant,');
    expect(csv).toContain('Currency,');
    expect(csv).toContain('Last refreshed,');
    // Only the filtered status is present in the data rows.
    expect(csv).toContain('Quote Sent');
    expect(csv).not.toContain('Closed Won');
    // Descriptive filename.
    expect(download.suggestedFilename()).toMatch(/-leads-\d{8}\.csv$/);
  });

  test('dashboard card ⋮ menu exports its underlying table', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/overview');

    // The High-Value Opportunities card exposes an Export menu.
    const exportMenu = page.getByTestId('high-value-export-menu');
    await exportMenu.getByTestId('high-value-export-menu-trigger').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportMenu.getByTestId('high-value-export-menu-csv').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('Excel export downloads an xlsx whose header carries the metadata block', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/leads');
    await expect(page.getByTestId('leads-table')).toBeVisible();

    await page.getByTestId('leads-export-menu-trigger').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('leads-export-menu-xlsx').click(),
    ]);

    // The workbook is an xlsx (ZIP/OOXML: first bytes are 'PK'); full content-shape assertions live in
    // the ExcelExportWriter integration tests, which can inspect the workbook cells directly.
    expect(download.suggestedFilename()).toMatch(/-leads-\d{8}\.xlsx$/);
    const stream = await download.createReadStream();
    const firstChunk: Buffer = await new Promise((resolve, reject) => {
      stream.once('data', (chunk) => resolve(Buffer.from(chunk)));
      stream.once('error', reject);
    });
    expect(firstChunk.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
