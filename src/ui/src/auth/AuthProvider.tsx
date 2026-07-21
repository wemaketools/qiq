import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAppDispatch } from '../app/hooks';
import { setSession, clearSession, updateActiveTenantCurrency } from '../app/slices/sessionSlice';
import type { TenantMembership, ThemePreference } from '../app/slices/sessionSlice';
import { PermissionCodes } from './permissions';
import { getCurrentSession, onAuthStateChange, SIGN_IN_ROUTE } from './supabase';
import { fetchMe } from '../api/me';
import type { MeResponse } from '../api/me';
import { getTenant } from '../features/tenantManager/tenantsApi';
import { fetchFullBusinessRules } from '../features/settings/settingsApi';

/**
 * Rehydrates a `global.view_any_tenant` holder's persisted cross-tenant selection (T-045, PRD 5.3):
 * when `lastTenantId` names a tenant the caller has no membership row for, synthesize the same
 * session membership the tenant switcher would have built (permission set = the caller's global
 * grants, exactly a non-member's effective set per the backend resolver), so a full reload restores
 * the cross-tenant context instead of silently dropping to no active tenant. Returns `null` when
 * the selection isn't a legitimate cross-tenant one (not a view-any-tenant holder, or the tenant
 * can't be read) — the caller then falls back to first-membership behavior.
 */
async function resolveCrossTenantMembership(me: MeResponse): Promise<TenantMembership | null> {
  if (
    me.lastTenantId == null ||
    me.memberships.some((m) => m.tenantId === me.lastTenantId) ||
    !(me.globalPermissions ?? []).includes(PermissionCodes.GlobalViewAnyTenant)
  ) {
    return null;
  }
  try {
    const tenant = await getTenant(me.lastTenantId);
    if (tenant.status !== 'active') {
      return null;
    }
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      // Placeholder until the business-rules read (below, once the session is in place) resolves
      // the tenant's real display currency.
      currencyCode: 'BWP',
      currencySymbol: 'BWP',
      permissions: me.globalPermissions ?? [],
    };
  } catch {
    return null;
  }
}

interface AuthProviderProps {
  children?: ReactNode;
}

/**
 * Gates the authenticated portion of the router (spec FR-01/FR-04, AC-001/AC-004). Renders nothing
 * (beyond a transient placeholder) until:
 *   1. a valid Supabase session exists (rendering a redirect to the SPA `/sign-in` route
 *      otherwise, remembering the requested path so sign-in can return to it), and
 *   2. `GET /me` has resolved, at which point `session` is populated with the user, tenant
 *      memberships, and per-tenant effective permissions, and the active tenant is set to the
 *      caller's remembered `lastTenantId` or their first membership (FR-04).
 *
 * Mounted as the element of a layout route wrapping the authenticated app shell; `/sign-in`,
 * `/forgot-password`, and `/reset-password` are separate top-level routes never wrapped by this
 * component (see app/router.tsx), so the sign-in surface itself is always reachable.
 *
 * Sign-out (and any other Supabase auth-state transition to a signed-out state) clears the whole
 * session slice, so no tenant-scoped state survives into the next session.
 */
function AuthProvider({ children }: AuthProviderProps) {
  const dispatch = useAppDispatch();
  const location = useLocation();
  const [status, setStatus] = useState<'checking' | 'signed-out' | 'ready' | 'error'>('checking');

  useEffect(() => {
    let cancelled = false;

    async function initialize(): Promise<void> {
      const session = await getCurrentSession();

      if (!session) {
        if (!cancelled) {
          setStatus('signed-out');
        }
        return;
      }

      try {
        const me = await fetchMe();
        if (cancelled) {
          return;
        }
        const crossTenantMembership = await resolveCrossTenantMembership(me);
        if (cancelled) {
          return;
        }
        const memberships: TenantMembership[] = me.memberships.map((m) => ({
          tenantId: m.tenantId,
          tenantName: m.tenantName,
          currencyCode: m.currencyCode,
          currencySymbol: m.currencySymbol,
          permissions: m.effectivePermissions,
        }));
        if (crossTenantMembership) {
          memberships.push(crossTenantMembership);
        }
        const restorableTenantIds = new Set(memberships.map((m) => m.tenantId));
        const activeTenantId =
          me.lastTenantId != null && restorableTenantIds.has(me.lastTenantId)
            ? me.lastTenantId
            : (memberships[0]?.tenantId ?? null);
        dispatch(
          setSession({
            user: { userId: me.userId, email: me.email, firstName: me.firstName, lastName: me.lastName },
            memberships,
            globalPermissions: me.globalPermissions ?? [],
            activeTenantId,
            themePreference: (me.themePreference as ThemePreference | null) ?? 'light',
          }),
        );
        if (crossTenantMembership && activeTenantId === crossTenantMembership.tenantId) {
          // Correct the placeholder display currency now that the session (and therefore the
          // X-Tenant-Id header) is in place; a failure just keeps the placeholder.
          fetchFullBusinessRules()
            .then((rules) =>
              dispatch(updateActiveTenantCurrency({ currencyCode: rules.currencyCode, currencySymbol: rules.currencySymbol })),
            )
            .catch(() => undefined);
        }
        setStatus('ready');
      } catch {
        if (!cancelled) {
          setStatus('error');
        }
      }
    }

    void initialize();

    // `SIGNED_OUT` covers the explicit sign-out action and a refresh failure that supabase-js
    // could not recover from; either way every tenant-scoped value in the store must go.
    const unsubscribe = onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        dispatch(clearSession());
        setStatus('signed-out');
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch]);

  if (status === 'signed-out') {
    return <Navigate to={SIGN_IN_ROUTE} replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  if (status !== 'ready') {
    return (
      <div data-testid="auth-loading" role="status" aria-live="polite">
        {status === 'error' ? 'Unable to load your session.' : 'Signing you in…'}
      </div>
    );
  }

  return children ?? <Outlet />;
}

export default AuthProvider;
