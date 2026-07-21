/**
 * Parties behaviour (T-023, AC-022, AC-024, AC-041; spec FR-26..FR-28, P-05).
 *
 * Ports the four CQRS handlers under `src/api/QuoteIQ.Application/Features/Parties/`
 * (ListParties, GetParty, CreateParty, UpdateParty) plus
 * `Features/Leads/GetPartyLeads/GetPartyLeadsQueryHandler`.
 *
 * THE DUPLICATE-NAME WARNING IS NON-BLOCKING, AND THAT IS THE HEADLINE BEHAVIOUR (spec FR-28)
 * ==========================================================================================
 * This is the property most easily broken by a well-meaning "improvement", so it is worth stating
 * exactly how the reference achieves it: `CreatePartyCommandHandler` writes the row FIRST
 * (:80 `AddAsync`), audits it (:82-88), and only THEN searches for similar names (:90) to attach to
 * an already-successful result (:91-95). The search cannot influence whether the write happens,
 * because it runs after it. `UpdatePartyCommandHandler` is identical (:86 save, :104 search).
 *
 * This port preserves that ORDER rather than merely preserving the status code. A version that
 * checked for duplicates first and then chose not to reject would pass a status-code-only test
 * while being one refactor away from becoming a blocking check; keeping the search after the write
 * makes blocking impossible to reintroduce by accident. `parties.test.ts` proves the OUTCOME both
 * ways: the warning is present AND the row is really in the database afterwards.
 *
 * There is deliberately NO uniqueness constraint behind this either
 * (20260718003000_parties.sql:30-37 explains why `parties` has no unique name index): two genuinely
 * distinct clients may legitimately share a name, so the product warns and lets a human decide.
 *
 * EVERY MUTATION AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024, V-031)
 * =====================================================================
 * The reference wrote its audit row through a separate `IAuditWriter` call AFTER the save, so a
 * crash in between produced a change with no audit trail. Here each mutation opens one transaction
 * covering the write and the audit row — strictly stronger, and the pattern every other domain in
 * this port already uses. The duplicate-name SEARCH runs inside that transaction too, so it sees
 * the row just written and must exclude it by id (as the reference does, :90).
 *
 * THERE IS NO DELETE OPERATION IN THIS FILE, AND THERE MUST NOT BE ONE (P-05, PRD 12.9).
 */
import { writeAudit } from '../audit/index.js';
import { withTransaction, type DbClient, type TenantId } from '../../lib/db/index.js';
import {
  invalidIndustryError,
  invalidPartyTypeError,
  invalidRegionError,
  invalidSegmentError,
  partyNotFoundError,
} from './errors.js';
import { normalizePartyName } from './name-matching.js';
import {
  findParty,
  findSimilarPartyNames,
  insertParty,
  isActiveReferenceItem,
  listLeadsForParty,
  listParties as listPartiesRows,
  updateParty as updatePartyRow,
  type PartyWriteValues,
} from './repository.js';
import {
  DUPLICATE_NAME_WARNING_CODE,
  PARTY_SORT_FIELDS,
  type LeadListItemDto,
  type ListPartiesQuery,
  type PartyDto,
  type PartyListDto,
  type PartyMutationResultDto,
  type PartySortField,
  type PartyWarningDto,
  type PartyWriteInput,
} from './schemas.js';

export interface PartiesDeps {
  readonly db: DbClient;
}

/** Who performed the action and in which verified tenant, for audit rows and the `*_by` stamps. */
export interface PartiesActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly correlationId?: string;
}

export const PARTY_CREATED_ACTION = 'party.created';
export const PARTY_UPDATED_ACTION = 'party.updated';

/** `ListPartiesQueryHandler` (:21-22): page floors at 1, a non-positive page size falls back to 25. */
const DEFAULT_PAGE_SIZE = 25;

function auditContext(actor: PartiesActor): { context?: { correlationId: string } } {
  return actor.correlationId === undefined ? {} : { context: { correlationId: actor.correlationId } };
}

/** `null` for an absent optional field, so "omitted" and "explicitly null" behave identically. */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/**
 * `SortSpec.Parse` (src/api/QuoteIQ.Infrastructure/Persistence/SortSpec.cs): a bare key ascending,
 * a `-` prefix descending. An UNRECOGNISED field is not an error — it falls through to the store's
 * default ordering, so a stale bookmark or hand-edited URL still returns a sane list.
 *
 * Narrowing to the `PartySortField` union here is what keeps the caller-supplied string out of SQL
 * entirely: the repository switches on the union and never interpolates the raw value.
 */
export function parsePartySort(sort: string | undefined): {
  field: PartySortField | null;
  descending: boolean;
} {
  if (sort === undefined || sort.trim() === '') return { field: null, descending: false };

  const descending = sort.startsWith('-');
  const raw = descending ? sort.slice(1) : sort;
  const field = (PARTY_SORT_FIELDS as readonly string[]).includes(raw)
    ? (raw as PartySortField)
    : null;

  return { field, descending };
}

/** `ListPartiesQueryHandler` (:19-37) + the count overlay it applies (:28-34). */
export async function listPartiesForTenant(
  deps: PartiesDeps,
  query: ListPartiesQuery,
  actor: PartiesActor,
): Promise<PartyListDto> {
  const page = query.page === undefined || query.page < 1 ? 1 : query.page;
  const pageSize =
    query.pageSize === undefined || query.pageSize < 1 ? DEFAULT_PAGE_SIZE : query.pageSize;

  const { items, totalCount } = await listPartiesRows(deps.db, actor.tenantId, {
    search: query.search,
    partyTypeId: query.partyTypeId,
    segmentId: query.segmentId,
    industryId: query.industryId,
    regionId: query.regionId,
    strategic: query.strategic,
    sort: parsePartySort(query.sort),
    page,
    pageSize,
  });

  return { items, totalCount, page, pageSize };
}

/** `GetPartyQueryHandler`. A foreign-tenant id resolves to the SAME 404 as a missing one (N-01). */
export async function getPartyById(
  deps: PartiesDeps,
  id: number,
  actor: PartiesActor,
): Promise<PartyDto> {
  const party = await findParty(deps.db, actor.tenantId, id);
  if (party === undefined) throw partyNotFoundError(id);
  return party;
}

/**
 * `GetPartyLeadsQueryHandler` (:20-32).
 *
 * THE PARTY IS RESOLVED FIRST, AND THAT ORDER IS THE ISOLATION GUARD (:22-26). Asking for another
 * tenant's party id must 404 rather than return an empty array: an empty array and a 404 are
 * distinguishable, and "this id exists but has no leads" versus "this id is not yours" is exactly
 * the cross-tenant existence oracle N-01 forbids. Both answers are the same 404 here because
 * `findParty` is tenant-predicated.
 */
export async function getPartyLeads(
  deps: PartiesDeps,
  partyId: number,
  actor: PartiesActor,
): Promise<LeadListItemDto[]> {
  const party = await findParty(deps.db, actor.tenantId, partyId);
  if (party === undefined) throw partyNotFoundError(partyId);

  return await listLeadsForParty(deps.db, actor.tenantId, partyId);
}

/**
 * The four reference-value guards, in the reference's ORDER (party type, segment, industry, region
 * — CreatePartyCommandHandler.cs:42-63, UpdatePartyCommandHandler.cs:45-66).
 *
 * The order is observable: a body with both a bad segment and a bad region reports the SEGMENT.
 * Optional ids are only checked WHEN SUPPLIED (`is not null`), which is what keeps a null region
 * legal (Q-9: a party's region is never required).
 */
async function assertReferenceValues(
  deps: PartiesDeps,
  tenantId: TenantId,
  input: PartyWriteInput,
): Promise<void> {
  if (!(await isActiveReferenceItem(deps.db, tenantId, input.partyTypeId, 'party_type'))) {
    throw invalidPartyTypeError(input.partyTypeId);
  }

  const segmentId = orNull(input.segmentId);
  if (segmentId !== null && !(await isActiveReferenceItem(deps.db, tenantId, segmentId, 'party_segment'))) {
    throw invalidSegmentError(segmentId);
  }

  const industryId = orNull(input.industryId);
  if (industryId !== null && !(await isActiveReferenceItem(deps.db, tenantId, industryId, 'industry'))) {
    throw invalidIndustryError(industryId);
  }

  const regionId = orNull(input.regionId);
  if (regionId !== null && !(await isActiveReferenceItem(deps.db, tenantId, regionId, 'region'))) {
    throw invalidRegionError(regionId);
  }
}

function toWriteValues(input: PartyWriteInput, actor: PartiesActor): PartyWriteValues {
  return {
    name: normalizePartyName(input.name),
    partyTypeId: input.partyTypeId,
    segmentId: orNull(input.segmentId),
    industryId: orNull(input.industryId),
    regionId: orNull(input.regionId),
    // `request.IsStrategic ?? false` (PartyEndpoints.cs:47,66).
    isStrategic: input.isStrategic ?? false,
    contactName: orNull(input.contactName),
    contactEmail: orNull(input.contactEmail),
    contactPhone: orNull(input.contactPhone),
    actorUserId: actor.userId,
  };
}

/** The mutable field snapshot the audit rows record (CreatePartyCommandHandler.cs:87). */
function auditPayload(party: PartyDto): Record<string, string | number | boolean | null> {
  return {
    name: party.name,
    partyTypeId: party.partyTypeId,
    segmentId: party.segmentId,
    industryId: party.industryId,
    regionId: party.regionId,
    isStrategic: party.isStrategic,
    contactName: party.contactName,
    contactEmail: party.contactEmail,
    contactPhone: party.contactPhone,
  };
}

/**
 * `PartyWarningDto.DuplicateName` (PartyDto.cs:59-60), or NO warning at all when nothing is similar.
 *
 * An empty `matches` array is never emitted: the reference attaches the warning object only when
 * `matches.Count > 0` (:91-93), so `warnings: []` is the "no near-duplicates" answer and the SPA's
 * banner keys off the array being non-empty.
 */
function duplicateWarnings(
  matches: readonly { id: number; name: string }[],
): PartyWarningDto[] {
  return matches.length === 0
    ? []
    : [{ code: DUPLICATE_NAME_WARNING_CODE, matches: [...matches] }];
}

/**
 * `CreatePartyCommandHandler` (:33-96).
 *
 * Note the sequence, which is the reference's and is load-bearing (see the file header): validate
 * shape (routes.ts), validate reference values, WRITE, audit, THEN look for similar names.
 */
export async function createParty(
  deps: PartiesDeps,
  input: PartyWriteInput,
  actor: PartiesActor,
): Promise<PartyMutationResultDto> {
  await assertReferenceValues(deps, actor.tenantId, input);

  return await withTransaction(deps.db, async (trx) => {
    const party = await insertParty(trx, actor.tenantId, toWriteValues(input, actor));

    await writeAudit(trx, {
      entityType: 'party',
      entityId: String(party.id),
      action: PARTY_CREATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: auditPayload(party),
      ...auditContext(actor),
    });

    const matches = await findSimilarPartyNames(trx, actor.tenantId, party.name, party.id);
    return { party, warnings: duplicateWarnings(matches) };
  });
}

/**
 * `UpdatePartyCommandHandler` (:30-110).
 *
 * The existence check comes BEFORE the reference-value guards (:39-43 precede :45), which is
 * observable: editing another tenant's party with an invalid body answers 404, not 422. Preserved.
 */
export async function updatePartyById(
  deps: PartiesDeps,
  id: number,
  input: PartyWriteInput,
  actor: PartiesActor,
): Promise<PartyMutationResultDto> {
  const existing = await findParty(deps.db, actor.tenantId, id);
  if (existing === undefined) throw partyNotFoundError(id);

  await assertReferenceValues(deps, actor.tenantId, input);

  return await withTransaction(deps.db, async (trx) => {
    const party = await updatePartyRow(trx, actor.tenantId, id, toWriteValues(input, actor));

    await writeAudit(trx, {
      entityType: 'party',
      entityId: String(party.id),
      action: PARTY_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      // The reference's before/after diff (:88-102), on this port's `before`/`after` keys.
      before: auditPayload(existing),
      after: auditPayload(party),
      ...auditContext(actor),
    });

    const matches = await findSimilarPartyNames(trx, actor.tenantId, party.name, party.id);
    return { party, warnings: duplicateWarnings(matches) };
  });
}
