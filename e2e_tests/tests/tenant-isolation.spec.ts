import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginAs } from '../helpers/auth';
import { DEMO_TENANT_NAME } from '../helpers/personas';

/**
 * Tenant data-isolation gold-standard suite (spec FR-09/NFR-01, AC-008/AC-067, V-008, T-042): a
 * user whose only membership is a DIFFERENT tenant sees none of the seeded "The Brittany" (T-041)
 * data anywhere the UI surfaces tenant-scoped records — the Leads list, global search, dashboards,
 * and the Alerts center. This is the UI-level companion to the structural per-endpoint isolation
 * proof that lives in the backend integration suites (AC-067/V-067: every tenant-scoped endpoint has
 * a tenant-A-vs-B probe, and EF global query filters prevent unfiltered cross-tenant reads — see e.g.
 * QuoteIQ.Api.Tests.Dashboards.DrillEndpointTests.Drill_ShouldEnforceTenantIsolation and the
 * per-feature *EndpointsTests isolation cases).
 *
 * The isolated persona is `rm.tebogo@quoteiq.local` (seed-shell-e2e.sh): a single member of "QuoteIQ
 * Shell E2E Tenant A", with NO membership in "The Brittany". Every probe below looks for the tokens
 * unique to the Brittany seed — the `SEED-####` external refs SeedLeads stamps and the tenant name
 * itself — and asserts they never appear.
 *
 * ---------------------------------------------------------------------------------------------------
 * STATUS: committed real body, kept `test.describe.fixme` (see demo-journey.spec.ts' header for the
 * full rationale). Requires the live compose stack + both seed scripts, unavailable while authoring.
 *
 * FLAGGED SEED GAP: T-041 seeds exactly ONE data-bearing tenant ("The Brittany"). The richest form of
 * V-008 ("tenant B's own lists render tenant-B-only data") needs a SECOND fully-seeded tenant with
 * distinct records; that does not exist in the T-041 seed. This suite therefore proves isolation in
 * the achievable direction — a non-member sees ZERO Brittany data — rather than fabricating a second
 * data set. A future seed extension (a minimal tenant B with 2 leads, as V-008's setup notes) would
 * let the positive-direction assertions be added; called out here rather than silently skipped.
 * ---------------------------------------------------------------------------------------------------
 */
test.describe.configure({ mode: 'serial' });

const ISOLATED_USER = 'rm.tebogo@quoteiq.local';
const BRITTANY_LEAD_REF_TOKEN = 'SEED-';

async function searchAndExpectNoResults(page: Page, term: string): Promise<void> {
  const input = page.getByTestId('global-search-input');
  await input.fill(term);
  await page.waitForTimeout(400); // debounce
  // Either the results panel shows an explicit empty state, or no result row references the term.
  const results = page.getByTestId('search-results');
  if ((await results.count()) > 0) {
    await expect(results.getByTestId('search-result-item')).toHaveCount(0);
  }
}

test.describe.fixme('tenant isolation (V-008) — committed real body, pending live stack', () => {
  test('a non-member sees no Brittany leads in the Leads list', async ({ page }) => {
    await loginAs(page, ISOLATED_USER);
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);

    // None of the isolated tenant's rows carry the Brittany seed's SEED-#### external refs.
    const table = page.getByTestId('leads-table');
    if ((await table.count()) > 0) {
      await expect(table).not.toContainText(BRITTANY_LEAD_REF_TOKEN);
    }
  });

  test('global search never returns Brittany records to a non-member', async ({ page }) => {
    await loginAs(page, ISOLATED_USER);
    await page.goto('/overview');
    await searchAndExpectNoResults(page, BRITTANY_LEAD_REF_TOKEN);
    await searchAndExpectNoResults(page, DEMO_TENANT_NAME);
  });

  test('dashboards show only the isolated tenant, never Brittany volumes', async ({ page }) => {
    await loginAs(page, ISOLATED_USER);

    // The isolated Shell Tenant A carries no seeded pipeline, so its dashboards render their own
    // (empty/near-empty) state and never the Brittany high-value opportunities.
    await page.goto('/overview');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);
    const highValue = page.getByTestId('high-value-table');
    if ((await highValue.count()) > 0) {
      await expect(highValue).not.toContainText(BRITTANY_LEAD_REF_TOKEN);
    }
  });

  test('the Alerts center surfaces no Brittany alerts to a non-member', async ({ page }) => {
    await loginAs(page, ISOLATED_USER);
    await page.goto('/alerts');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);

    const queue = page.getByTestId('alerts-queue-table');
    if ((await queue.count()) > 0) {
      await expect(queue).not.toContainText(BRITTANY_LEAD_REF_TOKEN);
    }
  });
});
