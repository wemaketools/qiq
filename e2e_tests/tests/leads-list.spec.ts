import { test } from '@playwright/test';

/**
 * Leads working queue, including column sorting (spec FR-43, PRD 12.4, T-027, AC-042,
 * verification.json V-042). The Leads
 * list UI itself is now real (`src/ui/src/features/leads/{LeadsListPage,LeadsFilterBar,LeadsTable,
 * BulkReassignDialog}.tsx`, wired at `/leads`) — unlike the still-`fixme`d `lead-intake.spec.ts`/
 * `lead-workflow.spec.ts`, this is not blocked on a missing screen.
 *
 * What *is* still missing is the fixture data V-042's scenario needs: "Seeded 300 leads; two open
 * leads for reassign" plus a "Sales Head" (`leads.view_all` + `leads.reassign`) persona and rows
 * old enough to fall in the amber/red aging buckets. That data set is T-041's scope (FR-67) and does
 * not exist yet — `e2e_tests/seed/seed-shell-e2e.sh` (T-013's minimal shell seed) provisions no
 * leads at all, and none of the eleven tenant reference lists (lead_status, product_line, region,
 * request_channel, broker_type is the one exception) are populated for its tenants, so there is no
 * way to create a real lead through the API yet either. Kept as `fixme` (rather than silently
 * omitted or faked against no data), following the exact convention already established by
 * `lead-intake.spec.ts`/`lead-workflow.spec.ts`/`quote-workflow.spec.ts` for this kind of forward
 * seed-data dependency — un-fixme once T-041 lands (or once a leads-specific seed extension
 * provisions the "Sales Head" persona + aging/reassign fixture leads V-042 describes).
 *
 * Every behavior V-042 describes is independently proven today at the component level (real DOM,
 * real interaction, mocked API — no seed dependency) in:
 *   - src/ui/src/features/leads/__tests__/LeadsListPage.test.tsx: column set incl. flag chips and
 *     status chip (render_WhenLeadsLoad_ShouldShowTableWithFlagsAndAgeColumns), amber/red age
 *     coloring (render_WhenAgeAtOrAboveAmberThreshold_ShouldColorAgeAmber /
 *     ...RedThreshold_ShouldColorAgeRed), overdue next-follow-up chip
 *     (render_WhenNextFollowUpInPast_ShouldShowOverdueChip), the forced My-leads toggle for a
 *     caller without `leads.view_all` (render_WhenUserLacksViewAll_ShouldForceMyLeadsToggleOnAndDisabled,
 *     which also asserts the resulting `listLeads` call carries `myLeads: true`), the `leads.reassign`-
 *     gated checkbox column and bulk action (render_WhenUserLacksReassignPermission_ShouldHideCheckboxColumn,
 *     render_WhenUserHasReassignPermission_ShouldShowCheckboxesAndBulkReassignButtonOnSelection),
 *     the Q-12 required-note rule (click_WhenBulkReassignSubmittedWithoutNote_ShouldShowInlineError,
 *     click_WhenBulkReassignSubmittedWithNoteAndOwner_ShouldCallApiAndClearSelection), the '1-25 of
 *     N'-shaped page summary (render_WhenPaged_ShouldShowRangeSummary), and the empty-state Clear
 *     filters/+New Lead actions (render_WhenNoLeads_ShouldShowEmptyStateWithClearFiltersAndNewLeadActions),
 *     and column sorting — every column except Flags now has a backend sort key (`LeadStore.ListAsync`'s
 *     switch; Flags is derived per row, so there is nothing to order by) — including the asc/desc
 *     toggle and the URL-synced `sort`/`dir` state
 *     (render_Always_ShouldDefaultSortStateToLowestAgeFirst,
 *     click_WhenLeadIdHeaderClicked_ShouldSortAscendingByLeadRefAndSyncUrl,
 *     click_WhenLeadIdHeaderClickedTwice_ShouldToggleToDescending,
 *     render_WhenSortParamsInUrl_ShouldInitializeSortStateFromUrl). The wire mapping, including Age's
 *     inverted direction, is covered by leads/__tests__/leadsSort.test.ts, and the ordering each key
 *     produces by QuoteIQ.Api.Tests' ListLeadsSortTests/ListPartiesSortTests against real Postgres.
 *   - src/ui/src/features/leads/__tests__/LeadsFilterBar.test.tsx: the 250ms debounced search
 *     (type_WhenSearchTyped_ShouldCallOnChangeAfterDebounce) and graceful degradation of a filter
 *     control whose reference-data source is unavailable to the caller
 *     (render_WhenOptionSetIsNull_ShouldDisableThatControl — see this task's final report for why
 *     several of the existing reference-data/brokers/business-assignments read endpoints are gated
 *     by admin-style permissions ordinary Leads users may not hold).
 *   - src/ui/src/features/leads/__tests__/BulkReassignDialog.test.tsx: note-required validation and
 *     the trimmed note/owner payload shape sent on confirm.
 *   - Server-side (T-018, real Postgres, no mocks): QuoteIQ.Api.Tests.Leads.ListLeadsTests
 *     (ListLeads_WithoutViewAll_ShouldReturnOnlyAssignedLeads, ListLeads_MyLeadsToggle_ShouldFilterToAssignments)
 *     and QuoteIQ.Api.Tests.Leads.BulkReassignTests (BulkReassign_WithoutNote_ShouldReturnValidationError,
 *     BulkReassign_WithNote_ShouldSwapOwnerAndAuditPerLead) prove the breadth/reassign contract this
 *     screen's requests rely on.
 */
test.fixme(
  'leads list columns, filters, search, sorting, pagination, and bulk reassign (V-042)',
  async () => {
    throw new Error(
      'Blocked: V-042 requires seeded fixture data (300 leads, amber/red-aged rows, a two-lead ' +
        'reassign pair, and a "Sales Head" leads.view_all/leads.reassign persona) that no seed script ' +
        'in this repo provisions yet — that data set is T-041 (FR-67), not a dependency of T-027. The ' +
        'Leads list UI itself is real and already exercised end-to-end at the component level (see ' +
        'this file\'s header comment for the exact test names) and against the real backend (T-018\'s ' +
        'QuoteIQ.Api.Tests.Leads.ListLeadsTests/BulkReassignTests). Un-fixme once T-041 (or an ' +
        'equivalent leads-specific seed extension) provisions the fixture data this scenario needs.',
    );
  },
);
