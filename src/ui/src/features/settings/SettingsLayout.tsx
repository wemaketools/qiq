import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectActiveTenant } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';

interface SettingsTabConfig {
  path: string;
  label: string;
  testId: string;
  /** Any one of these permission codes grants visibility of this subsection (spec FR-18, AC-017). */
  permissions: string[];
}

/**
 * Settings vertical-tab configuration (spec FR-18..FR-25, PRD 12.10, §12.6). The Internal-only global
 * template editor variant is out of scope for this task and is deliberately not listed here.
 */
const SETTINGS_TABS: SettingsTabConfig[] = [
  {
    path: 'brokers',
    label: 'Brokers',
    testId: 'settings-tab-brokers',
    permissions: [PermissionCodes.BrokersView, PermissionCodes.BrokersManage],
  },
  {
    path: 'reference-data',
    label: 'Reference data',
    testId: 'settings-tab-reference-data',
    permissions: [PermissionCodes.ReferenceDataManage],
  },
  {
    path: 'business-rules',
    label: 'Business rules',
    testId: 'settings-tab-business-rules',
    permissions: [PermissionCodes.BusinessRulesView, PermissionCodes.BusinessRulesManage],
  },
  {
    path: 'business-assignments',
    label: 'Business assignments',
    testId: 'settings-tab-business-assignments',
    permissions: [PermissionCodes.BusinessAssignmentsView, PermissionCodes.BusinessAssignmentsManage],
  },
  {
    path: 'api-access',
    label: 'API access',
    testId: 'settings-tab-api-access',
    permissions: [PermissionCodes.ApiAccessView],
  },
];

/**
 * Settings vertical-tab shell (spec FR-18, AC-017, T-016). Renders only the subsections whose
 * permission the active tenant grants; per-subsection route-level `RouteGuard`s (wired in
 * `app/router.tsx`) are the actual authorization boundary — this component additionally hides tabs
 * the user cannot enter at all, and redirects `/settings` itself to the first permitted subsection
 * so there is never a route with no visible content for a permitted user.
 */
function SettingsLayout() {
  const location = useLocation();
  const activeTenant = useAppSelector(selectActiveTenant);
  const grantedCodes = activeTenant?.permissions ?? [];
  const visibleTabs = SETTINGS_TABS.filter((tab) => tab.permissions.some((code) => grantedCodes.includes(code)));

  const isIndexRoute = location.pathname === '/settings' || location.pathname === '/settings/';

  return (
    <div data-testid="page-settings" style={{ display: 'flex', gap: 'var(--qiq-space-5)' }}>
      <nav data-testid="settings-tabs" aria-label="Settings sections" style={{ minWidth: '200px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: 'var(--qiq-space-3)' }}>Settings</h2>
        <ul className="qiq-vtabs">
          {visibleTabs.map((tab) => (
            <li key={tab.path}>
              <NavLink
                to={`/settings/${tab.path}`}
                data-testid={tab.testId}
                className={({ isActive }) => (isActive ? 'qiq-vtab--active' : undefined)}
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div style={{ flex: 1 }}>
        {isIndexRoute && visibleTabs[0] && <Navigate to={`/settings/${visibleTabs[0].path}`} replace />}
        <Outlet />
      </div>
    </div>
  );
}

export default SettingsLayout;
