/**
 * Quote attachments over the A-7 signed-URL envelope (T-027; AC-021, AC-022, AC-024, AC-056,
 * AC-057, AC-058; V-026, V-027, V-031, V-071..V-074).
 *
 * Ports `UploadAttachmentCommandHandler`, `DownloadAttachmentQueryHandler` and
 * `RemoveAttachmentCommandHandler`, re-cut across the envelope's two-step upload.
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY (AC-056)
 * ========================================================
 * Nothing is signed until everything checkable has been checked. `requestAttachmentUpload` runs, in
 * this order: resolve the quote IN THIS TENANT (a foreign or missing id dies here as a 404, before
 * any storage call exists) → closed-quote correction gate → content-type allow-list → extension
 * agreement → per-tenant size cap → only then insert the row and mint the URL. A disallowed type or
 * an oversize declaration therefore produces a 422 and NO URL, which is what V-071's negatives
 * assert. Reordering any check above the tenant lookup would leak, via the error code, whether a
 * quote id exists in another tenant.
 *
 * THE STORAGE KEY IS BUILT FROM SERVER-VERIFIED IDS, NEVER FROM THE REQUEST
 * ========================================================================
 * `tenantId` comes from the verified `TenantContext`, `quoteId` from the row just read under that
 * tenant, and `attachmentId` from the database. The ONLY caller-supplied component is the filename,
 * and it is sanitized (`lib/storage/keys.ts`) before it can contribute a character. A caller cannot
 * name a key, cannot reach another tenant's prefix, and cannot make two attachments collide.
 *
 * CONFIRM IS WHERE CLIENT CLAIMS ARE REPLACED BY SERVER OBSERVATIONS (R-8)
 * =======================================================================
 * `confirmAttachmentUpload` re-reads the object: `stat` supplies the size and content type that get
 * PERSISTED (the declared ones are used only for the cheap pre-signing rejection and are discarded),
 * and `readHead` supplies the leading bytes for the magic-number check the reference did mid-stream.
 * A file that is oversize, or whose bytes disagree with its declared type, is rejected AND the
 * object is deleted AND the pending row is dropped. What this cannot do — because the bytes reach
 * the bucket without passing through this function — is prevent the hostile object from existing at
 * all in the interval before confirm; see `attachment-content.ts` for that limitation stated in
 * full, including the unconfirmed-orphan case, which is a recorded finding rather than a fixed one.
 *
 * EVERY MUTATION AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024)
 * ==============================================================
 * Same discipline as the rest of the quotes domain: `writeAudit` is handed the SAME `trx` as the
 * business write, so a crash cannot leave a confirmed attachment with no audit trail. The storage
 * call is deliberately OUTSIDE the transaction and ordered per operation — see each function.
 */
import { writeAudit } from '../audit/index.js';
import { findSettings } from '../business-rules/repository.js';
import { stampLeadActivity, findReferenceItem } from '../leads/repository.js';
import type { EffectiveAccess } from '../rbac/effective-permissions.js';
import { InternalError } from '../../lib/errors/index.js';
import {
  buildAttachmentKey,
  sanitizeAttachmentFileName,
  type StorageAdapter,
} from '../../lib/storage/index.js';
import { withTransaction, type DbClient, type TenantId } from '../../lib/db/index.js';
import {
  ATTACHMENT_SIGNATURE_HEADER_BYTES,
  exceedsSizeCap,
  extensionOf,
  isAllowedAttachmentContentType,
  isExtensionAllowedForContentType,
  matchesDeclaredSignature,
} from './attachment-content.js';
import {
  attachmentAlreadyConfirmedError,
  attachmentClosedQuoteRequiresCorrectionError,
  attachmentExtensionMismatchError,
  attachmentNotFoundError,
  attachmentObjectMissingError,
  attachmentOverSizeCapError,
  attachmentQuoteNotFoundError,
  attachmentSignatureMismatchError,
  disallowedAttachmentTypeError,
} from './attachments.errors.js';
import {
  confirmAttachment,
  deletePendingAttachment,
  findAttachment,
  insertAttachment,
  listAttachmentsForQuote as listAttachmentRows,
  setAttachmentStorageKey,
  softRemoveAttachment,
  type AttachmentRecord,
} from './attachments.repository.js';
import type {
  AttachmentDownloadEnvelopeDto,
  AttachmentUploadEnvelopeDto,
  QuoteAttachmentDto,
  RequestAttachmentUploadInput,
} from './attachments.schemas.js';
import { findQuote } from './repository.js';

export const ATTACHMENT_UPLOADED_ACTION = 'quote_attachment.uploaded';
export const ATTACHMENT_REMOVED_ACTION = 'quote_attachment.removed';

/**
 * Download URL lifetime. Short because the URL is a bearer credential for the object: anyone
 * holding it can read the file, with no further authorization, until it expires. Five minutes is
 * ample for a browser to start the transfer and short enough that a URL leaked through a referrer
 * header, a proxy log or a shared screenshot is dead by the time it is used.
 */
export const ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS = 300;

export interface AttachmentsDeps {
  readonly db: DbClient;
  /**
   * The configured `StorageAdapter` (A-6). Injected rather than constructed here, which is what
   * makes AC-058's "switching adapters requires zero domain-code changes" true: this module names
   * no vendor and never imports `@supabase/supabase-js`.
   */
  readonly storage: StorageAdapter;
}

export interface AttachmentsActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly access: EffectiveAccess;
  readonly correlationId?: string;
}

function toDto(record: AttachmentRecord): QuoteAttachmentDto {
  return {
    id: record.id,
    quoteId: record.quoteId,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    uploadedAt: record.uploadedAt,
    uploadedBy: record.uploadedBy,
  };
}

/**
 * The reference's closed-record gate, applied identically to add and remove
 * (`UploadAttachmentCommandHandler.cs:96-106`, `RemoveAttachmentCommandHandler.cs:79-89`): managing
 * attachments on a terminal-status quote requires `quotes.correct_closed` ON TOP of the route's
 * `quotes.update`.
 */
async function assertQuoteIsManageable(
  deps: AttachmentsDeps,
  actor: AttachmentsActor,
  quote: { id: number; statusId: number },
): Promise<void> {
  const status = await findReferenceItem(deps.db, actor.tenantId, quote.statusId);
  if (status?.isTerminal !== true) return;

  if (!actor.access.has('quotes.correct_closed')) {
    throw attachmentClosedQuoteRequiresCorrectionError(quote.id);
  }
}

/** The tenant's `max_attachment_mb`. A tenant with no settings row is a seeding fault, not a 404. */
async function resolveSizeCapMb(deps: AttachmentsDeps, actor: AttachmentsActor): Promise<number> {
  const settings = await findSettings(deps.db, actor.tenantId);
  if (settings === undefined) {
    throw new InternalError(
      `Tenant ${String(actor.tenantId)} has no tenant_settings row; refusing to apply a default attachment size cap.`,
    );
  }
  return settings.maxAttachmentMb;
}

/**
 * `POST /quotes/{id}/attachments` — authorize, validate, record a PENDING row, issue a signed
 * upload URL. No bytes pass through this function (A-7).
 */
export async function requestAttachmentUpload(
  deps: AttachmentsDeps,
  quoteId: number,
  input: RequestAttachmentUploadInput,
  actor: AttachmentsActor,
): Promise<AttachmentUploadEnvelopeDto> {
  // FIRST, AND UNCONDITIONALLY: does this quote exist IN THIS TENANT? Everything below leaks
  // information about the quote, so nothing below may run for a foreign id (AC-021).
  const quote = await findQuote(deps.db, actor.tenantId, quoteId);
  if (quote === undefined) throw attachmentQuoteNotFoundError(quoteId);

  await assertQuoteIsManageable(deps, actor, quote);

  if (!isAllowedAttachmentContentType(input.contentType)) {
    throw disallowedAttachmentTypeError(input.contentType);
  }

  // The extension is taken from the ORIGINAL name, before sanitization, exactly as the reference
  // does (:110-115): sanitizing first could turn `report.pdf.exe` into something whose extension
  // no longer reveals the mismatch.
  const extension = extensionOf(input.fileName);
  if (!isExtensionAllowedForContentType(input.contentType, extension)) {
    throw attachmentExtensionMismatchError(extension, input.contentType);
  }

  const maxAttachmentMb = await resolveSizeCapMb(deps, actor);
  if (exceedsSizeCap(input.declaredSizeBytes, maxAttachmentMb)) {
    throw attachmentOverSizeCapError(maxAttachmentMb);
  }

  const now = new Date().toISOString();
  const sanitized = sanitizeAttachmentFileName(input.fileName);

  // The row is committed BEFORE the URL is minted, and that order is deliberate: the key contains
  // the attachment id, so no URL can exist for an object with no metadata row. The reverse order
  // would allow an object nothing in the database describes.
  const { attachmentId, storageKey } = await withTransaction(deps.db, async (trx) => {
    const id = await insertAttachment(trx, actor.tenantId, {
      quoteId: quote.id,
      // The ORIGINAL filename is what the user sees and downloads as; only the KEY is sanitized.
      fileName: input.fileName,
      contentType: input.contentType,
      declaredSizeBytes: input.declaredSizeBytes,
      uploadedBy: actor.userId,
      now,
    });

    const key = buildAttachmentKey(Number(actor.tenantId), quote.id, id, sanitized);
    await setAttachmentStorageKey(trx, actor.tenantId, id, key);

    return { attachmentId: id, storageKey: key };
  });

  // No audit row yet: nothing has been attached. The audit belongs to confirm (AC-057), which is
  // the moment a file actually exists on the quote.
  const target = await deps.storage.createSignedUploadUrl(storageKey, {
    contentType: input.contentType,
  });

  return {
    attachmentId,
    quoteId: quote.id,
    fileName: input.fileName,
    contentType: input.contentType,
    uploadUrl: target.url,
    uploadToken: target.token,
    expiresInSeconds: target.expiresInSeconds,
  };
}

/**
 * `POST /attachments/{id}/confirm` — verify the object, replace client claims with server
 * observations, record the audit row. The post-upload verification step R-8 asks for.
 */
export async function confirmAttachmentUpload(
  deps: AttachmentsDeps,
  attachmentId: number,
  actor: AttachmentsActor,
): Promise<QuoteAttachmentDto> {
  const attachment = await findAttachment(deps.db, actor.tenantId, attachmentId);
  // A foreign-tenant id, a missing id and a soft-removed row are one indistinguishable 404 (AC-021).
  if (attachment === undefined || attachment.removedAt !== null) {
    throw attachmentNotFoundError(attachmentId);
  }
  if (attachment.confirmedAt !== null) throw attachmentAlreadyConfirmedError(attachmentId);

  const quote = await findQuote(deps.db, actor.tenantId, attachment.quoteId);
  if (quote === undefined) throw attachmentQuoteNotFoundError(attachment.quoteId);
  await assertQuoteIsManageable(deps, actor, quote);

  const info = await deps.storage.stat(attachment.storageKey);
  if (info === null) throw attachmentObjectMissingError(attachmentId);

  // THE SIZE CHECK THAT ACTUALLY COUNTS. The pre-signing check tested a number the client chose;
  // this one tests the bytes that arrived. A client that declared 1 byte and uploaded 500 MB is
  // caught here and nowhere else.
  const maxAttachmentMb = await resolveSizeCapMb(deps, actor);
  if (exceedsSizeCap(info.sizeBytes, maxAttachmentMb)) {
    await discardPendingAttachment(deps, actor, attachment);
    throw attachmentOverSizeCapError(maxAttachmentMb);
  }

  // The magic-number check, moved from mid-stream to post-upload by A-7 (R-8). Validated against
  // the type the ROW records — the one the server allow-listed at request time — not against
  // anything the uploader sent with the bytes, which is attacker-controlled.
  const header = await deps.storage.readHead(
    attachment.storageKey,
    ATTACHMENT_SIGNATURE_HEADER_BYTES,
  );
  if (!matchesDeclaredSignature(attachment.contentType, header)) {
    await discardPendingAttachment(deps, actor, attachment);
    throw attachmentSignatureMismatchError(attachment.contentType);
  }

  const now = new Date().toISOString();
  await withTransaction(deps.db, async (trx) => {
    await confirmAttachment(trx, actor.tenantId, attachmentId, {
      observedSizeBytes: info.sizeBytes,
      // The allow-listed type from the row wins over whatever Storage recorded: a client can set
      // any `Content-Type` header on the upload, and persisting that would let `text/html` land in
      // a column the UI trusts. `info.contentType` has already served its purpose as evidence.
      observedContentType: attachment.contentType,
      now,
    });

    // An attachment add is quote activity, so it counts as lead activity (spec FR-36/§11.5) —
    // `UploadAttachmentCommandHandler.cs:167`.
    await stampLeadActivity(trx, actor.tenantId, quote.leadId, now, actor.userId);

    await writeAudit(trx, {
      tenantId: Number(actor.tenantId),
      entityType: 'quote_attachment',
      entityId: String(attachmentId),
      action: ATTACHMENT_UPLOADED_ACTION,
      actorUserId: actor.userId,
      before: null,
      after: {
        quoteId: attachment.quoteId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: info.sizeBytes,
      },
    });
  });

  const confirmed = await findAttachment(deps.db, actor.tenantId, attachmentId);
  if (confirmed === undefined) throw attachmentNotFoundError(attachmentId);
  return toDto(confirmed);
}

/**
 * Removes a rejected upload's object AND its pending row.
 *
 * The object goes first: if the storage delete fails the row survives, and an orphaned ROW pointing
 * at a real object is recoverable (an operator can find and delete it). The reverse failure — row
 * gone, object retained — leaves bytes in the bucket that nothing in the database describes, which
 * is unrecoverable without a bucket scan. Deliberately not inside the caller's transaction: a
 * storage call in a transaction holds a database connection open across a network round trip.
 */
async function discardPendingAttachment(
  deps: AttachmentsDeps,
  actor: AttachmentsActor,
  attachment: AttachmentRecord,
): Promise<void> {
  await deps.storage.delete(attachment.storageKey);
  await withTransaction(deps.db, async (trx) => {
    await deletePendingAttachment(trx, actor.tenantId, attachment.id);
  });
}

/**
 * `GET /quotes/{id}/attachments` — the live set for a quote.
 *
 * A BARE ARRAY, not a paged envelope: measured against the sibling `GET /leads/{id}/quotes`, which
 * this list mirrors (`quotes/routes.ts` records the same finding). A quote's attachment count is
 * inherently small and the reference paged neither subordinate list.
 *
 * NOTE THIS ROUTE HAS NO REFERENCE COUNTERPART. `AttachmentEndpoints.cs` exposes only upload,
 * download and remove; the SPA consequently tracked uploads in component state and lost them on
 * reload (a gap `QuotesCard.tsx:128-131` documents against itself). AC-057/V-073 require that
 * removed attachments "disappear from the quote's list while history remains", which is not
 * expressible without a list, so this endpoint is a deliberate ADDITION beyond the reference —
 * recorded as such in the task file rather than presented as a port.
 */
export async function listQuoteAttachments(
  deps: AttachmentsDeps,
  quoteId: number,
  actor: AttachmentsActor,
): Promise<QuoteAttachmentDto[]> {
  const quote = await findQuote(deps.db, actor.tenantId, quoteId);
  if (quote === undefined) throw attachmentQuoteNotFoundError(quoteId);

  const rows = await listAttachmentRows(deps.db, actor.tenantId, quote.id);
  return rows.map(toDto);
}

/**
 * `GET /attachments/{id}` — a short-lived signed download URL (A-7; replaces the reference's
 * `Results.Stream`).
 *
 * The tenant predicate in `findAttachment` is what stops a tenant-B caller obtaining a URL for a
 * tenant-A object: the row does not resolve, so the 404 is raised BEFORE anything is signed. There
 * is no path in this function from a caller-supplied value to a storage key.
 */
export async function getAttachmentDownload(
  deps: AttachmentsDeps,
  attachmentId: number,
  actor: AttachmentsActor,
): Promise<AttachmentDownloadEnvelopeDto> {
  const attachment = await findAttachment(deps.db, actor.tenantId, attachmentId);
  if (
    attachment === undefined ||
    attachment.removedAt !== null ||
    // A pending attachment has no object; signing for it would hand the user a URL that 404s.
    attachment.confirmedAt === null
  ) {
    throw attachmentNotFoundError(attachmentId);
  }

  const target = await deps.storage.createSignedDownloadUrl(attachment.storageKey, {
    expiresInSeconds: ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS,
    // `Content-Disposition: attachment` (spec §16). The name the USER uploaded, so the download is
    // recognisable rather than the opaque storage key.
    downloadFileName: attachment.fileName,
  });

  return {
    attachmentId: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    downloadUrl: target.url,
    expiresInSeconds: target.expiresInSeconds,
  };
}

/**
 * `DELETE /attachments/{id}` — SOFT remove plus the object delete
 * (`RemoveAttachmentCommandHandler`).
 *
 * The row survives (NFR-09) so who removed what, and when, stays answerable; the bytes do not,
 * which is the point of a removal. The row is flagged inside the transaction with its audit row,
 * and the storage delete runs AFTER the commit: were it inside, a storage failure would roll back
 * the removal and the user's delete would silently not happen, and a storage call inside a
 * transaction holds a connection open across a network round trip. The consequence of the chosen
 * order — commit succeeds, storage delete fails — leaves an orphaned object whose row is already
 * marked removed. That is the recoverable direction, and it is the same trade-off
 * `discardPendingAttachment` makes in the opposite circumstances.
 */
export async function removeAttachment(
  deps: AttachmentsDeps,
  attachmentId: number,
  actor: AttachmentsActor,
): Promise<void> {
  const attachment = await findAttachment(deps.db, actor.tenantId, attachmentId);
  if (
    attachment === undefined ||
    attachment.removedAt !== null ||
    attachment.confirmedAt === null
  ) {
    throw attachmentNotFoundError(attachmentId);
  }

  const quote = await findQuote(deps.db, actor.tenantId, attachment.quoteId);
  if (quote === undefined) throw attachmentQuoteNotFoundError(attachment.quoteId);
  await assertQuoteIsManageable(deps, actor, quote);

  const now = new Date().toISOString();
  await withTransaction(deps.db, async (trx) => {
    await softRemoveAttachment(trx, actor.tenantId, attachmentId, {
      removedBy: actor.userId,
      now,
    });

    await stampLeadActivity(trx, actor.tenantId, quote.leadId, now, actor.userId);

    await writeAudit(trx, {
      tenantId: Number(actor.tenantId),
      entityType: 'quote_attachment',
      entityId: String(attachmentId),
      action: ATTACHMENT_REMOVED_ACTION,
      actorUserId: actor.userId,
      before: { quoteId: attachment.quoteId, fileName: attachment.fileName, removedAt: null },
      after: { quoteId: attachment.quoteId, fileName: attachment.fileName, removedAt: now },
    });
  });

  await deps.storage.delete(attachment.storageKey);
}
