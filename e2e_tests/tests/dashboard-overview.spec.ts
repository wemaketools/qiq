import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Executive Overview dashboard (spec FR-55, AC-054, V-054, T-032): nine lead/quote-labeled KPI cards,
 * the three charts (Pipeline by Stage, Open Quotes Aging, Won vs Lost Trend with a Weekly/Monthly
 * selector), the High-Value Opportunities table (row drill to Lead Detail), and the Requires Attention
 * panel (chevron to the pre-filtered Alerts center), all drillable per AC-054.
 *
 * The Overview screen itself is now real: `src/ui/src/features/dashboards/OverviewPage.tsx` +
 * `src/ui/src/features/dashboards/overview/*.tsx`, wired at `/overview` (`src/ui/src/app/router.tsx`),
 * fed by `GET /api/v1/dashboards/executive`
 * (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`,
 * `src/api/.../Features/Dashboards/Executive/*`).
 *
 * What is NOT available yet is the seeded fixture V-054's scenario needs ("Seeded data set" with leads
 * across the lifecycle, quotes by status, aging, and per-category alert conditions). That data set is
 * T-041's scope (FR-67); the only e2e seed that exists today, `e2e_tests/seed/seed-shell-e2e.sh`,
 * provisions the personas (rm.tebogo@quoteiq.local does hold `dashboards.view_executive`) but no leads,
 * quotes, or alerts — so every Overview widget would render its empty state, and the drill/attention
 * assertions below have nothing to land on. Kept as `describe.fixme` (real, ready-to-run bodies rather
 * than faked assertions or a silent omission), following the exact convention already established by
 * `leads-list.spec.ts`/`dashboard-framework.spec.ts` for a forward seed-data dependency. Un-fixme once
 * T-041 (or an Overview-specific seed extension) provisions the fixture this scenario needs and the
 * compose stack (API on :5080 + Vite dev server) is running.
 *
 * Every behavior V-054 describes is already proven without a live stack:
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Dashboards.ExecutiveOverviewTests
 *     computes the nine KPI values against a hand-computed fixture, proves Pipeline by Stage counts
 *     CURRENT open items per stage (not cumulative), the weekly/monthly trend bucketing, filter
 *     consistency across widgets, the tenant high-value threshold, and the ViewExecutive 403 gate.
 *   - Frontend (real DOM, mocked API): src/ui/src/features/dashboards/__tests__/OverviewPage.test.tsx
 *     renders the nine lead/quote-labeled KPI cards + all widgets, the falling-turnaround green delta,
 *     KPI drill navigation, pipeline-stage drill, high-value row drill to Lead Detail, the Requires
 *     Attention chevron to the pre-filtered Alerts route, and the Weekly/Monthly toggle without a refetch.
 */
// T-042 un-fixme: the T-041 seed now provisions the Overview fixture, and the login persona is
// repointed to the seeded `sales.manager@quoteiq.local` (dashboards.view_executive + leads.view_all,
// member of "The Brittany") — see e2e_tests/helpers/personas.ts. The header note above predates T-041
// and describes the original blocked state.
test.describe('dashboard overview (V-054)', () => {
  test('renders nine KPIs, three charts, high-value table, and attention panel with drills', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/overview');

    // Nine KPI cards, each labeled with its lead-vs-quote distinction (FR-54).
    const kpiRow = page.getByTestId('kpi-row');
    await expect(kpiRow).toBeVisible();
    await expect(kpiRow.getByTestId('kpi-card')).toHaveCount(9);
    // The migrated KPI labels omit the "(Lead)"/"(Quote)" suffix when the name already carries the
    // distinction ("Total Leads"/"Total Quotes"): kpiCardLabel only appends the qualifier when the
    // label lacks the word lead/quote (src/ui/src/components/dashboards/formatters.ts).
    await expect(page.getByText(/Total Leads/)).toBeVisible();
    await expect(page.getByText(/Total Quotes/)).toBeVisible();

    // Three charts.
    await expect(page.getByTestId('pipeline-by-stage')).toBeVisible();
    await expect(page.getByTestId('aging-donut')).toBeVisible();
    await expect(page.getByTestId('aging-center-total')).toBeVisible();
    await expect(page.getByTestId('won-lost-trend')).toBeVisible();
    await expect(page.getByTestId('trend-granularity')).toBeVisible();

    // The trend chart must stay inside its card: it once rendered at a fixed 560px and spilled out
    // of the card at narrower columns — a geometry regression only a real layout can observe.
    const trendCard = page.getByTestId('chart-card').filter({ has: page.getByTestId('won-lost-trend') });
    const cardBox = await trendCard.boundingBox();
    const chartBox = await page.getByTestId('won-lost-trend').locator('svg').first().boundingBox();
    expect(chartBox!.x + chartBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);

    // High-Value Opportunities table and Requires Attention panel.
    await expect(page.getByTestId('high-value-table')).toBeVisible();
    await expect(page.getByTestId('requires-attention')).toBeVisible();
  });

  test('KPI drill and chart-segment drill open matching lead lists', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/overview');

    // KPI drill.
    await page.getByTestId('kpi-row').getByTestId('kpi-card').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();

    // Back to Overview, then chart-segment (pipeline stage bar) drill.
    await page.goto('/overview');
    await page.getByTestId('pipeline-stage-row').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();
  });

  test('High-Value Opportunities row drills to Lead Detail', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/overview');

    await page.getByTestId('high-value-row').first().click();
    await expect(page).toHaveURL(/\/leads\/\d+/);
  });

  test('Requires Attention chevron lands on the pre-filtered Alerts center', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/overview');

    await page.getByTestId('requires-attention').getByTestId('attention-row').filter({ hasText: /Overdue/ }).first().click();
    await expect(page).toHaveURL(/\/alerts\?tab=overdue/);
  });

  // SEED GAP (T-041 demo-seed extension): the demo set's Avg Turnaround is RISING period-over-period
  // (the live run renders "↑ +0.2" in the danger colour), so there is no falling turnaround to prove
  // the favourable green delta. Un-fixme once the demo seed produces a falling turnaround trend.
  // Finding raised against T-041.
  test.fixme('turnaround KPI shows a green delta when falling', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/overview');

    const turnaroundCard = page.getByTestId('kpi-card').filter({ hasText: /Avg Turnaround/ });
    const delta = turnaroundCard.getByTestId('kpi-delta');
    await expect(delta).toBeVisible();
    // Falling turnaround is favorable (LowerIsBetter): delta rendered in the success color
    // (--qiq-success = #1e8e5a in the light theme).
    await expect(delta).toHaveCSS('color', 'rgb(30, 142, 90)');
  });
});
