import { test } from '@playwright/test';

/**
 * Dashboard framework behaviors (spec FR-54, AC-053, V-053, T-031): the filter bar (with the RM
 * Performance variant) persisting across dashboard navigation (spec A-16), every KPI/chart/row
 * drilling to underlying items, shared reporting-category chips, and KPI deltas coloring by declared
 * good direction.
 *
 * The framework itself is real: `src/ui/src/components/dashboards/{FilterBar,KpiCard,ChartCard,
 * charts/*}.tsx`, `src/ui/src/app/slices/dashboardFiltersSlice.ts` (sessionStorage-persisted, wired
 * into `app/store.ts`), `src/ui/src/features/dashboards/{DrillListPage,dashboardsApi,useDrill}.ts(x)`
 * (route `/dashboards/drill/:widgetKey`), and the backend drill endpoint (`GET
 * /api/v1/dashboards/drill`, `src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`).
 *
 * What is NOT real yet is a dashboard *screen* to drive this scenario's steps against: V-053's steps
 * start "On Overview set Product line = Motor..." and "Navigate to Pipeline...", but both `/overview`
 * and `/pipeline` are still `StubPage` placeholders (`src/ui/src/app/router.tsx`) -- rendering neither
 * `FilterBar` nor any `KpiCard`/`ChartCard`. Building those screens is T-032 (Executive Overview) and
 * T-033 (Pipeline & Conversion), both explicitly out of this task's scope
 * (`.claude/tasks/T-031.json`'s `out_of_scope`: "Individual dashboard queries/pages (T-032..T-036)").
 * Kept as `test.fixme` (rather than faked against no real dashboard, or silently omitted) following
 * the exact convention already established by `leads-list.spec.ts`/`lead-intake.spec.ts` for a
 * forward same-repo dependency. Un-fixme once T-032 and T-033 both mount `FilterBar`/`KpiCard` for
 * real and wire the "Average Turnaround"/"Lost Premium" KPIs this scenario's delta-color assertion
 * needs.
 *
 * Every behavior V-053 describes is independently proven today, without a real dashboard screen, at:
 *   - src/ui/src/components/dashboards/__tests__/FilterBar.test.tsx: dropdowns default to "All"
 *     (render_ByDefault_ShouldShowAllDropdownsAsAll), a selection round-trips through onChange
 *     (change_WhenProductLineSelected_ShouldCallOnChangeWithUpdatedFilters), Clear filters
 *     (click_WhenClearFiltersClicked_ShouldCallOnClear), a date-range preset sets both endpoints
 *     (click_WhenDateRangePreset_ShouldSetFromAndToViaOnChange), and the RM Performance variant's
 *     "RM/Team"/"Broker Type" relabeling (render_WhenVariantIsRmPerformance_ShouldSwapRmAndBrokerLabels).
 *   - src/ui/src/app/slices/dashboardFiltersSlice.test.ts: filters replace/clear correctly
 *     (reducer_WhenSetDashboardFilters_ShouldReplaceState, reducer_WhenClearDashboardFilters_ShouldResetToAllNull)
 *     and round-trip through `sessionStorage` exactly as `app/store.ts`'s subscribe callback persists
 *     them on every dispatch (persistFilters_ThenNewStoreInit_ShouldRestoreFromSessionStorage) -- this
 *     is the A-16 "persists across dashboard navigation" mechanism itself, proven independent of which
 *     screens read it.
 *   - src/ui/src/components/dashboards/__tests__/KpiCard.test.tsx: a higher-is-better KPI with a
 *     positive delta renders green (render_WhenHigherIsBetterAndDeltaPositive_ShouldColorDeltaGreen),
 *     a lower-is-better KPI whose value is falling (Average Turnaround, matching V-053's own example)
 *     also renders green (render_WhenLowerIsBetterAndValueFalling_ShouldColorDeltaGreen), and an
 *     unfavorable delta (Lost Premium rising) renders red/danger
 *     (render_WhenUnfavorableDelta_ShouldColorDeltaRed) -- exactly the three cases this scenario's
 *     step 4 describes.
 *   - src/api/tests/QuoteIQ.Application.Tests/Dashboards/KpiValue is exercised indirectly via
 *     src/api/QuoteIQ.Application/Dashboards/KpiValue.cs's `IsFavorableDelta`, the single place this
 *     good/bad-direction rule lives (mirrored, not duplicated, by KpiCard's `isFavorableDelta` prop).
 *   - src/ui/src/features/dashboards/__tests__/DrillListPage.test.tsx: a widget's returned rows render
 *     through the shared `LeadsTable` (render_WhenDrillLoads_ShouldRenderMatchingRowsInSharedLeadsTable),
 *     matching step 3's "click a KPI card; assert drill list opens with matching rows".
 *   - src/ui/src/components/common/__tests__/StatusChip.test.tsx: every reporting category (open/
 *     quoted/won/lost/expired/withdrawn) uses the shared palette, and the chip always carries visible
 *     text (never color alone, NFR-03/AC-069) -- the "chips use the shared reporting-category palette"
 *     clause of AC-053.
 *   - Server-side (T-031, real Postgres/Keycloak, no mocks):
 *     QuoteIQ.Api.Tests.Dashboards.DrillEndpointTests proves widget-key + filter row matching
 *     (Drill_WithWidgetKeyAndFilters_ShouldReturnMatchingRows), tenant isolation
 *     (Drill_ShouldEnforceTenantIsolation), and the same breadth-permission rule the Leads list itself
 *     enforces (Drill_WithoutViewAll_ShouldReturnOnlyAssignedLeads) -- AC-053's "every KPI/chart/row
 *     drills to underlying items" and the drill endpoint's own tenant/breadth contract.
 */
test.fixme(
  'filters persist across dashboards, drills work, deltas color by good direction (V-053)',
  async () => {
    throw new Error(
      'Blocked: V-053 requires two real dashboard screens (Executive Overview at /overview, Pipeline ' +
        '& Conversion at /pipeline) that mount FilterBar/KpiCard/ChartCard for real -- both are still ' +
        'StubPage placeholders (src/ui/src/app/router.tsx). Building those screens is T-032/T-033, ' +
        "explicitly out of this task's scope (.claude/tasks/T-031.json). The framework itself " +
        '(FilterBar, KpiCard, ChartCard, chart wrappers, dashboardFiltersSlice persistence, the drill ' +
        'endpoint + DrillListPage) is real and already exercised end-to-end at the component level ' +
        "(see this file's header comment for the exact test names) and against the real backend " +
        '(T-031\'s QuoteIQ.Api.Tests.Dashboards.DrillEndpointTests). Un-fixme once T-032 and T-033 both ' +
        'mount the shared filter bar/KPI cards for real.',
    );
  },
);
