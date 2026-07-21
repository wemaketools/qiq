import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Lead intake and edit (spec FR-29..FR-32, PRD 9.3/12.6, T-018/T-026, verification.json
 * V-028/V-029/V-030/V-031). The Lead Intake/Edit UI is now real
 * (`src/ui/src/features/leads/{LeadFormPage,leadsApi}.tsx` +
 * `src/ui/src/features/leads/form/{PartySection,RequestSection,CoverageSection,
 * DuplicateLeadDialog}.tsx`, wired at `/leads/new` and `/leads/{id}/edit`) — unlike the
 * previously-`fixme`d version of this file (T-018, backend-only), this is not blocked on a missing
 * screen.
 *
 * What *is* still missing is fixture data: every scenario below needs an RM persona with
 * `leads.create`/`leads.update`, a seeded party to pick/duplicate against, and (for V-030) an
 * existing open lead for that party + product line within the tenant's duplicate window. That data
 * set is T-041's scope (FR-67) — `e2e_tests/seed/seed-shell-e2e.sh` (T-013's minimal shell seed)
 * provisions no parties, leads, or populated `product_line`/`cover_type`/`request_channel`/`region`
 * reference lists, so there is no way to drive a real lead through the API yet either.
 *
 * Kept as `test.fixme` (rather than silently omitted or faked against no data), following the exact
 * convention already established by `parties.spec.ts`/`leads-list.spec.ts`/`lead-workflow.spec.ts`/
 * `quote-workflow.spec.ts` for this kind of forward seed-data dependency. Each scenario below is
 * fully authored against the real selectors/locators this task's components render, so it is a real,
 * runnable test the moment its fixture data exists — not a placeholder. Un-fixme once T-041 (or an
 * equivalent leads-specific seed extension) provisions the fixture data these scenarios need.
 *
 * Every behavior these four verifications describe is independently proven today at the component
 * level (real DOM, real interaction, mocked API — no seed dependency) in
 * `src/ui/src/features/leads/__tests__/LeadFormPage.test.tsx`:
 *   - V-028: selecting an existing party collapses to the read-only summary card
 *     (selectParty_WhenSearchResultClicked_ShouldCollapseToReadOnlySummary), a broker-flagged
 *     channel reveals the required broker picker
 *     (changeChannel_WhenBrokerChannelSelected_ShouldShowBrokerSelectAsRequired), changing product
 *     line resets cover type (changeProductLine_WhenChanged_ShouldResetCoverType), and selecting
 *     policy term "Other" reveals its required companion text field
 *     (selectPolicyTermOther_ShouldRevealRequiredCompanionInput).
 *   - V-029: `?partyId=` locks the Party section
 *     (render_WhenPartyIdQueryParamPresent_ShouldRenderLockedPartySection) and no status/outcome/
 *     follow-up input exists anywhere on `LeadFormPage`'s rendered form (only Party/Request
 *     Details/Coverage Need fields, asserted implicitly by every test in that file never finding
 *     such a control).
 *   - V-030: the confirm-gated `requiresConfirmation` envelope shows the duplicate dialog, and
 *     "Create anyway" resubmits with `createAnyway: true` and proceeds
 *     (submit_WhenServerReturnsDuplicateConfirmation_ShouldShowDialogAndCreateAnywayResubmits).
 *   - V-031: a valid submission calls `createLead` and lands on `/leads/{id}`
 *     (submit_WhenFormValid_ShouldCallCreateLeadAndNavigateToLeadDetail), and Edit mode pre-fills,
 *     hides Owner, and labels its submit button "Save changes"
 *     (render_WhenEditingExistingLead_ShouldPrefillFieldsHideOwnerAndLabelSaveChanges,
 *     submit_WhenEditingExistingLead_ShouldCallUpdateLeadNotCreateLead).
 *
 * Server-side (T-018, real Postgres, no mocks): `QuoteIQ.Api.Tests.Leads.CreateLeadTests` proves the
 * field contract (broker-channel/cover-type/policy-term-Other/premium validation, derived priority),
 * the system-generated `lead_ref`/always-New-status contract, and the duplicate-lead
 * warning-then-`createAnyway` envelope these UI scenarios exercise end to end.
 */
test.describe.configure({ mode: 'serial' });

test.fixme(
  'intake form behaves per PRD 9.3 field spec (V-028)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads/new');

    const form = page.getByTestId('lead-form');
    await expect(form).toBeVisible();

    // Select existing party; assert read-only summary collapse.
    await page.getByTestId('party-select').fill('Botswana Mining Co.');
    await page.getByTestId('party-search-result').first().click();
    await expect(page.getByTestId('party-summary-collapsed')).toContainText('Botswana Mining Co.');

    // Choose broker channel; assert Broker becomes required.
    await page.locator("select[name='requestChannelId']").selectOption({ label: 'Broker email' });
    await expect(page.getByTestId('broker-select')).toBeVisible();

    // Choose a non-broker channel; assert Broker becomes optional (hidden).
    await page.locator("select[name='requestChannelId']").selectOption({ label: 'Direct email' });
    await expect(page.getByTestId('broker-select')).toHaveCount(0);

    // Change product line; assert cover type resets and repopulates.
    await page.locator("select[name='productLineId']").selectOption({ label: 'Motor' });
    await page.locator("select[name='coverTypeId']").selectOption({ label: 'Comprehensive' });
    await page.locator("select[name='productLineId']").selectOption({ label: 'Property' });
    await expect(page.locator("select[name='coverTypeId']")).toHaveValue('');

    // Enter estimated premium above the tenant threshold; assert Priority derives High but stays editable.
    await page.locator("input[name='estimatedPremium']").fill('5000000');
    await expect(page.getByTestId('priority-derived-hint')).toBeVisible();
    await expect(page.locator("select[name='priority']")).toHaveValue('high');
    await page.locator("select[name='priority']").selectOption('normal');
    await expect(page.locator("select[name='priority']")).toHaveValue('normal');

    // Select policy term Other; assert required companion text appears.
    await page.locator("select[name='policyTerm']").selectOption({ label: 'Other' });
    await expect(page.locator("input[name='policyTermOther']")).toBeVisible();

    // Currency inputs show the tenant symbol prefix and thousands separators.
    const premiumInput = page.getByTestId('currency-input').filter({ has: page.locator("input[name='estimatedPremium']") });
    await expect(premiumInput).toContainText('BWP');
    await expect(page.locator("input[name='estimatedPremium']")).toHaveValue('5,000,000');
  },
);

test.fixme(
  'intake exposes no lifecycle fields and generates the reference on save (V-029)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads/new');

    // No status, follow-up, outcome, or quote inputs exist anywhere on the form.
    const form = page.getByTestId('lead-form');
    await expect(form.locator("select[name='status']")).toHaveCount(0);
    await expect(form.locator("input[name='nextFollowUpDate']")).toHaveCount(0);
    await expect(form.locator("input[name='boundPremium']")).toHaveCount(0);
    await expect(form.getByText('Outcome')).toHaveCount(0);

    // Complete and save a minimal valid lead.
    await page.getByTestId('party-select').fill('Botswana Mining Co.');
    await page.getByTestId('party-search-result').first().click();
    await page.locator("select[name='requestChannelId']").selectOption({ label: 'Direct email' });
    await page.locator("select[name='regionId']").selectOption({ label: 'Gaborone' });
    await page.locator("select[name='ownerUserId']").selectOption({ label: 'Sam RM' });
    await page.locator("select[name='productLineId']").selectOption({ label: 'Motor' });
    await page.locator("select[name='coverTypeId']").selectOption({ label: 'Comprehensive' });
    await page.getByRole('button', { name: 'Create lead' }).click();

    // On Lead Detail, ref matches the L-YYYY-#### pattern and status chip is New.
    await expect(page).toHaveURL(/\/leads\/\d+$/);
    await expect(page.getByTestId('toast-success')).toContainText(/Lead L-\d{4}-\d+ created/);
    await expect(page.getByTestId('lead-ref')).toHaveText(/L-\d{4}-\d{4,}/);
    await expect(page.getByTestId('status-chip')).toContainText('New');
  },
);

test.fixme(
  'duplicate dialog lists matches and Create anyway proceeds (V-030)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');

    // A first Motor lead for the seeded party already exists (fixture: T-041). Start a second one
    // for the same party + product line.
    await page.goto('/leads/new');
    await page.getByTestId('party-select').fill('Botswana Mining Co.');
    await page.getByTestId('party-search-result').first().click();
    await page.locator("select[name='requestChannelId']").selectOption({ label: 'Direct email' });
    await page.locator("select[name='regionId']").selectOption({ label: 'Gaborone' });
    await page.locator("select[name='ownerUserId']").selectOption({ label: 'Sam RM' });
    await page.locator("select[name='productLineId']").selectOption({ label: 'Motor' });
    await page.locator("select[name='coverTypeId']").selectOption({ label: 'Comprehensive' });
    await page.getByRole('button', { name: 'Create lead' }).click();

    const dialog = page.getByTestId('duplicate-lead-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('duplicate-lead-link').first()).toBeVisible();

    // Review existing navigates to the first lead.
    await dialog.getByTestId('duplicate-lead-link').first().click();
    await expect(page).toHaveURL(/\/leads\/\d+$/);

    // Repeat submission and click Create anyway; assert a second lead is created.
    await page.goto('/leads/new');
    await page.getByTestId('party-select').fill('Botswana Mining Co.');
    await page.getByTestId('party-search-result').first().click();
    await page.locator("select[name='requestChannelId']").selectOption({ label: 'Direct email' });
    await page.locator("select[name='regionId']").selectOption({ label: 'Gaborone' });
    await page.locator("select[name='ownerUserId']").selectOption({ label: 'Sam RM' });
    await page.locator("select[name='productLineId']").selectOption({ label: 'Motor' });
    await page.locator("select[name='coverTypeId']").selectOption({ label: 'Comprehensive' });
    await page.getByRole('button', { name: 'Create lead' }).click();
    await expect(page.getByTestId('duplicate-lead-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Create anyway' }).click();
    await expect(page).toHaveURL(/\/leads\/\d+$/);
    await expect(page.getByTestId('toast-success')).toBeVisible();
  },
);

test.fixme(
  'success lands on detail with toast; edit reuses spec without lifecycle data (V-031)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads/new');

    // Create a lead; assert redirect to Lead Detail and the "Lead {ref} created" toast.
    await page.getByTestId('party-select').fill('Botswana Mining Co.');
    await page.getByTestId('party-search-result').first().click();
    await page.locator("select[name='requestChannelId']").selectOption({ label: 'Direct email' });
    await page.locator("select[name='regionId']").selectOption({ label: 'Gaborone' });
    await page.locator("select[name='ownerUserId']").selectOption({ label: 'Sam RM' });
    await page.locator("select[name='productLineId']").selectOption({ label: 'Motor' });
    await page.locator("select[name='coverTypeId']").selectOption({ label: 'Comprehensive' });
    await page.locator("input[name='estimatedPremium']").fill('50000');
    await page.getByRole('button', { name: 'Create lead' }).click();

    await expect(page).toHaveURL(/\/leads\/\d+$/);
    await expect(page.getByTestId('toast-success')).toContainText(/Lead L-\d{4}-\d+ created/);

    // Edit lead; assert the same three sections pre-populated, no lifecycle fields, and the
    // "Save changes" label.
    await page.getByRole('button', { name: 'Edit lead' }).click();
    const form = page.getByTestId('lead-form');
    await expect(form).toBeVisible();
    await expect(page.getByTestId('party-section-locked')).toBeVisible();
    await expect(form.locator("select[name='status']")).toHaveCount(0);
    await expect(page.getByTestId('owner-select')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();

    // Change estimated premium; save.
    await page.locator("input[name='estimatedPremium']").fill('75000');
    await page.getByRole('button', { name: 'Save changes' }).click();

    // Summary updates and an audit-friendly toast shows.
    await expect(page.getByTestId('toast-success')).toContainText(/Lead L-\d{4}-\d+ updated/);
    await expect(page.getByTestId('summary-panel')).toContainText('75,000');
  },
);
