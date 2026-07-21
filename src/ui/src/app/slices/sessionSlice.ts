import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';
import { PermissionCodes } from '../../auth/permissions';

/** One tenant membership as returned by `GET /me` (src/api/.../GetMe/GetMeQuery.cs `MembershipDto`). */
export interface TenantMembership {
  tenantId: number;
  tenantName: string;
  /**
   * Tenant display currency (spec A-3, AC-074): every member sees the correct code regardless of
   * `business_rules.view`, since GetMe sources it from `tenant_settings` for every membership.
   */
  currencyCode: string;
  currencySymbol: string;
  /** Effective permission codes for this user within this tenant (union of every grant path). */
  permissions: string[];
}

export interface SessionUser {
  userId: number;
  email: string;
  firstName: string;
  lastName: string;
}

export type ThemePreference = 'light' | 'dark';

export interface SessionState {
  isAuthenticated: boolean;
  user: SessionUser | null;
  memberships: TenantMembership[];
  /**
   * Tenant-less permission grants from `GET /me` (T-045): the Internal/global set (e.g.
   * `tenants.view`, `global.view_any_tenant`). For members these are already unioned into each
   * membership's `permissions`; carried separately so a zero-membership Internal user still
   * drives nav/route gates with no tenant context at all.
   */
  globalPermissions: string[];
  activeTenantId: number | null;
  themePreference: ThemePreference;
}

const initialState: SessionState = {
  isAuthenticated: false,
  user: null,
  memberships: [],
  globalPermissions: [],
  activeTenantId: null,
  themePreference: 'light',
};

export interface SetSessionPayload {
  user: SessionUser;
  memberships: TenantMembership[];
  globalPermissions?: string[];
  activeTenantId: number | null;
  themePreference: ThemePreference;
}

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    setSession(state, action: PayloadAction<SetSessionPayload>) {
      state.isAuthenticated = true;
      state.user = action.payload.user;
      state.memberships = action.payload.memberships;
      state.globalPermissions = action.payload.globalPermissions ?? [];
      state.activeTenantId = action.payload.activeTenantId;
      state.themePreference = action.payload.themePreference;
    },
    setActiveTenant(state, action: PayloadAction<number>) {
      state.activeTenantId = action.payload;
    },
    /**
     * Adds (or refreshes) a tenant the caller can act in without a membership row (T-045): when a
     * `global.view_any_tenant` holder switches into a non-member tenant, the switcher synthesizes
     * this entry so `selectActiveTenant`-based screens work unchanged. Faithful to the backend's
     * `EffectivePermissionResolver` semantics — a non-member's effective set in any tenant is
     * exactly their global grants.
     */
    upsertCrossTenantMembership(state, action: PayloadAction<TenantMembership>) {
      const existing = state.memberships.find((m) => m.tenantId === action.payload.tenantId);
      if (existing) {
        return;
      }
      state.memberships.push(action.payload);
    },
    setThemePreference(state, action: PayloadAction<ThemePreference>) {
      state.themePreference = action.payload;
    },
    /**
     * Updates the active tenant's display-currency fields in place (spec A-3, AC-074, T-016): the
     * Business rules tab's save action calls this immediately on success so the footer/other
     * currency-sourced surfaces (all read from this session slice, see `useTenantCurrency.ts`) stay
     * correct within the session without a full `GET /me` refetch/round trip.
     */
    updateActiveTenantCurrency(state, action: PayloadAction<{ currencyCode: string; currencySymbol: string }>) {
      const membership = state.memberships.find((m) => m.tenantId === state.activeTenantId);
      if (membership) {
        membership.currencyCode = action.payload.currencyCode;
        membership.currencySymbol = action.payload.currencySymbol;
      }
    },
    clearSession() {
      return initialState;
    },
  },
});

export const {
  setSession,
  setActiveTenant,
  setThemePreference,
  updateActiveTenantCurrency,
  upsertCrossTenantMembership,
  clearSession,
} = sessionSlice.actions;
export const sessionReducer = sessionSlice.reducer;

export const selectSession = (state: RootState): SessionState => state.session;

export const selectActiveTenant = (state: RootState): TenantMembership | null =>
  state.session.memberships.find((membership) => membership.tenantId === state.session.activeTenantId) ?? null;

/**
 * The active tenant's display currency code (spec A-3, AC-074), sourced from the session (itself
 * populated from `GET /me`) rather than a Settings-permission-gated endpoint, so it resolves
 * correctly for every member. Falls back to `'BWP'` only when there is no active tenant at all
 * (e.g. transient pre-session-load state), never as a degrade for a permission failure.
 */
export const selectActiveTenantCurrency = (state: RootState): string =>
  selectActiveTenant(state)?.currencyCode ?? 'BWP';

/** The caller's tenant-less global grants (empty for ordinary tenant users). */
export const selectGlobalPermissions = (state: RootState): string[] => state.session.globalPermissions;

/**
 * True when the active tenant's effective permission set — or a tenant-less global grant — includes
 * `code`. The global union (T-045) is what lets a zero-membership Internal user reach Tenant
 * Manager: with no active tenant their global grants are exactly their effective set, mirroring the
 * backend's `EffectivePermissionResolver`.
 */
export const selectHasPermission =
  (code: string) =>
  (state: RootState): boolean =>
    state.session.globalPermissions.includes(code) ||
    (selectActiveTenant(state)?.permissions.includes(code) ?? false);

/** True when any of `codes` is granted in the active tenant or globally (used for "any of" nav/route gates). */
export const selectHasAnyPermission =
  (codes: string[]) =>
  (state: RootState): boolean => {
    const tenantPermissions = selectActiveTenant(state)?.permissions ?? [];
    return codes.some(
      (code) => state.session.globalPermissions.includes(code) || tenantPermissions.includes(code),
    );
  };

/**
 * Single-tenant users see no tenant switcher (FR-10, AC-009): visible only for users with more
 * than one membership, or Internal users granted `global.view_any_tenant` (who may switch into
 * any tenant even with a single membership on record).
 */
export const selectShowTenantSwitcher = (state: RootState): boolean =>
  state.session.memberships.length > 1 || selectHasPermission(PermissionCodes.GlobalViewAnyTenant)(state);
