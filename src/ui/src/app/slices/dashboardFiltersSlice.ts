import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';

/**
 * Shared dashboard filter bar state (spec §10.1, PRD 12.2/12.3, AC-053): Date range, Product line,
 * Broker, RM, Region (RM Performance swaps RM -> RM/Team and Broker -> Broker Type; that variant's
 * extra fields land with T-035). Persisted to `sessionStorage` (spec A-16: filters persist across
 * dashboard navigation for the tab's lifetime, but not across browser restarts).
 */
export interface DashboardFiltersState {
  dateFrom: string | null;
  dateTo: string | null;
  productLineId: number | null;
  brokerId: number | null;
  rmUserId: number | null;
  regionId: number | null;
  /** RM Performance filter-bar variant (T-035): the "RM/Team" select (team grouping deferred — an RM id in the MVP). */
  teamOrRmId: number | null;
  /** RM Performance filter-bar variant (T-035): the "Broker Type" select replacing the plain Broker dropdown. */
  brokerTypeId: number | null;
}

export const DASHBOARD_FILTERS_STORAGE_KEY = 'qiq.dashboardFilters';

const defaultFilters: DashboardFiltersState = {
  dateFrom: null,
  dateTo: null,
  productLineId: null,
  brokerId: null,
  rmUserId: null,
  regionId: null,
  teamOrRmId: null,
  brokerTypeId: null,
};

/** The all-clear dashboard filter (every field null) — used by each dashboard's Clear-filters handler to persist the reset. */
export const EMPTY_DASHBOARD_FILTERS: DashboardFiltersState = defaultFilters;

function loadPersistedFilters(): DashboardFiltersState {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return defaultFilters;
  }
  try {
    const raw = window.sessionStorage.getItem(DASHBOARD_FILTERS_STORAGE_KEY);
    if (!raw) {
      return defaultFilters;
    }
    return { ...defaultFilters, ...(JSON.parse(raw) as Partial<DashboardFiltersState>) };
  } catch {
    return defaultFilters;
  }
}

export function persistFilters(filters: DashboardFiltersState): void {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }
  window.sessionStorage.setItem(DASHBOARD_FILTERS_STORAGE_KEY, JSON.stringify(filters));
}

const dashboardFiltersSlice = createSlice({
  name: 'dashboardFilters',
  initialState: loadPersistedFilters(),
  reducers: {
    setDashboardFilters(_state, action: PayloadAction<DashboardFiltersState>) {
      return action.payload;
    },
    clearDashboardFilters() {
      return defaultFilters;
    },
  },
});

export const { setDashboardFilters, clearDashboardFilters } = dashboardFiltersSlice.actions;
export const dashboardFiltersReducer = dashboardFiltersSlice.reducer;

export const selectDashboardFilters = (state: RootState): DashboardFiltersState => state.dashboardFilters;
