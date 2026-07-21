/**
 * Tenant-scoped `parties` persistence, plus the party leads card's read (T-023, AC-022, AC-041).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Parties/PartyStore.cs` and the two lead-side reads the
 * Parties surface depends on: `LeadStore.GetPartyLeadCountsAsync` (:325-348) and
 * `LeadStore.ListForPartyAsync` (:287-323).
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NO DATABASE NET UNDERNEATH
 * ========================================================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20). The reference had TWO layers
 * (an explicit predicate plus EF's ambient filter, PartyStore.cs:9-15); this port has ONE, so a
 * forgotten predicate here is an unguarded cross-tenant read with nothing beneath it. Nothing in
 * this file touches the raw executor for a tenant-scoped table: every query goes through
 * `forTenant(executor, tenantId)`, whose `insertInto` additionally INJECTS `tenant_id` so a hostile
 * body cannot write into another tenant. `parties.test.ts` asserts the OUTCOME per endpoint
 * (AC-022/V-027) rather than trusting the construction.
 *
 * The two multi-table reads (`listLeadsForParty`, and the sort subqueries in `listParties`) cannot
 * use the scope helper's single-table builders, so they are raw `sql` — and every table alias in
 * them carries its own `tenant_id = ${tenantId}` predicate, written out one join at a time. That is
 * the case the helper explicitly does not cover (lib/db/tenant.ts:117-125 offers `tenantPredicate`
 * for exactly this), so it is the case the isolation tests scrutinise hardest.
 *
 * NO DELETE FUNCTION EXISTS IN THIS FILE, AND THERE MUST NOT BE ONE (P-05, PRD 12.9). Parties are
 * corrected via Edit only; a lead's client reference must never become unresolvable.
 */
import { sql, type Expression, type SqlBool } from 'kysely';

import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import {
  DUPLICATE_NAME_SIMILARITY_THRESHOLD,
  MAX_DUPLICATE_MATCHES,
  TYPE_AHEAD_SIMILARITY_THRESHOLD,
} from './name-matching.js';
import type {
  LeadListItemDto,
  PartyDto,
  PartySortField,
  PartyWarningMatchDto,
} from './schemas.js';

/** Columns every party response projects — `PartyDto`'s persisted fields. */
const PARTY_COLUMNS = [
  'id',
  'name',
  'party_type_id',
  'segment_id',
  'industry_id',
  'region_id',
  'is_strategic',
  'contact_name',
  'contact_email',
  'contact_phone',
  'last_activity_at',
] as const;

interface PartyRow {
  readonly id: number | string;
  readonly name: string;
  readonly party_type_id: number | string;
  readonly segment_id: number | string | null;
  readonly industry_id: number | string | null;
  readonly region_id: number | string | null;
  readonly is_strategic: boolean;
  readonly contact_name: string | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
  readonly last_activity_at: Date | string | null;
}

/** `bigint` arrives as a string from node-postgres; ids are within the safe-integer range. */
function toId(value: number | string): number {
  return Number(value);
}

function toNullableId(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * `PartyDto.FromEntity` (PartyDto.cs:27-38). Counts DEFAULT TO ZERO exactly as the reference's
 * optional parameters do: a Create/Update response describes a party that cannot yet have leads (or
 * whose counts the mutation did not re-read), and `listParties` overlays the real values.
 */
export function toPartyDto(
  row: PartyRow,
  counts: { openCount: number; totalCount: number } = { openCount: 0, totalCount: 0 },
): PartyDto {
  return {
    id: toId(row.id),
    name: row.name,
    partyTypeId: toId(row.party_type_id),
    segmentId: toNullableId(row.segment_id),
    industryId: toNullableId(row.industry_id),
    regionId: toNullableId(row.region_id),
    isStrategic: row.is_strategic,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    lastActivityAt: toIsoOrNull(row.last_activity_at),
    openLeadsCount: counts.openCount,
    totalLeadsCount: counts.totalCount,
  };
}

export interface ListPartiesFilter {
  readonly search: string | undefined;
  readonly partyTypeId: number | undefined;
  readonly segmentId: number | undefined;
  readonly industryId: number | undefined;
  readonly regionId: number | undefined;
  readonly strategic: boolean | undefined;
  readonly sort: { field: PartySortField | null; descending: boolean };
  readonly page: number;
  readonly pageSize: number;
}

/**
 * `ReportingCategory.Open`/`Quoted` — what the grid's "Open leads" column counts
 * (PartyStore.cs:43, LeadStore.cs:346).
 */
const OPEN_REPORTING_CATEGORIES = ['open', 'quoted'] as const;

/**
 * `PartyStore.ListAsync` (:54-112).
 *
 * The search predicate is the reference's OR of an ILIKE substring match and a pg_trgm similarity
 * match (:69-75), so a partial name and a misspelling both find the party. The trigram half is
 * backed by `ix_parties_name_trgm` (20260718003000_parties.sql:91).
 */
export async function listParties(
  executor: DbExecutor,
  tenantId: TenantId,
  filter: ListPartiesFilter,
): Promise<{ items: PartyDto[]; totalCount: number }> {
  const scope = forTenant(executor, tenantId);

  // Built ONCE and applied to both the count and the page, so the two can never disagree about
  // which rows are in the result — a `total` computed from a different predicate than the page is
  // a paging bug that only shows up on the last page.
  const predicates: Expression<SqlBool>[] = [];

  if (filter.search !== undefined && filter.search.trim() !== '') {
    const term = filter.search;
    predicates.push(
      sql<SqlBool>`(parties.name ilike ${`%${term}%`}
         or extensions.similarity(parties.name, ${term}) >= ${TYPE_AHEAD_SIMILARITY_THRESHOLD})`,
    );
  }
  if (filter.partyTypeId !== undefined) {
    predicates.push(sql<SqlBool>`parties.party_type_id = ${filter.partyTypeId}`);
  }
  if (filter.segmentId !== undefined) {
    predicates.push(sql<SqlBool>`parties.segment_id = ${filter.segmentId}`);
  }
  if (filter.industryId !== undefined) {
    predicates.push(sql<SqlBool>`parties.industry_id = ${filter.industryId}`);
  }
  if (filter.regionId !== undefined) {
    predicates.push(sql<SqlBool>`parties.region_id = ${filter.regionId}`);
  }
  if (filter.strategic !== undefined) {
    predicates.push(sql<SqlBool>`parties.is_strategic = ${filter.strategic}`);
  }

  const countRow = await predicates
    .reduce(
      (query, predicate) => query.where(predicate),
      scope.selectFrom('parties').select(sql<string>`count(*)`.as('count')),
    )
    .executeTakeFirst();
  const totalCount = Number(countRow?.count ?? 0);

  // Resolved once, and only for the sort that needs them, exactly as PartyStore.cs:141-148 does:
  // the ORDER BY subquery then stays a plain count against `leads`.
  const openStatusIds =
    filter.sort.field === 'open_leads' ? await openLeadStatusIds(executor, tenantId) : [];

  const rows = (await predicates
    .reduce(
      (query, predicate) => query.where(predicate),
      scope.selectFrom('parties').select(PARTY_COLUMNS),
    )
    .orderBy(orderByFragment(tenantId, filter.sort, openStatusIds))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize)
    .execute()) as unknown as PartyRow[];

  const counts = await partyLeadCounts(
    executor,
    tenantId,
    rows.map((row) => toId(row.id)),
  );

  return {
    items: rows.map((row) => toPartyDto(row, counts.get(toId(row.id)))),
    totalCount,
  };
}

/** The lead-status ids in an open/quoted reporting category, for this tenant (PartyStore.cs:141-148). */
async function openLeadStatusIds(executor: DbExecutor, tenantId: TenantId): Promise<number[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select('id')
    .where('list_type', '=', 'lead_status')
    .where('reporting_category', 'in', [...OPEN_REPORTING_CATEGORIES])
    .execute();

  return rows.map((row) => toId(row.id as number | string));
}

/**
 * `PartyStore.ApplySortAsync` (:130-181), arm for arm.
 *
 * THE CALLER-SUPPLIED SORT STRING NEVER REACHES SQL. `field` has already been narrowed to the
 * `PartySortField` union by the service; this function only ever selects a hard-coded fragment, so
 * an arbitrary `?sort=` value cannot inject a column name (the same property SortSpec.cs's doc
 * comment claims for the reference).
 *
 * EVERY ARM ENDS IN AN `id` TIEBREAKER, and that is not decoration: paging a column with many ties
 * (Strategic, Region, a repeated count) is UNDEFINED in Postgres without one and can repeat or skip
 * rows across pages.
 *
 * The nullable arms lead with `(<id> is null) asc`, reproducing the reference's
 * `OrderBy(p => p.SegmentId == null)` (:157): rows WITHOUT a value sort last in BOTH directions,
 * rather than following Postgres's direction-dependent default.
 */
function orderByFragment(
  tenantId: TenantId,
  sort: { field: PartySortField | null; descending: boolean },
  openStatusIds: readonly number[],
): ReturnType<typeof sql.raw> | ReturnType<typeof sql> {
  const dir = sort.descending ? sql`desc` : sql`asc`;

  const referenceName = (column: 'party_type_id' | 'segment_id' | 'industry_id' | 'region_id') =>
    sql`(select r.name from reference_items r
          where r.tenant_id = ${tenantId} and r.id = parties.${sql.raw(column)})`;

  switch (sort.field) {
    case 'name':
      return sql`parties.name ${dir}, parties.id asc`;
    case 'type':
      return sql`${referenceName('party_type_id')} ${dir}, parties.id asc`;
    case 'segment':
      return sql`(parties.segment_id is null) asc, ${referenceName('segment_id')} ${dir}, parties.id asc`;
    case 'industry':
      return sql`(parties.industry_id is null) asc, ${referenceName('industry_id')} ${dir}, parties.id asc`;
    case 'region':
      return sql`(parties.region_id is null) asc, ${referenceName('region_id')} ${dir}, parties.id asc`;
    case 'strategic':
      return sql`parties.is_strategic ${dir}, parties.id asc`;
    case 'open_leads':
      return sql`(select count(*) from leads l
                   where l.tenant_id = ${tenantId} and l.party_id = parties.id
                     and l.status_id = any(${sql.val(openStatusIds)}::bigint[])) ${dir},
                 parties.id asc`;
    case 'total_leads':
      return sql`(select count(*) from leads l
                   where l.tenant_id = ${tenantId} and l.party_id = parties.id) ${dir},
                 parties.id asc`;
    case 'last_activity':
      return sql`(parties.last_activity_at is null) asc, parties.last_activity_at ${dir}, parties.id asc`;
    case null:
    default:
      // `_ => query.OrderBy(p => p.Name).ThenBy(p => p.Id)` (:179) — the default is ALPHABETICAL BY
      // NAME and is direction-independent, so `?sort=-nonsense` sorts ascending, as the reference does.
      return sql`parties.name asc, parties.id asc`;
  }
}

/**
 * `LeadStore.GetPartyLeadCountsAsync` (:325-348): open (open+quoted reporting category) and total
 * lead counts per party.
 *
 * ONE GROUPED QUERY FOR THE WHOLE PAGE, never one per row — the N+1 pattern CLAUDE.md forbids and
 * the reference also avoids. Parties with zero leads are absent from the map and fall back to the
 * DTO's zero defaults, matching the reference's dictionary miss (ListPartiesQueryHandler.cs:31-33).
 */
export async function partyLeadCounts(
  executor: DbExecutor,
  tenantId: TenantId,
  partyIds: readonly number[],
): Promise<Map<number, { openCount: number; totalCount: number }>> {
  const counts = new Map<number, { openCount: number; totalCount: number }>();
  if (partyIds.length === 0) return counts;

  const rows = await sql<{
    party_id: string;
    open_count: string;
    total_count: string;
  }>`
    select l.party_id::text as party_id,
           count(*) filter (
             where r.reporting_category in ('open', 'quoted')
           )::text as open_count,
           count(*)::text as total_count
      from leads l
      join reference_items r
        on r.tenant_id = ${tenantId} and r.id = l.status_id
     where l.tenant_id = ${tenantId}
       and l.party_id = any(${sql.val([...partyIds])}::bigint[])
     group by l.party_id
  `.execute(executor);

  for (const row of rows.rows) {
    counts.set(Number(row.party_id), {
      openCount: Number(row.open_count),
      totalCount: Number(row.total_count),
    });
  }
  return counts;
}

/** `PartyStore.FindAsync` (:183-187). The tenant predicate is what makes a foreign id a 404 (N-01). */
export async function findParty(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<PartyDto | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('parties')
    .select(PARTY_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as PartyRow | undefined;

  if (row === undefined) return undefined;

  const counts = await partyLeadCounts(executor, tenantId, [id]);
  return toPartyDto(row, counts.get(id));
}

/**
 * `PartyStore.FindSimilarByNameAsync` (:189-206): the non-blocking duplicate-name warning's matches.
 *
 * `similarity(name, $1) >= 0.4`, ordered by that score descending, capped at 5, ALWAYS within the
 * caller's tenant — a warning that named another tenant's party would leak that party's existence
 * and its name.
 *
 * THIS FUNCTION CANNOT BLOCK ANYTHING. It returns rows; the decision to warn rather than reject is
 * the service's, and both the reference (CreatePartyCommandHandler.cs:90-95) and this port call it
 * AFTER the row is already written.
 */
export async function findSimilarPartyNames(
  executor: DbExecutor,
  tenantId: TenantId,
  name: string,
  excludeId: number | null,
): Promise<PartyWarningMatchDto[]> {
  let query = forTenant(executor, tenantId)
    .selectFrom('parties')
    .select(['id', 'name'])
    .where(sql<boolean>`extensions.similarity(parties.name, ${name}) >= ${DUPLICATE_NAME_SIMILARITY_THRESHOLD}`);

  if (excludeId !== null) {
    query = query.where('id', '!=', excludeId);
  }

  const rows = await query
    .orderBy(sql`extensions.similarity(parties.name, ${name}) desc`)
    .limit(MAX_DUPLICATE_MATCHES)
    .execute();

  return rows.map((row) => ({ id: toId(row.id as number | string), name: row.name as string }));
}

export interface PartyWriteValues {
  readonly name: string;
  readonly partyTypeId: number;
  readonly segmentId: number | null;
  readonly industryId: number | null;
  readonly regionId: number | null;
  readonly isStrategic: boolean;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  /**
   * NULLABLE, matching the nullable `created_by`/`updated_by` columns (20260718003000_parties.sql:80)
   * and every sibling write-values type in this port. A party created on a path with no application
   * user behind it — the API intake ingress (T-030) — records no creating user rather than
   * borrowing one; the reference's `_currentUser.UserId` is `long?` for the same reason.
   */
  readonly actorUserId: number | null;
}

/**
 * `PartyStore.AddAsync` (:208-213) with the fields CreatePartyCommandHandler.cs:67-78 sets.
 *
 * `last_activity_at` is left NULL: the reference's `Party` entity does not set it at creation
 * either — it is stamped by lead/quote activity (20260718003000_parties.sql:76-77), and inventing a
 * value here would make a brand-new party with no leads look active to the inactivity scans.
 */
export async function insertParty(
  executor: DbExecutor,
  tenantId: TenantId,
  values: PartyWriteValues,
): Promise<PartyDto> {
  const now = new Date().toISOString();

  const inserted = (await forTenant(executor, tenantId)
    .insertInto('parties', {
      name: values.name,
      party_type_id: values.partyTypeId,
      segment_id: values.segmentId,
      industry_id: values.industryId,
      region_id: values.regionId,
      is_strategic: values.isStrategic,
      contact_name: values.contactName,
      contact_email: values.contactEmail,
      contact_phone: values.contactPhone,
      last_activity_at: null,
      created_at: now,
      created_by: values.actorUserId,
      updated_at: now,
      updated_by: values.actorUserId,
    })
    .returning(PARTY_COLUMNS)
    .executeTakeFirstOrThrow()) as unknown as PartyRow;

  return toPartyDto(inserted);
}

/** The write half of `UpdatePartyCommandHandler` (:76-86). Writes exactly what it is given. */
export async function updateParty(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  values: PartyWriteValues,
): Promise<PartyDto> {
  const updated = (await forTenant(executor, tenantId)
    .updateTable('parties')
    .set({
      name: values.name,
      party_type_id: values.partyTypeId,
      segment_id: values.segmentId,
      industry_id: values.industryId,
      region_id: values.regionId,
      is_strategic: values.isStrategic,
      contact_name: values.contactName,
      contact_email: values.contactEmail,
      contact_phone: values.contactPhone,
      updated_at: new Date().toISOString(),
      updated_by: values.actorUserId,
    })
    .where('id', '=', id)
    .returning(PARTY_COLUMNS)
    .executeTakeFirstOrThrow()) as unknown as PartyRow;

  return toPartyDto(updated);
}

/**
 * `ReferenceDataStore.IsActivePartyTypeAsync`/`IsActivePartySegmentAsync`/`IsActiveIndustryAsync`/
 * `IsActiveRegionAsync` (ReferenceDataStore.cs:94-136), which are four copies of one query
 * differing only in the list type.
 *
 * ACTIVE AND IN-TENANT ARE BOTH REQUIRED, and collapsing them into one function is what makes the
 * four call sites impossible to get subtly different from each other. A disabled reference value can
 * no longer be CHOSEN, while parties already pointing at it keep resolving it (AC-036).
 */
export async function isActiveReferenceItem(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  listType: 'party_type' | 'party_segment' | 'industry' | 'region',
): Promise<boolean> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('reference_items')
    .select('id')
    .where('id', '=', id)
    .where('list_type', '=', listType)
    .where('is_active', '=', true)
    .executeTakeFirst();

  return row !== undefined;
}

interface LeadCardRow {
  readonly id: string;
  readonly lead_ref: string;
  readonly party_id: string;
  readonly party_name: string;
  readonly broker_id: string | null;
  readonly broker_name: string | null;
  readonly product_line_name: string;
  readonly cover_type_name: string;
  readonly estimated_premium: string | null;
  readonly status_name: string;
  readonly priority: string;
  readonly date_received: string;
  readonly owner_user_id: string | null;
  readonly owner_first_name: string | null;
  readonly owner_last_name: string | null;
  readonly next_follow_up_date: string | null;
}

/**
 * `LeadStore.ListForPartyAsync` (:287-323) + `LeadListItemDto.FromRow` (LeadDto.cs:139-154),
 * collapsed into ONE query where the reference issued four (the leads join, then a separate owners
 * lookup, then a separate broker-name lookup).
 *
 * That is a deliberate divergence in SHAPE, not in behaviour: the reference's follow-up queries
 * exist because EF could not translate the joins, and re-issuing them here would be the N+1-adjacent
 * pattern CLAUDE.md forbids. Every projected field is the same, including the ones the reference
 * computes rather than reads:
 *   - `premium` is `estimated_premium` (LeadDto.cs:134-138 — the quoted branch is a later task);
 *   - `ageDays` is `today - date_received` (:148), computed in TypeScript so "today" is one value
 *     for the whole response rather than per row;
 *   - `flags` is ALWAYS EMPTY (:149-153): the Escalated/SLA/Expiring/High-value chips come from
 *     alert evaluation, which is not this task's scope. Emitting a guessed flag would be worse than
 *     emitting none, so the reference's empty list is preserved verbatim.
 *
 * OWNER IS THE `rm` SLOT SPECIFICALLY (LeadStore.cs:399, `BusinessAssignmentSlot.RelationshipManager`),
 * joined through `lead_assignments -> business_assignments`, and is LEFT-joined so a lead with no
 * RM assignment still appears on the card with a null owner rather than vanishing from it.
 *
 * Ordering is `date_received desc` (:298) with an `id desc` tiebreaker added here: the reference's
 * bare ordering is non-deterministic among leads received the same day, which for a card that is
 * asserted against in tests would be a flaky ordering rather than a stable one.
 */
export async function listLeadsForParty(
  executor: DbExecutor,
  tenantId: TenantId,
  partyId: number,
): Promise<LeadListItemDto[]> {
  const result = await sql<LeadCardRow>`
    select l.id::text                    as id,
           l.lead_ref                    as lead_ref,
           l.party_id::text              as party_id,
           p.name                        as party_name,
           l.broker_id::text             as broker_id,
           b.name                        as broker_name,
           pl.name                       as product_line_name,
           ct.name                       as cover_type_name,
           l.estimated_premium::text     as estimated_premium,
           st.name                       as status_name,
           l.priority                    as priority,
           to_char(l.date_received, 'YYYY-MM-DD')      as date_received,
           u.id::text                    as owner_user_id,
           u.first_name                  as owner_first_name,
           u.last_name                   as owner_last_name,
           to_char(l.next_follow_up_date, 'YYYY-MM-DD') as next_follow_up_date
      from leads l
      join parties p
        on p.tenant_id = ${tenantId} and p.id = l.party_id
      join reference_items pl
        on pl.tenant_id = ${tenantId} and pl.id = l.product_line_id
      join reference_items ct
        on ct.tenant_id = ${tenantId} and ct.id = l.cover_type_id
      join reference_items st
        on st.tenant_id = ${tenantId} and st.id = l.status_id
      left join brokers b
        on b.tenant_id = ${tenantId} and b.id = l.broker_id
      left join lead_assignments la
        on la.tenant_id = ${tenantId} and la.lead_id = l.id
      left join business_assignments ba
        on ba.tenant_id = ${tenantId} and ba.id = la.business_assignment_id and ba.slot = 'rm'
      left join users u
        on u.id = la.user_id and ba.id is not null
     where l.tenant_id = ${tenantId}
       and l.party_id = ${partyId}
     order by l.date_received desc, l.id desc
  `.execute(executor);

  // One "today" for the whole response, matching the reference's single
  // `DateOnly.FromDateTime(DateTime.UtcNow)` (GetPartyLeadsQueryHandler.cs:29).
  const today = new Date();
  const todayUtcDays = Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 86_400_000);

  return result.rows.map((row) => {
    const received = row.date_received;
    const receivedDays = Math.floor(Date.parse(`${received}T00:00:00Z`) / 86_400_000);

    return {
      id: Number(row.id),
      leadRef: row.lead_ref,
      partyId: Number(row.party_id),
      partyName: row.party_name,
      brokerId: row.broker_id === null ? null : Number(row.broker_id),
      brokerName: row.broker_name,
      productLineName: row.product_line_name,
      coverTypeName: row.cover_type_name,
      premium: row.estimated_premium === null ? null : Number(row.estimated_premium),
      statusName: row.status_name,
      priority: row.priority,
      dateReceived: received,
      ageDays: todayUtcDays - receivedDays,
      owner:
        row.owner_user_id === null
          ? null
          : {
              userId: Number(row.owner_user_id),
              firstName: row.owner_first_name ?? '',
              lastName: row.owner_last_name ?? '',
            },
      nextFollowUpDate: row.next_follow_up_date,
      flags: [],
    };
  });
}
