/**
 * Session bootstrap: the data behind `GET /me` and `PUT /me/preferences` (T-015, AC-025, AC-027,
 * AC-034; P-01, spec §12).
 *
 * Port of:
 *   src/api/QuoteIQ.Application/Features/Me/GetMe/GetMeQueryHandler.cs
 *   src/api/QuoteIQ.Infrastructure/Security/UserTenantMembershipReader.cs
 *   src/api/QuoteIQ.Application/Features/Me/SetPreferences/SetMePreferencesCommandHandler.cs
 *   src/api/QuoteIQ.Infrastructure/Security/UserPreferencesStore.cs
 *
 * THREE THINGS HERE ARE LOAD-BEARING AND EASY TO GET WRONG
 * =======================================================
 *
 * 1. PERMISSIONS ARE PER MEMBERSHIP, NOT "FOR THE ACTIVE TENANT". Each membership carries the
 *    effective set resolved IN THAT TENANT (GetMeQueryHandler.cs:53-62). The SPA picks the active
 *    tenant's entry out of the array (sessionSlice.ts:145-149) — so returning one shared set, or
 *    the same set for every tenant, hands a user tenant A's capabilities while they are in tenant B.
 *
 * 2. THE GRANT GRAPH IS LOADED ONCE. The reference called `IEffectivePermissionResolver.ResolveAsync`
 *    inside the membership loop — one query per tenant, an N+1 that its request-scoped memo only
 *    partly hid. `loadGrantGraph` here is tenant-independent by design (see rbac/repository.ts), so
 *    one round trip feeds every scope, and `createEffectiveAccess` applies the tenant predicate
 *    purely. This is a shape improvement, not a behaviour change: same sets, fewer queries.
 *
 * 3. NOTHING IS CACHED ACROSS REQUESTS (N-02). There is no module-level state in this file. A warm
 *    Vercel instance is shared by every subsequent caller, so a memo up here would serve one user's
 *    memberships and permissions to the next one.
 *
 * WHY THESE QUERIES ARE NOT `forTenant`-SCOPED
 * ===========================================
 * `user_tenants` and `tenant_settings` are tenant-scoped tables, but `/me` is a GLOBAL route
 * (lib/tenancy/context.ts `GLOBAL_ROUTE_PREFIXES`) whose entire job is to enumerate the tenants a
 * caller may enter — it has no single tenant to scope to. The reference needed an explicit
 * `IgnoreQueryFilters()` for exactly this reason (UserTenantMembershipReader.cs:24-38). The
 * isolation guarantee here comes from the `user_id = $1` predicate: a caller can only ever see
 * their OWN membership rows, and the display-currency columns of tenants they already belong to.
 *
 * DELIBERATE DIVERGENCE FROM THE REFERENCE: REMOVED TENANTS ARE EXCLUDED
 * =====================================================================
 * The reference joined `Tenants` with no status predicate and no soft-delete query filter (there is
 * exactly one `HasQueryFilter` in QuoteIqDbContext.cs:580 and it is the tenant-scoping one), so a
 * member of a soft-removed tenant got that tenant back in `/me` — and then a 403 from
 * `TenantAccessValidator` on every request made in it (access.ts step 2). The approved spec fixes
 * that: AC-025 requires memberships "excluding removed tenants", AC-027 requires removed tenants to
 * be "excluded from GET /me tenant choices", and V-032 pins it as a negative test. The `status`
 * predicate below is that fix, and it is asserted in me.test.ts.
 */
import {
  createEffectiveAccess,
  type GrantGraph,
  type GrantGraphLoader,
} from '../rbac/index.js';
import { toTenantId, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import type { TenantAccessValidator } from '../../lib/tenancy/index.js';
import type { MeMembershipDto, MeResponseDto, SetMePreferencesInput } from './me.schemas.js';

export interface MeDeps {
  readonly db: DbExecutor;
  readonly loadGrantGraph: GrantGraphLoader;
  /**
   * The SAME validator the tenant-context middleware uses (T-013). Sharing it is the point: a
   * caller must not be able to persist a `lastTenantId` they would then be refused entry to, and a
   * second, independently-written membership check is how those two rules drift apart.
   */
  readonly validateTenantAccess: TenantAccessValidator;
}

/** Only ever `'active'` reaches the switcher; see the header note on removed tenants. */
const ACTIVE_TENANT_STATUS = 'active';

/**
 * The reference's fallback when a tenant has no `tenant_settings` row
 * (UserTenantMembershipReader.cs:47). A provisioning gap must not blank out the currency or, worse,
 * drop the membership entirely — hence a LEFT join with defaults rather than an inner join.
 */
const DEFAULT_CURRENCY_CODE = 'BWP';
const DEFAULT_CURRENCY_SYMBOL = 'BWP';

interface UserProfileRow {
  readonly id: number;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly last_tenant_id: number | null;
  readonly theme_preference: string | null;
}

interface MembershipRow {
  readonly tenant_id: number;
  readonly tenant_name: string;
  readonly currency_code: string | null;
  readonly currency_symbol: string | null;
}

/**
 * Ordinal (code-unit) ordering, matching `OrderBy(p => p, StringComparer.Ordinal)`
 * (GetMeQueryHandler.cs:60,74). JavaScript's default array sort compares UTF-16 code units, which is
 * the same order — `localeCompare` is NOT, and would reorder codes across locales.
 */
function ordinalSorted(permissions: ReadonlySet<string>): string[] {
  return [...permissions].sort();
}

function permissionsFor(graph: GrantGraph, tenantId: TenantId | null): string[] {
  return ordinalSorted(createEffectiveAccess(graph, { tenantId }).permissions);
}

async function loadProfile(
  deps: MeDeps,
  userId: number,
): Promise<UserProfileRow | undefined> {
  return await deps.db
    .selectFrom('users')
    .select(['id', 'email', 'first_name', 'last_name', 'last_tenant_id', 'theme_preference'])
    .where('id', '=', userId)
    .executeTakeFirst();
}

async function loadMemberships(deps: MeDeps, userId: number): Promise<MembershipRow[]> {
  return await deps.db
    .selectFrom('user_tenants')
    .innerJoin('tenants', 'tenants.id', 'user_tenants.tenant_id')
    .leftJoin('tenant_settings', 'tenant_settings.tenant_id', 'user_tenants.tenant_id')
    .select([
      'tenants.id as tenant_id',
      'tenants.name as tenant_name',
      'tenant_settings.currency_code as currency_code',
      'tenant_settings.currency_symbol as currency_symbol',
    ])
    .where('user_tenants.user_id', '=', userId)
    .where('tenants.status', '=', ACTIVE_TENANT_STATUS)
    // `orderby t.Name` (UserTenantMembershipReader.cs:50) — the switcher renders this order.
    .orderBy('tenants.name')
    .execute();
}

/**
 * The `/me` payload for an authenticated caller, or `undefined` when no `users` row matches.
 *
 * A zero-membership Internal user is NOT a failure case: `memberships` comes back empty and
 * `globalPermissions` carries their tenant-less grants, which is precisely what lets the shell
 * render Tenant Manager for them (spec FR-16; GetMeQuery.cs:17-24). Any "no memberships, so bail
 * out" short-circuit added here would silently lock that persona out of the product.
 */
export async function getMe(deps: MeDeps, userId: number): Promise<MeResponseDto | undefined> {
  const profile = await loadProfile(deps, userId);
  if (profile === undefined) return undefined;

  const [membershipRows, graph] = await Promise.all([
    loadMemberships(deps, userId),
    deps.loadGrantGraph(userId),
  ]);

  const memberships: MeMembershipDto[] = membershipRows.map((row) => ({
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    currencyCode: row.currency_code ?? DEFAULT_CURRENCY_CODE,
    currencySymbol: row.currency_symbol ?? DEFAULT_CURRENCY_SYMBOL,
    effectivePermissions: permissionsFor(graph, toTenantId(row.tenant_id)),
  }));

  return {
    userId: profile.id,
    email: profile.email,
    firstName: profile.first_name,
    lastName: profile.last_name,
    lastTenantId: profile.last_tenant_id,
    themePreference: profile.theme_preference,
    memberships,
    // Tenant-less grants only: resolving in the global scope matches rows whose own scope is null
    // (effective-permissions.ts `scopeApplies`), which is what an Internal user's set is made of.
    globalPermissions: permissionsFor(graph, null),
  };
}

export type SetPreferencesOutcome = 'ok' | 'tenant_not_permitted';

/**
 * Persists the caller's preferences (SetMePreferencesCommandHandler.cs:47-77).
 *
 * `lastTenantId` IS NEVER TRUSTED. It arrives from the browser and is checked against the caller's
 * real access before it is written — a member, or an Internal `global.view_any_tenant` holder, who
 * may legitimately switch into a tenant they are not a member of (spec §5.3). A removed tenant
 * fails the validator's status check and is refused, so a caller cannot pin themselves to a tenant
 * they would be denied entry to on the next request.
 *
 * Null/omitted fields leave the stored value alone (UserPreferencesStore.cs:27-35) — the tenant
 * switcher sends `lastTenantId` on its own and must not clear the theme as a side effect.
 */
export async function setMePreferences(
  deps: MeDeps,
  userId: number,
  input: SetMePreferencesInput,
): Promise<SetPreferencesOutcome> {
  const lastTenantId = input.lastTenantId ?? null;
  const themePreference = input.themePreference ?? null;

  if (lastTenantId !== null) {
    const access = await deps.validateTenantAccess(userId, lastTenantId);
    if (access.result !== 'ok') return 'tenant_not_permitted';
  }

  if (lastTenantId === null && themePreference === null) return 'ok';

  await deps.db
    .updateTable('users')
    .set({
      ...(lastTenantId === null ? {} : { last_tenant_id: lastTenantId }),
      ...(themePreference === null ? {} : { theme_preference: themePreference }),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', userId)
    .execute();

  return 'ok';
}
