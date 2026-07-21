/**
 * Attachment object-key construction and filename sanitization (T-027; A-6, spec §16).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Quotes/Attachments/AttachmentStorageKey.cs`,
 * character rule for character rule, INCLUDING the key scheme:
 *
 *     t{tenantId}/quotes/{quoteId}/{attachmentId}_{sanitizedFileName}
 *
 * NOTE THE TASK BRIEF SPECIFIES A DIFFERENT SCHEME, AND THE REFERENCE WINS
 * =======================================================================
 * T-027's `implementation_details` describe `{tenantId}/{leadId}/{quoteId}/{attachmentId}-{name}`:
 * a bare numeric tenant segment, a lead segment the reference never had, and a `-` separator. The
 * reference uses a `t`-prefixed tenant segment, a literal `quotes` segment, NO lead segment, and a
 * `_` separator. This module preserves the reference scheme (recorded as a contradiction in the
 * task file). The lead segment is genuinely absent rather than forgotten: an attachment's row is
 * keyed by quote, a quote's lead can be re-derived, and putting a mutable-by-nothing-else id in an
 * immutable object key buys nothing while giving the key a second way to be wrong.
 *
 * THE `t` PREFIX IS NOT COSMETIC
 * ==============================
 * It makes every tenant prefix a non-numeric literal, so no arithmetic accident and no bare integer
 * from a request body can ever be mistaken for a complete prefix, and `t1/` cannot prefix-match
 * `t12/` when a future operator lists objects by prefix.
 *
 * THIS IS THE ONLY THING SEPARATING TENANTS INSIDE THE BUCKET
 * ==========================================================
 * Supabase Storage has no tenant concept and RLS is not adopted (Q-10), so the key IS the isolation
 * boundary in the bucket. The tenant, quote and attachment ids are server-derived and validated
 * here; the filename is hostile input and is sanitized before it can contribute a single character
 * to the path. Both halves are asserted in tests/unit/storage-keys.test.ts.
 */

const MAX_SANITIZED_FILE_NAME_LENGTH = 150;

/**
 * `AttachmentStorageKey.Sanitize` (:26-46).
 *
 * Splits on BOTH separators regardless of host OS (the API runs on Windows in dev and Linux on
 * Vercel, and `path.basename` would only strip `\` on Windows — a platform-dependent security
 * boundary is not a security boundary), replaces every character outside `[A-Za-z0-9.\-_]` with
 * `_`, trims leading/trailing `.`/`_` (defeating both hidden-file names and a trailing-dot
 * extension trick), and caps the length.
 *
 * The character allow-list is what makes the result safe: `/`, `\`, NUL, `%` and every other
 * separator or encoding character is replaced rather than removed, so no two adjacent survivors can
 * combine into a new traversal sequence.
 */
export function sanitizeAttachmentFileName(fileName: string): string {
  const lastSeparator = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const candidate = lastSeparator >= 0 ? fileName.slice(lastSeparator + 1) : fileName;

  let builder = '';
  for (const character of candidate) {
    builder += /[A-Za-z0-9.\-_]/.test(character) ? character : '_';
  }

  const sanitized = builder.replace(/^[._]+/, '').replace(/[._]+$/, '');
  if (sanitized.length === 0) return 'attachment';

  return sanitized.length > MAX_SANITIZED_FILE_NAME_LENGTH
    ? sanitized.slice(0, MAX_SANITIZED_FILE_NAME_LENGTH)
    : sanitized;
}

function requirePositiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer to build an attachment storage key.`);
  }
  return value;
}

/**
 * `AttachmentStorageKey.BuildKey` (:49-50).
 *
 * The id guards are an addition to the reference (C# `long` could not be fractional; a TypeScript
 * `number` can). They fail LOUDLY rather than emitting `tNaN/quotes/...` — a key that would sit
 * outside every tenant prefix and quietly pool objects from every tenant in one namespace.
 *
 * @param sanitizedFileName MUST already be through `sanitizeAttachmentFileName`; callers in this
 *   repo pass its result directly. Not re-sanitized here so a caller cannot mistake this for the
 *   sanitizing boundary — the unit suite asserts the composed pipeline, not this function alone.
 */
export function buildAttachmentKey(
  tenantId: number,
  quoteId: number,
  attachmentId: number,
  sanitizedFileName: string,
): string {
  requirePositiveId(tenantId, 'tenantId');
  requirePositiveId(quoteId, 'quoteId');
  requirePositiveId(attachmentId, 'attachmentId');

  return `t${String(tenantId)}/quotes/${String(quoteId)}/${String(attachmentId)}_${sanitizedFileName}`;
}

/** The prefix every one of a tenant's objects lives under. Used by isolation assertions. */
export function attachmentTenantPrefix(tenantId: number): string {
  return `t${String(requirePositiveId(tenantId, 'tenantId'))}/`;
}
