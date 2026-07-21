import { configureStore } from '@reduxjs/toolkit';
import { sessionReducer } from './slices/sessionSlice';
import { dashboardFiltersReducer, persistFilters } from './slices/dashboardFiltersSlice';
import { alertsBadgeReducer } from './slices/alertsBadgeSlice';

export const store = configureStore({
  reducer: {
    session: sessionReducer,
    dashboardFilters: dashboardFiltersReducer,
    alertsBadge: alertsBadgeReducer,
  },
});

// Persist dashboard filters to sessionStorage on every change (spec A-16 / AC-053).
store.subscribe(() => {
  persistFilters(store.getState().dashboardFilters);
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
