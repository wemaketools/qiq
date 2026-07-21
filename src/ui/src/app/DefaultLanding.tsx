import { Navigate } from 'react-router-dom';
import { useAppSelector } from './hooks';
import { selectActiveTenant, selectGlobalPermissions } from './slices/sessionSlice';
import { STANDARD_NAV_ITEMS, ADMIN_NAV_ITEMS } from '../components/shell/navConfig';

/**
 * Permission-aware post-login landing (T-044). The index route previously hardcoded
 * `Navigate to="/overview"`, which greeted every role without `dashboards.view_executive`
 * (Relationship Manager, Underwriter, Sales Operations, Tenant Admin, Internal) with the
 * Forbidden page immediately after login. Instead, land on the first sidebar entry the active
 * tenant's effective permissions actually allow — the same order and permission rules the
 * sidebar itself renders with (PRD 12.1) — falling back to `/overview` (and its RouteGuard's
 * Forbidden state) only when no nav entry is permitted at all.
 */
function DefaultLanding() {
  const activeTenant = useAppSelector(selectActiveTenant);
  const globalPermissions = useAppSelector(selectGlobalPermissions);
  // Same union the permission selectors apply (T-045): tenant-scoped effective set plus the
  // tenant-less global grants, so a zero-membership Internal user still lands on Tenant Manager.
  const permissions = [...(activeTenant?.permissions ?? []), ...globalPermissions];

  const firstPermitted = [...STANDARD_NAV_ITEMS, ...ADMIN_NAV_ITEMS].find(
    (item) => !item.permissions || item.permissions.some((code) => permissions.includes(code)),
  );

  return <Navigate to={firstPermitted?.path ?? '/overview'} replace />;
}

export default DefaultLanding;
