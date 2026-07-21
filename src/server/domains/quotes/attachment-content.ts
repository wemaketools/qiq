/**
 * Pure attachment content rules: allow-list, extension agreement, magic-number signatures, size cap
 * (T-027; AC-056, AC-057, spec FR-48/§16, R-8).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Quotes/Attachments/FileSignatureValidator.cs`. The
 * rules are unchanged; WHEN each runs is what the signed-URL flow changes:
 *
 *   allow-list + extension  -> before signing. The server has the declared type and the filename
 *                              without the bytes, so an oversize or disallowed upload is refused
 *                              before any URL exists and nothing ever reaches the bucket.
 *   size cap                -> checked twice. Against the DECLARED size before signing (cheap, and
 *                              it stops the honest client early) and against the SERVER-OBSERVED
 *                              size at confirm (the one that counts — a client can declare 1 byte
 *                              and upload 500 MB, and only the second check sees that).
 *   magic number            -> at confirm only. The bytes do not exist before then; see below.
 *
 * WHAT THE MAGIC-NUMBER CHECK DOES NOT DO UNDER A-7 (R-8, stated plainly)
 * ======================================================================
 * The reference inspected the leading bytes as they STREAMED THROUGH the API, so a mismatched file
 * never reached storage at all. Under the signed-URL flow the bytes go straight to the bucket, so
 * this check necessarily runs AFTER the object has landed. Consequences, none of them hypothetical:
 *
 *   - a hostile file EXISTS in the private bucket between upload and confirm. It is unreachable
 *     (private bucket, no policy, no signed URL is ever minted for an unconfirmed attachment) and
 *     confirm deletes it on mismatch, but "never written" has become "written, then deleted".
 *   - a client that uploads and never calls confirm leaves an unreferenced object behind. The
 *     attachment row stays unconfirmed and invisible to every read path; the object is orphaned.
 *     Reaping orphans is not implemented here — recorded as a finding on T-027, not dropped.
 *   - DOCX cannot be distinguished from any other ZIP-family file at the header level; that is the
 *     reference's own documented caveat and it is preserved verbatim, not silently widened.
 *
 * So the honest claim is: content type, extension and leading bytes must all agree before an
 * attachment becomes visible, and the size the product records is the size the SERVER measured.
 * The claim that is NOT made: that unvalidated bytes never touch storage.
 */

const PNG = 'image/png';
const JPEG = 'image/jpeg';
const PDF = 'application/pdf';
const DOC = 'application/msword';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** `FileSignatureValidator.SignaturesByContentType` (:31-38). */
const SIGNATURES: ReadonlyMap<string, readonly number[]> = new Map([
  [PNG, [0x89, 0x50, 0x4e, 0x47]],
  [JPEG, [0xff, 0xd8, 0xff]],
  [PDF, [0x25, 0x50, 0x44, 0x46]],
  [DOC, [0xd0, 0xcf, 0x11, 0xe0]],
  [DOCX, [0x50, 0x4b, 0x03, 0x04]],
]);

/** `FileSignatureValidator.AllowedExtensionsByContentType` (:45-53). */
const EXTENSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  [PNG, ['.png']],
  [JPEG, ['.jpg', '.jpeg']],
  [PDF, ['.pdf']],
  [DOC, ['.doc']],
  [DOCX, ['.docx']],
]);

/** `FileSignatureValidator.AllowedContentTypes` (:41) — exactly five, spec FR-48. */
export const ALLOWED_ATTACHMENT_CONTENT_TYPES: readonly string[] = [...SIGNATURES.keys()];

/** The number of leading bytes confirm must read to evaluate every signature above. */
export const ATTACHMENT_SIGNATURE_HEADER_BYTES = 8;

/**
 * Exact, case-SENSITIVE membership, matching the reference's `HashSet<string>.Contains`.
 *
 * Deliberately not normalized: `image/PNG` and `" image/png"` are rejected rather than coerced.
 * A caller sending a non-canonical type is not the SPA (which sends the browser's canonical value),
 * and quietly accepting variants widens the allow-list by exactly the amount an attacker controls.
 */
export function isAllowedAttachmentContentType(contentType: string): boolean {
  return SIGNATURES.has(contentType);
}

/**
 * `FileSignatureValidator.IsExtensionAllowed` (:75-76).
 *
 * The extension is lower-cased here, mirroring the reference's
 * `Path.GetExtension(...).ToLowerInvariant()` at the call site rather than at the predicate.
 */
export function isExtensionAllowedForContentType(contentType: string, extension: string): boolean {
  return EXTENSIONS.get(contentType)?.includes(extension.toLowerCase()) ?? false;
}

/** The lower-cased extension of a filename, including the leading dot; `''` when there is none. */
export function extensionOf(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  // A leading dot is a hidden-file name, not an extension — `Path.GetExtension(".pdf")` is "".
  if (lastDot <= 0) return '';
  return fileName.slice(lastDot).toLowerCase();
}

/**
 * `FileSignatureValidator.IsValid` (:59-67): the declared type must be allow-listed AND the header
 * must begin with that type's signature.
 *
 * A header SHORTER than the signature is a mismatch, never a pass — a truncated read must not be
 * able to satisfy the check by having nothing to disagree with.
 */
export function matchesDeclaredSignature(contentType: string, header: Uint8Array): boolean {
  const signature = SIGNATURES.get(contentType);
  if (signature === undefined) return false;
  if (header.length < signature.length) return false;

  return signature.every((byte, index) => header[index] === byte);
}

/** `UploadAttachmentCommandHandler.BytesPerMegabyte` (:29) — binary megabytes, as the reference. */
export const BYTES_PER_MEGABYTE = 1024 * 1024;

/** True when `sizeBytes` exceeds the tenant's `max_attachment_mb` cap. */
export function exceedsSizeCap(sizeBytes: number, maxAttachmentMb: number): boolean {
  return sizeBytes > maxAttachmentMb * BYTES_PER_MEGABYTE;
}
