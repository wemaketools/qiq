import { describe, expect, it } from 'vitest';
import {
  sessionReducer,
  setActiveTenant,
  setSession,
  clearSession,
  selectActiveTenant,
  selectActiveTenantCurrency,
  selectHasPermission,
  selectHasAnyPermission,
  selectShowTenantSwitcher,
} from './sessionSlice';
import type { RootState } from '../store';

function stateWith(
  memberships: { tenantId: number; tenantName: string; currencyCode?: string; currencySymbol?: string; permissions: string[] }[],
  activeTenantId: number | null,
  globalPermissions: string[] = [],
) {
  return {
    session: {
      isAuthenticated: true,
      user: { userId: 1, email: 'a@b.test', firstName: 'A', lastName: 'B' },
      memberships: memberships.map((m) => ({
        currencyCode: 'BWP',
        currencySymbol: 'BWP',
        ...m,
      })),
      globalPermissions,
      activeTenantId,
      themePreference: 'light' as const,
    },
  } as RootState;
}

describe('sessionSlice reducer', () => {
  it('setActiveTenant_WhenGivenTenantId_ShouldUpdateActiveTenantId', () => {
    // Arrange
    const initialState = sessionReducer(undefined, { type: '@@INIT' });

    // Act
    const result = sessionReducer(initialState, setActiveTenant(42));

    // Assert
    expect(result.activeTenantId).toBe(42);
  });

  it('clearSession_WhenCalled_ShouldResetSessionState', () => {
    // Arrange
    const populated = sessionReducer(
      undefined,
      setSession({
        user: { userId: 1, email: 'a@b.test', firstName: 'A', lastName: 'B' },
        memberships: [{ tenantId: 1, tenantName: 'T1', currencyCode: 'BWP', currencySymbol: 'BWP', permissions: [] }],
        activeTenantId: 1,
        themePreference: 'dark',
      }),
    );

    // Act
    const result = sessionReducer(populated, clearSession());

    // Assert
    expect(result.isAuthenticated).toBe(false);
    expect(result.activeTenantId).toBeNull();
  });
});

describe('selectActiveTenant', () => {
  it('selectActiveTenant_WhenActiveTenantIdMatchesMembership_ShouldReturnThatMembership', () => {
    // Arrange
    const state = stateWith(
      [
        { tenantId: 1, tenantName: 'Tenant One', permissions: ['leads.view'] },
        { tenantId: 2, tenantName: 'Tenant Two', permissions: [] },
      ],
      2,
    );

    // Act
    const result = selectActiveTenant(state);

    // Assert
    expect(result?.tenantName).toBe('Tenant Two');
  });
});

describe('selectActiveTenantCurrency', () => {
  it('selectActiveTenantCurrency_WhenActiveTenantHasNonDefaultCurrency_ShouldReturnItRegardlessOfPermissions', () => {
    // Arrange: caller has no permissions at all in the active tenant (not just missing
    // business_rules.view) -- the currency must still resolve correctly (AC-074).
    const state = stateWith(
      [{ tenantId: 1, tenantName: 'Tenant ZAR', currencyCode: 'ZAR', currencySymbol: 'R', permissions: [] }],
      1,
    );

    // Act
    const result = selectActiveTenantCurrency(state);

    // Assert
    expect(result).toBe('ZAR');
  });

  it('selectActiveTenantCurrency_WhenNoActiveTenant_ShouldFallBackToBwp', () => {
    // Arrange
    const state = stateWith([], null);

    // Act
    const result = selectActiveTenantCurrency(state);

    // Assert
    expect(result).toBe('BWP');
  });

  it('selectActiveTenantCurrency_WhenSwitchingActiveTenant_ShouldReflectNewlyActiveMembershipCurrency', () => {
    // Arrange
    const state = stateWith(
      [
        { tenantId: 1, tenantName: 'Tenant BWP', currencyCode: 'BWP', currencySymbol: 'BWP', permissions: [] },
        { tenantId: 2, tenantName: 'Tenant ZAR', currencyCode: 'ZAR', currencySymbol: 'R', permissions: [] },
      ],
      2,
    );

    // Act
    const result = selectActiveTenantCurrency(state);

    // Assert
    expect(result).toBe('ZAR');
  });
});

describe('selectHasPermission', () => {
  it('selectHasPermission_WhenActiveTenantGrantsCode_ShouldReturnTrue', () => {
    // Arrange
    const state = stateWith([{ tenantId: 1, tenantName: 'Tenant One', permissions: ['leads.view'] }], 1);

    // Act
    const result = selectHasPermission('leads.view')(state);

    // Assert
    expect(result).toBe(true);
  });

  it('selectHasPermission_WhenActiveTenantDoesNotGrantCode_ShouldReturnFalse', () => {
    // Arrange
    const state = stateWith([{ tenantId: 1, tenantName: 'Tenant One', permissions: ['leads.view'] }], 1);

    // Act
    const result = selectHasPermission('tenants.view')(state);

    // Assert
    expect(result).toBe(false);
  });

  it('selectHasAnyPermission_WhenAtLeastOneCodeGranted_ShouldReturnTrue', () => {
    // Arrange
    const state = stateWith([{ tenantId: 1, tenantName: 'Tenant One', permissions: ['users.view'] }], 1);

    // Act
    const result = selectHasAnyPermission(['tenants.view', 'users.view'])(state);

    // Assert
    expect(result).toBe(true);
  });

  it('selectHasPermission_WhenNoActiveTenantButGlobalGrant_ShouldReturnTrue', () => {
    // Arrange: the T-045 zero-membership Internal case — permissions come only from the
    // tenant-less global set.
    const state = stateWith([], null, ['tenants.view']);

    // Act & Assert
    expect(selectHasPermission('tenants.view')(state)).toBe(true);
    expect(selectHasAnyPermission(['tenants.view', 'users.view'])(state)).toBe(true);
    expect(selectHasPermission('leads.view')(state)).toBe(false);
  });
});

describe('selectShowTenantSwitcher', () => {
  it('selectShowTenantSwitcher_WhenSingleMembershipWithoutGlobalPermission_ShouldReturnFalse', () => {
    // Arrange
    const state = stateWith([{ tenantId: 1, tenantName: 'Tenant One', permissions: ['leads.view'] }], 1);

    // Act
    const result = selectShowTenantSwitcher(state);

    // Assert
    expect(result).toBe(false);
  });

  it('selectShowTenantSwitcher_WhenMultipleMemberships_ShouldReturnTrue', () => {
    // Arrange
    const state = stateWith(
      [
        { tenantId: 1, tenantName: 'Tenant One', permissions: [] },
        { tenantId: 2, tenantName: 'Tenant Two', permissions: [] },
      ],
      1,
    );

    // Act
    const result = selectShowTenantSwitcher(state);

    // Assert
    expect(result).toBe(true);
  });

  it('selectShowTenantSwitcher_WhenSingleMembershipWithGlobalViewAnyTenant_ShouldReturnTrue', () => {
    // Arrange
    const state = stateWith([{ tenantId: 1, tenantName: 'Tenant One', permissions: ['global.view_any_tenant'] }], 1);

    // Act
    const result = selectShowTenantSwitcher(state);

    // Assert
    expect(result).toBe(true);
  });
});
