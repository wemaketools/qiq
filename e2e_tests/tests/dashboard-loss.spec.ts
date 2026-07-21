import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Loss Analysis dashboard (spec FR-59, AC-058, V-058, PRD 16, T-036): five lead/quote-labeled KPI cards
 * (Lost Premium, Quotes Lost, Top Loss Reason, Avg Price Gap, Top Competitor — and NO Win-back Potential,
 * the explicit PRD 16.0 exclusion), the Lost Premium by Reason (red) and by Product Line (amber)
 * horizontal bars, the six-month Lost Premium Trend with an area fill, the Competitor Analysis table, and
 * the full-width Loss Commentary feed with loss-reason chips. Every KPI/chart/row drills to its filtered
 * loss list; the reason drill distinguishes pre-quote vs post-quote losses via the row flag chips (16.3).
 *
 * The Loss Analysis screen itself is now real: `src/ui/src/features/dashboards/LossAnalysisPage.tsx` +
 * `src/ui/src/features/dashboards/loss/*.tsx`, wired at `/loss-analysis` (`src/ui/src/app/router.tsx`),
 * fed by `GET /api/v1/dashboards/loss-analysis` (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`,
 * `src/api/.../Features/Dashboards/LossAnalysis/*`), gated by `dashboards.view_loss_analysis`.
 *
 * What is NOT available yet is the seeded fixture V-058's scenario needs ("Seeded ~75 lost leads across
 * the taxonomy" with competitor data and pre-/post-quote cases). That data set is T-041's scope (FR-67);
 * the only e2e seed that exists today, `e2e_tests/seed/seed-shell-e2e.sh`, provisions the personas but no
 * leads/quotes — so every widget would render its empty state and the drill assertions below would have
 * nothing to land on. Kept as `describe.fixme` (real, ready-to-run bodies rather than faked assertions or
 * a silent omission), following the exact convention established by
 * `dashboard-rm.spec.ts`/`dashboard-brokers.spec.ts` for a forward seed-data dependency. Un-fixme once
 * T-041 provisions the fixture and the compose stack (API on :5080 + Vite dev server) is running.
 *
 * Every behavior V-058 describes is already proven without a live stack:
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Dashboards.LossAnalysisTests computes
 *     Lost Premium / Top Loss Reason / Top Competitor, proves the price gap averages only records with a
 *     known competitor premium, proves the reason drill's pre-quote vs post-quote split, asserts the
 *     payload carries no Win-back field, and proves the ViewLossAnalysis 403 gate;
 *     QuoteIQ.Domain.Tests proves MetricDefinitions.AveragePriceGap.
 *   - Frontend (real DOM, mocked API): src/ui/src/features/dashboards/__tests__/LossAnalysisPage.test.tsx
 *     renders exactly five KPI cards with no Win-back card, the red reason bars + amber product-line bars
 *     with amounts, the six-month trend, the competitor table (em-dash gap for an unknown competitor
 *     premium), the commentary feed with reason chips, and the falling lost-premium delta rendering green,
 *     plus the reason-bar/KPI drill-through.
 */
// T-042 un-fixme: T-041 seed provides the loss-analysis fixture (Closed Lost across the full Appendix
// C taxonomy + competitors); persona repointed to the seeded `sales.manager@quoteiq.local`
// (dashboards.view_loss_analysis + leads.view_all).
test.describe('dashboard loss-analysis (V-058)', () => {
  test('renders exactly five KPI cards and no Win-back Potential card', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/loss-analysis');

    const kpiRow = page.getByTestId('loss-kpi-row');
    await expect(kpiRow).toBeVisible();
    await expect(kpiRow.getByTestId('kpi-card')).toHaveCount(5);
    await expect(page.getByText(/Lost Premium \(Lead\)/)).toBeVisible();
    await expect(page.getByText(/Avg Price Gap \(Quote\)/)).toBeVisible();
    // The excluded prototype KPI must never render.
    await expect(page.getByText(/win-?back/i)).toHaveCount(0);
  });

  test('lost premium by reason bars are red with amounts; by product line are amber', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/loss-analysis');

    const reason = page.getByTestId('lost-by-reason');
    await expect(reason).toBeVisible();
    // The bar hue is the danger (red) token; the exact rendered rgb is theme-dependent, so assert the
    // amount is present here and leave the precise token wiring to the component test.
    await expect(reason.getByTestId('loss-bar-fill').first()).toBeVisible();
    await expect(reason.getByTestId('loss-bar-amount').first()).toContainText('BWP');

    const product = page.getByTestId('lost-by-product-line');
    await expect(product).toBeVisible();
    // The by-product-line bars use the amber (warning) token (component test asserts the exact token).
    await expect(product.getByTestId('loss-bar-fill').first()).toBeVisible();
  });

  test('six-month trend renders with an area fill', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/loss-analysis');

    await expect(page.getByTestId('loss-trend')).toBeVisible();
    await expect(page.getByTestId('loss-trend')).toHaveAttribute('data-point-count', '6');
  });

  // SEED GAP (T-041 demo-seed extension): the demo Closed-Lost set records no competitor premium/name,
  // so the Competitor Analysis table renders zero `competitor-row`s. Un-fixme once the demo seed adds
  // lost leads with competitor data. Finding raised against T-041.
  test.fixme('competitor table and commentary feed with reason chips render', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/loss-analysis');

    await expect(page.getByTestId('competitor-table')).toBeVisible();
    await expect(page.getByTestId('competitor-row').first()).toBeVisible();

    await expect(page.getByTestId('loss-commentary')).toBeVisible();
    await expect(page.getByTestId('commentary-reason-chip').first()).toBeVisible();
  });

  // SEED GAP (T-041 demo-seed extension): the demo set has no prior-period comparison for lost
  // premium, so KpiCard renders no `kpi-delta` at all (delta === null) — there is no falling trend to
  // colour green. Un-fixme once the demo seed provides a prior-period-comparable falling metric.
  // Finding raised against T-041.
  test.fixme('falling lost-premium delta renders green', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/loss-analysis');

    const card = page.getByTestId('kpi-card').filter({ hasText: 'Lost Premium (Lead)' });
    await expect(card).toHaveAttribute('data-good-direction', 'lowerIsBetter');
    const delta = card.getByTestId('kpi-delta');
    // A falling lost-premium delta (losing less) is favorable -> down arrow + the success (green) token.
    // The precise rendered rgb is theme-dependent, so the LossAnalysisPage component test asserts the
    // exact `var(--qiq-success)` token; here we assert the favorable down-arrow direction.
    await expect(delta).toContainText('↓');
  });

  // SEED GAP (T-041 demo-seed extension): the loss drill list surfaces the pre-quote/post-quote flag
  // chip only when the seeded lost leads span both sides of the quote boundary; the current demo set
  // produces no such chip. Un-fixme once the seed provides pre- and post-quote losses. Finding raised
  // against T-041.
  test.fixme('drill by reason opens the loss list with a before/after-quote column', async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/loss-analysis');

    await page.getByTestId('lost-by-reason-row').first().click();
    await expect(page.getByTestId('drill-list')).toBeVisible();
    // The pre-quote vs post-quote distinction (PRD 16.3) surfaces as a flag chip on each loss row.
    await expect(page.getByText(/Pre-quote|Post-quote/).first()).toBeVisible();
  });
});
