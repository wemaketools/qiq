import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Reports screen + print-ready views + per-report CSV (spec FR-64/FR-65, AC-059/AC-063/AC-064,
 * V-059/V-063/V-064, T-040): a grid of the caller's permitted report cards (each with "Open report" +
 * "CSV" and NO scheduling/cadence UI), a print-ready report view whose header carries the tenant / report
 * date / data period / currency / last-refreshed metadata, a CSV download, and the SLA/Turnaround report's
 * underwriting delay queue.
 *
 * The Reports UI + backend are now real:
 *   - UI: `src/ui/src/features/reports/ReportsPage.tsx` (card grid) + `ReportViewPage.tsx`
 *     (print-ready view + "Print / Save as PDF" -> window.print()) + `print.css`, wired at `/reports`
 *     and `/reports/:reportKey` (`src/ui/src/app/router.tsx`), fed by `GET /api/v1/reports`,
 *     `GET /api/v1/reports/{key}`, and `GET /api/v1/reports/{key}/csv` (the CSV streams through the shared
 *     T-039 blob/download path).
 *   - API: `src/api/QuoteIQ.Api/Endpoints/ReportEndpoints.cs`,
 *     `src/api/.../Application/Features/Reports/*` (catalog, view, CSV, the new SLA/Turnaround,
 *     Pipeline-Aging, Escalation-Queue, Tenant-Configuration, and cross-tenant Internal-Tenant-Overview
 *     queries), reusing the dashboard query handlers and the T-039 export writers.
 *
 * What is NOT available yet is the seeded fixture V-063/V-059's scenario needs: a "Sales Head" persona
 * holding `reports.view` + the dashboard `dashboards.view_*` permissions, plus seeded leads/quotes/alerts
 * (incl. SLA-breaching records) to give the reports content. That data set is T-041's scope (FR-67);
 * `e2e_tests/seed/seed-shell-e2e.sh` provisions no leads or reports persona, so the grid would render but
 * the report views would be largely empty and the SLA delay queue would have no rows. Kept as
 * `describe.fixme` (real, ready-to-run bodies rather than faked assertions), following the exact
 * convention already established by `dashboard-overview.spec.ts`/`exports.spec.ts` for a forward
 * seed-data dependency. Un-fixme once T-041 (or a reports-specific seed extension) provisions the fixture
 * and the compose stack (API on :5080 + Vite dev server) is running.
 *
 * Every behavior V-063/V-059/V-064 describes is already proven without a live stack:
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Reports.ReportEndpointsTests proves
 *     the catalog filters by caller permissions, the SLA/Turnaround report computes the PRD 17.1 metrics
 *     + underwriting delay queue, the per-report CSV carries the metadata header and respects active
 *     filters, and the Internal Tenant Overview 403 gate.
 *   - Frontend (real DOM, mocked API): src/ui/src/features/reports/__tests__/{ReportsPage,ReportViewPage,
 *     reportsApi}.test.tsx render the permitted card grid (no scheduling UI), Open-report navigation, the
 *     CSV download path, the print-ready header metadata, the KPI/table sections, and window.print().
 */
// T-042 un-fixme: T-041 seed provides the report fixtures; persona repointed to the seeded
// `sales.manager@quoteiq.local` (reports.view/export + the underlying view_all data breadth).
test.describe('reports (V-063/V-059/V-064)', () => {
  test('reports grid shows only permitted cards with Open report + CSV and no scheduling UI', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/reports');

    const cards = page.getByTestId('report-card');
    await expect(cards.first()).toBeVisible();

    // Standard report cards each offer Open report + CSV.
    await expect(page.getByTestId('report-open-executive-weekly')).toBeVisible();
    await expect(page.getByTestId('report-csv-executive-weekly')).toBeVisible();

    // No scheduling / cadence UI exists anywhere on the screen (FR-64: on-demand only).
    await expect(page.getByText(/schedul/i)).toHaveCount(0);
    await expect(page.getByText(/cadence/i)).toHaveCount(0);
  });

  test('Open report renders a print-ready view with tenant / period / currency header', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/reports');

    await page.getByTestId('report-open-executive-weekly').click();

    await expect(page).toHaveURL(/\/reports\/executive-weekly$/);
    const meta = page.getByTestId('report-header-meta');
    await expect(meta).toBeVisible();
    await expect(page.getByTestId('report-meta-tenant')).not.toBeEmpty();
    await expect(page.getByTestId('report-meta-period')).not.toBeEmpty();
    await expect(page.getByTestId('report-meta-currency')).not.toBeEmpty();
    await expect(page.getByTestId('report-meta-refreshed')).not.toBeEmpty();

    // The print/PDF affordance is present (browser-print PDF per A-5; no server-side rendering).
    await expect(page.getByTestId('report-print-button')).toBeVisible();
  });

  test('SLA / Turnaround report shows the underwriting delay queue', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/reports/sla-turnaround');

    await expect(page.getByTestId('report-section-sla-metrics')).toBeVisible();
    await expect(page.getByTestId('report-section-underwriting-delay-queue')).toBeVisible();
  });

  test('CSV button downloads a per-report CSV file', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/reports');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('report-csv-pipeline-conversion').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/-pipeline-conversion-\d{8}\.csv$/);
  });
});
