import { createBrowserRouter } from 'react-router-dom';
import AuthProvider from '../auth/AuthProvider';
import DefaultLanding from './DefaultLanding';
import SignInPage from '../auth/SignInPage';
import ForgotPasswordPage from '../auth/ForgotPasswordPage';
import ResetPasswordPage from '../auth/ResetPasswordPage';
import AppShell from '../components/shell/AppShell';
import RouteGuard from './RouteGuard';
import NotFoundPage from '../pages/NotFoundPage';
import { PermissionCodes, SETTINGS_PERMISSION_CODES } from '../auth/permissions';
import TenantListPage from '../features/tenantManager/TenantListPage';
import TenantFormPage from '../features/tenantManager/TenantFormPage';
import UserListPage from '../features/userManager/UserListPage';
import UserFormPage from '../features/userManager/UserFormPage';
import UserDetailPage from '../features/userManager/UserDetailPage';
import RoleListPage from '../features/userManager/RoleListPage';
import RoleFormPage from '../features/userManager/RoleFormPage';
import GroupListPage from '../features/userManager/GroupListPage';
import GroupDetailPage from '../features/userManager/GroupDetailPage';
import SettingsLayout from '../features/settings/SettingsLayout';
import BrokersTab from '../features/settings/BrokersTab';
import ReferenceDataTab from '../features/settings/ReferenceDataTab';
import BusinessRulesTab from '../features/settings/BusinessRulesTab';
import BusinessAssignmentsTab from '../features/settings/BusinessAssignmentsTab';
import ApiAccessTab from '../features/settings/ApiAccessTab';
import LeadsListPage from '../features/leads/LeadsListPage';
import LeadFormPage from '../features/leads/LeadFormPage';
import LeadDetailPage from '../features/leads/LeadDetailPage';
import PartiesListPage from '../features/parties/PartiesListPage';
import PartyDetailPage from '../features/parties/PartyDetailPage';
import PartyFormPage from '../features/parties/PartyFormPage';
import DrillListPage from '../features/dashboards/DrillListPage';
import OverviewPage from '../features/dashboards/OverviewPage';
import PipelinePage from '../features/dashboards/PipelinePage';
import BrokerPerformancePage from '../features/dashboards/BrokerPerformancePage';
import RmPerformancePage from '../features/dashboards/RmPerformancePage';
import LossAnalysisPage from '../features/dashboards/LossAnalysisPage';
import ReportsPage from '../features/reports/ReportsPage';
import ReportViewPage from '../features/reports/ReportViewPage';
import AlertsCenterPage from '../features/alerts/AlertsCenterPage';

/**
 * Route map (spec §10.1). `/sign-in`, `/forgot-password`, and `/reset-password` are now SPA-rendered
 * routes served by Supabase Auth rather than Keycloak-hosted pages (P-01, the one accepted
 * login-surface change); the retired `/auth/callback` and `/auth/silent-renew` OIDC redirect
 * handlers are gone, since supabase-js manages session persistence and token refresh in-process.
 * Every other route sits under the `AuthProvider` layout route (gates on a valid Supabase session +
 * `GET /me`) and the `AppShell` layout route (sidebar/top bar/footer), with per-route `RouteGuard`
 * permission checks.
 */
export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    element: <AuthProvider />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DefaultLanding /> },
          {
            path: 'overview',
            element: (
              <RouteGuard permissions={[PermissionCodes.DashboardsViewExecutive]}>
                <OverviewPage />
              </RouteGuard>
            ),
          },
          {
            path: 'leads',
            element: (
              <RouteGuard permissions={[PermissionCodes.LeadsView]}>
                <LeadsListPage />
              </RouteGuard>
            ),
          },
          {
            path: 'leads/new',
            element: (
              <RouteGuard permissions={[PermissionCodes.LeadsCreate]}>
                <LeadFormPage />
              </RouteGuard>
            ),
          },
          {
            path: 'leads/:leadId',
            element: (
              <RouteGuard permissions={[PermissionCodes.LeadsView]}>
                <LeadDetailPage />
              </RouteGuard>
            ),
          },
          {
            path: 'leads/:leadId/edit',
            element: (
              <RouteGuard permissions={[PermissionCodes.LeadsUpdate]}>
                <LeadFormPage />
              </RouteGuard>
            ),
          },
          {
            path: 'parties',
            element: (
              <RouteGuard permissions={[PermissionCodes.PartiesView]}>
                <PartiesListPage />
              </RouteGuard>
            ),
          },
          {
            path: 'parties/new',
            element: (
              <RouteGuard permissions={[PermissionCodes.PartiesCreate]}>
                <PartyFormPage />
              </RouteGuard>
            ),
          },
          {
            path: 'parties/:partyId',
            element: (
              <RouteGuard permissions={[PermissionCodes.PartiesView]}>
                <PartyDetailPage />
              </RouteGuard>
            ),
          },
          {
            path: 'parties/:partyId/edit',
            element: (
              <RouteGuard permissions={[PermissionCodes.PartiesUpdate]}>
                <PartyFormPage />
              </RouteGuard>
            ),
          },
          {
            // Generic dashboard drill-through (spec FR-54/AC-053, T-031): gated by `leads.view`
            // (the same permission the backend's `DashboardEndpoints.DrillAsync` requires) rather
            // than any one dashboard's own `dashboards.view_*` permission, since a drill row is
            // itself a lead row, not a dashboard view.
            path: 'dashboards/drill/:widgetKey',
            element: (
              <RouteGuard permissions={[PermissionCodes.LeadsView]}>
                <DrillListPage />
              </RouteGuard>
            ),
          },
          {
            path: 'pipeline',
            element: (
              <RouteGuard permissions={[PermissionCodes.DashboardsViewPipeline]}>
                <PipelinePage />
              </RouteGuard>
            ),
          },
          {
            path: 'brokers',
            element: (
              <RouteGuard permissions={[PermissionCodes.DashboardsViewBrokerPerformance]}>
                <BrokerPerformancePage />
              </RouteGuard>
            ),
          },
          {
            path: 'rm-performance',
            element: (
              <RouteGuard permissions={[PermissionCodes.DashboardsViewRmPerformance]}>
                <RmPerformancePage />
              </RouteGuard>
            ),
          },
          {
            path: 'loss-analysis',
            element: (
              <RouteGuard permissions={[PermissionCodes.DashboardsViewLossAnalysis]}>
                <LossAnalysisPage />
              </RouteGuard>
            ),
          },
          {
            path: 'alerts',
            element: (
              <RouteGuard permissions={[PermissionCodes.AlertsView]}>
                <AlertsCenterPage />
              </RouteGuard>
            ),
          },
          {
            path: 'reports',
            element: (
              <RouteGuard permissions={[PermissionCodes.ReportsView]}>
                <ReportsPage />
              </RouteGuard>
            ),
          },
          {
            path: 'reports/:reportKey',
            element: (
              <RouteGuard permissions={[PermissionCodes.ReportsView]}>
                <ReportViewPage />
              </RouteGuard>
            ),
          },
          {
            path: 'settings',
            element: (
              <RouteGuard permissions={SETTINGS_PERMISSION_CODES}>
                <SettingsLayout />
              </RouteGuard>
            ),
            children: [
              {
                path: 'brokers',
                element: (
                  <RouteGuard permissions={[PermissionCodes.BrokersView, PermissionCodes.BrokersManage]}>
                    <BrokersTab />
                  </RouteGuard>
                ),
              },
              {
                path: 'reference-data',
                element: (
                  <RouteGuard permissions={[PermissionCodes.ReferenceDataManage]}>
                    <ReferenceDataTab />
                  </RouteGuard>
                ),
              },
              {
                path: 'reference-data/:listType',
                element: (
                  <RouteGuard permissions={[PermissionCodes.ReferenceDataManage]}>
                    <ReferenceDataTab />
                  </RouteGuard>
                ),
              },
              {
                path: 'business-rules',
                element: (
                  <RouteGuard permissions={[PermissionCodes.BusinessRulesView, PermissionCodes.BusinessRulesManage]}>
                    <BusinessRulesTab />
                  </RouteGuard>
                ),
              },
              {
                path: 'business-assignments',
                element: (
                  <RouteGuard
                    permissions={[PermissionCodes.BusinessAssignmentsView, PermissionCodes.BusinessAssignmentsManage]}
                  >
                    <BusinessAssignmentsTab />
                  </RouteGuard>
                ),
              },
              {
                path: 'api-access',
                element: (
                  <RouteGuard permissions={[PermissionCodes.ApiAccessView]}>
                    <ApiAccessTab />
                  </RouteGuard>
                ),
              },
            ],
          },
          {
            path: 'admin/users',
            element: (
              <RouteGuard permissions={[PermissionCodes.UsersView]}>
                <UserListPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/users/new',
            element: (
              <RouteGuard permissions={[PermissionCodes.UsersInvite]}>
                <UserFormPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/users/:userId',
            element: (
              <RouteGuard permissions={[PermissionCodes.UsersView]}>
                <UserDetailPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/roles',
            element: (
              <RouteGuard permissions={[PermissionCodes.RolesView]}>
                <RoleListPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/roles/new',
            element: (
              <RouteGuard permissions={[PermissionCodes.RolesManage]}>
                <RoleFormPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/roles/:roleId',
            element: (
              <RouteGuard permissions={[PermissionCodes.RolesView]}>
                <RoleFormPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/groups',
            element: (
              <RouteGuard permissions={[PermissionCodes.GroupsView]}>
                <GroupListPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/groups/new',
            element: (
              <RouteGuard permissions={[PermissionCodes.GroupsManage]}>
                <GroupDetailPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/groups/:groupId',
            element: (
              <RouteGuard permissions={[PermissionCodes.GroupsView]}>
                <GroupDetailPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/tenants',
            element: (
              <RouteGuard permissions={[PermissionCodes.TenantsView]}>
                <TenantListPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/tenants/new',
            element: (
              <RouteGuard permissions={[PermissionCodes.TenantsView]}>
                <TenantFormPage />
              </RouteGuard>
            ),
          },
          {
            path: 'admin/tenants/:tenantId',
            element: (
              <RouteGuard permissions={[PermissionCodes.TenantsView]}>
                <TenantFormPage />
              </RouteGuard>
            ),
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
