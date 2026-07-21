import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Parties workspace (spec FR-26..FR-28, PRD 12.9, T-025, verification.json V-025/V-026/V-027). The
 * Parties UI itself is now real (`src/ui/src/features/parties/{PartiesListPage,PartyDetailPage,
 * PartyFormPage,partiesApi}.tsx`, wired at `/parties`, `/parties/new`, `/parties/{id}`,
 * `/parties/{id}/edit`) — unlike the previously-`fixme`d version of this file (T-017, backend-only),
 * this is not blocked on a missing screen.
 *
 * What *is* still missing is fixture data:
 *   - V-025 ("parties list filters, searches, sorts, and paginates") needs "Seeded 200 parties"
 *     spanning multiple party types, with the type-filter and search assertions depending on a
 *     specific seeded party name. That data set is T-041's scope (FR-67) — `e2e_tests/seed/
 *     seed-shell-e2e.sh` (T-013's minimal shell seed) provisions no parties at all, and only one of
 *     the eleven tenant reference lists (`broker_type`) is populated for its tenants, so `party_type`/
 *     `party_segment`/`industry`/`region` are all empty too — there is no way to create a real party
 *     through the API yet either.
 *   - V-026 ("party detail shows its leads and pre-fills New Lead") needs "Seeded party with 3+
 *     leads" (same T-041 gap) *and* a working Lead Intake screen at `/leads/new` to assert the
 *     Party-section-locked behavior once `+ New Lead` is clicked — that screen is T-026's scope, not
 *     yet built (see the still-`fixme`d `lead-intake.spec.ts`). T-025 only proves (at the component
 *     level, see below) that the button navigates to `/leads/new?partyId={id}`; asserting
 *     `[data-testid='party-section-locked']` on the far side is necessarily T-026's job.
 *   - V-027 ("create party without region; duplicate name warns but allows save") needs an RM
 *     persona with `parties.create` plus a seeded party named "Botswana Mining Co." to duplicate
 *     against — also T-041.
 *
 * Kept as `test.fixme` (rather than silently omitted or faked against no data), following the exact
 * convention already established by `leads-list.spec.ts`/`lead-intake.spec.ts`/`lead-workflow.spec.ts`
 * /`quote-workflow.spec.ts` for this kind of forward seed-data dependency. Each scenario below is
 * fully authored against the real selectors/locators V-025/V-026/V-027 specify, so it is a real,
 * runnable test the moment its fixture data exists — not a placeholder. Un-fixme once T-041 (or an
 * equivalent parties-specific seed extension) provisions the fixture data these scenarios need.
 *
 * Every behavior these three verifications describe is independently proven today at the component
 * level (real DOM, real interaction, mocked API — no seed dependency) in:
 *   - src/ui/src/features/parties/__tests__/PartiesListPage.test.tsx: the column set incl. open/total
 *     lead counts and last activity (render_WhenPartiesLoad_ShouldShowColumnsIncludingLeadCountsAndLastActivity),
 *     the strategic-flag icon, party-type filter narrowing the `listParties` call
 *     (change_WhenPartyTypeFilterChanged_ShouldNarrowList), the '1-25 of N'-shaped pagination summary
 *     (render_WhenPaged_ShouldShowPaginationSummary), the disabled Export button
 *     (render_Always_ShouldShowDisabledExportButtonWithTooltip), and the empty state.
 *   - src/ui/src/features/parties/__tests__/PartiesFilterBar.test.tsx: the 250ms debounced type-ahead
 *     search (type_WhenSearchTyped_ShouldCallOnChangeAfterDebounce) and graceful disabled-control
 *     degradation when a reference-option source is unavailable.
 *   - src/ui/src/features/parties/__tests__/PartyDetailPage.test.tsx: the summary panel
 *     (render_WhenPartyLoads_ShouldShowSummaryAndLeadsCard), the Leads card reusing the shared T-027
 *     `LeadsTable` with the Party column omitted (render_WhenLeadsCardShown_ShouldOmitPartyColumn),
 *     `+ New Lead` navigating to `/leads/new?partyId={id}`
 *     (click_WhenNewLeadClicked_ShouldNavigateToLeadIntakeWithPartyIdQueryParam), and the
 *     permission-gated Edit button.
 *   - src/ui/src/features/parties/__tests__/PartyFormPage.test.tsx: required Name/Party type,
 *     contact email/phone format validation, region left empty succeeding
 *     (submit_WhenRegionLeftEmpty_ShouldSucceed, spec Q-9), and the non-blocking duplicate-name
 *     warning banner that lists matches with links without preventing the party from having already
 *     been saved (submit_WhenDuplicateNameWarningReturned_ShouldShowNonBlockingBannerAndStillNavigate).
 *   - Server-side (T-017, real Postgres, no mocks): QuoteIQ.Api.Tests.Parties.PartyEndpointsTests
 *     proves the region-optional, duplicate-warning, and no-DELETE-route contract this screen's
 *     requests rely on.
 */
test.describe.configure({ mode: 'serial' });

test.fixme(
  'parties list filters, searches, sorts, and paginates (V-025)',
  async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/parties');

    const table = page.getByTestId('parties-table');
    await expect(table).toBeVisible();
    await expect(table.getByText('Open leads')).toBeVisible();
    await expect(table.getByText('Total leads')).toBeVisible();
    await expect(table.getByText('Last activity')).toBeVisible();

    // Filter by party type Corporate; assert rows narrow.
    await page.getByTestId('party-type-filter').selectOption({ label: 'Corporate' });
    await expect(page.getByTestId('party-row').first()).toBeVisible();

    // Type a seeded party name in search; assert match.
    await page.getByTestId('parties-search-input').fill('Botswana Mining Co.');
    await expect(page.getByTestId('party-name-link').first()).toContainText('Botswana Mining Co.');

    // Assert pagination summary '1-25 of N'.
    await page.getByTestId('party-type-filter').selectOption({ label: 'All types' });
    await page.getByTestId('parties-search-input').fill('');
    await expect(page.getByTestId('pagination-summary')).toContainText(/1-25 of \d+/);
  },
);

test.fixme(
  'party detail shows its leads and pre-fills New Lead (V-026)',
  async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/parties');
    await page.getByTestId('parties-search-input').fill('Botswana Mining Co.');
    await page.getByTestId('party-name-link').first().click();

    await expect(page.getByTestId('party-summary')).toBeVisible();
    const leadsCard = page.getByTestId('party-leads-card');
    await expect(leadsCard).toBeVisible();
    await expect(leadsCard.getByTestId('lead-row')).toHaveCount(3, { timeout: 10000 });
    // The Leads card omits the Party column (T-027's `LeadsTable` `showParty: false` seam) — every
    // row is already scoped to this party.
    await expect(leadsCard.getByText('Party', { exact: true })).toHaveCount(0);

    await page.getByTestId('party-new-lead-button').click();
    await expect(page).toHaveURL(/\/leads\/new\?partyId=\d+/);
    await expect(page.getByTestId('party-section-locked')).toBeVisible();
  },
);

test.fixme(
  'create party without region; duplicate name warns but allows save (V-027)',
  async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');
    await page.goto('/parties/new');

    const form = page.getByTestId('party-form');
    await expect(form).toBeVisible();

    // Name matching a seeded party (trimmed-case variant) with region left empty.
    await page.getByLabel('Name').fill('botswana mining co.');
    await page.getByLabel('Party type').selectOption({ label: 'Corporate' });
    await expect(page.locator("select[name='regionId']")).toHaveValue('');

    await page.getByRole('button', { name: 'Save' }).click();

    // Non-blocking: the party is already saved by the time the warning banner shows.
    const banner = page.getByTestId('duplicate-warning-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId('duplicate-warning-link').first()).toContainText('Botswana Mining Co.');

    await page.getByTestId('dismiss-duplicate-warning').click();
    await expect(page).toHaveURL(/\/parties\/\d+$/);
    await expect(page.getByTestId('toast-success')).toBeVisible();
  },
);
