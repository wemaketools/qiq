import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  alertsBadgeReducer,
  openAlertsCenterBadgeReset,
  refreshAlertsBadge,
  resetAlertsBadge,
  selectAlertsBadgeCount,
  setAlertsBadgeCount,
} from './alertsBadgeSlice';
import { sessionReducer } from './sessionSlice';
import { dashboardFiltersReducer } from './dashboardFiltersSlice';
import { getAlertBadge, resetAlertBadge } from '../../features/alerts/alertsApi';

vi.mock('../../features/alerts/alertsApi', () => ({
  getAlertBadge: vi.fn(),
  resetAlertBadge: vi.fn(),
}));

function makeStore() {
  return configureStore({
    reducer: { session: sessionReducer, dashboardFilters: dashboardFiltersReducer, alertsBadge: alertsBadgeReducer },
  });
}

describe('alertsBadgeSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setAlertsBadgeCount_ShouldStoreCount', () => {
    const store = makeStore();
    store.dispatch(setAlertsBadgeCount(4));
    expect(selectAlertsBadgeCount(store.getState())).toBe(4);
  });

  it('resetAlertsBadge_ShouldZeroCount', () => {
    const store = makeStore();
    store.dispatch(setAlertsBadgeCount(9));
    store.dispatch(resetAlertsBadge());
    expect(selectAlertsBadgeCount(store.getState())).toBe(0);
  });

  it('refreshAlertsBadge_WhenFulfilled_ShouldSetServerCount', async () => {
    // Arrange
    vi.mocked(getAlertBadge).mockResolvedValue({ count: 7 });
    const store = makeStore();

    // Act
    await store.dispatch(refreshAlertsBadge());

    // Assert
    expect(getAlertBadge).toHaveBeenCalledTimes(1);
    expect(selectAlertsBadgeCount(store.getState())).toBe(7);
  });

  it('openAlertsCenterBadgeReset_ShouldPersistResetAndZeroCount', async () => {
    // Arrange
    vi.mocked(resetAlertBadge).mockResolvedValue(undefined);
    const store = makeStore();
    store.dispatch(setAlertsBadgeCount(5));

    // Act
    await store.dispatch(openAlertsCenterBadgeReset());

    // Assert
    expect(resetAlertBadge).toHaveBeenCalledTimes(1);
    expect(selectAlertsBadgeCount(store.getState())).toBe(0);
  });
});
