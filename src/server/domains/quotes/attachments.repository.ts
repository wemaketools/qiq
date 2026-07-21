/**
 * Tenant-scoped `quote_attachments` persistence (T-027; AC-021, AC-022, AC-057).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Quotes/QuoteAttachmentStore.cs`.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NOTHING UNDERNEATH IT
 * ===================================================================
 * Same standing warning as `quotes/repository.ts`: RLS is not adopted (Q-10), and the reference's
 * second layer (EF's ambient query filter) does not exist here. `forTenant(...)` is the ONLY thing
 * confining these reads and writes, and its `insertInto` injects `tenant_id` so a hostile body
 * cannot write into another tenant. There is no unscoped query in this file and none may be added:
 * a forgotten predicate is a cross-tenant read of the keys that name other tenants' objects.
 *
 * NOTHING HERE OPENS ITS OWN TRANSACTION
 * ======================================
 * Every function takes an executor so the caller can hand in its open transaction, making the
 * metadata write, the lead-activity stamp and the audit row commit or roll back together.
 *
 * THE LIVE-SET PREDICATE IS `confirmed_at is not null and removed_at is null`, AND BOTH HALVES COUNT
 * =================================================================================================
 * `removed_at is null` is the reference's soft-delete filter. `confirmed_at is not null` is new with
 * the A-7 envelope: a row exists from the moment an upload is REQUESTED, before any bytes are
 * transferred. Omitting that half would list attachments whose objects do not exist, and would let
 * `getDownloadable` mint a signed URL for one — a 404 from Storage presented to the user as a file.
 */
import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';

/** A `quote_attachments` row, with ids widened from the driver's strings. */
export interface AttachmentRecord {
  readonly id: number;
  readonly quoteId: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
  readonly uploadedAt: string;
  readonly uploadedBy: number | null;
  readonly confirmedAt: string | null;
  readonly removedAt: string | null;
  readonly removedBy: number | null;
}

interface AttachmentRow {
  readonly id: number | string;
  readonly quote_id: number | string;
  readonly file_name: string;
  readonly content_type: string;
  readonly size_bytes: number | string;
  readonly storage_key: string;
  readonly uploaded_at: string;
  readonly uploaded_by: number | string | null;
  readonly confirmed_at: string | null;
  readonly removed_at: string | null;
  readonly removed_by: number | string | null;
}

const ATTACHMENT_COLUMNS = [
  'id',
  'quote_id',
  'file_name',
  'content_type',
  'size_bytes',
  'storage_key',
  'uploaded_at',
  'uploaded_by',
  'confirmed_at',
  'removed_at',
  'removed_by',
] as const;

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: Number(row.id),
    quoteId: Number(row.quote_id),
    fileName: row.file_name,
    contentType: row.content_type,
    // `bigint` arrives as a string from node-postgres; a 10 MB size is far inside a safe integer.
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by === null ? null : Number(row.uploaded_by),
    confirmedAt: row.confirmed_at,
    removedAt: row.removed_at,
    removedBy: row.removed_by === null ? null : Number(row.removed_by),
  };
}

/**
 * `QuoteAttachmentStore.FindAsync` (:29-34): the row in THIS tenant, live or not, or undefined.
 *
 * Returns pending and soft-removed rows too — the service decides what each state means, because
 * confirm must be able to see a pending row while download must not.
 */
export async function findAttachment(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<AttachmentRecord | undefined> {
  const row = (await forTenant(executor, tenantId)
    .selectFrom('quote_attachments')
    .select(ATTACHMENT_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as AttachmentRow | undefined;

  return row === undefined ? undefined : toRecord(row);
}

/**
 * The live set for one quote, oldest first.
 *
 * `orderBy('quote_attachments.id')` is QUALIFIED deliberately. Postgres resolves a bare
 * `order by <name>` against the OUTPUT COLUMN ALIASES before the underlying columns, so an
 * unqualified `order by id` in a projection that aliased `id` to text would sort lexically —
 * `10` before `9` — and produce an intermittently wrong order. Nothing here aliases `id` today;
 * qualifying it means nothing can start to.
 */
export async function listAttachmentsForQuote(
  executor: DbExecutor,
  tenantId: TenantId,
  quoteId: number,
): Promise<AttachmentRecord[]> {
  const rows = (await forTenant(executor, tenantId)
    .selectFrom('quote_attachments')
    .select(ATTACHMENT_COLUMNS)
    .where('quote_id', '=', quoteId)
    .where('confirmed_at', 'is not', null)
    .where('removed_at', 'is', null)
    .orderBy('quote_attachments.id')
    .execute()) as unknown as AttachmentRow[];

  return rows.map(toRecord);
}

export interface InsertAttachmentValues {
  readonly quoteId: number;
  readonly fileName: string;
  readonly contentType: string;
  /** The client's DECLARED size, replaced at confirm by what the server observed. */
  readonly declaredSizeBytes: number;
  readonly uploadedBy: number | null;
  readonly now: string;
}

/**
 * Inserts the PENDING row and returns its id.
 *
 * `storage_key` is written empty and set immediately afterwards by `setAttachmentStorageKey`,
 * mirroring the reference's own two-step (`UploadAttachmentCommandHandler.cs:150-157`): the key
 * embeds the attachment id, which the database assigns. The column is NOT NULL, so the empty string
 * is the placeholder — and it is unreachable in practice because both statements run in one
 * transaction. `tenant_id` is injected by `forTenant`, never taken from a caller.
 */
export async function insertAttachment(
  trx: DbExecutor,
  tenantId: TenantId,
  values: InsertAttachmentValues,
): Promise<number> {
  const inserted = await forTenant(trx, tenantId)
    .insertInto('quote_attachments', {
      quote_id: values.quoteId,
      file_name: values.fileName,
      content_type: values.contentType,
      size_bytes: values.declaredSizeBytes,
      storage_key: '',
      uploaded_at: values.now,
      uploaded_by: values.uploadedBy,
      confirmed_at: null,
      removed_at: null,
      removed_by: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return Number(inserted.id);
}

/** Second half of the insert: the key, now that the id exists. */
export async function setAttachmentStorageKey(
  trx: DbExecutor,
  tenantId: TenantId,
  id: number,
  storageKey: string,
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('quote_attachments')
    .set({ storage_key: storageKey })
    .where('id', '=', id)
    .execute();
}

/**
 * Marks the attachment confirmed and records the SERVER-OBSERVED size and content type.
 *
 * The size written here is the one `stat` measured, not the one the client declared — the whole
 * reason confirm re-observes the object. `uploaded_at` is restamped to the confirmation moment so
 * the timestamp the UI shows is when the file actually arrived, not when a URL was requested.
 */
export async function confirmAttachment(
  trx: DbExecutor,
  tenantId: TenantId,
  id: number,
  values: { observedSizeBytes: number; observedContentType: string; now: string },
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('quote_attachments')
    .set({
      size_bytes: values.observedSizeBytes,
      content_type: values.observedContentType,
      uploaded_at: values.now,
      confirmed_at: values.now,
    })
    .where('id', '=', id)
    .execute();
}

/**
 * SOFT remove (NFR-09): flags the row, never deletes it. `RemoveAttachmentCommandHandler.cs:88-90`.
 *
 * Guarded on `removed_at is null` so a concurrent double-remove cannot overwrite the first
 * remover's identity and timestamp with the second's.
 */
export async function softRemoveAttachment(
  trx: DbExecutor,
  tenantId: TenantId,
  id: number,
  values: { removedBy: number | null; now: string },
): Promise<void> {
  await forTenant(trx, tenantId)
    .updateTable('quote_attachments')
    .set({ removed_at: values.now, removed_by: values.removedBy })
    .where('id', '=', id)
    .where('removed_at', 'is', null)
    .execute();
}

/** A pending row the reaper (T-049) is a candidate to delete: id plus the object key to remove. */
export interface OrphanedAttachmentCandidate {
  readonly id: number;
  readonly storageKey: string;
}

/**
 * PENDING uploads whose signed URL has already expired (T-049; AC-024).
 *
 * The candidate predicate is `confirmed_at is null AND removed_at is null AND uploaded_at < cutoff`.
 * All three halves matter and none may be dropped:
 *   - `confirmed_at is null`  — a CONFIRMED attachment is a live business record; the reaper must
 *                               never touch it. This is the property `deletePendingAttachment`'s own
 *                               `confirmed_at is null` guard backstops on the write side.
 *   - `removed_at is null`    — a soft-removed row is history that NFR-09 preserves; it is not litter
 *                               to reclaim even though its object is already gone.
 *   - `uploaded_at < cutoff`  — and STRICTLY less than: a row at or after the cutoff may still be
 *                               uploading, because its signed URL has not yet expired. Reaping one in
 *                               flight would destroy a legitimate upload. The `<` (not `<=`) is the
 *                               whole ordering hazard the sweep exists to respect.
 *
 * `orderBy('quote_attachments.id')` is QUALIFIED for the same reason as the sibling reads: a bare
 * `order by id` resolves against output aliases first, and the projection selects `id` — an alias
 * that arrived as text would sort lexically. Nothing aliases it today; qualifying keeps it that way.
 */
export async function listOrphanedAttachmentCandidates(
  executor: DbExecutor,
  tenantId: TenantId,
  uploadedBefore: string,
): Promise<OrphanedAttachmentCandidate[]> {
  const rows = (await forTenant(executor, tenantId)
    .selectFrom('quote_attachments')
    .select(['id', 'storage_key'])
    .where('confirmed_at', 'is', null)
    .where('removed_at', 'is', null)
    .where('uploaded_at', '<', uploadedBefore)
    .orderBy('quote_attachments.id')
    .execute()) as unknown as { id: number | string; storage_key: string }[];

  return rows.map((row) => ({ id: Number(row.id), storageKey: row.storage_key }));
}

/**
 * Hard-deletes a PENDING row whose confirm failed validation.
 *
 * The only hard delete in this domain, and it does not violate NFR-09: NFR-09 preserves BUSINESS
 * records, and a row that never passed validation never became one — no user ever saw it, it never
 * appeared in a list, and its object has just been deleted from the bucket. Leaving it would
 * accumulate unreferenced rows that every future reader would have to remember to filter out.
 * Guarded on `confirmed_at is null` so a confirmed attachment can never be reached by this path.
 *
 * The T-049 orphaned-upload reaper reuses this exact function — same `confirmed_at is null` guard —
 * so a CONFIRMED row can never be deleted by the sweep even if its candidate query were ever wrong.
 */
export async function deletePendingAttachment(
  trx: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<void> {
  await forTenant(trx, tenantId)
    .deleteFrom('quote_attachments')
    .where('id', '=', id)
    .where('confirmed_at', 'is', null)
    .execute();
}
