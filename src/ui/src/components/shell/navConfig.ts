import { PermissionCodes, SETTINGS_PERMISSION_CODES } from '../../auth/permissions';
import type { IconName } from '../common/Icon';

export interface NavItem {
  path: string;
  label: string;
  testId: string;
  /** Sidebar icon (UI Standards §7; T-043). */
  icon: IconName;
  /** Any one of these permission codes grants visibility; omitted = always visible when authenticated. */
  permissions?: string[];
  /** Shows the alerts badge count next to this item. */
  showAlertsBadge?: boolean;
}

/** Standard, daily-work sections (PRD 12.1) — always above the separator. */
export const STANDARD_NAV_ITEMS: NavItem[] = [
  { path: '/overview', label: 'Overview', testId: 'nav-overview', icon: 'overview', permissions: [PermissionCodes.DashboardsViewExecutive] },
  { path: '/leads', label: 'Leads', testId: 'nav-leads', icon: 'leads', permissions: [PermissionCodes.LeadsView] },
  { path: '/parties', label: 'Parties', testId: 'nav-parties', icon: 'parties', permissions: [PermissionCodes.PartiesView] },
  { path: '/pipeline', label: 'Pipeline', testId: 'nav-pipeline', icon: 'pipeline', permissions: [PermissionCodes.DashboardsViewPipeline] },
  { path: '/brokers', label: 'Brokers', testId: 'nav-brokers', icon: 'brokers', permissions: [PermissionCodes.DashboardsViewBrokerPerformance] },
  {
    path: '/rm-performance',
    label: 'RM Performance',
    testId: 'nav-rm-performance',
    icon: 'rm-performance',
    permissions: [PermissionCodes.DashboardsViewRmPerformance],
  },
  {
    path: '/loss-analysis',
    label: 'Loss Analysis',
    testId: 'nav-loss-analysis',
    icon: 'loss-analysis',
    permissions: [PermissionCodes.DashboardsViewLossAnalysis],
  },
  { path: '/alerts', label: 'Alerts', testId: 'nav-alerts', icon: 'alerts', permissions: [PermissionCodes.AlertsView], showAlertsBadge: true },
  { path: '/reports', label: 'Reports', testId: 'nav-reports', icon: 'reports', permissions: [PermissionCodes.ReportsView] },
];

/** Administrative sections (PRD 12.1) — grouped below a visual separator. */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  { path: '/settings', label: 'Settings', testId: 'nav-settings', icon: 'settings', permissions: SETTINGS_PERMISSION_CODES },
  { path: '/admin/users', label: 'User Manager', testId: 'nav-user-manager', icon: 'user-manager', permissions: [PermissionCodes.UsersView] },
  { path: '/admin/tenants', label: 'Tenant Manager', testId: 'nav-tenant-manager', icon: 'tenant-manager', permissions: [PermissionCodes.TenantsView] },
];
