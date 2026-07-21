/**
 * Tenant-scoped leads persistence (T-024, AC-021, AC-022, AC-045; V-026, V-027, V-058).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Leads/LeadStore.cs` plus the small reference/broker/
 * business-assignment reads the lead handlers depend on.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NOTHING UNDERNEATH IT
 * ===================================================================
 * Postgres RLS is NOT adopted (spec Q-10). The reference had TWO layers (an explicit predicate plus
 * EF's ambient query filter, LeadStore.cs:12-15); this port has ONE. A forgotten predicate here is
 * an unguarded cross-tenant read with no database net beneath it. Single-table access goes through
 * `forTenant(...)`, whose `insertInto` additionally INJECTS `tenant_id` so a hostile body cannot
 * write into another tenant. The multi-table reads (`listLeads`, `findOpenDuplicateLeads`,
 * `findAccountableOwners`) cannot use the single-table builders, so they are raw joins in which
 * EVERY alias carries its own `tenant_id` predicate, written out one join at a time.
 *
 * THE BREADTH PREDICATE IS APPLIED IN SQL, NEVER BY POST-FILTERING (P-03/P-08, AC-045)
 * ===================================================================================
 * `listLeads` narrows with an `exists (... lead_assignments ...)` subquery BEFORE counting and
 * paging. Post-filtering a page would be wrong in two visible ways, not merely inelegant: the
 * `totalCount` would describe rows the caller may not see, and a 25-row page would arrive
 * short — leaking the existence and the count of other users' leads through the shape of the
 * response. The count and the page therefore share one predicate set by construction.
 */
import { sql } from 'kysely';

import type { RawBuilder, SqlBool } from 'kysely';

import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import { OPEN_REPORTING_CATEGORIES } from './schemas.js';
import type {
  LeadAssigneeDto,
  LeadDuplicateMatchDto,
  LeadListItemDto,
  LeadNoteDto,
  LeadSortField,
} from './schemas.js';

/** `bigint`/`numeric` arrive as strings from node-postgres. */
function toId(value: number | string): number {
  return Number(value);
}

function toNullableId(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function toNullableAmount(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** `date` columns come back as `Date` under node-postgres; the wire contract is `yyyy-MM-dd`. */
function toDateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toDateOnlyOrNull(value: Date | string | null): string | null {
  return value === null ? null : toDateOnly(value);
}


/**
 * `numeric` columns are typed `string` by the generated types and arrive as strings from
 * node-postgres, because a Postgres `numeric` does not fit an IEEE double without loss. Money is
 * therefore passed as a STRING on the way in and only widened to `number` on the way out, where the
 * wire contract requires it.
 */
function toNumericParam(value: number | null): string | null {
  return value === null ? null : String(value);
}

/** The persisted lead, as the service needs it (mutations, audit diffs, detail assembly). */
export interface LeadRecord {
  readonly id: number;
  readonly leadRef: string;
  readonly externalRef: string | null;
  readonly partyId: number;
  readonly requestChannelId: number;
  readonly brokerId: number | null;
  readonly regionId: number;
  readonly productLineId: number;
  readonly coverTypeId: number;
  readonly sumInsured: number | null;
  readonly estimatedPremium: number | null;
  readonly policyTerm: string;
  readonly policyTermOther: string | null;
  readonly priority: string;
  readonly isExistingClient: boolean;
  readonly statusId: number;
  readonly dateReceived: string;
  readonly source: string;
  readonly lastFollowUpDate: string | null;
  readonly nextFollowUpDate: string | null;
  readonly lastActivityAt: string | null;
}

const LEAD_COLUMNS = [
  'id',
  'lead_ref',
  'external_ref',
  'party_id',
  'request_channel_id',
  'broker_id',
  'region_id',
  'product_line_id',
  'cover_type_id',
  'sum_insured',
  'estimated_premium',
  'policy_term',
  'policy_term_other',
  'priority',
  'is_existing_client',
  'status_id',
  'date_received',
  'source',
  'last_follow_up_date',
  'next_follow_up_date',
  'last_activity_at',
] as const;

interface LeadRow {
  readonly id: number | string;
  readonly lead_ref: string;
  readonly external_ref: string | null;
  readonly party_id: number | string;
  readonly request_channel_id: number | string;
  readonly broker_id: number | string | null;
  readonly region_id: number | string;
  readonly product_line_id: number | string;
  readonly cover_type_id: number | string;
  readonly sum_insured: number | string | null;
  readonly estimated_premium: number | string | null;
  readonly policy_term: string;
  readonly policy_term_other: string | null;
  readonly priority: string;
  readonly is_existing_client: boolean;
  readonly status_id: number | string;
  readonly date_received: Date | string;
  readonly source: string;
  readonly last_follow_up_date: Date | string | null;
  readonly next_follow_up_date: Date | string | null;
  readonly last_activity_at: Date | string | null;
}

function toLeadRecord(row: LeadRow): LeadRecord {
  return {
    id: toId(row.id),
    leadRef: row.lead_ref,
    externalRef: row.external_ref,
    partyId: toId(row.party_id),
    requestChannelId: toId(row.request_channel_id),
    brokerId: toNullableId(row.broker_id),
    regionId: toId(row.region_id),
    productLineId: toId(row.product_line_id),
    coverTypeId: toId(row.cover_type_id),
    sumInsured: toNullableAmount(row.sum_insured),
    estimatedPremium: toNullableAmount(row.estimated_premium),
    policyTerm: row.policy_term,
    policyTermOther: row.policy_term_other,
    priority: row.priority,
    isExistingClient: row.is_existing_client,
    statusId: toId(row.status_id),
    dateReceived: toDateOnly(row.date_received),
    source: row.source,
    lastFollowUpDate: toDateOnlyOrNull(row.last_follow_up_date),
    nextFollowUpDate: toDateOnlyOrNull(row.next_follow_up_date),
    lastActivityAt: toIsoOrNull(row.last_activity_at),
  };
}

/** `LeadStore.FindAsync` (:49-53). A foreign-tenant id resolves to `undefined`, never to a row. */
export async function findLead(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<LeadRecord | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('leads')
    .select(LEAD_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as LeadRow | undefined;

  return row === undefined ? undefined : toLeadRecord(row);
}

/** The mutable intake facts a create/update writes. */
export interface LeadWriteValues {
  readonly isExistingClient: boolean;
  readonly dateReceived: string;
  readonly requestChannelId: number;
  readonly brokerId: number | null;
  readonly regionId: number;
  readonly externalRef: string | null;
  readonly productLineId: number;
  readonly coverTypeId: number;
  readonly sumInsured: number | null;
  readonly estimatedPremium: number | null;
  readonly policyTerm: string;
  readonly policyTermOther: string | null;
  readonly priority: string;
  readonly actorUserId: number | null;
}

export interface InsertLeadValues extends LeadWriteValues {
  readonly partyId: number;
  readonly leadRef: string;
  readonly statusId: number;
  readonly source: string;
  readonly intakeCredentialId: number | null;
  /** `LastActivityAt = now` (CreateLeadCommandHandler.cs:254) — the inactivity job (T-032) reads it. */
  readonly lastActivityAt: string;
}

/** `LeadStore.AddAsync` (:28-33). `tenant_id` is injected by the scope, never taken from the body. */
export async function insertLead(
  trx: DbExecutor,
  tenantId: TenantId,
  values: InsertLeadValues,
): Promise<LeadRecord> {
  const row = (await forTenant(trx, tenantId)
    .insertInto('leads', {
      party_id: values.partyId,
      lead_ref: values.leadRef,
      external_ref: values.externalRef,
      date_received: values.dateReceived,
      request_channel_id: values.requestChannelId,
      broker_id: values.brokerId,
      region_id: values.regionId,
      product_line_id: values.productLineId,
      cover_type_id: values.coverTypeId,
      sum_insured: toNumericParam(values.sumInsured),
      estimated_premium: toNumericParam(values.estimatedPremium),
      policy_term: values.policyTerm,
      policy_term_other: values.policyTermOther,
      priority: values.priority,
      is_existing_client: values.isExistingClient,
      status_id: values.statusId,
      pricing_approval_state: 'none',
      last_activity_at: values.lastActivityAt,
      follow_up_count: 0,
      source: values.source,
      intake_credential_id: values.intakeCredentialId,
      created_at: values.lastActivityAt,
      updated_at: values.lastActivityAt,
      created_by: values.actorUserId,
      updated_by: values.actorUserId,
    })
    .returning(LEAD_COLUMNS)
    .executeTakeFirstOrThrow()) as unknown as LeadRow;

  return toLeadRecord(row);
}

/**
 * `UpdateLeadCommandHandler` (:125-140). `last_activity_at` is stamped on EVERY edit (:138) — the
 * inactivity-expiry job (T-032) keys off it, so an edit that did not stamp it would let an actively
 * maintained lead expire.
 */
export async function updateLead(
  trx: DbExecutor,
  tenantId: TenantId,
  id: number,
  values: LeadWriteValues,
  now: string,
): Promise<LeadRecord> {
  const row = (await forTenant(trx, tenantId)
    .updateTable('leads')
    .set({
      is_existing_client: values.isExistingClient,
      date_received: values.dateReceived,
      request_channel_id: values.requestChannelId,
      broker_id: values.brokerId,
      region_id: values.regionId,
      external_ref: values.externalRef,
      product_line_id: values.productLineId,
      cover_type_id: values.coverTypeId,
      sum_insured: toNumericParam(values.sumInsured),
      estimated_premium: toNumericParam(values.estimatedPremium),
      policy_term: values.policyTerm,
      policy_term_other: values.policyTermOther,
      priority: values.priority,
      last_activity_at: now,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .where('id', '=', id)
    .returning(LEAD_COLUMNS)
    .executeTakeFirstOrThrow()) as unknown as LeadRow;

  return toLeadRecord(row);
}

/** Stamps `last_activity_at` alone — `LeadActivityStamper.Stamp` on the bulk-reassign path (:84). */
export async function stampLeadActivity(
  trx: DbExecutor,
  tenantId: TenantId,
  id: number,
  now: string,
  actorUserId: number | null,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('leads')
    .set({ last_activity_at: now, updated_at: now, updated_by: actorUserId })
    .where('id', '=', id)
    .execute();
}

/**
 * `LeadStore.ListInactivityExpiredCandidatesAsync` (:350-374) — the T-032 lead-inactivity sweep's
 * candidate set.
 *
 * THE PREDICATE IS PORTED FROM THE REFERENCE, NOT RE-DERIVED FROM THE TASK WORDING
 * ===============================================================================
 *   1. `last_activity_at IS NOT NULL` — a lead whose activity clock never started cannot be judged
 *      inactive. Stated explicitly rather than left to `<`'s NULL handling.
 *   2. `last_activity_at < threshold`, where the caller computes `threshold = now - N days` from the
 *      tenant's OWN `lead_inactivity_expiry_days`. Strictly less than: a lead that went quiet
 *      exactly N days ago is on its last day, not past it. Both sides are fixtures in
 *      `lead-inactivity-job.test.ts`.
 *   3. `reporting_category IN ('open','quoted')` — the CATEGORY, not a canonical-key list. This is
 *      the opposite of the quote sweep's key-based predicate, and it is deliberate on the
 *      reference's part: a tenant's own intermediate open status still ages out, because "open" is
 *      what the tenant declared it to mean.
 *
 * This function never re-derives activity from quote data. `executeQuoteOperation` stamps the parent
 * lead's `last_activity_at` on EVERY quote operation, so the column is already the union of lead and
 * quote activity by the time the sweep reads it.
 */
export async function listInactivityExpiredLeadCandidates(
  executor: DbExecutor,
  tenantId: TenantId,
  threshold: string,
): Promise<{ id: number }[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('leads')
    .innerJoin('reference_items', 'reference_items.id', 'leads.status_id')
    .select(['leads.id as id'])
    .where('leads.last_activity_at', 'is not', null)
    .where('leads.last_activity_at', '<', threshold)
    .where('reference_items.reporting_category', 'in', ['open', 'quoted'])
    .orderBy('leads.id')
    .execute();

  return rows.map((row) => ({ id: toId(row.id as number | string) }));
}

/** `LeadStore.AddAssignmentAsync` (:35-40). */
export async function insertLeadAssignment(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    leadId: number;
    businessAssignmentId: number;
    userId: number;
    actorUserId: number | null;
    now: string;
  },
): Promise<void> {
  await forTenant(trx, tenantId)
    .insertInto('lead_assignments', {
      lead_id: values.leadId,
      business_assignment_id: values.businessAssignmentId,
      user_id: values.userId,
      created_at: values.now,
      updated_at: values.now,
      created_by: values.actorUserId,
      updated_by: values.actorUserId,
    })
    .execute();
}

/** `LeadStore.FindAssignmentAsync` (:57-63) — the accountable-owner row for one lead, if any. */
export async function findLeadAssignment(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  businessAssignmentId: number,
): Promise<{ id: number; userId: number } | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('lead_assignments')
    .select(['id', 'user_id'])
    .where('lead_id', '=', leadId)
    .where('business_assignment_id', '=', businessAssignmentId)
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : { id: toId(row.id as number | string), userId: toId(row.user_id as number | string) };
}

/** The `existingAssignment.UserId = ...` branch of bulk reassign (BulkReassignCommandHandler.cs:100-101). */
export async function updateLeadAssignmentUser(
  trx: DbExecutor,
  tenantId: TenantId,
  assignmentId: number,
  userId: number,
  now: string,
  actorUserId: number | null,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('lead_assignments')
    .set({ user_id: userId, updated_at: now, updated_by: actorUserId })
    .where('id', '=', assignmentId)
    .execute();
}

/** `LeadStore.AddNoteAsync` (:42-47) — the intake note, which becomes the lead's first activity. */
export async function insertLeadNote(
  trx: DbExecutor,
  tenantId: TenantId,
  values: { leadId: number; body: string; createdBy: number | null; now: string },
): Promise<void> {
  await forTenant(trx, tenantId)
    .insertInto('lead_notes', {
      lead_id: values.leadId,
      body: values.body,
      created_at: values.now,
      created_by: values.createdBy,
    })
    .execute();
}

/** `LeadStore.ListNotesAsync` (:87-94) — newest first. */
export async function listLeadNotes(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<LeadNoteDto[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('lead_notes')
    .select(['id', 'body', 'created_at'])
    .where('lead_id', '=', leadId)
    .orderBy('created_at', 'desc')
    .execute();

  return rows.map((row) => ({
    id: toId(row.id as number | string),
    body: row.body as string,
    createdAt: toIsoOrNull(row.created_at as Date | string) ?? '',
  }));
}

/**
 * `LeadStore.FindOpenDuplicatesAsync` (:96-114) — the duplicate-lead rule, MEASURED.
 *
 * It is party + product line + `date_received >= since` + a status whose REPORTING CATEGORY is open
 * or quoted. It is NOT name normalisation and NOT trigram similarity (that is the PARTY duplicate
 * rule, which is a different feature); the task file's "duplicate normalization" description does
 * not match the reference and the reference is what is ported. Newest first (:111).
 */
export async function findOpenDuplicateLeads(
  executor: DbExecutor,
  tenantId: TenantId,
  partyId: number,
  productLineId: number,
  sinceDateReceived: string,
): Promise<LeadDuplicateMatchDto[]> {
  const result = await sql<{
    id: number | string;
    lead_ref: string;
    status_name: string;
    date_received: Date | string;
  }>`
    select l.id, l.lead_ref, s.name as status_name, l.date_received
      from leads l
      join reference_items s
        on s.id = l.status_id
       and s.tenant_id = ${tenantId}
     where l.tenant_id = ${tenantId}
       and l.party_id = ${partyId}
       and l.product_line_id = ${productLineId}
       and l.date_received >= ${sinceDateReceived}::date
       and s.reporting_category is not null
       and s.reporting_category = any(${sql.val(OPEN_REPORTING_CATEGORIES as unknown as string[])}::text[])
     order by l.date_received desc, l.id desc
  `.execute(executor);

  return result.rows.map((row) => ({
    leadId: toId(row.id),
    leadRef: row.lead_ref,
    status: row.status_name,
    dateReceived: toDateOnly(row.date_received),
  }));
}

/** `LeadStore.ExternalRefExistsAsync` (:116-123) — the non-blocking uniqueness warning's query. */
export async function externalRefExists(
  executor: DbExecutor,
  tenantId: TenantId,
  externalRef: string,
  excludeLeadId: number | null,
): Promise<boolean> {
  let query = forTenant(executor, tenantId)
    .selectFrom('leads')
    .select('id')
    .where('external_ref', '=', externalRef);

  if (excludeLeadId !== null) {
    query = query.where('id', '!=', excludeLeadId);
  }

  return (await query.executeTakeFirst()) !== undefined;
}

/** One reference item, with every column the lead rules consult. */
export interface ReferenceItemRecord {
  readonly id: number;
  readonly name: string;
  readonly listType: string;
  readonly isActive: boolean;
  readonly isBrokerChannel: boolean | null;
  readonly productLineId: number | null;
  readonly canonicalKey: string | null;
  readonly reportingCategory: string | null;
  readonly isTerminal: boolean;
}

const REFERENCE_COLUMNS = [
  'id',
  'name',
  'list_type',
  'is_active',
  'is_broker_channel',
  'product_line_id',
  'canonical_key',
  'reporting_category',
  'is_terminal',
] as const;

interface ReferenceRow {
  readonly id: number | string;
  readonly name: string;
  readonly list_type: string;
  readonly is_active: boolean;
  readonly is_broker_channel: boolean | null;
  readonly product_line_id: number | string | null;
  readonly canonical_key: string | null;
  readonly reporting_category: string | null;
  readonly is_terminal: boolean;
}

function toReferenceRecord(row: ReferenceRow): ReferenceItemRecord {
  return {
    id: toId(row.id),
    name: row.name,
    listType: row.list_type,
    isActive: row.is_active,
    isBrokerChannel: row.is_broker_channel,
    productLineId: toNullableId(row.product_line_id),
    canonicalKey: row.canonical_key,
    reportingCategory: row.reporting_category,
    isTerminal: row.is_terminal,
  };
}

/**
 * `IReferenceDataStore.FindActiveAsync(id, listType)` — id AND list type AND active AND this tenant.
 * All four conditions in one query is what makes the four failure reasons indistinguishable (N-01).
 */
export async function findActiveReferenceItem(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  listType: string,
): Promise<ReferenceItemRecord | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select(REFERENCE_COLUMNS)
    .where('id', '=', id)
    .where('list_type', '=', listType)
    .where('is_active', '=', true)
    .executeTakeFirst()) as unknown as ReferenceRow | undefined;

  return row === undefined ? undefined : toReferenceRecord(row);
}

/** `IReferenceDataStore.FindAsync(id)` — active or not, for naming an EXISTING lead's stored values. */
export async function findReferenceItem(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<ReferenceItemRecord | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select(REFERENCE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as ReferenceRow | undefined;

  return row === undefined ? undefined : toReferenceRecord(row);
}

/** `IReferenceDataStore.FindByCanonicalKeyAsync` — how the canonical `new` status is resolved. */
export async function findReferenceItemByCanonicalKey(
  executor: DbExecutor,
  tenantId: TenantId,
  listType: string,
  canonicalKey: string,
): Promise<ReferenceItemRecord | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select(REFERENCE_COLUMNS)
    .where('list_type', '=', listType)
    .where('canonical_key', '=', canonicalKey)
    .executeTakeFirst()) as unknown as ReferenceRow | undefined;

  return row === undefined ? undefined : toReferenceRecord(row);
}

/** `IReferenceDataStore.IsActiveRegionAsync`. */
export async function isActiveRegion(
  executor: DbExecutor,
  tenantId: TenantId,
  regionId: number,
): Promise<boolean> {
  return (await findActiveReferenceItem(executor, tenantId, regionId, 'region')) !== undefined;
}

/** `IBrokerStore.FindAsync(...) is not { Status: "active" }` (CreateLeadCommandHandler.cs:127). */
export async function findActiveBroker(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number,
): Promise<{ id: number; name: string } | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('brokers')
    .select(['id', 'name'])
    .where('id', '=', brokerId)
    .where('status', '=', 'active')
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : { id: toId(row.id as number | string), name: row.name as string };
}

/** Names a broker whatever its status — a lead keeps showing the broker it was created with. */
export async function findBrokerName(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number,
): Promise<string | null> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('brokers')
    .select('name')
    .where('id', '=', brokerId)
    .executeTakeFirst();

  return row === undefined ? null : (row.name as string);
}

/**
 * The RM-slot business assignment (`.SingleOrDefault(a => a.Slot == RelationshipManager)`).
 *
 * This is the "accountable owner" seam: `business_assignments` maps the RM slot to a ROLE, and the
 * owner must hold that role. Two consumers must agree on which assignment counts as the owner —
 * this one and `listLeads`'s owner sort — so both use this same slot predicate.
 */
export async function findRmSlotAssignment(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<{ assignmentId: number; roleId: number } | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('business_assignments')
    .select(['id', 'role_id'])
    .where('slot', '=', 'rm')
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : {
        assignmentId: toId(row.id as number | string),
        roleId: toId(row.role_id as number | string),
      };
}

/** `LeadStore.GetAccountableOwnersAsync` (:384-404) — one round trip for a whole page of leads. */
export async function findAccountableOwners(
  executor: DbExecutor,
  tenantId: TenantId,
  leadIds: readonly number[],
): Promise<Map<number, LeadAssigneeDto>> {
  if (leadIds.length === 0) return new Map();

  const result = await sql<{
    lead_id: number | string;
    user_id: number | string;
    first_name: string;
    last_name: string;
  }>`
    select la.lead_id, u.id as user_id, u.first_name, u.last_name
      from lead_assignments la
      join business_assignments ba
        on ba.id = la.business_assignment_id
       and ba.tenant_id = ${tenantId}
      join users u on u.id = la.user_id
     where la.tenant_id = ${tenantId}
       and la.lead_id = any(${sql.val(leadIds as unknown as number[])}::bigint[])
       and ba.slot = 'rm'
  `.execute(executor);

  const owners = new Map<number, LeadAssigneeDto>();
  for (const row of result.rows) {
    owners.set(toId(row.lead_id), {
      userId: toId(row.user_id),
      firstName: row.first_name,
      lastName: row.last_name,
    });
  }
  return owners;
}

/** Party name for the detail projection — tenant-predicated like everything else. */
export async function findPartyName(
  executor: DbExecutor,
  tenantId: TenantId,
  partyId: number,
): Promise<string | null> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('parties')
    .select('name')
    .where('id', '=', partyId)
    .executeTakeFirst();

  return row === undefined ? null : (row.name as string);
}

/** `party.LastActivityAt = now` (CreateLeadCommandHandler.cs:307-314): lead creation is party activity. */
export async function stampPartyActivity(
  trx: DbExecutor,
  tenantId: TenantId,
  partyId: number,
  now: string,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('parties')
    .set({ last_activity_at: now, updated_at: now })
    .where('id', '=', partyId)
    .execute();
}

/** Whether a user holds the RM role in this tenant — the owner-eligibility check's storage side. */
export async function isEligibleOwner(
  executor: DbExecutor,
  tenantId: TenantId,
  roleId: number,
  userId: number,
): Promise<boolean> {
  const result = await sql<{ ok: number }>`
    select 1 as ok
      from users u
     where u.id = ${userId}
       and u.is_active = true
       and exists (
             select 1 from user_tenants ut
              where ut.user_id = u.id and ut.tenant_id = ${tenantId}
           )
       and (
             exists (
               select 1 from user_roles ur
                where ur.user_id = u.id
                  and ur.role_id = ${roleId}
                  and (ur.tenant_id is null or ur.tenant_id = ${tenantId})
             )
             or exists (
               select 1
                 from group_members gm
                 join user_groups g on g.id = gm.group_id
                 join group_roles gr on gr.group_id = g.id
                where gm.user_id = u.id
                  and gr.role_id = ${roleId}
                  and g.is_active = true
                  and (g.tenant_id is null or g.tenant_id = ${tenantId})
             )
           )
     limit 1
  `.execute(executor);

  return result.rows.length > 0;
}

export interface ListLeadsFilter {
  readonly statusIds: readonly number[] | undefined;
  readonly ownerUserId: number | undefined;
  readonly brokerId: number | undefined;
  readonly productLineId: number | undefined;
  readonly regionId: number | undefined;
  readonly requestChannelId: number | undefined;
  readonly dateReceivedFrom: string | undefined;
  readonly dateReceivedTo: string | undefined;
  readonly myLeadsOnly: boolean;
  readonly callerUserId: number;
  readonly callerHasViewAll: boolean;
  readonly search: string | undefined;
  readonly sort: { field: LeadSortField | null; descending: boolean };
  readonly page: number;
  readonly pageSize: number;
  /**
   * Extra lead-level predicates, `and`-joined onto the same WHERE body (T-050).
   *
   * The dashboard drill needs populations the Leads list has no filter dimension for — "has a quote
   * in an open category", "carries an unresolved alert", "premium above the tenant threshold". This
   * seam exists so those land on THIS query rather than in a second lead query of their own: the
   * breadth rule above is what stops a drill from being a way to read leads the caller may not see,
   * and a second implementation of it is exactly how the two would stop agreeing.
   *
   * Every predicate must be alias-`l` scoped and fully parameterised; it is composed SQL from
   * server-side code, never a caller-supplied string.
   */
  readonly extraPredicates?: readonly RawBuilder<SqlBool>[] | undefined;
}

/**
 * `LeadStore.ListAsync` (:125-285).
 *
 * ORDERING ALWAYS ENDS IN A LEAD-ID TIEBREAKER (:228-229). Without one, paging a low-cardinality
 * sort (Status, Premium, Broker) is UNDEFINED across pages in Postgres and can repeat or skip rows
 * between page 1 and page 2 — a bug that is invisible on a single-page fixture.
 *
 * The sort field is a NARROWED UNION, never the caller's raw string: it selects a branch below and
 * is never interpolated. An unrecognised key is not an error (SortSpec.Parse) — it falls through to
 * the default, newest-received first, so a stale bookmark still returns a sane list.
 */
export async function listLeads(
  executor: DbExecutor,
  tenantId: TenantId,
  filter: ListLeadsFilter,
  today: string,
): Promise<{ items: LeadListItemDto[]; totalCount: number }> {
  const conditions = [
    sql`l.tenant_id = ${tenantId}`,
    sql`p.tenant_id = ${tenantId}`,
    sql`pl.tenant_id = ${tenantId}`,
    sql`ct.tenant_id = ${tenantId}`,
    sql`s.tenant_id = ${tenantId}`,
  ];

  if (filter.statusIds !== undefined && filter.statusIds.length > 0) {
    conditions.push(sql`l.status_id = any(${sql.val(filter.statusIds as number[])}::bigint[])`);
  }
  if (filter.brokerId !== undefined) conditions.push(sql`l.broker_id = ${filter.brokerId}`);
  if (filter.productLineId !== undefined) {
    conditions.push(sql`l.product_line_id = ${filter.productLineId}`);
  }
  if (filter.regionId !== undefined) conditions.push(sql`l.region_id = ${filter.regionId}`);
  if (filter.requestChannelId !== undefined) {
    conditions.push(sql`l.request_channel_id = ${filter.requestChannelId}`);
  }
  if (filter.dateReceivedFrom !== undefined) {
    conditions.push(sql`l.date_received >= ${filter.dateReceivedFrom}::date`);
  }
  if (filter.dateReceivedTo !== undefined) {
    conditions.push(sql`l.date_received <= ${filter.dateReceivedTo}::date`);
  }

  if (filter.search !== undefined && filter.search.trim() !== '') {
    // "Lead ref, party, or broker" (:184). The broker match reads off the LEFT JOIN, so a
    // broker-less lead leaves it null and `NULL ILIKE` never matches — same as the reference.
    const pattern = `%${filter.search.trim()}%`;
    conditions.push(
      sql`(l.lead_ref ilike ${pattern} or p.name ilike ${pattern} or b.name ilike ${pattern})`,
    );
  }

  /**
   * THE BREADTH PREDICATE (:196-203). Without `leads.view_all`, only leads carrying ANY assignment
   * for the caller are visible; the My-leads toggle applies the SAME predicate on top of a
   * view_all holder's otherwise-unrestricted view. So the toggle can only ever narrow — it is
   * structurally incapable of widening, because both paths add the identical `exists` clause.
   */
  if (!filter.callerHasViewAll || filter.myLeadsOnly) {
    conditions.push(sql`exists (
      select 1 from lead_assignments la
       where la.tenant_id = ${tenantId}
         and la.lead_id = l.id
         and la.user_id = ${filter.callerUserId}
    )`);
  }

  if (filter.ownerUserId !== undefined) {
    conditions.push(sql`exists (
      select 1 from lead_assignments la
       where la.tenant_id = ${tenantId}
         and la.lead_id = l.id
         and la.user_id = ${filter.ownerUserId}
    )`);
  }

  // T-050's drill scopes. Appended LAST so they can only ever narrow what the breadth predicate
  // above already allowed — they are and-joined, never or-joined, into the same WHERE body.
  for (const predicate of filter.extraPredicates ?? []) {
    conditions.push(predicate);
  }

  const where = sql.join(conditions, sql` and `);

  const from = sql`
      from leads l
      join parties p on p.id = l.party_id
      join reference_items pl on pl.id = l.product_line_id
      join reference_items ct on ct.id = l.cover_type_id
      join reference_items s on s.id = l.status_id
      left join brokers b on b.id = l.broker_id and b.tenant_id = ${tenantId}
     where ${where}
  `;

  const countResult = await sql<{ count: string | number }>`
    select count(*) as count ${from}
  `.execute(executor);
  const totalCount = Number(countResult.rows[0]?.count ?? 0);

  const direction = filter.sort.descending ? sql`desc` : sql`asc`;
  // The owner sort needs the owner NAME before paging, so it keys off a correlated subquery on the
  // same RM-slot assignment `findAccountableOwners` uses for display. The two must agree on which
  // assignment counts as "the owner", hence the identical slot/tenant predicate (:216-226).
  const ownerName = sql`(
    select u.first_name || ' ' || u.last_name
      from lead_assignments la
      join business_assignments ba on ba.id = la.business_assignment_id and ba.tenant_id = ${tenantId}
      join users u on u.id = la.user_id
     where la.tenant_id = ${tenantId} and la.lead_id = l.id and ba.slot = 'rm'
     limit 1
  )`;

  const orderBy = ((): ReturnType<typeof sql> => {
    switch (filter.sort.field) {
      case 'lead_ref':
        return sql`order by l.lead_ref ${direction}, l.id asc`;
      case 'party':
        return sql`order by p.name ${direction}, l.id asc`;
      // `OrderBy(x => x.broker == null)` first (:237): broker-less leads sort LAST in both
      // directions rather than clustering at whichever end nulls happen to land.
      case 'broker':
        return sql`order by (b.name is null) asc, b.name ${direction}, l.id asc`;
      case 'product':
        return sql`order by pl.name ${direction}, ct.name ${direction}, l.id asc`;
      case 'premium':
        return sql`order by (l.estimated_premium is null) asc, l.estimated_premium ${direction}, l.id asc`;
      case 'status':
        return sql`order by s.name ${direction}, l.id asc`;
      // The ONLY branch whose tiebreaker follows the sort direction (:249-251), preserved as measured.
      case 'date_received':
        return sql`order by l.date_received ${direction}, l.id ${direction}`;
      case 'owner':
        return sql`order by (${ownerName} is null) asc, ${ownerName} ${direction}, l.id asc`;
      case 'next_follow_up':
        return sql`order by (l.next_follow_up_date is null) asc, l.next_follow_up_date ${direction}, l.id asc`;
      default:
        return sql`order by l.date_received desc, l.id desc`;
    }
  })();

  const offset = (filter.page - 1) * filter.pageSize;

  const pageResult = await sql<{
    id: number | string;
    lead_ref: string;
    party_id: number | string;
    party_name: string;
    broker_id: number | string | null;
    broker_name: string | null;
    product_line_name: string;
    cover_type_name: string;
    estimated_premium: number | string | null;
    status_name: string;
    priority: string;
    date_received: Date | string;
    next_follow_up_date: Date | string | null;
  }>`
    select l.id, l.lead_ref, l.party_id, p.name as party_name, l.broker_id, b.name as broker_name,
           pl.name as product_line_name, ct.name as cover_type_name, l.estimated_premium,
           s.name as status_name, l.priority, l.date_received, l.next_follow_up_date
    ${from}
    ${orderBy}
    limit ${filter.pageSize} offset ${offset}
  `.execute(executor);

  const leadIds = pageResult.rows.map((row) => toId(row.id));
  const owners = await findAccountableOwners(executor, tenantId, leadIds);

  const items = pageResult.rows.map((row) => {
    const id = toId(row.id);
    const dateReceived = toDateOnly(row.date_received);
    return {
      id,
      leadRef: row.lead_ref,
      partyId: toId(row.party_id),
      partyName: row.party_name,
      brokerId: toNullableId(row.broker_id),
      brokerName: row.broker_name,
      productLineName: row.product_line_name,
      coverTypeName: row.cover_type_name,
      // "Premium (estimated until quoted, then current quoted premium)" (LeadDto.cs:135-137): the
      // quoted branch belongs to T-026; until quotes exist this always projects the estimate.
      premium: toNullableAmount(row.estimated_premium),
      statusName: row.status_name,
      priority: row.priority,
      dateReceived,
      ageDays: ageInDays(dateReceived, today),
      owner: owners.get(id) ?? null,
      nextFollowUpDate: toDateOnlyOrNull(row.next_follow_up_date),
      // Flags (Escalated/SLA/Expiring/High value) are computed from alert-evaluation data, which is
      // T-031's scope — left EMPTY rather than guessed at, exactly as the reference does (:150-152).
      flags: [] as readonly string[],
    } satisfies LeadListItemDto;
  });

  return { items, totalCount };
}

/** `today.DayNumber - row.DateReceived.DayNumber` (LeadDto.cs:148) — whole days, UTC, no clock time. */
export function ageInDays(dateReceived: string, today: string): number {
  const received = Date.parse(`${dateReceived}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.round((now - received) / 86_400_000);
}
