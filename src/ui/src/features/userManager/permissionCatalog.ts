/**
 * Static mirror of the backend permission catalog
 * (src/api/QuoteIQ.Domain/Security/PermissionCatalog.cs `PermissionCatalog.All`), grouped by
 * category, for the RoleFormPage/GroupDetailPage permission-picker checkbox tree.
 *
 * Deviation flagged per T-015 task brief: the brief describes sourcing this from
 * `GET /permissions`, but T-007's backend (inspected for this task) exposes no such catalog
 * endpoint — `PermissionCatalog.All` is an in-process static list consumed only by
 * `PermissionCatalogSeeder`, never surfaced over HTTP. Rather than inventing a new backend
 * endpoint (out of scope for this frontend-only task) this module mirrors that same static list
 * client-side. If a real catalog endpoint is added later, this module is the single place to swap
 * the static array for a fetched one — no picker-rendering code depends on the data being static.
 *
 * F-050 drift guard: rather than adding an unused/premature backend endpoint just to remove this
 * static mirror, the drift risk is closed by
 * `src/api/tests/QuoteIQ.Domain.Tests/Security/PermissionCatalogDriftGuardTests.cs`, which fails the
 * backend build the moment this file's code set diverges from `PermissionCatalog.All` (missing or
 * extra codes), so any future backend catalog change is caught in CI rather than discovered as a
 * silently-broken picker.
 */
export interface PermissionCatalogEntry {
  code: string;
  category: string;
  description: string;
}

export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { code: 'tenants.view', category: 'tenants', description: 'View tenant' },
  { code: 'tenants.create', category: 'tenants', description: 'Create tenant' },
  { code: 'tenants.edit', category: 'tenants', description: 'Edit tenant' },
  { code: 'tenants.deactivate', category: 'tenants', description: 'Deactivate/remove tenant' },
  { code: 'tenants.restore', category: 'tenants', description: 'Restore a removed tenant' },
  { code: 'tenants.view_removed', category: 'tenants', description: 'View removed tenants' },
  { code: 'tenants.manage_settings', category: 'tenants', description: 'Manage tenant settings' },

  { code: 'users.view', category: 'users', description: 'View users' },
  { code: 'users.invite', category: 'users', description: 'Invite/create user' },
  { code: 'users.edit', category: 'users', description: 'Edit user' },
  { code: 'users.deactivate', category: 'users', description: 'Deactivate user' },
  { code: 'users.assign_tenant', category: 'users', description: 'Assign user to tenant' },
  { code: 'users.assign_role', category: 'users', description: 'Assign role to user' },
  { code: 'users.assign_group', category: 'users', description: 'Assign user to group' },
  { code: 'users.grant_direct_permission', category: 'users', description: 'Grant direct permission to user' },

  { code: 'roles.view', category: 'roles', description: 'View roles' },
  { code: 'roles.manage', category: 'roles', description: 'Create, edit, and disable roles' },

  { code: 'groups.view', category: 'groups', description: 'View user groups' },
  { code: 'groups.manage', category: 'groups', description: 'Create, edit, and disable user groups' },

  { code: 'leads.create', category: 'leads', description: 'Create lead' },
  { code: 'leads.view', category: 'leads', description: 'View lead' },
  { code: 'leads.view_all', category: 'leads', description: 'View all tenant leads' },
  { code: 'leads.update', category: 'leads', description: 'Update lead' },
  { code: 'leads.assign', category: 'leads', description: 'Assign/reassign lead' },
  { code: 'leads.close', category: 'leads', description: 'Close lead' },
  { code: 'leads.delete', category: 'leads', description: 'Delete/void lead' },
  { code: 'leads.export', category: 'leads', description: 'Export leads' },
  { code: 'leads.reassign', category: 'leads', description: 'Bulk reassign leads' },
  { code: 'leads.correct_closed', category: 'leads', description: 'Correct a closed lead' },
  { code: 'leads.reopen', category: 'leads', description: 'Reopen a closed lead' },

  { code: 'parties.create', category: 'parties', description: 'Create party' },
  { code: 'parties.view', category: 'parties', description: 'View party' },
  { code: 'parties.update', category: 'parties', description: 'Update party' },
  { code: 'parties.export', category: 'parties', description: 'Export parties' },

  { code: 'quotes.create', category: 'quotes', description: 'Create quote' },
  { code: 'quotes.view', category: 'quotes', description: 'View quote' },
  { code: 'quotes.view_all', category: 'quotes', description: 'View all tenant quotes' },
  { code: 'quotes.update', category: 'quotes', description: 'Update quote' },
  { code: 'quotes.revise', category: 'quotes', description: 'Revise quote' },
  { code: 'quotes.mark_sent', category: 'quotes', description: 'Mark quote sent' },
  { code: 'quotes.close_won', category: 'quotes', description: 'Close quote won' },
  { code: 'quotes.close_lost', category: 'quotes', description: 'Close quote lost' },
  { code: 'quotes.export', category: 'quotes', description: 'Export quotes' },
  { code: 'quotes.assign', category: 'quotes', description: 'Assign/reassign quote' },
  { code: 'quotes.withdraw', category: 'quotes', description: 'Withdraw quote' },
  { code: 'quotes.correct_closed', category: 'quotes', description: 'Correct a closed quote' },
  { code: 'quotes.set_current', category: 'quotes', description: 'Set the current quote for a lead' },

  { code: 'pricing.request', category: 'pricing', description: 'Request pricing approval' },
  { code: 'pricing.approve', category: 'pricing', description: 'Approve pricing' },
  { code: 'pricing.reject', category: 'pricing', description: 'Reject pricing' },

  { code: 'brokers.view', category: 'brokers', description: 'View brokers' },
  { code: 'brokers.manage', category: 'brokers', description: 'Manage brokers' },
  { code: 'brokers.manage_api_access', category: 'brokers', description: 'Manage broker API access' },
  { code: 'brokers.view_performance', category: 'brokers', description: 'View broker performance' },

  { code: 'reference_data.manage', category: 'reference_data', description: 'Manage tenant reference data lists' },

  { code: 'business_rules.view', category: 'business_rules', description: 'View tenant business rules' },
  { code: 'business_rules.manage', category: 'business_rules', description: 'Manage tenant business rules' },

  { code: 'business_assignments.view', category: 'business_assignments', description: 'View business assignment configuration' },
  { code: 'business_assignments.manage', category: 'business_assignments', description: 'Manage business assignment configuration' },

  { code: 'api_access.view', category: 'api_access', description: 'View API credentials' },
  { code: 'api_access.enable', category: 'api_access', description: 'Enable API access' },
  { code: 'api_access.disable', category: 'api_access', description: 'Disable API access' },
  { code: 'api_access.regenerate_secret', category: 'api_access', description: 'Regenerate API credential secret' },

  { code: 'dashboards.view_executive', category: 'dashboards', description: 'View executive overview dashboard' },
  { code: 'dashboards.view_pipeline', category: 'dashboards', description: 'View pipeline & conversion dashboard' },
  { code: 'dashboards.view_broker_performance', category: 'dashboards', description: 'View broker performance dashboard' },
  { code: 'dashboards.view_rm_performance', category: 'dashboards', description: 'View RM performance dashboard' },
  { code: 'dashboards.view_loss_analysis', category: 'dashboards', description: 'View loss analysis dashboard' },

  { code: 'reports.view', category: 'reports', description: 'View reports' },
  { code: 'reports.export', category: 'reports', description: 'Export reports' },

  { code: 'alerts.view', category: 'alerts', description: 'View alerts' },
  { code: 'alerts.assign_owner', category: 'alerts', description: 'Assign alert owner' },
  { code: 'alerts.escalate', category: 'alerts', description: 'Escalate alert' },
  { code: 'alerts.resolve', category: 'alerts', description: 'Clear/resolve alert' },

  { code: 'audit.view', category: 'audit', description: 'View tenant audit history' },

  { code: 'global.view_any_tenant', category: 'global', description: 'View and switch into any tenant' },
  { code: 'global.manage_templates', category: 'global', description: 'Manage global default templates' },
  { code: 'global.cross_tenant_reporting', category: 'global', description: 'View cross-tenant reporting' },
  { code: 'global.cross_tenant_audit_access', category: 'global', description: 'View cross-tenant audit history' },
  { code: 'global.cross_tenant_export', category: 'global', description: 'Export data under a cross-tenant context' },
  { code: 'global.manage_global_defaults', category: 'global', description: 'Manage global default platform data' },
];

const DESCRIPTION_BY_CODE = new Map(PERMISSION_CATALOG.map((entry) => [entry.code, entry.description]));

/**
 * User-friendly display name for a permission code (its catalog description), falling back to the
 * raw code for anything not in the catalog so unknown/server-added codes still render.
 */
export function permissionDescription(code: string): string {
  return DESCRIPTION_BY_CODE.get(code) ?? code;
}

/** Human-readable form of a catalog category slug: `business_rules` -> `Business rules`. */
export function formatPermissionCategory(category: string): string {
  const words = category.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Groups the flat catalog into `{ category -> entries[] }`, preserving catalog order within each group. */
export function groupPermissionsByCategory(
  catalog: PermissionCatalogEntry[] = PERMISSION_CATALOG,
): Array<{ category: string; entries: PermissionCatalogEntry[] }> {
  const order: string[] = [];
  const byCategory = new Map<string, PermissionCatalogEntry[]>();
  for (const entry of catalog) {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, []);
      order.push(entry.category);
    }
    byCategory.get(entry.category)!.push(entry);
  }
  return order.map((category) => ({ category, entries: byCategory.get(category)! }));
}
