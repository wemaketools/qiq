/**
 * Static demo catalog (T-041): the fixed inputs the plan generator draws from — tenants, personas,
 * roles, and the per-tenant reference-data lists — plus the deterministic id scheme that makes the
 * whole seed reproducible and idempotent.
 *
 * WHY EXPLICIT IDS
 * ================
 * Every demo row is inserted with an explicit primary key via `OVERRIDING SYSTEM VALUE`, drawn from
 * the bases below. Two consequences, both load-bearing for AC-085/AC-086:
 *   - re-running converges to a BYTE-identical dataset (ids included), because delete-then-reinsert
 *     reproduces the same keys rather than advancing an identity sequence;
 *   - the plan can wire foreign keys in memory (a lead's `status_id`, a quote's `lead_id`) without a
 *     round trip to learn a generated id.
 * The bases sit far above any organically-generated id (sequences start at 1), so demo rows never
 * collide with rows integration tests create, and `DEMO_ID_BASE` is the single predicate every
 * idempotency delete keys on.
 *
 * REFERENCE LISTS ARE SELF-CONTAINED, NOT COPIED FROM THE TEMPLATE
 * ===============================================================
 * The names below mirror the global default template (supabase/seed.sql), but the demo tenants own
 * their reference lists outright — a tenant is *meant* to be able to customise them — so the demo
 * defines its own, and additionally supplies cover types (which the global template deliberately
 * omits, DefaultReferenceData.cs). The guarded lead/quote statuses carry the SAME canonical keys and
 * reporting categories as the template, because dashboards and alert rules resolve statuses by
 * canonical key: a divergent key here would silently break every conversion metric.
 */

export const DEMO_ID_BASE = 900_000_000;

/** Bases for the two GLOBAL (non-partitioned) demo tables and their join tables. */
export const GLOBAL_ID = {
  tenant: DEMO_ID_BASE, // + tenant index (1..2)
  user: DEMO_ID_BASE + 1_000,
  role: DEMO_ID_BASE + 2_000,
  group: DEMO_ID_BASE + 3_000,
  jobRun: DEMO_ID_BASE + 4_000,
  rolePermission: DEMO_ID_BASE + 100_000,
  userRole: DEMO_ID_BASE + 200_000,
  userPermission: DEMO_ID_BASE + 300_000,
  groupMember: DEMO_ID_BASE + 400_000,
  groupRole: DEMO_ID_BASE + 500_000,
  groupPermission: DEMO_ID_BASE + 600_000,
} as const;

/**
 * Per-tenant id offsets for the partitioned tables. A row's id is
 * `DEMO_ID_BASE + tenantIndex * TENANT_ID_STRIDE + offset + localIndex`.
 * The stride (20M) exceeds the largest offset (< 16M), so two tenants never share an id on the
 * same partitioned parent even though the identity sequence is shared across partitions.
 */
export const TENANT_ID_STRIDE = 20_000_000;
export const ENTITY_OFFSET = {
  referenceItem: 0,
  party: 1_000_000,
  broker: 2_000_000,
  brokerContact: 3_000_000,
  lead: 4_000_000,
  leadAssignment: 5_000_000,
  leadNote: 6_000_000,
  leadHistory: 7_000_000,
  followUp: 8_000_000,
  pricingApproval: 9_000_000,
  quote: 10_000_000,
  quoteVersion: 11_000_000,
  quoteAssignment: 12_000_000,
  quoteHistory: 13_000_000,
  businessAssignment: 15_000_000,
  referenceSequence: 15_100_000,
  tenantSettings: 15_200_000,
  userTenant: 15_300_000,
} as const;

export function tenantEntityId(
  tenantIndex: number,
  offset: number,
  localIndex: number,
): number {
  return DEMO_ID_BASE + tenantIndex * TENANT_ID_STRIDE + offset + localIndex;
}

// ---------------------------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------------------------

export interface TenantDef {
  readonly index: number; // 1-based
  readonly id: number;
  readonly name: string;
  /** numeric(18,2) as a string; the high-value classification threshold. Non-null on purpose so
   *  the high-value dashboards and the high_value_stalled/executive_escalation alerts have targets. */
  readonly highValueThreshold: string;
  readonly currencyCode: string;
  readonly currencySymbol: string;
}

export const TENANTS: readonly TenantDef[] = [
  {
    index: 1,
    id: GLOBAL_ID.tenant + 1,
    name: 'Kalahari Insurance (Pilot)',
    highValueThreshold: '500000.00',
    currencyCode: 'BWP',
    currencySymbol: 'BWP',
  },
  {
    index: 2,
    id: GLOBAL_ID.tenant + 2,
    name: 'Okavango Risk Partners',
    highValueThreshold: '750000.00',
    currencyCode: 'BWP',
    currencySymbol: 'BWP',
  },
];

// ---------------------------------------------------------------------------------------------
// Roles (per tenant) and the internal/global role
// ---------------------------------------------------------------------------------------------

/**
 * The Internal/global-only permission domains (CLAUDE.md "Global/Internal domains include: Tenants...
 * Internal/global permissions... Cross-tenant oversight"; PermissionCatalog.cs `Global` +
 * `Tenants` categories). These are NOT grantable to a tenant-level administrator: a tenant admin
 * manages users/roles/reference-data/brokers WITHIN its tenant, while managing tenants themselves
 * and cross-tenant oversight belongs to Internal users only.
 *
 * The concrete symptom this boundary prevents (F-041-4 / F-043-2 / F-043-6): the Tenant Manager nav
 * gates on `tenants.view`, but GET /api/v1/tenants resolves `tenants.view` in the GLOBAL scope
 * (tenants/routes.ts: require-permission tenantScopeOf) — so a tenant admin granted tenant-scoped
 * `tenants.view` renders the nav yet the endpoint correctly 403s, the AC-083-forbidden mismatch.
 * Excluding these prefixes from the tenant admin role hides the nav to match the enforcement.
 */
export const INTERNAL_ONLY_PERMISSION_PREFIXES = ['tenants.', 'global.'] as const;

/** True when `code` is an Internal/global-only permission (see INTERNAL_ONLY_PERMISSION_PREFIXES). */
export function isInternalOnlyPermission(code: string): boolean {
  return INTERNAL_ONLY_PERMISSION_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * Demo role definitions. `permissions` selects the grant set resolved at apply time from the seeded
 * `permissions` table (so it stays correct as the catalog evolves):
 *   - `'all'`        — the whole catalog, including Internal/global codes; only for an Internal role.
 *   - `'tenant_all'` — every catalog code EXCEPT the Internal/global-only ones (isInternalOnlyPermission);
 *                      the correct ceiling for a tenant-level administrator.
 *   - an explicit list — used verbatim.
 */
export interface RoleDef {
  readonly key: string;
  readonly name: string;
  readonly permissions: 'all' | 'tenant_all' | readonly string[];
  /** When true the role is created once with tenant_id NULL (a global/Internal role). */
  readonly global?: boolean;
}

export const TENANT_ROLES: readonly RoleDef[] = [
  // TENANT-scoped admin: the full tenant capability set, but NOT tenants.*/global.* (those are
  // Internal-only). The Internal persona gets those separately via INTERNAL_ROLE (a global role).
  { key: 'admin', name: 'Tenant Administrator', permissions: 'tenant_all' },
  {
    key: 'sales_manager',
    name: 'Sales Manager',
    permissions: [
      'leads.view',
      'leads.view_all',
      'leads.create',
      'leads.update',
      'leads.assign',
      'leads.reassign',
      'leads.close',
      'leads.export',
      'quotes.view',
      'quotes.view_all',
      'quotes.create',
      'quotes.update',
      'quotes.revise',
      'quotes.mark_sent',
      'quotes.close_won',
      'quotes.close_lost',
      'parties.view',
      'parties.create',
      'parties.update',
      'brokers.view',
      'brokers.view_performance',
      'dashboards.view_executive',
      'dashboards.view_pipeline',
      'dashboards.view_broker_performance',
      'dashboards.view_rm_performance',
      'dashboards.view_loss_analysis',
      'reports.view',
      'reports.export',
      'alerts.view',
      'alerts.assign_owner',
      'alerts.resolve',
    ],
  },
  {
    key: 'relationship_manager',
    name: 'Relationship Manager',
    permissions: [
      'leads.view',
      'leads.create',
      'leads.update',
      'quotes.view',
      'quotes.create',
      'quotes.update',
      'quotes.revise',
      'quotes.mark_sent',
      'parties.view',
      'parties.create',
      'parties.update',
      'brokers.view',
      'dashboards.view_pipeline',
      'alerts.view',
    ],
  },
  {
    key: 'underwriter',
    name: 'Underwriter',
    permissions: [
      'leads.view',
      'leads.view_all',
      'leads.update',
      'quotes.view',
      'quotes.view_all',
      'quotes.update',
      'quotes.revise',
      'pricing.request',
      'pricing.approve',
      'pricing.reject',
      'dashboards.view_pipeline',
      'alerts.view',
    ],
  },
  {
    key: 'executive',
    name: 'Executive',
    permissions: [
      'leads.view',
      'leads.view_all',
      'quotes.view',
      'quotes.view_all',
      'dashboards.view_executive',
      'dashboards.view_pipeline',
      'dashboards.view_broker_performance',
      'dashboards.view_rm_performance',
      'dashboards.view_loss_analysis',
      'reports.view',
      'alerts.view',
      'audit.view',
    ],
  },
];

export const INTERNAL_ROLE: RoleDef = {
  key: 'internal_ops',
  name: 'Internal Operations',
  global: true,
  permissions: [
    'global.view_any_tenant',
    'global.cross_tenant_reporting',
    'global.cross_tenant_audit_access',
    'global.manage_templates',
    'global.manage_global_defaults',
    'tenants.view',
    'tenants.create',
    'tenants.edit',
    'tenants.deactivate',
    'tenants.restore',
    'tenants.view_removed',
    'users.view',
    'users.invite',
    'users.edit',
  ],
};

// ---------------------------------------------------------------------------------------------
// Personas (demo users)
// ---------------------------------------------------------------------------------------------

/**
 * The shared demo password for a LOCAL stack. Committed on purpose: it is documented in the README
 * and driven by the e2e suite, and a local Supabase stack grants nothing beyond the machine it runs
 * on. It must be at least `minimum_password_length` (6, supabase/config.toml) or the Auth Admin API
 * rejects the create, and well under GoTrue's 72-byte bcrypt cap.
 *
 * It is NOT a default for anywhere else. A hosted environment is reachable by anyone who learns its
 * URL, and this value is in the repository — see `resolveDemoPassword`.
 */
export const LOCAL_DEMO_PASSWORD = 'test1234';

export type DemoPasswordDecision =
  | { readonly ok: true; readonly password: string; readonly source: 'configured' | 'local-default' }
  | { readonly ok: false; readonly reason: string };

/**
 * Decides which password the demo personas get, and REFUSES rather than falling back to the
 * committed one outside local.
 *
 * The seed re-asserts every persona's password on each run (auth-users.ts), which is what makes a
 * rotated demo credential "heal" locally — and what silently re-published a known password on a
 * hosted environment every time anyone re-seeded it. Requiring DEMO_SEED_PASSWORD away from local
 * is what stops a re-seed from undoing a rotation.
 *
 * Pure, so the branch that matters can be tested exhaustively without a database or a stack.
 */
export function resolveDemoPassword(appEnv: string, configured: string | null): DemoPasswordDecision {
  const trimmed = configured?.trim() ?? '';
  if (trimmed !== '') return { ok: true, password: trimmed, source: 'configured' };

  if (appEnv === 'local') {
    return { ok: true, password: LOCAL_DEMO_PASSWORD, source: 'local-default' };
  }

  return {
    ok: false,
    reason:
      `Refusing to seed demo personas into "${appEnv}" with the committed local password.\n` +
      `That value (${LOCAL_DEMO_PASSWORD}) is in the repository, and this seed re-asserts it on ` +
      'every run — so a rotated password would be undone and re-published each time.\n\n' +
      'Set DEMO_SEED_PASSWORD for this environment and re-run.',
  };
}

export interface PersonaDef {
  readonly key: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Tenant indexes (1..2) this user belongs to. Empty only for a pure-internal user. */
  readonly tenantIndexes: readonly number[];
  /** Role key per tenant membership; index-aligned with `tenantIndexes`. */
  readonly rolePerTenant: readonly string[];
  /** When true the user also holds the global Internal role (cross-tenant). */
  readonly internal?: boolean;
  /** The tenant index this user lands in after sign-in (last_tenant_id). Defaults to the first. */
  readonly lastTenantIndex?: number;
  readonly isActive?: boolean;
}

/**
 * Sixteen personas across the roles (AC-085: "15 users across roles"). The set is designed so the
 * T-043 e2e suite has the personas it needs: an internal multi-tenant admin, a two-tenant user, a
 * single-tenant user, RMs (assignment targets), an underwriter (pricing), and one deactivated user.
 */
export const PERSONAS: readonly PersonaDef[] = [
  {
    key: 'internal_admin',
    email: 'internal.admin@quoteiq.local',
    firstName: 'Ava',
    lastName: 'Molefe',
    tenantIndexes: [1, 2],
    rolePerTenant: ['admin', 'admin'],
    internal: true,
    lastTenantIndex: 1,
  },
  {
    key: 'pilot_admin',
    email: 'pilot.admin@quoteiq.local',
    firstName: 'Boitumelo',
    lastName: 'Seretse',
    tenantIndexes: [1],
    rolePerTenant: ['admin'],
  },
  {
    key: 'multi_manager',
    email: 'sales.manager@quoteiq.local',
    firstName: 'Kagiso',
    lastName: 'Dube',
    tenantIndexes: [1, 2],
    rolePerTenant: ['sales_manager', 'sales_manager'],
    lastTenantIndex: 1,
  },
  {
    key: 'exec',
    email: 'executive@quoteiq.local',
    firstName: 'Naledi',
    lastName: 'Khama',
    tenantIndexes: [1],
    rolePerTenant: ['executive'],
  },
  {
    key: 'rm1',
    email: 'rm.tebogo@quoteiq.local',
    firstName: 'Tebogo',
    lastName: 'Moremi',
    tenantIndexes: [1],
    rolePerTenant: ['relationship_manager'],
  },
  {
    key: 'rm2',
    email: 'rm.lorato@quoteiq.local',
    firstName: 'Lorato',
    lastName: 'Pheto',
    tenantIndexes: [1],
    rolePerTenant: ['relationship_manager'],
  },
  {
    key: 'rm3',
    email: 'rm.mpho@quoteiq.local',
    firstName: 'Mpho',
    lastName: 'Sekgoma',
    tenantIndexes: [1],
    rolePerTenant: ['relationship_manager'],
  },
  {
    key: 'uw1',
    email: 'uw.thabo@quoteiq.local',
    firstName: 'Thabo',
    lastName: 'Ramotswe',
    tenantIndexes: [1],
    rolePerTenant: ['underwriter'],
  },
  {
    key: 'uw2',
    email: 'uw.gorata@quoteiq.local',
    firstName: 'Gorata',
    lastName: 'Nkwe',
    tenantIndexes: [1],
    rolePerTenant: ['underwriter'],
  },
  {
    key: 'single_rm',
    email: 'rm.single@quoteiq.local',
    firstName: 'Onalenna',
    lastName: 'Botha',
    tenantIndexes: [1],
    rolePerTenant: ['relationship_manager'],
  },
  {
    key: 'partner_admin',
    email: 'partner.admin@quoteiq.local',
    firstName: 'Refilwe',
    lastName: 'Modise',
    tenantIndexes: [2],
    rolePerTenant: ['admin'],
    lastTenantIndex: 2,
  },
  {
    key: 'partner_manager',
    email: 'partner.manager@quoteiq.local',
    firstName: 'Kabelo',
    lastName: 'Tau',
    tenantIndexes: [2],
    rolePerTenant: ['sales_manager'],
    lastTenantIndex: 2,
  },
  {
    key: 'partner_rm1',
    email: 'partner.rm1@quoteiq.local',
    firstName: 'Sethunya',
    lastName: 'Kgosi',
    tenantIndexes: [2],
    rolePerTenant: ['relationship_manager'],
    lastTenantIndex: 2,
  },
  {
    key: 'partner_rm2',
    email: 'partner.rm2@quoteiq.local',
    firstName: 'Tumelo',
    lastName: 'Segwabe',
    tenantIndexes: [2],
    rolePerTenant: ['relationship_manager'],
    lastTenantIndex: 2,
  },
  {
    key: 'partner_uw',
    email: 'partner.uw@quoteiq.local',
    firstName: 'Bonolo',
    lastName: 'Mogami',
    tenantIndexes: [2],
    rolePerTenant: ['underwriter'],
    lastTenantIndex: 2,
  },
  {
    key: 'disabled_user',
    email: 'disabled.user@quoteiq.local',
    firstName: 'Kefilwe',
    lastName: 'Radipati',
    tenantIndexes: [1],
    rolePerTenant: ['relationship_manager'],
    isActive: false,
  },
];

// ---------------------------------------------------------------------------------------------
// Reference-data lists (per tenant). Statuses carry guarded canonical keys.
// ---------------------------------------------------------------------------------------------

export interface RefItemDef {
  readonly name: string;
  readonly isBrokerChannel?: boolean;
  readonly reportingCategory?: string;
  readonly canonicalKey?: string;
  readonly isTerminal?: boolean;
  /** For cover types: the product-line name this cover type belongs to. */
  readonly productLineName?: string;
}

export interface RefListDef {
  readonly listType: string;
  readonly items: readonly RefItemDef[];
}

export const LEAD_STATUS_KEYS = [
  'new',
  'assigned',
  'information_gathering',
  'underwriting',
  'pricing',
  'quote_sent',
  'negotiation',
  'closed_won',
  'closed_lost',
  'expired',
  'withdrawn',
] as const;

export const REFERENCE_LISTS: readonly RefListDef[] = [
  {
    listType: 'request_channel',
    items: [
      { name: 'Broker email', isBrokerChannel: true },
      { name: 'Direct client' },
      { name: 'RM referral' },
      { name: 'Phone' },
      { name: 'Portal', isBrokerChannel: true },
      { name: 'Renewal review' },
      { name: 'Other' },
    ],
  },
  {
    listType: 'product_line',
    items: [
      { name: 'Motor' },
      { name: 'Property' },
      { name: 'Liability' },
      { name: 'Engineering' },
      { name: 'Marine' },
      { name: 'Group Life' },
      { name: 'Health' },
      { name: 'Agriculture' },
      { name: 'Commercial Combined' },
      { name: 'Specialty Risks' },
    ],
  },
  {
    listType: 'cover_type',
    items: [
      { name: 'Comprehensive', productLineName: 'Motor' },
      { name: 'Third Party', productLineName: 'Motor' },
      { name: 'Fleet', productLineName: 'Motor' },
      { name: 'Buildings', productLineName: 'Property' },
      { name: 'Contents', productLineName: 'Property' },
      { name: 'Business Interruption', productLineName: 'Property' },
      { name: 'Public Liability', productLineName: 'Liability' },
      { name: 'Professional Indemnity', productLineName: 'Liability' },
      { name: 'Contractors All Risk', productLineName: 'Engineering' },
      { name: 'Plant & Machinery', productLineName: 'Engineering' },
      { name: 'Cargo', productLineName: 'Marine' },
      { name: 'Hull', productLineName: 'Marine' },
      { name: 'Scheme', productLineName: 'Group Life' },
      { name: 'Hospital Plan', productLineName: 'Health' },
      { name: 'Crop', productLineName: 'Agriculture' },
      { name: 'Livestock', productLineName: 'Agriculture' },
      { name: 'Package', productLineName: 'Commercial Combined' },
      { name: 'Bespoke', productLineName: 'Specialty Risks' },
    ],
  },
  {
    listType: 'party_type',
    items: [
      { name: 'Individual' },
      { name: 'SME' },
      { name: 'Corporate' },
      { name: 'Group' },
      { name: 'Government' },
      { name: 'Parastatal' },
      { name: 'Non-profit' },
    ],
  },
  {
    listType: 'industry',
    items: [
      { name: 'Agriculture' },
      { name: 'Mining' },
      { name: 'Logistics / Transport' },
      { name: 'Hospitality' },
      { name: 'Retail' },
      { name: 'Construction' },
      { name: 'Manufacturing' },
      { name: 'Financial Services' },
      { name: 'Public Sector' },
      { name: 'Professional Services' },
    ],
  },
  {
    listType: 'party_segment',
    items: [
      { name: 'Retail' },
      { name: 'SME' },
      { name: 'Corporate' },
      { name: 'Strategic Account' },
      { name: 'Specialty Risks' },
      { name: 'Public Sector' },
    ],
  },
  {
    listType: 'region',
    items: [
      { name: 'Gaborone' },
      { name: 'Francistown' },
      { name: 'Maun' },
      { name: 'Kasane' },
      { name: 'Lobatse' },
      { name: 'Palapye' },
      { name: 'Selebi-Phikwe' },
    ],
  },
  {
    listType: 'lead_status',
    items: [
      { name: 'New', reportingCategory: 'open', canonicalKey: 'new' },
      { name: 'Assigned', reportingCategory: 'open', canonicalKey: 'assigned' },
      { name: 'Information Gathering', reportingCategory: 'open', canonicalKey: 'information_gathering' },
      { name: 'Underwriting', reportingCategory: 'open', canonicalKey: 'underwriting' },
      { name: 'Pricing', reportingCategory: 'open', canonicalKey: 'pricing' },
      { name: 'Quote Sent', reportingCategory: 'quoted', canonicalKey: 'quote_sent' },
      { name: 'Negotiation', reportingCategory: 'quoted', canonicalKey: 'negotiation' },
      { name: 'Closed Won', reportingCategory: 'won', canonicalKey: 'closed_won', isTerminal: true },
      { name: 'Closed Lost', reportingCategory: 'lost', canonicalKey: 'closed_lost', isTerminal: true },
      { name: 'Expired', reportingCategory: 'expired', canonicalKey: 'expired', isTerminal: true },
      { name: 'Withdrawn', reportingCategory: 'withdrawn', canonicalKey: 'withdrawn', isTerminal: true },
    ],
  },
  {
    listType: 'quote_status',
    items: [
      { name: 'Draft', reportingCategory: 'open', canonicalKey: 'draft' },
      { name: 'Sent', reportingCategory: 'quoted', canonicalKey: 'sent' },
      { name: 'Revised', reportingCategory: 'quoted', canonicalKey: 'revised' },
      { name: 'Won', reportingCategory: 'won', canonicalKey: 'won', isTerminal: true },
      { name: 'Lost', reportingCategory: 'lost', canonicalKey: 'lost', isTerminal: true },
      { name: 'Expired', reportingCategory: 'expired', canonicalKey: 'expired', isTerminal: true },
      { name: 'Withdrawn', reportingCategory: 'withdrawn', canonicalKey: 'withdrawn', isTerminal: true },
    ],
  },
  {
    listType: 'broker_type',
    items: [
      { name: 'Tier 1 - strategic partner' },
      { name: 'Tier 2 - core partner' },
      { name: 'Tier 3 - occasional partner' },
      { name: 'Direct / non-intermediated' },
    ],
  },
  {
    listType: 'lost_reason',
    items: [
      { name: 'Pricing too high' },
      { name: 'Competitor won' },
      { name: 'Incumbent retained' },
      { name: 'Coverage gap' },
      { name: 'Terms not accepted' },
      { name: 'Underwriting declined' },
      { name: 'No response' },
      { name: 'Quote expired' },
      { name: 'Other' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Volume targets (AC-085 minimums; split so BOTH tenants render non-degenerate dashboards).
// ---------------------------------------------------------------------------------------------

export interface TenantVolumes {
  readonly parties: number;
  readonly brokers: number;
  readonly leads: number;
}

/** Index-aligned with TENANTS. Totals: 200 parties, 18 brokers, 300 leads (>= AC-085 minimums). */
export const TENANT_VOLUMES: readonly TenantVolumes[] = [
  { parties: 130, brokers: 12, leads: 195 },
  { parties: 70, brokers: 6, leads: 105 },
];
