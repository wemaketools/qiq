import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Global top-bar search (spec FR-53, A-14, AC-052, V-052, T-038). The search is a real, wired screen
 * element: `src/ui/src/components/shell/GlobalSearch.tsx` (replacing the T-013 placeholder in
 * `TopBar.tsx`), fed by `src/ui/src/features/search/searchApi.ts` -> the T-038 backend
 * (`GET /api/v1/search?q=`, `src/api/QuoteIQ.Api/Endpoints/SearchEndpoints.cs`,
 * `src/api/QuoteIQ.Application/Features/Search/*`), gated by `leads.view`. It groups tenant-scoped
 * hits by entity (Clients/Leads/Quotes/Brokers), routes a quote hit into its lead with the T-037
 * `highlightQuote` param, and supports arrow-key navigation + Enter.
 *
 * What is NOT available yet is the seeded fixture these scenarios need: parties, leads, and quotes
 * with searchable names/refs in the active tenant. The only e2e seed that exists today
 * (`e2e_tests/seed/seed-shell-e2e.sh`) provisions personas/tenants but no leads/quotes/parties, so
 * every group would be empty and these assertions would have nothing to land on -- that data set is
 * T-041's scope (FR-67). Kept as `test.describe.fixme` (real, ready-to-run bodies rather than faked
 * assertions or a silent omission), following the exact convention already established by
 * `parties.spec.ts`/`alerts-center.spec.ts`/`lead-workflow.spec.ts` for a forward seed-data
 * dependency. Un-fixme once T-041 (or a search-specific seed extension) provisions searchable
 * parties/leads/quotes and the compose stack (API on :5080 + Vite dev server) is running.
 *
 * Every behavior V-052 describes is already proven without a live stack:
 *   - Backend (real Postgres/Keycloak, no mocks): QuoteIQ.Api.Tests.Search.GlobalSearchTests covers
 *     grouped-with-per-type-limit results, quote hits carrying their lead id/ref, strict tenant
 *     isolation, the leads/quotes breadth rule (assigned-only caller), and the 2-char minimum.
 *   - Frontend (real DOM, mocked API): src/ui/src/components/shell/__tests__/GlobalSearch.test.tsx
 *     proves the debounce + 2-char minimum, the grouped dropdown with per-entity headers, party and
 *     quote selection routing (party -> /parties/{id}, quote -> /leads/{leadId}?highlightQuote={id}),
 *     arrow-key navigation + Enter, Esc-to-close, and the empty state.
 */
// T-042 un-fixme: T-041 seed provides leads/quotes/parties/brokers to search; persona repointed to
// the seeded `sales.manager@quoteiq.local` (leads.view_all breadth so results are non-empty).
test.describe('global search (V-052)', () => {
  test('typing a party name shows grouped results; quote opens its lead highlighted; party opens detail; keyboard nav works', async ({
    page,
  }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/overview');

    const input = page.getByTestId('global-search-input');
    await expect(input).toBeVisible();

    // Typing a seeded party name shows the grouped dropdown with per-entity headers.
    await input.fill('Botswana Mining');
    const results = page.getByTestId('search-results');
    await expect(results).toBeVisible();
    await expect(page.getByTestId('search-group-header').filter({ hasText: 'Clients' })).toBeVisible();
    await expect(page.getByTestId('search-result-item').first()).toBeVisible();

    // Arrow-key to the first (party) result and press Enter -> party detail opens.
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/parties\/\d+$/);

    // Search a quote ref; selecting it opens the quote's lead with the quote highlighted.
    await input.fill('Q-2026');
    await expect(results).toBeVisible();
    await page.getByTestId('search-result-item').filter({ hasText: 'Q-2026' }).first().click();
    await expect(page).toHaveURL(/\/leads\/\d+\?highlightQuote=\d+/);
    // The migrated QuotesCard marks the highlighted quote as `data-testid="quote-row"` +
    // `data-highlighted="true"` (src/ui/src/features/quotes/QuotesCard.tsx), matching the same
    // locator alerts-center.spec.ts uses — not a distinct `quote-row-highlighted` test id.
    await expect(page.locator('[data-testid="quote-row"][data-highlighted="true"]')).toBeVisible();
  });
});
