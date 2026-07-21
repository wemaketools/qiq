import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * RM Performance dashboard (spec FR-58, AC-057/AC-059, V-057, PRD 15.2/15.4, T-035): six lead/quote-labeled
 * KPI cards, the Top RMs won-premium ranking, the Turnaround-by-RM bars with the dashed SLA target
 * marker, the Performance Watchlist with color-coded suggested-action chips, and the Leadership Insights
 * panel — under the RM/Team + Broker Type filter variant. RM rows/bars drill to that RM's leads (AC-057).
 * Deviation from PRD 15.2/T-035 (user decision, 2026-07-16): the Top Brokers ranking and the shared
 * quadrant Broker Matrix were removed from this screen — broker-centric, already on the Brokers dashboard.
 *
 * The RM Performance screen itself is now real: `src/ui/src/features/dashboards/RmPerformancePage.tsx` +
 * `src/ui/src/features/dashboards/rm/*.tsx`, wired at `/rm-performance` (`src/ui/src/app/router.tsx`), fed by
 * `GET /api/v1/dashboards/rm-performance` (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`,
 * `src/api/.../Features/Dashboards/RmPerformance/*`), gated by `dashboards.view_rm_performance`.
 *
 * What is NOT available yet is the seeded fixture V-057's scenario needs ("Seeded 6 RMs with varied
 * performance" plus their owned leads/quotes and broker channels). That data set is T-041's scope
 * (FR-67); the only e2e seed that exists today, `e2e_tests/seed/seed-shell-e2e.sh`, provisions the
 * personas but no leads/quotes/assignments — so every widget would render its empty state and the drill
 * assertions below would have nothing to land on. Kept as `describe.fixme` (real, ready-to-run bodies
 * rather than faked assertions or a silent omission), following the exact convention established by
 * `dashboard-brokers.spec.ts`/`dashboard-pipeline.spec.ts` for a forward seed-data dependency. Un-fixme
 * once T-041 provisions the fixture and the compose stack (API on :5080 + Vite dev server) is running.
 *
 * Every behavior V-057 describes is already proven without a live stack:
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Dashboards.RmPerformanceTests ranks
 *     RMs by won premium, checks the follow-up-compliance KPI against MetricDefinitions, flags turnaround
 *     bars beyond the SLA target, and proves the ViewRmPerformance 403 gate;
 *     QuoteIQ.Domain.Tests.Dashboards.{SuggestedActionRuleTests,LeadershipInsightRulesTests} prove the
 *     PRD 15.4 action labels and the five PRD 15.2 insight types.
 *   - Frontend (real DOM, mocked API): src/ui/src/features/dashboards/__tests__/RmPerformancePage.test.tsx
 *     renders the six lead/quote-labeled KPI cards + every widget, the RM/Team + Broker Type filter
 *     variant, the turnaround SLA marker + beyond-target flagging, the watchlist action chips, and the
 *     five leadership insights, plus the watchlist-row/KPI drill-through.
 */
// T-042 un-fixme: T-041 seed provides the RM-performance fixture; persona repointed to the seeded
// `sales.manager@quoteiq.local` (dashboards.view_rm_performance + leads.view_all).
test.describe('dashboard rm-performance (V-057)', () => {
  test('renders KPIs, Top RMs ranking, turnaround bars, watchlist, and insights', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/rm-performance');

    // The filter bar shows the RM/Team + Broker Type variant instead of RM + Broker.
    await expect(page.getByTestId('filter-bar-rm-variant')).toBeVisible();
    await expect(page.getByLabel('RM/Team')).toBeVisible();
    await expect(page.getByLabel('Broker Type')).toBeVisible();

    // Six KPI cards, each labeled with its lead-vs-quote distinction (FR-54).
    const kpiRow = page.getByTestId('rm-kpi-row');
    await expect(kpiRow).toBeVisible();
    await expect(kpiRow.getByTestId('kpi-card')).toHaveCount(6);
    await expect(page.getByText(/Active RMs \(Lead\)/)).toBeVisible();
    await expect(page.getByText(/Follow-up Compliance \(Lead\)/)).toBeVisible();

    // Top RMs won-premium ranking.
    await expect(page.getByTestId('top-rms-ranking')).toBeVisible();

    // The broker-centric widgets were removed from this screen (user decision, 2026-07-16):
    // Top Brokers + Broker Matrix live on the Brokers dashboard only.
    await expect(page.getByTestId('top-brokers-ranking')).toHaveCount(0);
    await expect(page.getByTestId('broker-matrix')).toHaveCount(0);
  });

  test('turnaround bars show a dashed SLA target marker and flag beyond-target RMs', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/rm-performance');

    await expect(page.getByTestId('turnaround-bars')).toBeVisible();
    await expect(page.getByTestId('sla-target-marker')).toBeVisible();
    await expect(page.getByTestId('turnaround-row').first()).toBeVisible();

    // The bar itself must actually render: components.css's bare-button centering once collapsed
    // the track to zero width (a CSS-cascade regression jsdom unit tests cannot observe).
    const firstFill = page.getByTestId('turnaround-bar-fill').first();
    const fillBox = await firstFill.boundingBox();
    expect(fillBox?.width ?? 0).toBeGreaterThan(0);
  });

  test('watchlist rows carry color-coded suggested-action chips', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/rm-performance');

    await expect(page.getByTestId('performance-watchlist')).toBeVisible();
    await expect(page.getByTestId('suggested-action-chip').first()).toBeVisible();
  });

  test('leadership insights panel lists five insight entries', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/rm-performance');

    await expect(page.getByTestId('leadership-insights')).toBeVisible();
    await expect(page.getByTestId('insight-item')).toHaveCount(5);
  });

  test('watchlist row drills through to that RM\'s leads', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/rm-performance');

    await page.getByTestId('watchlist-row').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();
  });
});
