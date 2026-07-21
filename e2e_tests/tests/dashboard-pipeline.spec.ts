import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Pipeline & Conversion dashboard (spec FR-56, AC-055/AC-059, V-055, T-033): nine lead/quote-labeled
 * KPI cards, the cumulative Stage Conversion funnel (Lost last in red), Pipeline-by-Product-Line
 * stacked columns, the Quote-Volume-by-Source and Lead-Volume-by-Channel donuts, the open-stage-only
 * Aging heatmap (hot-cell drill to the aged lead list), the At-Risk table (row drill to Lead Detail,
 * risk reason + suggested action), and the Immediate Actions panel (each category to the pre-filtered
 * Alerts center), all drillable per AC-055.
 *
 * The Pipeline screen itself is now real: `src/ui/src/features/dashboards/PipelinePage.tsx` +
 * `src/ui/src/features/dashboards/pipeline/*.tsx`, wired at `/pipeline` (`src/ui/src/app/router.tsx`),
 * fed by `GET /api/v1/dashboards/pipeline` (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`,
 * `src/api/.../Features/Dashboards/Pipeline/*`), gated by `dashboards.view_pipeline` (RM keeps
 * pipeline-only access — it does NOT require `dashboards.view_executive`).
 *
 * What is NOT available yet is the seeded fixture V-055's scenario needs ("Seeded data set" with leads
 * across the lifecycle, quotes by status, aging, and per-category alert conditions). That data set is
 * T-041's scope (FR-67); the only e2e seed that exists today, `e2e_tests/seed/seed-shell-e2e.sh`,
 * provisions the personas but no leads/quotes/alerts — so every Pipeline widget would render its empty
 * state and the drill/action assertions below would have nothing to land on. Kept as `describe.fixme`
 * (real, ready-to-run bodies rather than faked assertions or a silent omission), following the exact
 * convention already established by `dashboard-overview.spec.ts` for a forward seed-data dependency.
 * Un-fixme once T-041 (or a Pipeline-specific seed extension) provisions the fixture this scenario
 * needs and the compose stack (API on :5080 + Vite dev server) is running.
 *
 * Every behavior V-055 describes is already proven without a live stack:
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Dashboards.PipelineDashboardTests
 *     computes the cumulative funnel (Lost last), the open-stage-only aging heatmap, the Q-8 overdue-
 *     quote Immediate Action, the product-line stacks summing to their monthly totals, the At-Risk
 *     risk-reason/suggested-action rows, the nine KPI values, and the ViewPipeline 403 gate + the
 *     pipeline-only (no ViewExecutive) success path.
 *   - Frontend (real DOM, mocked API): src/ui/src/features/dashboards/__tests__/PipelinePage.test.tsx
 *     renders the nine lead/quote-labeled KPI cards + every widget, flags the Lost funnel bar last/red,
 *     shows only open stages in the heatmap, renders the fixed product-line stack segments, and proves
 *     KPI drill, funnel-stage drill, At-Risk row drill to Lead Detail, and Immediate-Action navigation
 *     to the pre-filtered Alerts route.
 */
// T-042 un-fixme: T-041 seed provides the pipeline fixture; persona repointed to the seeded
// `sales.manager@quoteiq.local` (dashboards.view_pipeline + leads.view_all). See helpers/personas.ts.
test.describe('dashboard pipeline (V-055)', () => {
  test('renders nine KPIs, funnel, stacks, donuts, heatmap, at-risk table, and immediate actions', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/pipeline');

    // Nine KPI cards, each labeled with its lead-vs-quote distinction (FR-54).
    const kpiRow = page.getByTestId('pipeline-kpi-row');
    await expect(kpiRow).toBeVisible();
    await expect(kpiRow.getByTestId('kpi-card')).toHaveCount(9);
    // "New Leads This Month" already carries "Leads", so the migrated kpiCardLabel appends no
    // "(Lead)" suffix; "SLA Breaches" lacks lead/quote so it keeps its "(Quote)" qualifier
    // (src/ui/src/components/dashboards/formatters.ts).
    await expect(page.getByText(/New Leads This Month/)).toBeVisible();
    await expect(page.getByText(/SLA Breaches \(Quote\)/)).toBeVisible();

    // Funnel with conversion-from-top percentages and Lost last in red.
    await expect(page.getByTestId('conversion-funnel')).toBeVisible();
    const funnelRows = page.getByTestId('funnel-stage-row');
    await expect(funnelRows.last()).toHaveAttribute('data-is-lost', 'true');

    // Stacked product-line columns with legend and monthly totals.
    await expect(page.getByTestId('product-line-stacks')).toBeVisible();
    await expect(page.getByTestId('stack-legend')).toBeVisible();
    await expect(page.getByTestId('stack-column-total').first()).toBeVisible();

    // Source and channel donuts.
    await expect(page.getByTestId('quote-volume-by-source')).toBeVisible();
    await expect(page.getByTestId('lead-volume-by-channel')).toBeVisible();

    // Open-stage-only aging heatmap with graded cells.
    await expect(page.getByTestId('aging-heatmap')).toBeVisible();
    await expect(page.getByTestId('aging-heatmap').getByText('Closed Won')).toHaveCount(0);

    // At-Risk table and Immediate Actions panel.
    await expect(page.getByTestId('at-risk-table')).toBeVisible();
    await expect(page.getByTestId('immediate-actions')).toBeVisible();
  });

  test('heatmap hot cell drills to the matching aged lead list', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/pipeline');

    await page.getByTestId('heatmap-cell').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();
  });

  test('funnel stage drill opens the matching lead list', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/pipeline');

    await page.getByTestId('funnel-stage-row').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();
  });

  test('At-Risk row carries a risk reason and suggested action and drills to Lead Detail', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/pipeline');

    const firstRow = page.getByTestId('at-risk-row').first();
    await expect(firstRow.getByTestId('at-risk-reason')).toBeVisible();
    await expect(firstRow.getByTestId('at-risk-action')).toBeVisible();
    await firstRow.click();
    await expect(page).toHaveURL(/\/leads\/\d+/);
  });

  test('Immediate Actions category lands on the pre-filtered Alerts center', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/pipeline');

    await page.getByTestId('immediate-action-row').first().click();
    await expect(page).toHaveURL(/\/alerts(\?tab=.+)?$/);
  });
});
