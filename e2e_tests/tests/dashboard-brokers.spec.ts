import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Broker Performance dashboard (spec FR-57, AC-056, V-056, PRD 15.1/15.3, T-034): six lead/quote-labeled
 * KPI cards, the Top Brokers ranking (quote-volume bars + conversion column), the quadrant Performance
 * Matrix (bubble = won premium, quadrant colors matching the shared palette legend), and the full-width
 * ranked broker table (tier chips, green-strong/red-weak conversion, top loss reason). Broker rows/points
 * drill to that broker's filtered lead lists (AC-056).
 *
 * The Brokers screen itself is now real: `src/ui/src/features/dashboards/BrokerPerformancePage.tsx` +
 * `src/ui/src/features/dashboards/brokers/*.tsx` (with the single-source
 * `src/ui/src/features/dashboards/quadrantPalette.ts`), wired at `/brokers` (`src/ui/src/app/router.tsx`),
 * fed by `GET /api/v1/dashboards/broker-performance`
 * (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`,
 * `src/api/.../Features/Dashboards/BrokerPerformance/*`), gated by `dashboards.view_broker_performance`.
 *
 * What is NOT available yet is the seeded fixture V-056's scenario needs ("Seeded 18 brokers with skewed
 * performance" plus leads/quotes across won/lost with lost reasons). That data set is T-041's scope
 * (FR-67); the only e2e seed that exists today, `e2e_tests/seed/seed-shell-e2e.sh`, provisions the
 * personas but no brokers/leads/quotes — so every widget would render its empty state and the drill
 * assertions below would have nothing to land on. Kept as `describe.fixme` (real, ready-to-run bodies
 * rather than faked assertions or a silent omission), following the exact convention already established
 * by `dashboard-pipeline.spec.ts`/`dashboard-overview.spec.ts` for a forward seed-data dependency.
 * Un-fixme once T-041 (or a Brokers-specific seed extension) provisions the fixture and the compose stack
 * (API on :5080 + Vite dev server) is running.
 *
 * Every behavior V-056 describes is already proven without a live stack:
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Dashboards.BrokerPerformanceTests
 *     computes the ranking order + conversion math, the top-loss-reason mode, the median-split quadrant
 *     matrix (bubble = won premium), consistent filter narrowing, and the ViewBrokerPerformance 403 gate;
 *     QuoteIQ.Domain.Tests.Metrics.QuadrantClassifierTests proves the PRD 15.3 classification.
 *   - Frontend (real DOM, mocked API): src/ui/src/features/dashboards/__tests__/BrokerPerformancePage.test.tsx
 *     renders the six lead/quote-labeled KPI cards + every widget, the top-brokers volume/conversion
 *     columns, the four-item quadrant legend from the shared palette, the table's tier chips +
 *     green-strong/red-weak conversion + top loss reason, and the broker-row/KPI drill-through;
 *     quadrantPalette.test.ts locks the single-source palette.
 */
// T-042 un-fixme: T-041 seed provides the broker-performance fixture; persona repointed to the seeded
// `sales.manager@quoteiq.local` (dashboards.view_broker_performance + brokers.view_performance).
test.describe('dashboard brokers (V-056)', () => {
  test('renders KPIs, ranking, quadrant matrix, and full table', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/brokers');

    // Six KPI cards, each labeled with its lead-vs-quote distinction (FR-54).
    const kpiRow = page.getByTestId('broker-kpi-row');
    await expect(kpiRow).toBeVisible();
    await expect(kpiRow.getByTestId('kpi-card')).toHaveCount(6);
    await expect(page.getByText(/Active Brokers \(Lead\)/)).toBeVisible();
    await expect(page.getByText(/Avg Turnaround \(Quote\)/)).toBeVisible();

    // Top Brokers ranking bars with a conversion column.
    await expect(page.getByTestId('top-brokers-ranking')).toBeVisible();
    await expect(page.getByTestId('top-broker-row').first()).toBeVisible();
    await expect(page.getByTestId('top-broker-conversion').first()).toBeVisible();

    // Quadrant scatter matrix with a legend colored from the shared palette.
    await expect(page.getByTestId('broker-matrix')).toBeVisible();
    await expect(page.getByTestId('quadrant-legend')).toBeVisible();
    await expect(page.getByTestId('quadrant-legend-item')).toHaveCount(4);

    // Full broker table: tier chips, color-coded conversion, top loss reason.
    await expect(page.getByTestId('broker-performance-table')).toBeVisible();
    await expect(page.getByTestId('broker-conversion').first()).toBeVisible();
    await expect(page.getByTestId('broker-top-loss-reason').first()).toBeVisible();
  });

  test('matrix bubbles are direct-labeled with broker names', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/brokers');

    // Every scatter bubble carries a broker-name label (identity is never color-alone).
    const matrix = page.getByTestId('broker-matrix');
    await expect(matrix).toBeVisible();
    const labels = matrix.locator('.recharts-label-list text');
    await expect(labels.first()).toBeVisible();
    expect(await labels.count()).toBe(await matrix.locator('.recharts-scatter-symbol').count());
  });

  test('matrix quadrant legend lists the four PRD 15.3 categories', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/brokers');

    const legend = page.getByTestId('quadrant-legend');
    await expect(legend.getByText('High Volume / High Conversion')).toBeVisible();
    await expect(legend.getByText('High Volume / Low Conversion')).toBeVisible();
    await expect(legend.getByText('Low Volume / High Conversion')).toBeVisible();
    await expect(legend.getByText('Low Volume / Low Conversion')).toBeVisible();
  });

  test('broker table row drills through to that broker\'s leads', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/brokers');

    await page.getByTestId('broker-table-row').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();
  });

  test('top broker ranking bar drills through to that broker\'s quoted leads', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/brokers');

    await page.getByTestId('top-broker-row').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();
  });
});
