/**
 * Tenant-scoped quotes persistence (T-026; AC-021, AC-022, AC-052, AC-053).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Quotes/QuoteStore.cs` (the `IQuoteStore` seam) and
 * `QuoteWorkflowStore`.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NOTHING UNDERNEATH IT
 * ===================================================================
 * Postgres RLS is NOT adopted (spec Q-10). The reference had TWO layers (an explicit predicate plus
 * EF's ambient query filter); this port has ONE. A forgotten predicate here is an unguarded
 * cross-tenant read with no database net beneath it. Single-table access goes through
 * `forTenant(...)`, whose `insertInto` additionally INJECTS `tenant_id` so a hostile body cannot
 * write into another tenant. The two joined reads carry their own `tenant_id` predicate on EVERY
 * alias, written out one join at a time.
 *
 * NOTHING HERE OPENS ITS OWN TRANSACTION
 * ======================================
 * Same contract as `leads/repository.ts`: every function takes an executor, so a caller hands in
 * the operation's open transaction and has the mutation, its history row and its audit row commit
 * or roll back together. That is what makes "nothing persists" on the pricing gate true.
 *
 * MONEY NEVER BECOMES A `number` ON THE WAY IN OR THROUGH
 * ======================================================
 * `quoted_premium`, `bound_premium` and `competitor_premium` are `numeric(18,2)`, which the Kysely
 * schema types as `string` because node-postgres returns them as strings — a Postgres `numeric`
 * does not fit an IEEE double without loss. This module therefore keeps them as STRINGS end to end
 * on the write path (`toNumericParam`) and only widens to `number` at the DTO boundary where the
 * wire contract requires it. The one comparison that matters for correctness — the high-value
 * pricing gate — is done in SQL against `numeric` (`isCurrentVersionPremiumAbove`) rather than in
 * JavaScript, so no premium is ever routed through a double to make a business decision. There is
 * deliberately no `sql<number>` cast anywhere in this file; the T-008 money pin cannot catch one
 * written here, so it is asserted in this task's own integration suite instead.
 */
import { sql } from 'kysely';

import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';

/** `bigint` arrives as a string from node-postgres. */
function toId(value: number | string): number {
  return Number(value);
}

function toNullableId(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/** Widens a `numeric` string to the `number` the wire contract declares. DTO boundary only. */
function toAmount(value: number | string): number {
  return Number(value);
}

function toNullableAmount(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/** Money goes to Postgres as a STRING so the driver cannot re-widen it through a double. */
function toNumericParam(value: number | null): string | null {
  return value === null ? null : String(value);
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

/** The persisted quote, as the service and the workflow need it. */
export interface QuoteRecord {
  readonly id: number;
  readonly leadId: number;
  readonly quoteRef: string;
  readonly statusId: number;
  readonly isCurrent: boolean;
  readonly productLineId: number;
  readonly coverTypeId: number;
  readonly preparedDate: string;
  readonly sentDate: string | null;
  readonly validUntil: string | null;
  readonly decisionDate: string | null;
  readonly boundPremium: number | null;
  readonly lostReasonId: number | null;
  readonly competitor: string | null;
  readonly competitorPremium: number | null;
  readonly lossComments: string | null;
  readonly withdrawalNote: string | null;
  readonly notes: string | null;
}

const QUOTE_COLUMNS = [
  'id',
  'lead_id',
  'quote_ref',
  'status_id',
  'is_current',
  'product_line_id',
  'cover_type_id',
  'prepared_date',
  'sent_date',
  'valid_until',
  'decision_date',
  'bound_premium',
  'lost_reason_id',
  'competitor',
  'competitor_premium',
  'loss_comments',
  'withdrawal_note',
  'notes',
] as const;

interface QuoteRow {
  readonly id: number | string;
  readonly lead_id: number | string;
  readonly quote_ref: string;
  readonly status_id: number | string;
  readonly is_current: boolean;
  readonly product_line_id: number | string;
  readonly cover_type_id: number | string;
  readonly prepared_date: Date | string;
  readonly sent_date: Date | string | null;
  readonly valid_until: Date | string | null;
  readonly decision_date: Date | string | null;
  readonly bound_premium: number | string | null;
  readonly lost_reason_id: number | string | null;
  readonly competitor: string | null;
  readonly competitor_premium: number | string | null;
  readonly loss_comments: string | null;
  readonly withdrawal_note: string | null;
  readonly notes: string | null;
}

function toQuoteRecord(row: QuoteRow): QuoteRecord {
  return {
    id: toId(row.id),
    leadId: toId(row.lead_id),
    quoteRef: row.quote_ref,
    statusId: toId(row.status_id),
    isCurrent: row.is_current,
    productLineId: toId(row.product_line_id),
    coverTypeId: toId(row.cover_type_id),
    preparedDate: toDateOnly(row.prepared_date),
    sentDate: toDateOnlyOrNull(row.sent_date),
    validUntil: toDateOnlyOrNull(row.valid_until),
    decisionDate: toIsoOrNull(row.decision_date),
    boundPremium: toNullableAmount(row.bound_premium),
    lostReasonId: toNullableId(row.lost_reason_id),
    competitor: row.competitor,
    competitorPremium: toNullableAmount(row.competitor_premium),
    lossComments: row.loss_comments,
    withdrawalNote: row.withdrawal_note,
    notes: row.notes,
  };
}

/** `QuoteStore.FindAsync`. A foreign-tenant id resolves to `undefined`, never to a row. */
export async function findQuote(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<QuoteRecord | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('quotes')
    .select(QUOTE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as QuoteRow | undefined;

  return row === undefined ? undefined : toQuoteRecord(row);
}

export interface InsertQuoteValues {
  readonly leadId: number;
  readonly quoteRef: string;
  readonly statusId: number;
  readonly isCurrent: boolean;
  readonly productLineId: number;
  readonly coverTypeId: number;
  readonly preparedDate: string;
  readonly validUntil: string | null;
  readonly notes: string | null;
  readonly actorUserId: number | null;
  readonly now: string;
}

/** `QuoteStore.AddAsync`. `tenant_id` is injected by the scope, never taken from the body. */
export async function insertQuote(
  trx: DbExecutor,
  tenantId: TenantId,
  values: InsertQuoteValues,
): Promise<QuoteRecord> {
  const row = (await forTenant(trx, tenantId)
    .insertInto('quotes', {
      lead_id: values.leadId,
      quote_ref: values.quoteRef,
      status_id: values.statusId,
      is_current: values.isCurrent,
      product_line_id: values.productLineId,
      cover_type_id: values.coverTypeId,
      prepared_date: values.preparedDate,
      valid_until: values.validUntil,
      notes: values.notes,
      created_at: values.now,
      updated_at: values.now,
      created_by: values.actorUserId,
      updated_by: values.actorUserId,
    })
    .returning(QUOTE_COLUMNS)
    .executeTakeFirstOrThrow()) as unknown as QuoteRow;

  return toQuoteRecord(row);
}

/** The quote columns the operations and the draft edit own. Only what is passed is written. */
export interface QuoteWriteFields {
  readonly statusId?: number;
  readonly isCurrent?: boolean;
  readonly productLineId?: number;
  readonly coverTypeId?: number;
  readonly preparedDate?: string;
  readonly sentDate?: string | null;
  readonly validUntil?: string | null;
  readonly decisionDate?: string | null;
  readonly boundPremium?: number | null;
  readonly lostReasonId?: number | null;
  readonly competitor?: string | null;
  readonly competitorPremium?: number | null;
  readonly lossComments?: string | null;
  readonly withdrawalNote?: string | null;
  readonly notes?: string | null;
}

/** `QuoteStore.SaveChangesAsync` for the quote row — one statement, only the named columns. */
export async function updateQuoteFields(
  trx: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
  fields: QuoteWriteFields,
  now: string,
  actorUserId: number | null,
): Promise<void> {
  const values: Record<string, unknown> = {
    updated_at: now,
    updated_by: actorUserId,
  };

  if (fields.statusId !== undefined) values['status_id'] = fields.statusId;
  if (fields.isCurrent !== undefined) values['is_current'] = fields.isCurrent;
  if (fields.productLineId !== undefined) values['product_line_id'] = fields.productLineId;
  if (fields.coverTypeId !== undefined) values['cover_type_id'] = fields.coverTypeId;
  if (fields.preparedDate !== undefined) values['prepared_date'] = fields.preparedDate;
  if (fields.sentDate !== undefined) values['sent_date'] = fields.sentDate;
  if (fields.validUntil !== undefined) values['valid_until'] = fields.validUntil;
  if (fields.decisionDate !== undefined) values['decision_date'] = fields.decisionDate;
  if (fields.boundPremium !== undefined) {
    values['bound_premium'] = toNumericParam(fields.boundPremium);
  }
  if (fields.lostReasonId !== undefined) values['lost_reason_id'] = fields.lostReasonId;
  if (fields.competitor !== undefined) values['competitor'] = fields.competitor;
  if (fields.competitorPremium !== undefined) {
    values['competitor_premium'] = toNumericParam(fields.competitorPremium);
  }
  if (fields.lossComments !== undefined) values['loss_comments'] = fields.lossComments;
  if (fields.withdrawalNote !== undefined) values['withdrawal_note'] = fields.withdrawalNote;
  if (fields.notes !== undefined) values['notes'] = fields.notes;

  await forTenant(trx, tenantId)
    .updateTable('quotes')
    .set(values)
    .where('id', '=', quoteId)
    .execute();
}

/** One `quote_versions` row. `quotedPremium` is widened only here, at the DTO boundary. */
export interface QuoteVersionRecord {
  readonly id: number;
  readonly versionNo: number;
  readonly quotedPremium: number;
  readonly termsNotes: string | null;
  readonly revisionNote: string | null;
  readonly isCurrent: boolean;
  readonly createdAt: string;
}

interface QuoteVersionRow {
  readonly id: number | string;
  readonly version_no: number | string;
  readonly quoted_premium: number | string;
  readonly terms_notes: string | null;
  readonly revision_note: string | null;
  readonly is_current: boolean;
  readonly created_at: Date | string;
}

function toVersionRecord(row: QuoteVersionRow): QuoteVersionRecord {
  return {
    id: toId(row.id),
    versionNo: Number(row.version_no),
    quotedPremium: toAmount(row.quoted_premium),
    termsNotes: row.terms_notes,
    revisionNote: row.revision_note,
    isCurrent: row.is_current,
    createdAt: toIsoOrNull(row.created_at) ?? '',
  };
}

const VERSION_COLUMNS = [
  'id',
  'version_no',
  'quoted_premium',
  'terms_notes',
  'revision_note',
  'is_current',
  'created_at',
] as const;

/** `QuoteStore.AddVersionAsync` (`quotedPremium` handed over as a numeric STRING). */
export async function insertQuoteVersion(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    quoteId: number;
    versionNo: number;
    quotedPremium: number;
    termsNotes: string | null;
    revisionNote: string | null;
    isCurrent: boolean;
    createdAt: string;
    createdBy: number | null;
  },
): Promise<void> {
  await forTenant(trx, tenantId)
    .insertInto('quote_versions', {
      quote_id: values.quoteId,
      version_no: values.versionNo,
      quoted_premium: String(values.quotedPremium),
      terms_notes: values.termsNotes,
      revision_note: values.revisionNote,
      is_current: values.isCurrent,
      created_at: values.createdAt,
      created_by: values.createdBy,
    })
    .execute();
}

/** `QuoteStore.ListVersionsAsync`, ordered by version number (`GetQuoteQueryHandler` :51). */
export async function listQuoteVersions(
  executor: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
): Promise<QuoteVersionRecord[]> {
  const rows = (await forTenant(executor, tenantId)
    .selectFrom('quote_versions')
    .select(VERSION_COLUMNS)
    .where('quote_id', '=', quoteId)
    .orderBy('version_no')
    .execute()) as unknown as QuoteVersionRow[];

  return rows.map(toVersionRecord);
}

/** `QuoteStore.FindCurrentVersionAsync` — the one version flagged current, if any. */
export async function findCurrentQuoteVersion(
  executor: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
): Promise<QuoteVersionRecord | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('quote_versions')
    .select(VERSION_COLUMNS)
    .where('quote_id', '=', quoteId)
    .where('is_current', '=', true)
    .executeTakeFirst()) as unknown as QuoteVersionRow | undefined;

  return row === undefined ? undefined : toVersionRecord(row);
}

/**
 * THE HIGH-VALUE PRICING GATE'S COMPARISON, DONE IN SQL (`SendQuoteCommandHandler.cs:85-91`).
 *
 * The reference compares `currentVersion.QuotedPremium > settings.HighValueThreshold` in C#, where
 * both are `decimal` — an exact base-10 type. The nearest JavaScript equivalent would route two
 * money values through IEEE doubles to make a business decision, which is exactly what the T-008
 * money pins exist to prevent. So the comparison happens in Postgres against `numeric`, with the
 * threshold passed as a string and cast: `> ` is a `numeric` comparison, exact at any scale.
 *
 * Returns false when there is no current version — matching the reference's
 * `currentVersion is not null` conjunct, which makes a version-less quote pass the gate rather than
 * trip it.
 */
export async function isCurrentVersionPremiumAbove(
  executor: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
  threshold: string,
): Promise<boolean> {
  const result = await sql<{ ok: number }>`
    select 1 as ok
      from quote_versions v
     where v.tenant_id = ${tenantId}
       and v.quote_id = ${quoteId}
       and v.is_current = true
       and v.quoted_premium > ${threshold}::numeric
     limit 1
  `.execute(executor);

  return result.rows.length > 0;
}

/**
 * `currentVersion.QuotedPremium = command.QuotedPremium` — the Draft edit's in-place premium write.
 *
 * Rewrites the CURRENT version rather than minting a new one: minting is Revise's job, and doing it
 * here would make every draft correction look like a revision in the version history. Money is
 * handed over as a numeric STRING so the driver cannot re-widen it through a double.
 */
export async function updateQuoteVersionPremium(
  trx: DbExecutor,
  tenantId: TenantId,
  versionId: number,
  quotedPremium: number,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('quote_versions')
    .set({ quoted_premium: String(quotedPremium) })
    .where('id', '=', versionId)
    .execute();
}

/** `priorCurrent.IsCurrent = false` — demotes a quote's current version (Revise). */
export async function demoteCurrentQuoteVersion(
  trx: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('quote_versions')
    .set({ is_current: false })
    .where('quote_id', '=', quoteId)
    .where('is_current', '=', true)
    .execute();
}

/**
 * `QuoteStore.DemoteOtherCurrentQuotesAsync` — clears `is_current` on every OTHER quote of the lead
 * (FR-50: exactly one current quote per lead).
 *
 * Now backed by `uq_quotes_current` (this task's migration): if two callers race, one commits and
 * the other fails the unique index rather than both committing a current quote.
 */
export async function demoteOtherCurrentQuotes(
  trx: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  exceptQuoteId: number,
  now: string,
  actorUserId: number | null,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('quotes')
    .set({ is_current: false, updated_at: now, updated_by: actorUserId })
    .where('lead_id', '=', leadId)
    .where('id', '!=', exceptQuoteId)
    .where('is_current', '=', true)
    .execute();
}

/** `QuoteStore.HasAnyQuoteForLeadAsync` — the first quote of a lead becomes current by default. */
export async function hasAnyQuoteForLead(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<boolean> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('quotes')
    .select('id')
    .where('lead_id', '=', leadId)
    .executeTakeFirst();

  return row !== undefined;
}

/** One sibling quote, for the mark-won withdrawal cascade and mark-lost's "any left?" check. */
export interface SiblingQuoteRecord {
  readonly id: number;
  readonly statusId: number;
}

/**
 * `QuoteStore.ListOtherOpenQuotesAsync` — every OTHER quote of the lead whose status carries an
 * OPEN or QUOTED reporting category.
 *
 * "Open" is a property of the status's reporting CATEGORY, never of a canonical-key list — that is
 * what lets a tenant add its own intermediate quote status and still have it cascade correctly.
 * (Note this is the one place quote logic keys off a CATEGORY; the legality matrix does not.)
 */
export async function listOtherOpenQuotes(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  excludeQuoteId: number,
): Promise<SiblingQuoteRecord[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('quotes')
    .innerJoin('reference_items', 'reference_items.id', 'quotes.status_id')
    .select(['quotes.id as id', 'quotes.status_id as status_id'])
    .where('quotes.lead_id', '=', leadId)
    .where('quotes.id', '!=', excludeQuoteId)
    .where('reference_items.reporting_category', 'in', ['open', 'quoted'])
    .orderBy('quotes.id')
    .execute();

  return rows.map((row) => ({
    id: toId(row.id as number | string),
    statusId: toId(row.status_id as number | string),
  }));
}

/**
 * `QuoteStore.ListForLeadAsync` + `ListQuotesForLeadQueryHandler`'s projection, as ONE joined query.
 *
 * The reference looped per quote doing three extra lookups each (status, product line, current
 * version) — a textbook N+1 on the lead detail's Quotes card. Same rows, same order
 * (`OrderByDescending(PreparedDate).ThenByDescending(Id)`), one round trip. Every alias carries its
 * own tenant predicate.
 */
/** One quote-expiry candidate: the ids the T-032 sweep needs and nothing else. */
export interface ExpiryCandidateRecord {
  readonly id: number;
  readonly leadId: number;
}

/**
 * `QuoteStore.ListExpiredCandidatesAsync` (:185-209) — the T-032 quote-expiry sweep's candidate set.
 *
 * THE PREDICATE IS PORTED FROM THE REFERENCE, NOT RE-DERIVED FROM THE TASK WORDING
 * ===============================================================================
 * Three conditions, all measured:
 *
 *   1. `valid_until IS NOT NULL` — a quote with no expiry date can never lapse. Postgres would
 *      already drop NULLs on the `<` comparison; it is stated anyway so the intent is not an
 *      accident of three-valued logic.
 *   2. `valid_until < asOfDate` — STRICTLY less than today. A quote valid THROUGH today is still
 *      valid today, so `<=` would expire it a day early, on the last day it is meant to be usable.
 *      Both sides of this boundary are fixtures in `quote-expiry-job.test.ts`.
 *   3. `canonical_key IN ('sent','revised')` — BOTH, per `expirableCanonicalKeys` (:188). T-032's
 *      task text says only "Sent"; the reference includes Revised and T-026's legality matrix
 *      already allows `expire_automatic` from both. The reference wins.
 *
 * Note this keys off the canonical KEY, unlike `listOtherOpenQuotes` above which keys off the
 * reporting CATEGORY. That asymmetry is the reference's and is preserved: a tenant-added quote
 * status is never auto-expired, because nothing states what its expiry semantics should be.
 *
 * `asOfDate` is a date-only string (`YYYY-MM-DD`), tenant-local modelled as UTC — the reference's
 * `DateOnly.FromDateTime(DateTime.UtcNow)`, flagged there as an MVP simplification because no
 * per-tenant timezone column exists. That flag is inherited, not resolved here.
 */
export async function listExpiredQuoteCandidates(
  executor: DbExecutor,
  tenantId: TenantId,
  asOfDate: string,
): Promise<ExpiryCandidateRecord[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('quotes')
    .innerJoin('reference_items', 'reference_items.id', 'quotes.status_id')
    .select(['quotes.id as id', 'quotes.lead_id as lead_id'])
    .where('quotes.valid_until', 'is not', null)
    .where('quotes.valid_until', '<', asOfDate)
    .where('reference_items.canonical_key', 'in', ['sent', 'revised'])
    .orderBy('quotes.id')
    .execute();

  return rows.map((row) => ({
    id: toId(row.id as number | string),
    leadId: toId(row.lead_id as number | string),
  }));
}

export async function listQuotesForLead(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<
  {
    id: number;
    quoteRef: string;
    statusName: string;
    statusCanonicalKey: string | null;
    isCurrent: boolean;
    productLineName: string;
    currentQuotedPremium: number;
    preparedDate: string;
    sentDate: string | null;
    validUntil: string | null;
  }[]
> {
  const result = await sql<{
    id: number | string;
    quote_ref: string;
    status_name: string;
    canonical_key: string | null;
    is_current: boolean;
    product_line_name: string;
    current_quoted_premium: string | null;
    prepared_date: Date | string;
    sent_date: Date | string | null;
    valid_until: Date | string | null;
  }>`
    select q.id, q.quote_ref, s.name as status_name, s.canonical_key, q.is_current,
           pl.name as product_line_name,
           (select v.quoted_premium
              from quote_versions v
             where v.tenant_id = ${tenantId} and v.quote_id = q.id and v.is_current = true
             limit 1) as current_quoted_premium,
           q.prepared_date, q.sent_date, q.valid_until
      from quotes q
      join reference_items s on s.id = q.status_id and s.tenant_id = ${tenantId}
      join reference_items pl on pl.id = q.product_line_id and pl.tenant_id = ${tenantId}
     where q.tenant_id = ${tenantId}
       and q.lead_id = ${leadId}
     order by q.prepared_date desc, q.id desc
  `.execute(executor);

  return result.rows.map((row) => ({
    id: toId(row.id),
    quoteRef: row.quote_ref,
    statusName: row.status_name,
    statusCanonicalKey: row.canonical_key,
    isCurrent: row.is_current,
    productLineName: row.product_line_name,
    // `?? 0m` in the reference: a quote with no current version reports zero rather than crashing.
    currentQuotedPremium:
      row.current_quoted_premium === null ? 0 : toAmount(row.current_quoted_premium),
    preparedDate: toDateOnly(row.prepared_date),
    sentDate: toDateOnlyOrNull(row.sent_date),
    validUntil: toDateOnlyOrNull(row.valid_until),
  }));
}

/** `QuoteStore.FindAssignmentAsync` — the slot row for one quote, if any. */
export async function findQuoteAssignment(
  executor: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
  businessAssignmentId: number,
): Promise<{ id: number; userId: number } | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('quote_assignments')
    .select(['id', 'user_id'])
    .where('quote_id', '=', quoteId)
    .where('business_assignment_id', '=', businessAssignmentId)
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : { id: toId(row.id as number | string), userId: toId(row.user_id as number | string) };
}

/** `QuoteStore.AddAssignmentAsync`. */
export async function insertQuoteAssignment(
  trx: DbExecutor,
  tenantId: TenantId,
  values: {
    quoteId: number;
    businessAssignmentId: number;
    userId: number;
    actorUserId: number | null;
    now: string;
  },
): Promise<void> {
  await forTenant(trx, tenantId)
    .insertInto('quote_assignments', {
      quote_id: values.quoteId,
      business_assignment_id: values.businessAssignmentId,
      user_id: values.userId,
      created_at: values.now,
      updated_at: values.now,
      created_by: values.actorUserId,
      updated_by: values.actorUserId,
    })
    .execute();
}

/** The `existing.UserId = ...` branch of Assign/Reassign. */
export async function updateQuoteAssignmentUser(
  trx: DbExecutor,
  tenantId: TenantId,
  assignmentId: number,
  userId: number,
  now: string,
  actorUserId: number | null,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('quote_assignments')
    .set({ user_id: userId, updated_at: now, updated_by: actorUserId })
    .where('id', '=', assignmentId)
    .execute();
}

/**
 * `QuoteStore.RemoveAssignmentAsync` — the clear-the-slot half of the Assign/Reassign contract.
 *
 * A hard delete, matching the reference and the lead side: an assignment row is current state, not
 * history. The record that a slot WAS held and by whom lives in `quote_status_history.inputs`.
 */
export async function deleteQuoteAssignment(
  trx: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
  businessAssignmentId: number,
): Promise<void> {
  await forTenant(trx, tenantId)
    .deleteFrom('quote_assignments')
    .where('quote_id', '=', quoteId)
    .where('business_assignment_id', '=', businessAssignmentId)
    .execute();
}

/** One `quote_status_history` row as the detail projection reads it back. */
export interface QuoteStatusHistoryRecord {
  readonly id: number;
  readonly operation: string;
  readonly previousStatusId: number | null;
  readonly newStatusId: number | null;
  readonly actedBy: number | null;
  readonly actedAt: string;
}

/**
 * `QuoteWorkflowStore.ListHistoryAsync`, oldest first, in APPEND order.
 *
 * ORDER BY `id`, NOT BY `acted_at` (T-048) — identical to `listStatusHistory` on the lead side by
 * design; see the full rationale there. In short: `id` is the identity column the database assigns
 * at INSERT, so it increases strictly with append order, whereas `acted_at` is the executor's
 * application-supplied `new Date()` wall clock, which ties at millisecond resolution and can step
 * BACKWARDS across an NTP or VM host correction. `(acted_at, id)` is a total order but it faithfully
 * reproduces any such regression as a REORDERED audit trail, which for an append-only history is a
 * correctness defect. `acted_at` stays as the user-visible "when".
 */
export async function listQuoteStatusHistory(
  executor: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
): Promise<QuoteStatusHistoryRecord[]> {
  const rows = await forTenant(executor, tenantId)
    .selectFrom('quote_status_history')
    .select(['id', 'operation', 'previous_status_id', 'new_status_id', 'acted_by', 'acted_at'])
    .where('quote_id', '=', quoteId)
    .orderBy('id')
    .execute();

  return rows.map((row) => ({
    id: toId(row.id as number | string),
    operation: row.operation as string,
    previousStatusId: toNullableId(row.previous_status_id as number | string | null),
    newStatusId: toNullableId(row.new_status_id as number | string | null),
    actedBy: toNullableId(row.acted_by as number | string | null),
    actedAt: toIsoOrNull(row.acted_at as Date | string) ?? '',
  }));
}

/**
 * Allocates and renders one quote reference inside the caller's transaction
 * (`IQuoteReferenceGenerator.GenerateAsync`).
 *
 * Deliberately delegates to the leads module's `allocateReferenceSequence` and the shared
 * `formatReference` grammar rather than reimplementing either: `reference_sequences` is one table
 * keyed by `entity_type`, and a second copy of the `FOR UPDATE` allocation would be one refactor
 * away from losing the row lock that makes concurrent creates non-duplicating. The YEAR comes from
 * the creation moment (UTC), so back-dating a quote does not reach into last year's sequence.
 */
export { QUOTE_SEQUENCE_ENTITY_TYPE, generateQuoteRef } from './quote-ref.js';
