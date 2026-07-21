import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectSession } from '../../app/slices/sessionSlice';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import Footer from './Footer';
import UserCard from './UserCard';
import TenantSwitcher from './TenantSwitcher';
import { resolvePageTitle } from './pageTitles';
import { ExportTargetProvider } from '../../features/exports/ExportTargetContext';
import { useAlertsBadgePolling } from '../../features/alerts/useAlertsBadgePolling';

/**
 * Application shell composition (spec FR-52, AC-051, PRD 12.2): fixed sidebar (brand, nav, user
 * card), tenant switcher, top bar, routed content, and footer. Wraps every authenticated route
 * (see app/router.tsx) below the `AuthProvider` layout route.
 */
function AppShell() {
  const location = useLocation();
  const { themePreference, activeTenantId } = useAppSelector(selectSession);

  useAlertsBadgePolling();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themePreference);
  }, [themePreference]);

  return (
    <ExportTargetProvider>
      <div
        data-testid="app-shell"
        style={{ display: 'grid', gridTemplateColumns: '248px 1fr', minHeight: '100vh' }}
      >
        <div className="qiq-sidebar">
          <Sidebar />
          <TenantSwitcher />
          <UserCard />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <TopBar title={resolvePageTitle(location.pathname)} />
          {/* Keyed on the active tenant so switching tenants remounts the routed page, re-running
              its data-fetch effects against the new X-Tenant-Id — without this, on-screen data
              stayed stale until the user navigated away and back. */}
          <main key={activeTenantId ?? 'no-tenant'} style={{ flex: 1, padding: 'var(--qiq-space-5)' }}>
            <Outlet />
          </main>
          <Footer />
        </div>
      </div>
    </ExportTargetProvider>
  );
}

export default AppShell;
