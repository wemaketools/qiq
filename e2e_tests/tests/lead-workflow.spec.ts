import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';
import { selectAssignee } from '../helpers/selects';

/**
 * Lead Detail and the eight lead workflow dialogs (spec FR-34..FR-37, FR-40, FR-41, FR-44, FR-51,
 * PRD 10.4/12.5/12.8, T-019/T-022/T-028, verification.json V-034/V-035/V-040/V-043/V-050). The Lead
 * Detail screen and every workflow dialog (Assign/Reassign, Send to underwriting, Request pricing
 * approval, Approve/Reject pricing, Log follow-up, Mark lost, Withdraw, Reopen) are now real
 * (`src/ui/src/features/leads/{LeadDetailPage,leadsApi}.tsx`,
 * `src/ui/src/features/leads/detail/{SummaryPanel,TimelinePanel,OutcomePanel,MoreActionsMenu,
 * leadOperations}.tsx`, `src/ui/src/features/leads/dialogs/*.tsx`,
 * `src/ui/src/components/common/{WorkflowDialog,SearchSelect}.tsx`, wired at `/leads/{id}`) — unlike
 * the previously-`fixme`d version of this file (T-019, backend-only), this is not blocked on a
 * missing screen.
 *
 * What *is* still missing is fixture data: every scenario below needs an RM persona with
 * `leads.view`/`leads.update`, a fresh lead in New status (to exercise the Assign→...→Mark lost
 * lifecycle), a seeded Quote Sent lead with follow-ups and a quote (for the composition scenario), a
 * seeded Closed Won lead, and a seeded Closed Lost lead. That data set is T-041's scope (FR-67) —
 * `e2e_tests/seed/seed-shell-e2e.sh` (T-013's minimal shell seed) provisions no leads at all. Kept as
 * `test.fixme` (rather than silently omitted or faked against no data), following the exact
 * convention already established by `lead-intake.spec.ts`/`leads-list.spec.ts`/`quote-workflow.spec.ts`
 * for this kind of forward seed-data dependency. Each scenario below is fully authored against the
 * real selectors/locators this task's components render, so it is a real, runnable test the moment
 * its fixture data exists — not a placeholder. Un-fixme once T-041 (or an equivalent leads-specific
 * seed extension) provisions the fixture data these scenarios need.
 *
 * Every behavior these five verifications describe is independently proven today at the component
 * level (real DOM, real interaction, mocked API — no seed dependency):
 *   - V-034 (multi-role Assign dialog): `src/ui/src/features/leads/dialogs/__tests__/AssignDialog.test.tsx`
 *     (one select per configured role, accountable owner required, pre-fills the owner role on
 *     reassign, clears a non-owner role), plus
 *     `src/ui/src/features/leads/__tests__/LeadDetailPage.test.tsx`'s
 *     `click_WhenAssignConfirmed_ShouldUpdateStatusChipInPlaceAndShowToast` (status chip updates
 *     in-place after Assign, no reload).
 *   - V-035 (lead operation matrix conformance / contextual primary action / illegal ops hidden):
 *     `src/ui/src/features/leads/detail/__tests__/leadOperations.test.ts` (PrimaryActionResolver:
 *     New→Assign, Quote Sent→Log follow-up, else first legal op) and
 *     `.../__tests__/MoreActionsMenu.test.tsx` (menu renders only the operations it is given — AC-016).
 *   - V-040 (shared workflow dialog pattern: title format, consequence, danger styling, inline
 *     validation, in-place update): `src/ui/src/features/leads/dialogs/__tests__/MarkLostDialog.test.tsx`
 *     (title `"Mark lost — {ref} · {party}"`, danger button, "Select a lost reason." inline error) and
 *     `LeadDetailPage.test.tsx`'s `click_WhenMarkLostConfirmedWithoutReason_ShouldKeepDialogOpenWithInlineError`.
 *   - V-043 (Lead Detail composition: header/summary/timeline/outcome panel):
 *     `src/ui/src/features/leads/detail/__tests__/{SummaryPanel,TimelinePanel,OutcomePanel}.test.tsx`
 *     and `LeadDetailPage.test.tsx`'s outcome-panel-only-when-closed assertions.
 *   - V-050 (follow-up logging: required+future next date past Quote Sent, no status change):
 *     `src/ui/src/features/leads/dialogs/__tests__/LogFollowUpDialog.test.tsx`.
 *
 * Server-side (T-019, real Postgres + Keycloak, no mocks): `QuoteIQ.Api.Tests.Leads.Workflow.LeadWorkflowTests`
 * and `QuoteIQ.Domain.Tests.Workflow.LeadWorkflowMatrixTests` prove the operation contract and 409
 * legal-operations hint this UI's `availableOperations`-driven rendering relies on.
 */
test.describe.configure({ mode: 'serial' });

test.fixme(
  'assign dialog manages all configured roles in one operation (V-034)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'New' }).first().click();

    await expect(page.getByTestId('primary-workflow-action')).toHaveText('Assign');
    await page.getByTestId('primary-workflow-action').click();

    const dialog = page.getByTestId('assign-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('role-select-accountable')).toContainText('*');

    // Set owner + underwriter; submit.
    await selectAssignee(dialog, 'role-select-accountable', 'Sam');
    await selectAssignee(dialog, 'role-select-underwriter', 'Uma');
    await dialog.getByTestId('dialog-primary-button').click();

    await expect(page.getByTestId('status-chip')).toContainText('Assigned');
    await expect(page.getByTestId('assignee-avatars')).toContainText('SR');

    // Reopen dialog; clear underwriter; submit; assert underwriter removed and status unchanged.
    await page.getByTestId('primary-workflow-action').click();
    await expect(page.getByTestId('assign-dialog')).toBeVisible();
    await page.getByTestId('role-select-underwriter-select').selectOption('');
    await page.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('status-chip')).toContainText('Assigned');
  },
);

test.fixme(
  'walk the standard lifecycle through dialogs (V-035)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'New' }).first().click();

    // Assign.
    await expect(page.getByTestId('primary-workflow-action')).toHaveText('Assign');
    await page.getByTestId('primary-workflow-action').click();
    await selectAssignee(page, 'role-select-accountable', 'Sam');
    await page.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('status-chip')).toContainText('Assigned');

    // Send to underwriting.
    await page.getByTestId('more-actions-trigger').click();
    await page.getByTestId('more-action-send-to-underwriting').click();
    await selectAssignee(page, 'underwriting-owner-select', 'Uma');
    await page.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('status-chip')).toContainText('Underwriting');

    // Start pricing.
    await page.getByTestId('more-actions-trigger').click();
    await page.getByTestId('more-action-start-pricing').click();
    await page.getByTestId('dialog-primary-button').click();
    await expect(page.getByTestId('status-chip')).toContainText('Pricing');

    // Mark lost with a reason.
    await page.getByTestId('more-actions-trigger').click();
    await page.getByTestId('more-action-mark-lost').click();
    await page.getByTestId('lost-reason-select').selectOption({ label: 'Pricing too high' });
    await page.getByTestId('dialog-danger-button').click();
    await expect(page.getByTestId('status-chip')).toContainText('Closed Lost');
    await expect(page.getByTestId('outcome-panel')).toBeVisible();
    await expect(page.getByTestId('primary-workflow-action')).toHaveCount(0);
  },
);

test.fixme(
  'dialogs follow the shared pattern with danger styling and in-place updates (V-040)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads');
    // An already-open, already-assigned lead (Mark lost is legal from any open status).
    await page.getByTestId('lead-row').filter({ hasText: 'Assigned' }).first().click();
    const leadUrl = page.url();

    await page.getByTestId('more-actions-trigger').click();
    await page.getByTestId('more-action-mark-lost').click();

    const dialog = page.getByTestId('mark-lost-dialog');
    await expect(dialog.getByTestId('workflow-dialog-title')).toContainText(/^Mark lost — .+ · .+$/);
    await expect(dialog.getByTestId('dialog-danger-button')).toBeVisible();

    // Submit without reason; assert inline error and dialog stays open.
    await dialog.getByTestId('dialog-danger-button').click();
    await expect(dialog.getByTestId('field-error-lost-reason')).toContainText('Select a lost reason.');
    await expect(dialog).toBeVisible();

    // Select reason and submit; assert toast, chip updates in place (no navigation), timeline entry added.
    await dialog.getByTestId('lost-reason-select').selectOption({ label: 'Competitor won' });
    await dialog.getByTestId('dialog-danger-button').click();
    await expect(page.getByTestId('toast-success')).toBeVisible();
    await expect(page.getByTestId('status-chip')).toContainText('Closed Lost');
    await expect(page).toHaveURL(leadUrl);
    await expect(page.getByTestId('timeline-entries').getByTestId('timeline-entry').first()).toContainText('Mark Lost');
  },
);

test.fixme(
  'lead detail renders header, summary, timeline, and outcome panel correctly (V-043)',
  async ({ page }) => {
    await loginAs(page, 'sales.manager@quoteiq.local');

    // A seeded Quote Sent lead with follow-ups and a quote.
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Quote Sent' }).first().click();

    const header = page.getByTestId('lead-header');
    await expect(header.getByTestId('lead-ref')).toContainText(/L-\d{4}-\d+/);
    await expect(header).toContainText('Botswana Mining Co.');
    await expect(header.getByTestId('status-chip')).toContainText('Quote Sent');
    await expect(header.getByTestId('assignee-avatars')).toBeVisible();
    await expect(header.getByTestId('lead-age')).toBeVisible();
    await expect(header.getByTestId('primary-workflow-action')).toHaveText('Log follow-up');

    await expect(page.getByTestId('summary-panel')).toBeVisible();
    await expect(page.getByTestId('summary-request-group')).toBeVisible();
    await expect(page.getByTestId('summary-coverage-group')).toBeVisible();
    await expect(page.getByTestId('party-card-link')).toBeVisible();

    const timeline = page.getByTestId('timeline-panel');
    await expect(timeline.getByTestId('timeline-entries')).toBeVisible();
    await expect(page.getByTestId('next-follow-up-banner')).toBeVisible();
    await expect(page.getByTestId('overdue-chip')).toBeVisible();

    // Closed Won lead: bound premium and closer.
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Closed Won' }).first().click();
    await expect(page.getByTestId('outcome-panel')).toBeVisible();
    await expect(page.getByTestId('outcome-bound-premium')).toBeVisible();
    await expect(page.getByTestId('outcome-closed-by')).toBeVisible();

    // Closed Lost lead: reason/competitor/comments.
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Closed Lost' }).first().click();
    await expect(page.getByTestId('outcome-lost-reason')).toBeVisible();
    await expect(page.getByTestId('outcome-competitor')).toBeVisible();
    await expect(page.getByTestId('outcome-loss-comments')).toBeVisible();
  },
);

test.fixme(
  'log follow-up updates dates, count, and timeline without status change (V-050)',
  async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await page.goto('/leads');
    await page.getByTestId('lead-row').filter({ hasText: 'Quote Sent' }).first().click();

    const statusBefore = await page.getByTestId('status-chip').textContent();

    await page.getByTestId('log-follow-up-button').click();
    const dialog = page.getByTestId('log-follow-up-dialog');
    await expect(dialog).toBeVisible();

    // Submit without next date -> inline error.
    await dialog.locator("textarea[name='outcomeNote']").fill('Called client, awaiting decision');
    await dialog.getByTestId('dialog-primary-button').click();
    await expect(dialog.getByTestId('field-error-next-follow-up')).toBeVisible();

    // Set outcome note + tomorrow as next date; submit.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);
    await dialog.locator("input[name='nextFollowUpDate']").fill(tomorrowIso);
    await dialog.getByTestId('dialog-primary-button').click();

    await expect(page.getByTestId('toast-success')).toBeVisible();
    await expect(page.getByTestId('next-follow-up-banner')).toContainText(tomorrowIso);
    await expect(page.getByTestId('timeline-entries').getByTestId('timeline-entry').first()).toContainText('Follow-up logged');
    await expect(page.getByTestId('status-chip')).toHaveText(statusBefore ?? '');
  },
);
