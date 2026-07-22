import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Quote workflow: the Lead Detail Quotes card, New Quote modal, expanded quote detail panel, and the
 * six quote workflow dialogs (spec FR-38..FR-40, FR-45..FR-50, PRD 10.4/7.3, T-020/T-021, T-029,
 * verification.json V-037/V-044/V-045/V-046/V-047). Every one of these screens is now real
 * (`src/ui/src/features/quotes/{QuotesCard,NewQuoteModal,QuoteDetailPanel,AttachmentsSection,quotesApi}.tsx`,
 * `src/ui/src/features/quotes/dialogs/*.tsx`, composed into `src/ui/src/features/leads/LeadDetailPage.tsx`
 * in place of T-028's `QuotesCardShell`) — unlike the previously-`fixme`d version of this file (T-020/
 * T-021, backend-only), this is not blocked on a missing screen.
 *
 * What *is* still missing is fixture data: every scenario below needs an RM persona with
 * `quotes.view`/`quotes.create`/`quotes.update`, a lead already in Pricing (to exercise the Create ->
 * Send -> Revise -> Mark won lifecycle), a seeded Revised quote (for the expanded-panel legal-buttons
 * scenario), a seeded quote ref reachable via global search, and MinIO running for the attachment
 * round-trip. That data set is T-041's scope (FR-67, currently EVALUATING) — kept as `test.fixme`
 * (rather than silently omitted or faked against no data), following the exact convention already
 * established by `lead-workflow.spec.ts`/`lead-intake.spec.ts`/`leads-list.spec.ts` for this kind of
 * forward seed-data dependency. Each scenario below is fully authored against the real selectors/
 * locators this task's components render, so it is a real, runnable test the moment its fixture data
 * exists — not a placeholder. Un-fixme once T-041 (or an equivalent leads/quotes-specific seed
 * extension) provisions the fixture data these scenarios need.
 *
 * Every behavior these five verifications describe is independently proven today at the component
 * level (real DOM, real interaction, mocked API — no seed dependency):
 *   - V-037 (quote operation matrix, send/revise/won cascades): server-side by
 *     `QuoteIQ.Domain.Tests.Workflow.QuoteWorkflowMatrixTests` and `QuoteIQ.Api.Tests.Quotes.QuoteWorkflowTests`
 *     (T-020); UI dialog contracts by
 *     `src/ui/src/features/quotes/dialogs/__tests__/{SendQuoteDialog,ReviseQuoteDialog,MarkWonDialog}.test.tsx`
 *     and `src/ui/src/features/quotes/__tests__/QuotesCard.test.tsx` (row expansion fetches
 *     `GET /quotes/{id}`, Set current calls `POST /quotes/{id}/set-current` and reloads in place).
 *   - V-044 (no top-level Quotes nav; quote access always lands in lead context): structural — no
 *     `Quotes` entry exists in `src/ui/src/components/shell/navConfig.ts`, and `QuoteEndpoints`
 *     (T-020) exposes no standalone quote-list route; every quote lives inside `QuotesCard` on
 *     `/leads/{id}`. The global-search-lands-on-lead half additionally needs T-038 (global search),
 *     not yet built — doubly blocked until both T-038 and T-041 land.
 *   - V-045 (New Quote form rules: premium > 0, prepared >= lead received, ref/version read-only):
 *     `src/ui/src/features/quotes/__tests__/NewQuoteModal.test.tsx` (all five scenarios: read-only
 *     placeholders, premium-required inline error, prepared-before-received inline error, successful
 *     draft-save payload, product-line-change resets cover type) plus server-side
 *     `QuoteIQ.Api.Tests.Quotes.QuoteWorkflowTests.CreateQuote_WithPremiumZero_ShouldReturnValidationError`/
 *     `CreateQuote_WithPreparedDateBeforeLeadReceived_ShouldReturnValidationError`.
 *   - V-046 (expanded quote panel: fields/version history/status history/legal-buttons-only):
 *     `src/ui/src/features/quotes/__tests__/QuoteDetailPanel.test.tsx`'s
 *     `render_WhenAvailableOperationsGiven_ShouldOnlyRenderThoseButtons` (Revised quote: Send absent,
 *     Mark won/Mark lost/Withdraw/Assign present, matching this file's own V-046 script) plus
 *     `GetQuoteQueryHandler`'s `availableOperations` projection (T-020).
 *   - V-047 (attachment upload/download/remove, disallowed-type rejection):
 *     `src/ui/src/features/quotes/__tests__/AttachmentsSection.test.tsx` (inline rejection for a
 *     disallowed extension without calling the upload API, successful upload/list/remove flow,
 *     closed-quote correction gating) plus server-side
 *     `QuoteIQ.Api.Tests.Attachments.AttachmentEndpointsTests` (real Postgres + Keycloak + MinIO
 *     Testcontainer round-trip, magic-number/size-cap rejection, closed-quote gating, T-021).
 *
 * Server-side (T-020/T-021, real Postgres + Keycloak, no mocks): `QuoteIQ.Domain.Tests.Workflow.QuoteWorkflowMatrixTests`,
 * `QuoteIQ.Api.Tests.Quotes.QuoteWorkflowTests`, and `QuoteIQ.Api.Tests.Attachments.AttachmentEndpointsTests`
 * prove the operation contract, cascades, and attachment validation this UI's `availableOperations`-
 * driven rendering and upload flow rely on.
 */
test.describe.configure({ mode: 'serial' });

test.fixme(
  'quote lifecycle: draft, send, revise, mark won with cascades (V-037)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads');
    // A seeded lead already in Pricing.
    await page.getByTestId('lead-row').filter({ hasText: 'Pricing' }).first().click();

    // Create a draft quote on the Pricing lead.
    await page.getByTestId('new-quote-button').click();
    const newQuoteModal = page.getByTestId('new-quote-modal');
    await expect(newQuoteModal).toBeVisible();
    // Ref and version are system-assigned and deliberately not shown pre-save.
    await expect(newQuoteModal.getByTestId('new-quote-ref-placeholder')).toHaveCount(0);
    await expect(newQuoteModal.getByTestId('new-quote-version-placeholder')).toHaveCount(0);
    await newQuoteModal.locator("input[name='quotedPremium']").fill('500,000');
    await newQuoteModal.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();
    const draftRow = page.getByTestId('quote-row').filter({ hasText: 'Draft' }).first();
    await expect(draftRow).toBeVisible();

    // Send it: valid-until + next follow-up required; assert lead chip becomes Quote Sent.
    await expect(page.getByTestId('primary-workflow-action')).toHaveText('Send quote');
    await page.getByTestId('primary-workflow-action').click();
    const sendDialog = page.getByTestId('send-quote-dialog');
    await expect(sendDialog).toBeVisible();
    await sendDialog.locator("input[name='validUntil']").fill('2027-01-31');
    await sendDialog.locator("input[name='nextFollowUpDate']").fill('2026-08-15');
    await sendDialog.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('status-chip')).toContainText('Quote Sent');

    // Revise with a new premium; assert version 2 marked current, version 1 in history.
    await draftRow.click();
    await page.getByTestId('quote-action-revise').click();
    const reviseDialog = page.getByTestId('revise-quote-dialog');
    await reviseDialog.locator("input[name='newQuotedPremium']").fill('450,000');
    await reviseDialog.locator("textarea[name='revisionNote']").fill('Adjusted after underwriting review.');
    await reviseDialog.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('version-history').getByTestId('version-current-badge')).toHaveCount(1);
    await expect(page.getByTestId('version-history')).toContainText('v2');
    await expect(page.getByTestId('version-history')).toContainText('v1');

    // Create a second draft quote, then Mark won on the revised quote (bound premium defaulted).
    await page.getByTestId('new-quote-button').click();
    await page.getByTestId('new-quote-modal').locator("input[name='quotedPremium']").fill('300,000');
    await page.getByTestId('new-quote-modal').getByTestId('dialog-primary-button').click();

    await page.getByTestId('quote-action-mark-won').click();
    const markWonDialog = page.getByTestId('mark-won-dialog');
    await expect(markWonDialog.locator("input[name='boundPremium']")).toHaveValue('450,000');
    await markWonDialog.getByTestId('dialog-primary-button').click();

    // Assert lead Closed Won and the second (draft) quote Withdrawn.
    await expect(page.getByTestId('status-chip').first()).toContainText('Closed Won');
    await expect(page.getByTestId('quote-row').filter({ hasText: 'Withdrawn' })).toBeVisible();
  },
);

test.fixme(
  'no top-level Quotes nav; quote access always lands in lead context (V-044)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/overview');

    await expect(page.getByTestId('sidebar-nav')).not.toContainText('Quotes');

    await page.getByTestId('global-search-input').fill('Q-2026');
    await page.getByTestId('global-search-input').press('Enter');
    await page.getByText(/Q-2026-\d+/).first().click();

    await expect(page).toHaveURL(/\/leads\/\d+/);
    await expect(page.getByTestId('quote-row-highlighted')).toBeVisible();
  },
);

test.fixme(
  'new quote modal validates and saves as draft (V-045)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Assigned' }).first().click();

    await page.getByTestId('new-quote-button').click();
    const modal = page.getByTestId('new-quote-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('new-quote-ref-placeholder')).toHaveCount(0);
    await expect(modal.locator("select[name='productLineId']")).not.toHaveValue('');
    await expect(modal.locator("select[name='coverTypeId']")).toBeEnabled();

    // Submit without premium -> inline error.
    await modal.getByTestId('dialog-primary-button').click();
    await expect(modal.getByTestId('field-error-premium')).toBeVisible();

    // Prepared date before the lead's received date -> inline error.
    await modal.locator("input[name='quotedPremium']").fill('750,000');
    await modal.locator("input[name='preparedDate']").fill('2020-01-01');
    await modal.getByTestId('dialog-primary-button').click();
    await expect(modal.getByTestId('field-error-prepared-date')).toBeVisible();

    // Fix dates; Save as draft; assert Draft row appears with toast.
    const today = new Date().toISOString().slice(0, 10);
    await modal.locator("input[name='preparedDate']").fill(today);
    await modal.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();
    await expect(page.getByTestId('quotes-table').getByTestId('quote-row').filter({ hasText: 'Draft' })).toBeVisible();
  },
);

test.fixme(
  'expanded quote panel shows fields, histories, attachments, and legal buttons only (V-046)',
  async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');

    // A seeded lead carrying a Revised quote.
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Negotiation' }).first().click();
    await page.getByTestId('quote-row').filter({ hasText: 'Revised' }).first().click();

    const panel = page.getByTestId('quote-detail-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('quote-field-grid')).toBeVisible();
    await expect(panel.getByTestId('version-history')).toBeVisible();
    await expect(panel.getByTestId('quote-status-history')).toBeVisible();
    await expect(panel.getByTestId('attachments-section')).toBeVisible();

    // Legal buttons for Revised only (V-046's own script): Send-not-present, Mark won/Mark lost/Withdraw/Assign present.
    const actions = panel.getByTestId('quote-actions');
    await expect(actions.getByTestId('quote-action-send')).toHaveCount(0);
    await expect(actions.getByTestId('quote-action-revise')).toHaveCount(0);
    await expect(actions.getByTestId('quote-action-mark-won')).toBeVisible();
    await expect(actions.getByTestId('quote-action-mark-lost')).toBeVisible();
    await expect(actions.getByTestId('quote-action-withdraw')).toBeVisible();
    await expect(actions.getByTestId('quote-action-assign')).toBeVisible();
  },
);

test.fixme(
  'upload, download, and remove quote attachments (V-047)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Assigned' }).first().click();
    await page.getByTestId('new-quote-button').click();
    await page.getByTestId('new-quote-modal').locator("input[name='quotedPremium']").fill('500,000');
    await page.getByTestId('new-quote-modal').getByTestId('dialog-primary-button').click();
    await page.getByTestId('quote-row').filter({ hasText: 'Draft' }).first().click();

    const attachments = page.getByTestId('attachments-section');
    await expect(attachments).toBeVisible();

    // Upload sample.pdf; assert it lists with size.
    await attachments.locator("input[type='file']").setInputFiles('e2e_tests/fixtures/sample.pdf');
    const row = attachments.getByTestId('attachment-row').filter({ hasText: 'sample.pdf' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('attachment-file-size')).toBeVisible();

    // Download and assert the browser download event fires.
    const [download] = await Promise.all([page.waitForEvent('download'), row.getByTestId('attachment-download-button').click()]);
    expect(download.suggestedFilename()).toContain('sample.pdf');

    // Attempt sample.exe upload; assert inline rejection (no request made).
    await attachments.locator("input[type='file']").setInputFiles('e2e_tests/fixtures/sample.exe');
    await expect(attachments.getByTestId('attachment-upload-error')).toBeVisible();

    // Remove the PDF; assert the list empties.
    await row.getByTestId('attachment-remove-button').click();
    await expect(attachments.getByTestId('attachments-empty')).toBeVisible();
  },
);
