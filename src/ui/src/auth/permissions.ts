/**
 * Permission code constants used by shell-level gating (nav, route guards, tenant switcher).
 * Mirrors the subset of `PermissionCatalog` (src/api/QuoteIQ.Domain/Security/PermissionCatalog.cs)
 * the shell itself references; this is not duplicated backend validation — the server remains the
 * sole authority (`RequirePermission` on every gated endpoint) and these codes exist here purely so
 * the UI can hide navigation/routes a user has no access to. Screen-level permission checks for
 * later tasks should extend this file rather than inventing ad hoc strings.
 */
export const PermissionCodes = {
  DashboardsViewExecutive: 'dashboards.view_executive',
  DashboardsViewPipeline: 'dashboards.view_pipeline',
  DashboardsViewBrokerPerformance: 'dashboards.view_broker_performance',
  DashboardsViewRmPerformance: 'dashboards.view_rm_performance',
  DashboardsViewLossAnalysis: 'dashboards.view_loss_analysis',
  LeadsView: 'leads.view',
  LeadsCreate: 'leads.create',
  LeadsUpdate: 'leads.update',
  /** Record-level visibility breadth (spec A-17/Q-6, FR-12): without this, a caller sees only leads carrying any assignment for them. */
  LeadsViewAll: 'leads.view_all',
  /** Bulk accountable-owner reassign (spec FR-43, Q-12): matches `PermissionCatalog.Leads.Reassign` — the actual gate on `POST /leads/bulk-reassign` (T-018's `LeadEndpoints`), not `leads.assign` (the single-lead Assign workflow op's permission). */
  LeadsReassign: 'leads.reassign',
  /** Export leads to CSV/Excel (spec FR-65, T-039). */
  LeadsExport: 'leads.export',
  PartiesView: 'parties.view',
  PartiesCreate: 'parties.create',
  PartiesUpdate: 'parties.update',
  /** Export parties to CSV/Excel (spec FR-65, T-039). */
  PartiesExport: 'parties.export',
  QuotesCreate: 'quotes.create',
  QuotesView: 'quotes.view',
  QuotesUpdate: 'quotes.update',
  QuotesSetCurrent: 'quotes.set_current',
  QuotesCorrectClosed: 'quotes.correct_closed',
  AlertsView: 'alerts.view',
  ReportsView: 'reports.view',
  UsersView: 'users.view',
  UsersInvite: 'users.invite',
  UsersEdit: 'users.edit',
  UsersDeactivate: 'users.deactivate',
  UsersAssignTenant: 'users.assign_tenant',
  UsersAssignRole: 'users.assign_role',
  UsersAssignGroup: 'users.assign_group',
  UsersGrantDirectPermission: 'users.grant_direct_permission',
  RolesView: 'roles.view',
  RolesManage: 'roles.manage',
  GroupsView: 'groups.view',
  GroupsManage: 'groups.manage',
  TenantsView: 'tenants.view',
  TenantsCreate: 'tenants.create',
  TenantsEdit: 'tenants.edit',
  TenantsDeactivate: 'tenants.deactivate',
  TenantsRestore: 'tenants.restore',
  TenantsViewRemoved: 'tenants.view_removed',
  BusinessRulesView: 'business_rules.view',
  BusinessRulesManage: 'business_rules.manage',
  ReferenceDataManage: 'reference_data.manage',
  BusinessAssignmentsView: 'business_assignments.view',
  BusinessAssignmentsManage: 'business_assignments.manage',
  BrokersView: 'brokers.view',
  BrokersManage: 'brokers.manage',
  ApiAccessView: 'api_access.view',
  ApiAccessEnable: 'api_access.enable',
  ApiAccessDisable: 'api_access.disable',
  ApiAccessRegenerateSecret: 'api_access.regenerate_secret',
  GlobalViewAnyTenant: 'global.view_any_tenant',
} as const;

export type PermissionCode = (typeof PermissionCodes)[keyof typeof PermissionCodes];

/** Any of these grants entry to some part of Settings (final subsection gating lands in T-016). */
export const SETTINGS_PERMISSION_CODES: string[] = [
  PermissionCodes.BusinessRulesView,
  PermissionCodes.BusinessRulesManage,
  PermissionCodes.ReferenceDataManage,
  PermissionCodes.BusinessAssignmentsView,
  PermissionCodes.BusinessAssignmentsManage,
  PermissionCodes.BrokersView,
  PermissionCodes.BrokersManage,
  PermissionCodes.ApiAccessView,
];
