/**
 * Quote-attachment failures (T-027; AC-021, AC-056, AC-057).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Quotes/Attachments/QuoteAttachmentErrors.cs` with
 * the status mapping from `AttachmentEndpoints.ProblemFromError` (:96-107):
 *
 *   ATTACHMENT_NOT_FOUND                                  -> 404  (:99)
 *   ATTACHMENT_QUOTE_NOT_FOUND                            -> 404  (:99)
 *   ATTACHMENT_FORBIDDEN                                  -> 403  (:102)
 *   ATTACHMENT_CLOSED_QUOTE_REQUIRES_CORRECTION_PERMISSION-> 403  (:102)
 *   ATTACHMENT_VALIDATION_FAILED                          -> 422  (:105, the default arm)
 *   ATTACHMENT_DISALLOWED_TYPE                            -> 422
 *   ATTACHMENT_EXTENSION_MISMATCH                         -> 422
 *   ATTACHMENT_SIGNATURE_MISMATCH                         -> 422
 *   ATTACHMENT_OVER_SIZE_CAP                              -> 422
 *
 * TWO CODES ARE NEW, BECAUSE THE ENVELOPE HAS TWO FAILURES THE REFERENCE COULD NOT HAVE
 * ====================================================================================
 * `ATTACHMENT_OBJECT_MISSING` and `ATTACHMENT_ALREADY_CONFIRMED` exist only because A-7 splits one
 * request into request-upload → direct transfer → confirm. The reference's upload was atomic, so
 * "confirm an attachment whose bytes were never uploaded" and "confirm the same attachment twice"
 * were not reachable states. Both are recorded as part of the M-07 contract deviation rather than
 * folded into the generic 422, because the SPA's remedies differ: the first means retry the
 * transfer, the second means the upload already succeeded and the UI is behind.
 *
 * EVERY CODE IS DISTINCT BECAUSE STATUS ALONE CANNOT DISCRIMINATE
 * ==============================================================
 * Five of these answer 422 and two answer 403. A test — or a SPA — that branched on status could
 * not tell an oversize file from a renamed executable, nor a missing permission from a closed
 * quote. The code is the contract, and the integration suite asserts the code on every rejection.
 */
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

export const ATTACHMENT_VALIDATION_FAILED = 'ATTACHMENT_VALIDATION_FAILED';
export const ATTACHMENT_QUOTE_NOT_FOUND = 'ATTACHMENT_QUOTE_NOT_FOUND';
export const ATTACHMENT_NOT_FOUND = 'ATTACHMENT_NOT_FOUND';
export const ATTACHMENT_DISALLOWED_TYPE = 'ATTACHMENT_DISALLOWED_TYPE';
export const ATTACHMENT_EXTENSION_MISMATCH = 'ATTACHMENT_EXTENSION_MISMATCH';
export const ATTACHMENT_SIGNATURE_MISMATCH = 'ATTACHMENT_SIGNATURE_MISMATCH';
export const ATTACHMENT_OVER_SIZE_CAP = 'ATTACHMENT_OVER_SIZE_CAP';
export const ATTACHMENT_CLOSED_QUOTE_REQUIRES_CORRECTION_PERMISSION =
  'ATTACHMENT_CLOSED_QUOTE_REQUIRES_CORRECTION_PERMISSION';
/** New under A-7: confirm found no object at the key. */
export const ATTACHMENT_OBJECT_MISSING = 'ATTACHMENT_OBJECT_MISSING';
/** New under A-7: confirm ran against an attachment that is already confirmed. */
export const ATTACHMENT_ALREADY_CONFIRMED = 'ATTACHMENT_ALREADY_CONFIRMED';

/** `QuoteAttachmentErrors.Validation` (:9) -> 422, carrying this port's structured `errors[]`. */
export function attachmentValidationError(fieldErrors: readonly FieldError[]): AppError {
  return new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
    code: ATTACHMENT_VALIDATION_FAILED,
    fieldErrors,
  });
}

/**
 * `QuoteAttachmentErrors.QuoteNotFound` (:11-12) -> 404. ALSO the answer for another tenant's quote
 * id (N-01, AC-021): the lookup is tenant-predicated, so a foreign id simply does not resolve and
 * lands here with a message identical to a genuinely missing one.
 */
export function attachmentQuoteNotFoundError(quoteId: number): NotFoundError {
  return new NotFoundError(`Quote ${String(quoteId)} was not found.`, {
    code: ATTACHMENT_QUOTE_NOT_FOUND,
  });
}

/**
 * `QuoteAttachmentErrors.NotFound` (:14-15) -> 404.
 *
 * The single answer for four distinct situations, deliberately indistinguishable: the id does not
 * exist, it belongs to ANOTHER TENANT, it has been soft-removed, or it is still pending confirmation.
 * Differentiating any of them would leak whether a given attachment id exists in some other tenant,
 * which is precisely the existence oracle AC-021 forbids.
 */
export function attachmentNotFoundError(id: number): NotFoundError {
  return new NotFoundError(`Attachment ${String(id)} was not found.`, {
    code: ATTACHMENT_NOT_FOUND,
  });
}

/** `QuoteAttachmentErrors.DisallowedContentType` (:17-19) -> 422. */
export function disallowedAttachmentTypeError(contentType: string): AppError {
  return new AppError(
    422,
    `Content type '${contentType}' is not allowed. Only PNG, JPEG, PDF, DOC, and DOCX attachments are permitted.`,
    { code: ATTACHMENT_DISALLOWED_TYPE },
  );
}

/** `QuoteAttachmentErrors.ExtensionMismatch` (:25-27) -> 422. */
export function attachmentExtensionMismatchError(
  extension: string,
  contentType: string,
): AppError {
  return new AppError(
    422,
    `File extension '${extension}' is not permitted for content type '${contentType}'.`,
    { code: ATTACHMENT_EXTENSION_MISMATCH },
  );
}

/**
 * `QuoteAttachmentErrors.SignatureMismatch` (:21-23) -> 422.
 *
 * Raised at CONFIRM rather than mid-stream (A-7); the object is deleted before this is thrown.
 */
export function attachmentSignatureMismatchError(contentType: string): AppError {
  return new AppError(
    422,
    `The file's content does not match its declared content type '${contentType}'.`,
    { code: ATTACHMENT_SIGNATURE_MISMATCH },
  );
}

/** `QuoteAttachmentErrors.OverSizeCap` (:29-30) -> 422. */
export function attachmentOverSizeCapError(maxAttachmentMb: number): AppError {
  return new AppError(
    422,
    `The file exceeds this tenant's ${String(maxAttachmentMb)} MB attachment size cap.`,
    { code: ATTACHMENT_OVER_SIZE_CAP },
  );
}

/**
 * `QuoteAttachmentErrors.ClosedQuoteRequiresCorrectionPermission` (:35-37) -> 403.
 *
 * Same shape as the quotes domain's closed-record gate: the caller holds `quotes.update` (the route
 * guard passed) but not `quotes.correct_closed`.
 */
export function attachmentClosedQuoteRequiresCorrectionError(quoteId: number): ForbiddenError {
  return new ForbiddenError(
    `Quote ${String(quoteId)} is closed; managing its attachments requires the correct-closed-quote permission.`,
    { code: ATTACHMENT_CLOSED_QUOTE_REQUIRES_CORRECTION_PERMISSION },
  );
}

/** New under A-7 -> 422: confirm ran but Storage holds no object at the attachment's key. */
export function attachmentObjectMissingError(id: number): AppError {
  return new AppError(
    422,
    `No uploaded file was found for attachment ${String(id)}; upload the file to the signed URL before confirming.`,
    { code: ATTACHMENT_OBJECT_MISSING },
  );
}

/** New under A-7 -> 409: a repeated confirm. The first one already committed the metadata. */
export function attachmentAlreadyConfirmedError(id: number): AppError {
  return new AppError(409, `Attachment ${String(id)} has already been confirmed.`, {
    code: ATTACHMENT_ALREADY_CONFIRMED,
  });
}
