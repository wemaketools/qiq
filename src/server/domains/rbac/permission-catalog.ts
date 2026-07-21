/**
 * The fixed permission catalog (T-012, P-03/FR-12), ported from
 * `src/api/QuoteIQ.Domain/Security/PermissionCatalog.cs` and kept byte-identical to the codes
 * seeded by `supabase/seed.sql` (T-006).
 *
 * There is no free-form permission creation anywhere in the product, so this list is exhaustive by
 * design and `PermissionCode` can be a literal union. That union is the point: a route guarded with
 * a typo'd or invented code is a COMPILE error, not a route that silently never authorizes anyone.
 * `src/server/tests/unit/permission-catalog.test.ts` additionally pins this list against seed.sql,
 * and the integration suite pins it against the seeded database — the TypeScript constant, the SQL
 * seed and the live table cannot drift apart without a red test (the .NET reference guarded the
 * same invariant with PermissionCatalogDriftGuardTests).
 */

/** All 81 permission codes, in seed order. */
export const PERMISSION_CODES = [
  'tenants.view',
  'tenants.create',
  'tenants.edit',
  'tenants.deactivate',
  'tenants.restore',
  'tenants.view_removed',
  'tenants.manage_settings',
  'users.view',
  'users.invite',
  'users.edit',
  'users.deactivate',
  'users.assign_tenant',
  'users.assign_role',
  'users.assign_group',
  'users.grant_direct_permission',
  'roles.view',
  'roles.manage',
  'groups.view',
  'groups.manage',
  'leads.create',
  'leads.view',
  'leads.view_all',
  'leads.update',
  'leads.assign',
  'leads.close',
  'leads.delete',
  'leads.export',
  'leads.reassign',
  'leads.correct_closed',
  'leads.reopen',
  'parties.create',
  'parties.view',
  'parties.update',
  'parties.export',
  'quotes.create',
  'quotes.view',
  'quotes.view_all',
  'quotes.update',
  'quotes.revise',
  'quotes.mark_sent',
  'quotes.close_won',
  'quotes.close_lost',
  'quotes.export',
  'quotes.assign',
  'quotes.withdraw',
  'quotes.correct_closed',
  'quotes.set_current',
  'pricing.request',
  'pricing.approve',
  'pricing.reject',
  'brokers.view',
  'brokers.manage',
  'brokers.manage_api_access',
  'brokers.view_performance',
  'reference_data.manage',
  'business_rules.view',
  'business_rules.manage',
  'business_assignments.view',
  'business_assignments.manage',
  'api_access.view',
  'api_access.enable',
  'api_access.disable',
  'api_access.regenerate_secret',
  'dashboards.view_executive',
  'dashboards.view_pipeline',
  'dashboards.view_broker_performance',
  'dashboards.view_rm_performance',
  'dashboards.view_loss_analysis',
  'reports.view',
  'reports.export',
  'alerts.view',
  'alerts.assign_owner',
  'alerts.escalate',
  'alerts.resolve',
  'audit.view',
  'global.view_any_tenant',
  'global.manage_templates',
  'global.cross_tenant_reporting',
  'global.cross_tenant_audit_access',
  'global.cross_tenant_export',
  'global.manage_global_defaults',
] as const;

/** A code that exists in the catalog. Guards and grants are typed with this, never with `string`. */
export type PermissionCode = (typeof PERMISSION_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set<string>(PERMISSION_CODES);

/** Narrows an arbitrary string (a seeded row, an API payload) to a catalog code. */
export function isPermissionCode(value: string): value is PermissionCode {
  return CODE_SET.has(value);
}

/**
 * Permissions that widen RECORD-LEVEL VISIBILITY rather than granting an operation (P-03:
 * "visibility-breadth permissions (`leads.view_all`-style) enforced in query filters").
 *
 * These are deliberately surfaced as a named capability instead of being checked ad hoc with a
 * string literal at each call site. In the reference, every dashboard/search/export store took a
 * `callerHasViewAll` boolean derived from exactly this check
 * (`GetDrillQueryHandler.cs:45`, `ExportDrillQueryHandler.cs:54`, `DrillCallerContext.cs:9`), and
 * the later query-filter tasks (P-03/P-08) consume the same seam here via
 * `EffectiveAccess.canViewAll(domain)`.
 */
export const VISIBILITY_BREADTH_PERMISSIONS = {
  leads: 'leads.view_all',
  quotes: 'quotes.view_all',
} as const satisfies Readonly<Record<string, PermissionCode>>;

/** A domain whose record-level visibility can be widened by a breadth permission. */
export type VisibilityDomain = keyof typeof VISIBILITY_BREADTH_PERMISSIONS;
