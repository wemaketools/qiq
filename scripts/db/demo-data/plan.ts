/**
 * The demo data PLAN (T-041): a pure function of (seed, now) producing every demo row with explicit
 * ids and fully-wired foreign keys. Nothing here touches a database — that is `apply.ts`'s job — so
 * the whole dataset is unit-testable: volumes, the "every quote has a lead / exactly one current
 * version" invariants, and (decisively) that the seeded records satisfy the REAL alert-rule
 * predicates for every alert type.
 *
 * DATES ARE RELATIVE TO `now`, DISTRIBUTIONS ARE FROM A FIXED RNG
 * ==============================================================
 * A demo dated `now()` would fall into no aging bucket and light up no "current month" KPI, so the
 * generator spreads `date_received` across the trailing ~180 days with deliberate density in the
 * current calendar month (the dashboards' default period). The alert fixtures below are dated
 * against the SHIPPED default thresholds (tenant_settings defaults) so each of the eleven rules has
 * at least one guaranteed match after an evaluation run.
 */
import {
  ENTITY_OFFSET,
  GLOBAL_ID,
  INTERNAL_ROLE,
  isInternalOnlyPermission,
  PERSONAS,
  REFERENCE_LISTS,
  TENANTS,
  TENANT_ROLES,
  TENANT_VOLUMES,
  tenantEntityId,
  type PersonaDef,
  type RoleDef,
  type TenantDef,
} from './catalog.js';
import { Rng } from './rng.js';

const DEMO_SEED = 0x5175_0011; // "QU..IQ" — fixed so the plan is reproducible.

// ---------------------------------------------------------------------------------------------
// Row shapes (columns match the migrations; only what the seed writes).
// ---------------------------------------------------------------------------------------------

export interface TenantRow {
  readonly id: number;
  readonly name: string;
}
export interface TenantSettingsRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly currency_code: string;
  readonly currency_symbol: string;
  readonly high_value_threshold: string;
}
export interface RefItemRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly list_type: string;
  readonly name: string;
  readonly display_order: number;
  readonly is_broker_channel: boolean | null;
  readonly product_line_id: number | null;
  readonly reporting_category: string | null;
  readonly canonical_key: string | null;
  readonly is_terminal: boolean;
}
export interface RoleRow {
  readonly id: number;
  readonly tenant_id: number | null;
  readonly name: string;
}
export interface RolePermissionRow {
  readonly id: number;
  readonly role_id: number;
  readonly permission_code: string;
}
export interface GroupRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly name: string;
}
export interface GroupRoleRow {
  readonly id: number;
  readonly group_id: number;
  readonly role_id: number;
}
export interface GroupPermissionRow {
  readonly id: number;
  readonly group_id: number;
  readonly permission_code: string;
}
export interface GroupMemberRow {
  readonly id: number;
  readonly group_id: number;
  readonly user_id: number;
}
export interface UserRow {
  readonly id: number;
  readonly personaKey: string;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly is_active: boolean;
  readonly last_tenant_id: number | null;
}
export interface UserTenantRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly user_id: number;
}
export interface UserRoleRow {
  readonly id: number;
  readonly user_id: number;
  readonly role_id: number;
  readonly tenant_id: number | null;
}
export interface UserPermissionRow {
  readonly id: number;
  readonly user_id: number;
  readonly permission_code: string;
  readonly tenant_id: number | null;
}
export interface BusinessAssignmentRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly role_id: number;
  readonly slot: string;
}
export interface ReferenceSequenceRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly entity_type: string;
  readonly year: number;
  readonly next_value: number;
}
export interface PartyRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly name: string;
  readonly party_type_id: number;
  readonly segment_id: number | null;
  readonly industry_id: number | null;
  readonly region_id: number | null;
  readonly is_strategic: boolean;
  readonly contact_name: string;
  readonly contact_email: string;
  readonly contact_phone: string;
  readonly last_activity_at: string;
}
export interface BrokerRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly name: string;
  readonly broker_type_id: number;
  readonly branch: string;
  readonly status: string;
}
export interface BrokerContactRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly broker_id: number;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly is_primary: boolean;
}
export interface LeadRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly party_id: number;
  readonly lead_ref: string;
  readonly external_ref: string | null;
  readonly date_received: string;
  readonly request_channel_id: number;
  readonly broker_id: number | null;
  readonly region_id: number;
  readonly product_line_id: number;
  readonly cover_type_id: number;
  readonly sum_insured: string;
  readonly estimated_premium: string;
  readonly policy_term: string;
  readonly priority: string;
  readonly is_existing_client: boolean;
  readonly status_id: number;
  readonly pricing_approval_state: string;
  readonly date_assigned: string | null;
  readonly decision_date: string | null;
  readonly lost_reason_id: number | null;
  readonly loss_comments: string | null;
  readonly last_activity_at: string | null;
  readonly next_follow_up_date: string | null;
  readonly follow_up_count: number;
  readonly source: string;
  readonly created_at: string;
}
export interface LeadAssignmentRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly lead_id: number;
  readonly business_assignment_id: number;
  readonly user_id: number;
}
export interface LeadNoteRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly lead_id: number;
  readonly body: string;
  readonly created_at: string;
  readonly created_by: number;
}
export interface LeadHistoryRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly lead_id: number;
  readonly operation: string;
  readonly previous_status_id: number | null;
  readonly new_status_id: number | null;
  readonly acted_by: number;
  readonly acted_at: string;
}
export interface FollowUpRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly lead_id: number;
  readonly follow_up_date: string;
  readonly outcome_note: string;
  readonly next_follow_up_date: string | null;
  readonly logged_by: number;
  readonly logged_at: string;
}
export interface PricingApprovalRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly lead_id: number;
  readonly requested_by: number;
  readonly requested_at: string;
  readonly approver_id: number;
  readonly proposed_premium: string;
  readonly state: string;
  readonly decided_by: number | null;
  readonly decided_at: string | null;
}
export interface QuoteRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly lead_id: number;
  readonly quote_ref: string;
  readonly status_id: number;
  readonly is_current: boolean;
  readonly product_line_id: number;
  readonly cover_type_id: number;
  readonly prepared_date: string;
  readonly sent_date: string | null;
  readonly valid_until: string | null;
  readonly decision_date: string | null;
  readonly bound_premium: string | null;
  readonly created_at: string;
}
export interface QuoteVersionRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly quote_id: number;
  readonly version_no: number;
  readonly quoted_premium: string;
  readonly is_current: boolean;
  readonly created_at: string;
}
export interface QuoteAssignmentRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly quote_id: number;
  readonly business_assignment_id: number;
  readonly user_id: number;
}
export interface QuoteHistoryRow {
  readonly id: number;
  readonly tenant_id: number;
  readonly quote_id: number;
  readonly operation: string;
  readonly previous_status_id: number | null;
  readonly new_status_id: number | null;
  readonly acted_by: number;
  readonly acted_at: string;
}
export interface JobRunRow {
  readonly id: number;
  readonly job_name: string;
  readonly trigger: string;
  readonly environment: string;
  readonly correlation_id: string;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly counts: string;
}

export interface DemoPlan {
  readonly password: string;
  readonly tenants: TenantRow[];
  readonly tenantSettings: TenantSettingsRow[];
  readonly referenceItems: RefItemRow[];
  readonly roles: RoleRow[];
  readonly rolePermissions: RolePermissionRow[];
  readonly groups: GroupRow[];
  readonly groupRoles: GroupRoleRow[];
  readonly groupPermissions: GroupPermissionRow[];
  readonly groupMembers: GroupMemberRow[];
  readonly users: UserRow[];
  readonly userTenants: UserTenantRow[];
  readonly userRoles: UserRoleRow[];
  readonly userPermissions: UserPermissionRow[];
  readonly businessAssignments: BusinessAssignmentRow[];
  readonly referenceSequences: ReferenceSequenceRow[];
  readonly parties: PartyRow[];
  readonly brokers: BrokerRow[];
  readonly brokerContacts: BrokerContactRow[];
  readonly leads: LeadRow[];
  readonly leadAssignments: LeadAssignmentRow[];
  readonly leadNotes: LeadNoteRow[];
  readonly leadHistory: LeadHistoryRow[];
  readonly followUps: FollowUpRow[];
  readonly pricingApprovals: PricingApprovalRow[];
  readonly quotes: QuoteRow[];
  readonly quoteVersions: QuoteVersionRow[];
  readonly quoteAssignments: QuoteAssignmentRow[];
  readonly quoteHistory: QuoteHistoryRow[];
  readonly jobRuns: JobRunRow[];
}

// ---------------------------------------------------------------------------------------------
// Date / money helpers
// ---------------------------------------------------------------------------------------------

function iso(d: Date): string {
  return d.toISOString();
}
function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}
function money(amount: number): string {
  return `${Math.round(amount)}.00`;
}

// The permission-resolver map: role 'all' -> the full seeded catalog. Injected at build time so the
// plan carries no hidden coupling to a live database.
export interface PlanInputs {
  readonly now: Date;
  /** Resolved by resolveDemoPassword(); recorded on the plan so it is never re-derived here. */
  readonly password: string;
  /** Every permission code from the seeded `permissions` table (for `permissions: 'all'`). */
  readonly allPermissionCodes: readonly string[];
}

interface TenantRefs {
  readonly byList: Map<string, RefItemRow[]>;
  readonly leadStatusByKey: Map<string, RefItemRow>;
  readonly quoteStatusByKey: Map<string, RefItemRow>;
  readonly coverTypesByProductLine: Map<number, RefItemRow[]>;
}

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

export function buildDemoPlan(inputs: PlanInputs): DemoPlan {
  const { now, allPermissionCodes, password } = inputs;
  const rng = new Rng(DEMO_SEED);

  const plan: DemoPlan = {
    password,
    tenants: [],
    tenantSettings: [],
    referenceItems: [],
    roles: [],
    rolePermissions: [],
    groups: [],
    groupRoles: [],
    groupPermissions: [],
    groupMembers: [],
    users: [],
    userTenants: [],
    userRoles: [],
    userPermissions: [],
    businessAssignments: [],
    referenceSequences: [],
    parties: [],
    brokers: [],
    brokerContacts: [],
    leads: [],
    leadAssignments: [],
    leadNotes: [],
    leadHistory: [],
    followUps: [],
    pricingApprovals: [],
    quotes: [],
    quoteVersions: [],
    quoteAssignments: [],
    quoteHistory: [],
    jobRuns: [],
  };

  // --- Tenants + settings ---
  for (const tenant of TENANTS) {
    plan.tenants.push({ id: tenant.id, name: tenant.name });
    plan.tenantSettings.push({
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.tenantSettings, 0),
      tenant_id: tenant.id,
      currency_code: tenant.currencyCode,
      currency_symbol: tenant.currencySymbol,
      high_value_threshold: tenant.highValueThreshold,
    });
  }

  // --- Roles (per tenant) + the one global Internal role ---
  const roleIdByTenantKey = new Map<string, number>();
  let roleSeq = 0;
  const addRole = (tenantId: number | null, def: RoleDef, mapKey: string): number => {
    const id = GLOBAL_ID.role + roleSeq;
    roleSeq += 1;
    plan.roles.push({ id, tenant_id: tenantId, name: def.name });
    const codes =
      def.permissions === 'all'
        ? allPermissionCodes
        : def.permissions === 'tenant_all'
          ? allPermissionCodes.filter((code) => !isInternalOnlyPermission(code))
          : def.permissions;
    for (const code of codes) {
      plan.rolePermissions.push({
        id: GLOBAL_ID.rolePermission + plan.rolePermissions.length,
        role_id: id,
        permission_code: code,
      });
    }
    roleIdByTenantKey.set(mapKey, id);
    return id;
  };

  const internalRoleId = addRole(null, INTERNAL_ROLE, `global:${INTERNAL_ROLE.key}`);
  for (const tenant of TENANTS) {
    for (const def of TENANT_ROLES) {
      addRole(tenant.id, def, `${tenant.index}:${def.key}`);
    }
  }

  // --- Business assignment slots (rm/underwriter) per tenant ---
  const rmSlotIdByTenant = new Map<number, number>();
  const uwSlotIdByTenant = new Map<number, number>();
  for (const tenant of TENANTS) {
    const rmId = tenantEntityId(tenant.index, ENTITY_OFFSET.businessAssignment, 0);
    const uwId = tenantEntityId(tenant.index, ENTITY_OFFSET.businessAssignment, 1);
    plan.businessAssignments.push(
      {
        id: rmId,
        tenant_id: tenant.id,
        role_id: roleIdByTenantKey.get(`${tenant.index}:relationship_manager`) as number,
        slot: 'rm',
      },
      {
        id: uwId,
        tenant_id: tenant.id,
        role_id: roleIdByTenantKey.get(`${tenant.index}:underwriter`) as number,
        slot: 'underwriter',
      },
    );
    rmSlotIdByTenant.set(tenant.index, rmId);
    uwSlotIdByTenant.set(tenant.index, uwId);
  }

  // Reference sequences are planted AFTER the business data below, derived from the refs actually
  // used — see the end of this function.

  // --- Reference items per tenant ---
  const tenantRefs = new Map<number, TenantRefs>();
  for (const tenant of TENANTS) {
    tenantRefs.set(tenant.index, buildTenantReferenceItems(plan, tenant));
  }

  // --- Users, memberships, grant paths, groups ---
  const userIdByPersona = new Map<string, number>();
  PERSONAS.forEach((persona, index) => {
    const userId = GLOBAL_ID.user + index;
    userIdByPersona.set(persona.key, userId);
    const lastTenantIndex = persona.lastTenantIndex ?? persona.tenantIndexes[0] ?? null;
    const lastTenantId =
      lastTenantIndex === null ? null : (TENANTS[lastTenantIndex - 1]?.id ?? null);
    plan.users.push({
      id: userId,
      personaKey: persona.key,
      email: persona.email,
      first_name: persona.firstName,
      last_name: persona.lastName,
      is_active: persona.isActive ?? true,
      last_tenant_id: lastTenantId,
    });

    persona.tenantIndexes.forEach((tenantIndex, slot) => {
      const tenant = TENANTS[tenantIndex - 1] as TenantDef;
      plan.userTenants.push({
        id: tenantEntityId(tenantIndex, ENTITY_OFFSET.userTenant, plan.userTenants.length),
        tenant_id: tenant.id,
        user_id: userId,
      });
      const roleKey = persona.rolePerTenant[slot] ?? 'relationship_manager';
      plan.userRoles.push({
        id: GLOBAL_ID.userRole + plan.userRoles.length,
        user_id: userId,
        role_id: roleIdByTenantKey.get(`${tenantIndex}:${roleKey}`) as number,
        tenant_id: tenant.id,
      });
    });

    if (persona.internal === true) {
      plan.userRoles.push({
        id: GLOBAL_ID.userRole + plan.userRoles.length,
        user_id: userId,
        role_id: internalRoleId,
        tenant_id: null,
      });
    }
  });

  buildDemoGroup(plan, userIdByPersona, roleIdByTenantKey);

  // --- Per-tenant business data ---
  const jobNow = now;
  for (const tenant of TENANTS) {
    const refs = tenantRefs.get(tenant.index) as TenantRefs;
    const rmUsers = personaUserIds(
      userIdByPersona,
      tenant.index,
      (p) => p.rolePerTenant[p.tenantIndexes.indexOf(tenant.index)] === 'relationship_manager',
    );
    const uwUsers = personaUserIds(
      userIdByPersona,
      tenant.index,
      (p) => p.rolePerTenant[p.tenantIndexes.indexOf(tenant.index)] === 'underwriter',
    );
    // Managers/admins double as fallback RMs so tenant 2 (few RMs) still has owners.
    const ownerPool = rmUsers.length > 0 ? rmUsers : personaUserIds(userIdByPersona, tenant.index, () => true);
    const uwPool = uwUsers.length > 0 ? uwUsers : ownerPool;

    buildTenantBusinessData(plan, {
      rng,
      now,
      tenant,
      refs,
      rmSlotId: rmSlotIdByTenant.get(tenant.index) as number,
      uwSlotId: uwSlotIdByTenant.get(tenant.index) as number,
      ownerPool,
      uwPool,
    });
  }

  // --- Reference sequences: continue AFTER the highest planted ref, never after a volume count ---
  //
  // `next_value` must equal the LARGEST sequence number any planted ref uses, because the app's
  // allocator hands out `next_value + 1` (lead-ref.ts). Deriving it from a volume constant is how
  // this broke before (2026-07-22): alert-fixture leads number PAST the bulk lead count and quote
  // refs start at 600, so the low-seeded counters made the first POST /leads re-mint an
  // already-taken reference — a unique violation surfacing as a 500.
  const year = now.getUTCFullYear();
  const trailingNumber = (ref: string): number => Number(ref.slice(ref.lastIndexOf('-') + 1));
  const maxRefFor = (tenantId: number, refs: readonly { tenant: number; ref: string }[]): number =>
    refs.reduce((max, row) => (row.tenant === tenantId ? Math.max(max, trailingNumber(row.ref)) : max), 0);
  const leadRefs = plan.leads.map((lead) => ({ tenant: lead.tenant_id, ref: lead.lead_ref }));
  const quoteRefs = plan.quotes.map((quote) => ({ tenant: quote.tenant_id, ref: quote.quote_ref }));
  for (const tenant of TENANTS) {
    plan.referenceSequences.push(
      {
        id: tenantEntityId(tenant.index, ENTITY_OFFSET.referenceSequence, 0),
        tenant_id: tenant.id,
        entity_type: 'lead',
        year,
        next_value: maxRefFor(tenant.id, leadRefs),
      },
      {
        id: tenantEntityId(tenant.index, ENTITY_OFFSET.referenceSequence, 1),
        tenant_id: tenant.id,
        entity_type: 'quote',
        year,
        next_value: maxRefFor(tenant.id, quoteRefs),
      },
    );
  }

  // --- Sample job runs (AC-085 "sample job runs") ---
  buildJobRuns(plan, jobNow);

  return plan;
}

// ---------------------------------------------------------------------------------------------
// Reference items
// ---------------------------------------------------------------------------------------------

function buildTenantReferenceItems(plan: DemoPlan, tenant: TenantDef): TenantRefs {
  const byList = new Map<string, RefItemRow[]>();
  const leadStatusByKey = new Map<string, RefItemRow>();
  const quoteStatusByKey = new Map<string, RefItemRow>();
  const coverTypesByProductLine = new Map<number, RefItemRow[]>();
  const productLineIdByName = new Map<string, number>();

  let local = 0;
  const nextId = (): number => {
    const id = tenantEntityId(tenant.index, ENTITY_OFFSET.referenceItem, local);
    local += 1;
    return id;
  };

  // Product lines first so cover types can resolve their parent id.
  for (const list of REFERENCE_LISTS) {
    if (list.listType !== 'product_line') continue;
    list.items.forEach((item, order) => {
      const row: RefItemRow = {
        id: nextId(),
        tenant_id: tenant.id,
        list_type: 'product_line',
        name: item.name,
        display_order: order + 1,
        is_broker_channel: null,
        product_line_id: null,
        reporting_category: null,
        canonical_key: null,
        is_terminal: false,
      };
      plan.referenceItems.push(row);
      pushList(byList, row);
      productLineIdByName.set(item.name, row.id);
    });
  }

  for (const list of REFERENCE_LISTS) {
    if (list.listType === 'product_line') continue;
    list.items.forEach((item, order) => {
      const productLineId =
        list.listType === 'cover_type' && item.productLineName !== undefined
          ? (productLineIdByName.get(item.productLineName) ?? null)
          : null;
      const row: RefItemRow = {
        id: nextId(),
        tenant_id: tenant.id,
        list_type: list.listType,
        name: item.name,
        display_order: order + 1,
        is_broker_channel: item.isBrokerChannel ?? (list.listType === 'request_channel' ? false : null),
        product_line_id: productLineId,
        reporting_category: item.reportingCategory ?? null,
        canonical_key: item.canonicalKey ?? null,
        is_terminal: item.isTerminal ?? false,
      };
      plan.referenceItems.push(row);
      pushList(byList, row);
      if (list.listType === 'lead_status' && row.canonical_key !== null) {
        leadStatusByKey.set(row.canonical_key, row);
      }
      if (list.listType === 'quote_status' && row.canonical_key !== null) {
        quoteStatusByKey.set(row.canonical_key, row);
      }
      if (list.listType === 'cover_type' && productLineId !== null) {
        pushMapList(coverTypesByProductLine, productLineId, row);
      }
    });
  }

  return { byList, leadStatusByKey, quoteStatusByKey, coverTypesByProductLine };
}

function pushList(map: Map<string, RefItemRow[]>, row: RefItemRow): void {
  const existing = map.get(row.list_type);
  if (existing === undefined) map.set(row.list_type, [row]);
  else existing.push(row);
}
function pushMapList(map: Map<number, RefItemRow[]>, key: number, row: RefItemRow): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [row]);
  else existing.push(row);
}

// ---------------------------------------------------------------------------------------------
// Groups (exercises the group grant paths — supports AC-018-style fixtures too)
// ---------------------------------------------------------------------------------------------

function buildDemoGroup(
  plan: DemoPlan,
  userIdByPersona: Map<string, number>,
  roleIdByTenantKey: Map<string, number>,
): void {
  const tenant = TENANTS[0] as TenantDef;
  const groupId = GLOBAL_ID.group + 0;
  plan.groups.push({ id: groupId, tenant_id: tenant.id, name: 'Pilot Sales Pod' });
  plan.groupRoles.push({
    id: GLOBAL_ID.groupRole + 0,
    group_id: groupId,
    role_id: roleIdByTenantKey.get(`1:relationship_manager`) as number,
  });
  plan.groupPermissions.push({
    id: GLOBAL_ID.groupPermission + 0,
    group_id: groupId,
    permission_code: 'reports.view',
  });
  for (const key of ['rm1', 'rm2', 'rm3']) {
    const userId = userIdByPersona.get(key);
    if (userId === undefined) continue;
    plan.groupMembers.push({
      id: GLOBAL_ID.groupMember + plan.groupMembers.length,
      group_id: groupId,
      user_id: userId,
    });
  }
}

function personaUserIds(
  userIdByPersona: Map<string, number>,
  tenantIndex: number,
  predicate: (persona: PersonaDef) => boolean,
): number[] {
  return PERSONAS.filter(
    (p) => p.tenantIndexes.includes(tenantIndex) && (p.isActive ?? true) && predicate(p),
  )
    .map((p) => userIdByPersona.get(p.key))
    .filter((id): id is number => id !== undefined);
}

// ---------------------------------------------------------------------------------------------
// Business data per tenant
// ---------------------------------------------------------------------------------------------

interface TenantBuildContext {
  readonly rng: Rng;
  readonly now: Date;
  readonly tenant: TenantDef;
  readonly refs: TenantRefs;
  readonly rmSlotId: number;
  readonly uwSlotId: number;
  readonly ownerPool: readonly number[];
  readonly uwPool: readonly number[];
}

function buildTenantBusinessData(plan: DemoPlan, ctx: TenantBuildContext): void {
  const { rng, now, tenant, refs } = ctx;
  const volumes = TENANT_VOLUMES[tenant.index - 1] as { parties: number; brokers: number; leads: number };

  const partyTypes = refs.byList.get('party_type') ?? [];
  const segments = refs.byList.get('party_segment') ?? [];
  const industries = refs.byList.get('industry') ?? [];
  const regions = refs.byList.get('region') ?? [];
  const productLines = refs.byList.get('product_line') ?? [];
  const channels = refs.byList.get('request_channel') ?? [];
  const brokerTypes = refs.byList.get('broker_type') ?? [];
  const lostReasons = refs.byList.get('lost_reason') ?? [];

  // --- Parties ---
  const parties: PartyRow[] = [];
  for (let i = 0; i < volumes.parties; i += 1) {
    const isStrategic = rng.chance(0.12);
    const region = rng.pick(regions);
    const row: PartyRow = {
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.party, i),
      tenant_id: tenant.id,
      name: partyName(rng, tenant.index, i),
      party_type_id: rng.pick(partyTypes).id,
      segment_id: isStrategic ? (segments.find((s) => s.name === 'Strategic Account')?.id ?? rng.pick(segments).id) : rng.pick(segments).id,
      industry_id: rng.pick(industries).id,
      region_id: region.id,
      is_strategic: isStrategic,
      contact_name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      contact_email: `contact${String(i)}@party-${String(tenant.index)}.example`,
      contact_phone: `+267 7${String(1000000 + rng.int(0, 8999999))}`,
      last_activity_at: iso(addDays(now, -rng.int(0, 120))),
    };
    parties.push(row);
    plan.parties.push(row);
  }

  // --- Brokers + contacts ---
  const brokers: BrokerRow[] = [];
  for (let i = 0; i < volumes.brokers; i += 1) {
    const broker: BrokerRow = {
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.broker, i),
      tenant_id: tenant.id,
      name: `${rng.pick(BROKER_PREFIXES)} ${rng.pick(BROKER_SUFFIXES)} ${String(tenant.index)}-${String(i + 1)}`,
      broker_type_id: rng.pick(brokerTypes).id,
      branch: rng.pick(regions).name,
      status: i === volumes.brokers - 1 ? 'disabled' : 'active',
    };
    brokers.push(broker);
    plan.brokers.push(broker);
    const contactCount = rng.int(1, 3);
    for (let c = 0; c < contactCount; c += 1) {
      plan.brokerContacts.push({
        id: tenantEntityId(tenant.index, ENTITY_OFFSET.brokerContact, i * 4 + c),
        tenant_id: tenant.id,
        broker_id: broker.id,
        name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
        email: `broker${String(i)}-${String(c)}@brokers-${String(tenant.index)}.example`,
        phone: `+267 3${String(1000000 + rng.int(0, 8999999))}`,
        is_primary: c === 0,
      });
    }
  }
  const activeBrokers = brokers.filter((b) => b.status === 'active');

  // --- Leads (bulk) with a status distribution that lights up every dashboard ---
  const leadRefBase = 1;
  let leadLocal = 0;
  const takeLeadId = (): number =>
    tenantEntityId(tenant.index, ENTITY_OFFSET.lead, leadLocal++);

  const bulkLeadCount = volumes.leads;
  for (let i = 0; i < bulkLeadCount; i += 1) {
    const statusKey = rng.weighted(BULK_STATUS_WEIGHTS);
    const party = rng.pick(parties);
    const productLine = rng.pick(productLines);
    const coverTypes = refs.coverTypesByProductLine.get(productLine.id) ?? [];
    const coverType = coverTypes.length > 0 ? rng.pick(coverTypes) : rng.pick(refs.byList.get('cover_type') ?? []);
    const channel = rng.pick(channels);
    const isBrokerChannel = channel.is_broker_channel === true;
    const daysAgo = weightedAge(rng);
    const received = addDays(now, -daysAgo);
    buildLead(plan, ctx, {
      id: takeLeadId(),
      seq: leadRefBase + i,
      statusKey,
      party,
      productLine,
      coverType,
      channel,
      broker: isBrokerChannel && activeBrokers.length > 0 ? rng.pick(activeBrokers) : null,
      region: rng.pick(regions),
      received,
      lostReasons,
      isAlertFixture: false,
    });
  }

  // --- Alert fixtures: one dedicated lead per hard-to-hit predicate ---
  buildAlertFixtures(plan, ctx, {
    takeLeadId,
    seqStart: leadRefBase + bulkLeadCount,
    parties,
    productLines,
    activeBrokers,
    regions,
    channels,
    lostReasons,
  });

  // --- Distribute follow-ups and pricing approvals to hit the AC-085 minimums ---
  distributeFollowUps(plan, ctx);
  distributePricingApprovals(plan, ctx);
}

// -- Lead construction ------------------------------------------------------------------------

interface LeadSpec {
  readonly id: number;
  readonly seq: number;
  readonly statusKey: string;
  readonly party: PartyRow;
  readonly productLine: RefItemRow;
  readonly coverType: RefItemRow;
  readonly channel: RefItemRow;
  readonly broker: BrokerRow | null;
  readonly region: RefItemRow;
  readonly received: Date;
  readonly lostReasons: readonly RefItemRow[];
  readonly isAlertFixture: boolean;
  /** Overrides for alert fixtures. */
  readonly overrides?: Partial<{
    lastActivityAt: string | null;
    nextFollowUpDate: string | null;
    pricingApprovalState: string;
    estimatedPremium: string;
    priority: string;
  }>;
}

function buildLead(plan: DemoPlan, ctx: TenantBuildContext, spec: LeadSpec): LeadRow {
  const { rng, now, tenant, refs } = ctx;
  const status = refs.leadStatusByKey.get(spec.statusKey) as RefItemRow;
  const category = status.reporting_category;
  const isClosed = status.is_terminal;
  const received = spec.received;

  const estimated = spec.overrides?.estimatedPremium ?? money(rng.int(20, 900) * 1000);
  const sumInsured = money(rng.int(500, 40000) * 1000);

  // Activity clock: recent for most, but coherent with closed/aged leads.
  const lastActivity =
    spec.overrides?.lastActivityAt !== undefined
      ? spec.overrides.lastActivityAt
      : iso(addDays(received, rng.int(0, Math.max(0, daysBetween(received, now) - 1))));

  const decisionDate = isClosed ? iso(addDays(received, rng.int(3, 40))) : null;
  const isLost = category === 'lost';
  const lostReasonId = isLost && spec.lostReasons.length > 0 ? rng.pick(spec.lostReasons).id : null;

  const assignedStatuses = new Set(['new']);
  const dateAssigned = assignedStatuses.has(spec.statusKey) ? null : iso(addDays(received, 1));

  const nextFollowUp =
    spec.overrides?.nextFollowUpDate !== undefined
      ? spec.overrides.nextFollowUpDate
      : !isClosed && ['quote_sent', 'negotiation', 'pricing'].includes(spec.statusKey)
        ? dateOnly(addDays(now, rng.int(2, 20)))
        : null;

  const row: LeadRow = {
    id: spec.id,
    tenant_id: tenant.id,
    party_id: spec.party.id,
    lead_ref: `L-${String(now.getUTCFullYear())}-${String(spec.seq).padStart(4, '0')}`,
    external_ref: rng.chance(0.3) ? `EXT-${String(tenant.index)}-${String(spec.seq)}` : null,
    date_received: dateOnly(received),
    request_channel_id: spec.channel.id,
    broker_id: spec.broker?.id ?? null,
    region_id: spec.region.id,
    product_line_id: spec.productLine.id,
    cover_type_id: spec.coverType.id,
    sum_insured: sumInsured,
    estimated_premium: estimated,
    policy_term: rng.pick(['m6', 'm12', 'm24', 'm36']),
    priority: spec.overrides?.priority ?? (rng.chance(0.15) ? 'high' : 'normal'),
    is_existing_client: rng.chance(0.4),
    status_id: status.id,
    pricing_approval_state: spec.overrides?.pricingApprovalState ?? 'none',
    date_assigned: dateAssigned,
    decision_date: decisionDate,
    lost_reason_id: lostReasonId,
    loss_comments: isLost ? 'Client chose an alternative carrier.' : null,
    last_activity_at: lastActivity,
    next_follow_up_date: nextFollowUp,
    follow_up_count: 0,
    source: rng.chance(0.15) ? 'api' : 'browser',
    created_at: iso(received),
  };
  plan.leads.push(row);

  // Owner assignment (RM slot) for every lead past 'new'.
  if (spec.statusKey !== 'new' && ctx.ownerPool.length > 0) {
    plan.leadAssignments.push({
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.leadAssignment, plan.leadAssignments.length),
      tenant_id: tenant.id,
      lead_id: row.id,
      business_assignment_id: ctx.rmSlotId,
      user_id: ctx.ownerPool[spec.seq % ctx.ownerPool.length] as number,
    });
  }

  // An intake note on every lead — the timeline's chronologically-first entry.
  plan.leadNotes.push({
    id: tenantEntityId(tenant.index, ENTITY_OFFSET.leadNote, plan.leadNotes.length),
    tenant_id: tenant.id,
    lead_id: row.id,
    body: `Intake captured via ${spec.channel.name}.`,
    created_at: iso(received),
    created_by: ctx.ownerPool[0] ?? plan.users[0]?.id ?? 0,
  });

  // Status history: a coherent trail into the current status.
  buildLeadHistory(plan, ctx, row, spec.statusKey, received);

  // Quotes for leads that reached the quote stage (or later).
  buildQuotesForLead(plan, ctx, row, spec);

  return row;
}

function buildLeadHistory(
  plan: DemoPlan,
  ctx: TenantBuildContext,
  lead: LeadRow,
  statusKey: string,
  received: Date,
): void {
  const { tenant, refs, ownerPool, now } = ctx;
  const trail = STATUS_TRAIL[statusKey] ?? [statusKey];
  let previousId: number | null = null;
  const span = Math.max(1, daysBetween(received, now));
  trail.forEach((key, index) => {
    const status = refs.leadStatusByKey.get(key);
    if (status === undefined) return;
    const actedAt = iso(addDays(received, Math.min(span, index + 1)));
    plan.leadHistory.push({
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.leadHistory, plan.leadHistory.length),
      tenant_id: tenant.id,
      lead_id: lead.id,
      operation: STATUS_OPERATION[key] ?? 'transition',
      previous_status_id: previousId,
      new_status_id: status.id,
      acted_by: ownerPool[0] ?? 0,
      acted_at: actedAt,
    });
    previousId = status.id;
  });
}

function buildQuotesForLead(
  plan: DemoPlan,
  ctx: TenantBuildContext,
  lead: LeadRow,
  spec: LeadSpec,
): void {
  const { rng, now, tenant, refs } = ctx;
  const quoteStages = new Set(['quote_sent', 'negotiation', 'closed_won', 'closed_lost', 'expired', 'withdrawn']);
  const preQuoteWithDraft = ['underwriting', 'pricing'].includes(spec.statusKey) && rng.chance(0.4);
  if (!quoteStages.has(spec.statusKey) && !preQuoteWithDraft && !spec.isAlertFixture) return;

  const quoteCount = spec.isAlertFixture ? 1 : preQuoteWithDraft ? 1 : rng.weighted([[2, 5], [3, 3], [4, 2]]);
  const received = new Date(`${lead.date_received}T00:00:00Z`);

  for (let q = 0; q < quoteCount; q += 1) {
    const quoteId = tenantEntityId(tenant.index, ENTITY_OFFSET.quote, plan.quotes.length);
    const isPrimary = q === quoteCount - 1;
    const quoteStatusKey = quoteStatusForLead(spec.statusKey, isPrimary, preQuoteWithDraft);
    const status = refs.quoteStatusByKey.get(quoteStatusKey) as RefItemRow;
    const prepared = addDays(received, rng.int(1, 10));
    const sent = ['sent', 'revised', 'won', 'lost', 'expired', 'withdrawn'].includes(quoteStatusKey)
      ? addDays(prepared, rng.int(0, 5))
      : null;
    const validUntil = sent !== null ? addDays(sent, 30) : null;
    const decision = ['won', 'lost'].includes(quoteStatusKey) ? (lead.decision_date ?? iso(addDays(prepared, 20))) : null;
    const premium = rng.int(15, 850) * 1000;
    const bound = quoteStatusKey === 'won' ? money(premium) : null;

    const quote: QuoteRow = {
      id: quoteId,
      tenant_id: tenant.id,
      lead_id: lead.id,
      quote_ref: `Q-${String(now.getUTCFullYear())}-${String(600 + plan.quotes.length).padStart(4, '0')}`,
      status_id: status.id,
      is_current: isPrimary,
      product_line_id: lead.product_line_id,
      cover_type_id: lead.cover_type_id,
      prepared_date: dateOnly(prepared),
      sent_date: sent === null ? null : dateOnly(sent),
      valid_until: validUntil === null ? null : dateOnly(validUntil),
      decision_date: decision,
      bound_premium: bound,
      created_at: iso(prepared),
    };
    plan.quotes.push(quote);

    // Versions: usually one; a "revised" quote carries a superseded first version + current second.
    const versionCount = quoteStatusKey === 'revised' ? 2 : 1;
    for (let v = 0; v < versionCount; v += 1) {
      plan.quoteVersions.push({
        id: tenantEntityId(tenant.index, ENTITY_OFFSET.quoteVersion, plan.quoteVersions.length),
        tenant_id: tenant.id,
        quote_id: quoteId,
        version_no: v + 1,
        quoted_premium: money(v === versionCount - 1 ? premium : Math.round(premium * 0.92)),
        is_current: v === versionCount - 1,
        created_at: iso(addDays(prepared, v)),
      });
    }

    // Quote status history + quote assignment (underwriter slot).
    plan.quoteHistory.push({
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.quoteHistory, plan.quoteHistory.length),
      tenant_id: tenant.id,
      quote_id: quoteId,
      operation: `set-${quoteStatusKey}`,
      previous_status_id: null,
      new_status_id: status.id,
      acted_by: ctx.uwPool[0] ?? 0,
      acted_at: iso(prepared),
    });
    if (ctx.uwPool.length > 0) {
      plan.quoteAssignments.push({
        id: tenantEntityId(tenant.index, ENTITY_OFFSET.quoteAssignment, plan.quoteAssignments.length),
        tenant_id: tenant.id,
        quote_id: quoteId,
        business_assignment_id: ctx.uwSlotId,
        user_id: ctx.uwPool[plan.quoteAssignments.length % ctx.uwPool.length] as number,
      });
    }
  }
}

function quoteStatusForLead(leadStatusKey: string, isPrimary: boolean, draftOnly: boolean): string {
  if (draftOnly) return 'draft';
  switch (leadStatusKey) {
    case 'closed_won':
      return isPrimary ? 'won' : 'lost';
    case 'closed_lost':
      return 'lost';
    case 'expired':
      return 'expired';
    case 'withdrawn':
      return 'withdrawn';
    case 'negotiation':
      return isPrimary ? 'sent' : 'revised';
    case 'quote_sent':
    default:
      return isPrimary ? 'sent' : 'revised';
  }
}

// -- Alert fixtures ---------------------------------------------------------------------------

interface AlertFixtureContext {
  readonly takeLeadId: () => number;
  readonly seqStart: number;
  readonly parties: readonly PartyRow[];
  readonly productLines: readonly RefItemRow[];
  readonly activeBrokers: readonly BrokerRow[];
  readonly regions: readonly RefItemRow[];
  readonly channels: readonly RefItemRow[];
  readonly lostReasons: readonly RefItemRow[];
}

/**
 * One dedicated lead (or the smallest set) per alert type, dated against the SHIPPED default
 * thresholds so an evaluation run cannot miss them. Kept apart from the bulk so the bulk's random
 * dates never accidentally suppress a type.
 */
function buildAlertFixtures(plan: DemoPlan, ctx: TenantBuildContext, fx: AlertFixtureContext): void {
  const { rng, now, tenant, refs, uwPool, ownerPool } = ctx;
  let seq = fx.seqStart;
  const strategicParty = fx.parties.find((p) => p.is_strategic) ?? fx.parties[0] as PartyRow;
  const normalParty = fx.parties.find((p) => !p.is_strategic) ?? fx.parties[0] as PartyRow;

  const common = (party: PartyRow, received: Date): Omit<LeadSpec, 'id' | 'seq' | 'statusKey' | 'overrides'> => {
    const productLine = rng.pick(fx.productLines);
    const coverTypes = refs.coverTypesByProductLine.get(productLine.id) ?? [];
    return {
      party,
      productLine,
      coverType: coverTypes.length > 0 ? rng.pick(coverTypes) : rng.pick(refs.byList.get('cover_type') ?? []),
      channel: rng.pick(fx.channels),
      broker: fx.activeBrokers.length > 0 ? rng.pick(fx.activeBrokers) : null,
      region: rng.pick(fx.regions),
      received,
      lostReasons: fx.lostReasons,
      isAlertFixture: true,
    };
  };

  // (1) unassigned_lead + sla_breach (both legs) + stalled_lead: aged 'new' lead, no quote.
  buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -10)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'new',
    overrides: { lastActivityAt: iso(addDays(now, -10)), estimatedPremium: money(120000) },
  });

  // (2) overdue_follow_up: open lead, follow-up date yesterday, recent activity (not stalled), low value.
  buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -6)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'negotiation',
    overrides: {
      lastActivityAt: iso(addDays(now, -1)),
      nextFollowUpDate: dateOnly(addDays(now, -1)),
      estimatedPremium: money(90000),
    },
  });

  // (3) stalled_quote: open quote on a lead whose activity is > 7 days old; far-future validity.
  const stalledQuoteLead = buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -20)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'quote_sent',
    overrides: { lastActivityAt: iso(addDays(now, -12)), estimatedPremium: money(140000) },
  });
  retargetLastQuoteValidity(plan, stalledQuoteLead, dateOnly(addDays(now, 40)));

  // (4) quote_expiring: open quote valid_until = today+3 (within 7, not past), recent activity.
  const expiringLead = buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -9)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'quote_sent',
    overrides: { lastActivityAt: iso(addDays(now, -2)), estimatedPremium: money(160000) },
  });
  retargetLastQuoteValidity(plan, expiringLead, dateOnly(addDays(now, 3)));

  // (5) quote_expired: open quote valid_until = today-2.
  const expiredLead = buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -12)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'quote_sent',
    overrides: { lastActivityAt: iso(addDays(now, -2)), estimatedPremium: money(150000) },
  });
  retargetLastQuoteValidity(plan, expiredLead, dateOnly(addDays(now, -2)));

  // (6) pending_pricing_approval: lead pending, a pending pricing_approval requested 5 days ago.
  const pendingLead = buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -8)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'pricing',
    overrides: { pricingApprovalState: 'pending', lastActivityAt: iso(addDays(now, -1)), estimatedPremium: money(180000) },
  });
  plan.pricingApprovals.push({
    id: tenantEntityId(tenant.index, ENTITY_OFFSET.pricingApproval, plan.pricingApprovals.length),
    tenant_id: tenant.id,
    lead_id: pendingLead.id,
    requested_by: ownerPool[0] ?? 0,
    requested_at: iso(addDays(now, -5)),
    approver_id: uwPool[0] ?? ownerPool[0] ?? 0,
    proposed_premium: money(180000),
    state: 'pending',
    decided_by: null,
    decided_at: null,
  });

  // (7) awaiting_underwriting: lead in underwriting, entered 5 days ago.
  const uwLead = buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -9)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'underwriting',
    overrides: { lastActivityAt: iso(addDays(now, -1)), estimatedPremium: money(200000) },
  });
  plan.leadHistory.push({
    id: tenantEntityId(tenant.index, ENTITY_OFFSET.leadHistory, plan.leadHistory.length),
    tenant_id: tenant.id,
    lead_id: uwLead.id,
    operation: 'send-to-underwriting',
    previous_status_id: refs.leadStatusByKey.get('information_gathering')?.id ?? null,
    new_status_id: refs.leadStatusByKey.get('underwriting')?.id ?? null,
    acted_by: uwPool[0] ?? 0,
    acted_at: iso(addDays(now, -5)),
  });

  // (8) high_value_stalled + executive_escalation: high-value, no quote, stalled.
  buildLead(plan, ctx, {
    ...common(normalParty, addDays(now, -15)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'assigned',
    overrides: {
      lastActivityAt: iso(addDays(now, -10)),
      estimatedPremium: money(1_200_000),
      priority: 'high',
    },
  });

  // (9) executive_escalation via the strategic-party stalled leg (not high value).
  buildLead(plan, ctx, {
    ...common(strategicParty, addDays(now, -16)),
    id: fx.takeLeadId(),
    seq: seq++,
    statusKey: 'information_gathering',
    overrides: { lastActivityAt: iso(addDays(now, -11)), estimatedPremium: money(140000) },
  });
}

/** Points the most recently generated quote of `lead` at a specific validity date (alert fixtures). */
function retargetLastQuoteValidity(plan: DemoPlan, lead: LeadRow, validUntil: string): void {
  for (let i = plan.quotes.length - 1; i >= 0; i -= 1) {
    const quote = plan.quotes[i] as QuoteRow;
    if (quote.lead_id === lead.id) {
      plan.quotes[i] = {
        ...quote,
        valid_until: validUntil,
        sent_date: quote.sent_date ?? dateOnly(new Date(`${lead.date_received}T00:00:00Z`)),
      };
      return;
    }
  }
}

// -- Follow-ups & pricing approvals distribution ----------------------------------------------

function distributeFollowUps(plan: DemoPlan, ctx: TenantBuildContext): void {
  const { rng, now, tenant } = ctx;
  const target = tenant.index === 1 ? 260 : 140;
  const eligible = plan.leads.filter(
    (l) => l.tenant_id === tenant.id && ['quote_sent', 'negotiation', 'pricing', 'closed_won', 'closed_lost'].includes(statusKeyOf(ctx, l)),
  );
  const pool = eligible.length > 0 ? eligible : plan.leads.filter((l) => l.tenant_id === tenant.id);
  for (let i = 0; i < target; i += 1) {
    const lead = pool[i % pool.length] as LeadRow;
    const loggedAt = addDays(now, -rng.int(1, 60));
    plan.followUps.push({
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.followUp, plan.followUps.length),
      tenant_id: tenant.id,
      lead_id: lead.id,
      follow_up_date: dateOnly(loggedAt),
      outcome_note: rng.pick(FOLLOW_UP_NOTES),
      next_follow_up_date: rng.chance(0.6) ? dateOnly(addDays(now, rng.int(1, 21))) : null,
      logged_by: ctx.ownerPool[i % Math.max(1, ctx.ownerPool.length)] ?? 0,
      logged_at: iso(loggedAt),
    });
  }
}

function distributePricingApprovals(plan: DemoPlan, ctx: TenantBuildContext): void {
  const { rng, now, tenant, uwPool, ownerPool } = ctx;
  const target = tenant.index === 1 ? 26 : 14;
  const eligible = plan.leads.filter(
    (l) => l.tenant_id === tenant.id && ['underwriting', 'pricing', 'quote_sent', 'negotiation', 'closed_won'].includes(statusKeyOf(ctx, l)),
  );
  const pool = eligible.length > 0 ? eligible : plan.leads.filter((l) => l.tenant_id === tenant.id);
  let added = 0;
  for (let i = 0; added < target; i += 1) {
    const lead = pool[i % pool.length] as LeadRow;
    // Skip the pending fixture lead's dedicated approval collision.
    const requestedAt = addDays(now, -rng.int(4, 45));
    const decided = rng.chance(0.75);
    const state = decided ? (rng.chance(0.7) ? 'approved' : 'rejected') : 'pending';
    plan.pricingApprovals.push({
      id: tenantEntityId(tenant.index, ENTITY_OFFSET.pricingApproval, plan.pricingApprovals.length),
      tenant_id: tenant.id,
      lead_id: lead.id,
      requested_by: ownerPool[i % Math.max(1, ownerPool.length)] ?? 0,
      requested_at: iso(requestedAt),
      approver_id: uwPool[i % Math.max(1, uwPool.length)] ?? ownerPool[0] ?? 0,
      proposed_premium: money(rng.int(30, 900) * 1000),
      state,
      decided_by: decided ? (uwPool[0] ?? 0) : null,
      decided_at: decided ? iso(addDays(requestedAt, rng.int(1, 4))) : null,
    });
    added += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Job runs (durable job_run rows the observability suite expects to exist)
// ---------------------------------------------------------------------------------------------

function buildJobRuns(plan: DemoPlan, now: Date): void {
  const jobs = [
    ['alert-evaluation', 'cron'],
    ['quote-expiry', 'cron'],
    ['lead-inactivity-expiry', 'cron'],
    ['alert.reevaluate-lead', 'queue'],
  ] as const;
  jobs.forEach(([name, trigger], i) => {
    const started = addDays(now, -1);
    plan.jobRuns.push({
      id: GLOBAL_ID.jobRun + i,
      job_name: name,
      trigger,
      environment: 'local',
      correlation_id: `demo-seed-${name}`,
      status: 'succeeded',
      started_at: iso(started),
      finished_at: iso(new Date(started.getTime() + 1200)),
      duration_ms: 1200,
      counts: JSON.stringify({ demo: true, tenants: TENANTS.length }),
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Small helpers, name pools and distributions
// ---------------------------------------------------------------------------------------------

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Recovers a lead's status canonical key from its status_id via the plan's reference items. */
function statusKeyOf(ctx: TenantBuildContext, lead: LeadRow): string {
  for (const [key, row] of ctx.refs.leadStatusByKey) {
    if (row.id === lead.status_id) return key;
  }
  return 'new';
}

/** Skews lead ages so the current month is dense while the trailing 6 months stay populated. */
function weightedAge(rng: Rng): number {
  return rng.weighted([
    [rng.int(0, 27), 5], // current-ish month
    [rng.int(28, 60), 3],
    [rng.int(61, 120), 2],
    [rng.int(121, 180), 1],
  ]);
}

const BULK_STATUS_WEIGHTS: readonly (readonly [string, number])[] = [
  ['new', 4],
  ['assigned', 5],
  ['information_gathering', 5],
  ['underwriting', 5],
  ['pricing', 4],
  ['quote_sent', 10],
  ['negotiation', 7],
  ['closed_won', 9],
  ['closed_lost', 8],
  ['expired', 3],
  ['withdrawn', 2],
];

const STATUS_TRAIL: Readonly<Record<string, readonly string[]>> = {
  new: ['new'],
  assigned: ['new', 'assigned'],
  information_gathering: ['new', 'assigned', 'information_gathering'],
  underwriting: ['new', 'assigned', 'information_gathering', 'underwriting'],
  pricing: ['new', 'assigned', 'information_gathering', 'underwriting', 'pricing'],
  quote_sent: ['new', 'assigned', 'information_gathering', 'underwriting', 'pricing', 'quote_sent'],
  negotiation: ['new', 'assigned', 'information_gathering', 'underwriting', 'pricing', 'quote_sent', 'negotiation'],
  closed_won: ['new', 'assigned', 'information_gathering', 'underwriting', 'pricing', 'quote_sent', 'negotiation', 'closed_won'],
  closed_lost: ['new', 'assigned', 'information_gathering', 'underwriting', 'pricing', 'quote_sent', 'closed_lost'],
  expired: ['new', 'assigned', 'information_gathering', 'underwriting', 'pricing', 'quote_sent', 'expired'],
  withdrawn: ['new', 'assigned', 'withdrawn'],
};

const STATUS_OPERATION: Readonly<Record<string, string>> = {
  new: 'create',
  assigned: 'assign',
  information_gathering: 'start-information-gathering',
  underwriting: 'send-to-underwriting',
  pricing: 'start-pricing',
  quote_sent: 'send-quote',
  negotiation: 'start-negotiation',
  closed_won: 'mark-won',
  closed_lost: 'mark-lost',
  expired: 'expire',
  withdrawn: 'withdraw',
};

const FIRST_NAMES = ['Amantle', 'Boago', 'Chedza', 'Dintle', 'Emang', 'Goitse', 'Kelebogile', 'Lesego', 'Masego', 'Neo', 'Oratile', 'Pako', 'Reneilwe', 'Same', 'Tshepo', 'Wame'];
const LAST_NAMES = ['Baloyi', 'Chirwa', 'Dikgang', 'Gaborone', 'Kgomotso', 'Letsholo', 'Mmusi', 'Ntsima', 'Otukile', 'Phiri', 'Rammidi', 'Sebina', 'Tlhabi', 'Vister'];
const BROKER_PREFIXES = ['Kalahari', 'Delta', 'Chobe', 'Tswana', 'Limpopo', 'Zebra', 'Baobab', 'Savuti'];
const BROKER_SUFFIXES = ['Brokers', 'Risk Advisors', 'Insurance Partners', 'Underwriting', 'Financial Services'];
const CLIENT_WORDS = ['Trading', 'Holdings', 'Logistics', 'Farms', 'Mining', 'Retail', 'Construction', 'Group', 'Enterprises', 'Investments', 'Motors', 'Foods'];
const FOLLOW_UP_NOTES = ['Left voicemail, awaiting callback.', 'Client requested revised terms.', 'Sent updated quotation.', 'Discussed cover options.', 'Awaiting broker confirmation.', 'Client comparing competitor pricing.'];

function partyName(rng: Rng, tenantIndex: number, i: number): string {
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(CLIENT_WORDS)} ${String(tenantIndex)}-${String(i + 1)}`;
}
