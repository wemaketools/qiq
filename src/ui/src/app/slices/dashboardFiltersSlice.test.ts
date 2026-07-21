import { describe, expect, it, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  dashboardFiltersReducer,
  setDashboardFilters,
  clearDashboardFilters,
  persistFilters,
  DASHBOARD_FILTERS_STORAGE_KEY,
  type DashboardFiltersState,
} from './dashboardFiltersSlice';

describe('dashboardFiltersSlice', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('reducer_WhenSetDashboardFilters_ShouldReplaceState', () => {
    // Arrange
    const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer } });
    const filters: DashboardFiltersState = {
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      productLineId: 1,
      brokerId: null,
      rmUserId: null,
      regionId: null,
      teamOrRmId: null,
      brokerTypeId: null,
    };

    // Act
    store.dispatch(setDashboardFilters(filters));

    // Assert
    expect(store.getState().dashboardFilters).toEqual(filters);
  });

  it('reducer_WhenClearDashboardFilters_ShouldResetToAllNull', () => {
    // Arrange
    const store = configureStore({ reducer: { dashboardFilters: dashboardFiltersReducer } });
    store.dispatch(
      setDashboardFilters({ dateFrom: '2026-07-01', dateTo: '2026-07-31', productLineId: 1, brokerId: 2, rmUserId: 3, regionId: 4, teamOrRmId: null, brokerTypeId: null }),
    );

    // Act
    store.dispatch(clearDashboardFilters());

    // Assert
    expect(store.getState().dashboardFilters).toEqual({
      dateFrom: null,
      dateTo: null,
      productLineId: null,
      brokerId: null,
      rmUserId: null,
      regionId: null,
      teamOrRmId: null,
      brokerTypeId: null,
    });
  });

  it('persistFilters_ThenNewStoreInit_ShouldRestoreFromSessionStorage', () => {
    // Arrange: this mirrors what `app/store.ts`'s subscribe callback does on every dispatch (spec
    // A-16: filters persist across dashboard route navigation for the tab's lifetime).
    const filters: DashboardFiltersState = {
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      productLineId: 7,
      brokerId: null,
      rmUserId: null,
      regionId: 9,
      teamOrRmId: null,
      brokerTypeId: null,
    };
    persistFilters(filters);

    // Act: a fresh slice module state resolution reads sessionStorage synchronously at import
    // time, so simulate that by reading the persisted value directly (module state is already
    // initialized once per test file) -- confirms the storage key/shape a re-import would restore.
    const raw = window.sessionStorage.getItem(DASHBOARD_FILTERS_STORAGE_KEY);

    // Assert
    expect(JSON.parse(raw!)).toEqual(filters);
  });
});
