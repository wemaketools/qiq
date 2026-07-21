/**
 * Attachment request schemas and wire DTOs (T-027; AC-056, AC-057, M-07).
 *
 * Ports `UploadAttachmentValidator.cs` (shape-level only) and `QuoteAttachmentDto.cs`, adapted to
 * the A-7 signed-URL envelope.
 *
 * THE ENVELOPE IS THE ONE DOCUMENTED CONTRACT DEVIATION ON THIS SURFACE (M-07, A-7, Q-22)
 * ======================================================================================
 * The reference bound `IFormFile file` from a multipart body and answered with the bytes on
 * download. Vercel caps function bodies at ~4.5 MB, below the 10 MB attachment cap that Q-22
 * explicitly refused to lower, so the bytes cannot pass through the function at all. The request
 * therefore carries only what the server needs to AUTHORIZE and VALIDATE — filename, declared
 * content type, declared size — and the response carries a signed URL the client transfers to
 * directly.
 *
 * `QuoteAttachmentDto` ITSELF IS UNCHANGED, AND THAT IS DELIBERATE
 * ===============================================================
 * The confirm and list responses return exactly the reference's seven fields, in the reference's
 * names (`src/ui/src/features/quotes/quotesApi.ts` already declares this interface). The deviation
 * is confined to HOW bytes move; the metadata contract the SPA renders is preserved, so T-028's
 * changes stay inside the upload/download call sites.
 *
 * DECLARED SIZE IS A HINT, NOT A FACT, AND THE TYPES SAY SO
 * ========================================================
 * `declaredSizeBytes` is named for what it is: a client claim, used only for the cheap pre-signing
 * rejection. What lands in `quote_attachments.size_bytes` is what the SERVER observed at confirm
 * (`stat`). The migration is explicit that these columns hold server-observed values.
 */
import { z } from 'zod';

/** `UploadAttachmentValidator`: `FileName` NotEmpty (:12). */
const fileName = z
  .string({ message: 'ATTACHMENT_REQUIRED|A file name is required.' })
  .trim()
  .min(1, { message: 'ATTACHMENT_REQUIRED|A file name is required.' })
  // The sanitizer defends the storage key regardless, but a 4 KB filename has no legitimate use and
  // would be truncated into something the user did not recognise; refuse it at the boundary instead.
  .max(255, { message: 'ATTACHMENT_TOO_LONG|A file name must be 255 characters or fewer.' });

/** `UploadAttachmentValidator`: `DeclaredContentType` NotEmpty (:13). */
const contentType = z
  .string({ message: 'ATTACHMENT_REQUIRED|A content type is required.' })
  .trim()
  .min(1, { message: 'ATTACHMENT_REQUIRED|A content type is required.' });

/**
 * `UploadAttachmentValidator`: `DeclaredSizeBytes` GreaterThan(0) with the reference's own message
 * (:14). Zero-byte uploads are refused here rather than at confirm so no signed URL is ever issued
 * for one.
 *
 * `.int()` and the safe-integer ceiling are additions: a `long` could not be fractional, a
 * TypeScript `number` can, and a non-integer or `1e30` size would flow into the cap comparison and
 * then into a `bigint` column.
 */
const declaredSizeBytes = z
  .number({ message: 'ATTACHMENT_REQUIRED|A file size is required.' })
  .int({ message: 'ATTACHMENT_INVALID_SIZE|A file size must be a whole number of bytes.' })
  .positive({ message: 'ATTACHMENT_EMPTY_FILE|An uploaded file must not be empty.' })
  .max(Number.MAX_SAFE_INTEGER, {
    message: 'ATTACHMENT_INVALID_SIZE|A file size must be a whole number of bytes.',
  });

/** Body of `POST /api/v1/quotes/{id}/attachments` — the request-upload envelope. */
export const requestAttachmentUploadSchema = z
  .object({
    fileName,
    contentType,
    declaredSizeBytes,
  })
  .strict();

export type RequestAttachmentUploadInput = z.infer<typeof requestAttachmentUploadSchema>;

/** `QuoteAttachmentDto.cs` — preserved field for field. */
export interface QuoteAttachmentDto {
  readonly id: number;
  readonly quoteId: number;
  readonly fileName: string;
  readonly contentType: string;
  /** SERVER-OBSERVED at confirm, never the client's declared value. */
  readonly sizeBytes: number;
  readonly uploadedAt: string;
  readonly uploadedBy: number | null;
}

/**
 * Response of the request-upload envelope (new under A-7).
 *
 * `uploadUrl` and `uploadToken` are CREDENTIALS: possession of them authorizes writing this one
 * object. They are returned to the authorized caller and are never logged (spec §14) and never
 * persisted.
 */
export interface AttachmentUploadEnvelopeDto {
  /** The pending attachment's id; the client passes it back to confirm. */
  readonly attachmentId: number;
  readonly quoteId: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly uploadUrl: string;
  /** supabase-js's `uploadToSignedUrl(path, token, file)` takes this separately from the URL. */
  readonly uploadToken: string;
  readonly expiresInSeconds: number;
}

/**
 * Response of the download envelope (new under A-7; replaces the reference's streamed bytes).
 *
 * The URL carries `Content-Disposition: attachment`, so following it downloads rather than renders.
 */
export interface AttachmentDownloadEnvelopeDto {
  readonly attachmentId: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
  readonly expiresInSeconds: number;
}
