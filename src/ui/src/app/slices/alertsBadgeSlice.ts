import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';
import { getAlertBadge, resetAlertBadge } from '../../features/alerts/alertsApi';

/**
 * New-alert badge count (FR-63, AC-062): a new-since-last-visit count, not an open-alert count.
 * The count is a per-user, server-persisted value — `GET /alerts/badge` counts alerts created after
 * the user's own last Alerts-center visit, and `POST /alerts/badge/reset` (fired on entering
 * `/alerts`) upserts that visit timestamp server-side. Because the reset is server-persisted, the
 * badge stays zero for that user across reloads while another user still sees their own count.
 *
 * This slice holds the shell-displayed count (rendered by the Sidebar Alerts item and the TopBar
 * bell). `refreshAlertsBadge` is polled (60s + on window focus, see `useAlertsBadgePolling`);
 * `openAlertsCenterBadgeReset` is dispatched when the Alerts center mounts.
 */
export interface AlertsBadgeState {
  count: number;
}

const initialState: AlertsBadgeState = { count: 0 };

/** Polls the current per-user new-alert count (`GET /alerts/badge`). */
export const refreshAlertsBadge = createAsyncThunk('alertsBadge/refresh', async () => {
  const result = await getAlertBadge();
  return result.count;
});

/**
 * Persists the current user's Alerts-center visit server-side (`POST /alerts/badge/reset`) and zeroes
 * the local count. Server-persisted so the badge stays zero for this user after reload (AC-062).
 */
export const openAlertsCenterBadgeReset = createAsyncThunk('alertsBadge/reset', async () => {
  await resetAlertBadge();
  return 0;
});

const alertsBadgeSlice = createSlice({
  name: 'alertsBadge',
  initialState,
  reducers: {
    setAlertsBadgeCount(state, action: PayloadAction<number>) {
      state.count = action.payload;
    },
    resetAlertsBadge(state) {
      state.count = 0;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(refreshAlertsBadge.fulfilled, (state, action) => {
        state.count = action.payload;
      })
      .addCase(openAlertsCenterBadgeReset.fulfilled, (state, action) => {
        state.count = action.payload;
      });
  },
});

export const { setAlertsBadgeCount, resetAlertsBadge } = alertsBadgeSlice.actions;
export const alertsBadgeReducer = alertsBadgeSlice.reducer;

export const selectAlertsBadgeCount = (state: RootState): number => state.alertsBadge.count;
