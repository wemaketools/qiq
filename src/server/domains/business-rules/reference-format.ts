/**
 * The lead/quote reference-number template grammar (T-020, AC-037; spec FR-11, §11.2).
 *
 * Port of `src/api/QuoteIQ.Domain/Settings/ReferenceFormatTemplate.cs`, kept in ONE module because
 * two callers need the identical grammar and must never disagree about it:
 *
 *   1. `PUT /settings/business-rules` validates `leadRefFormat`/`quoteRefFormat` here before
 *      storing them (schemas.ts).
 *   2. T-024's lead/quote reference generator RENDERS those stored templates here.
 *
 * If the validator accepted a template the generator could not render, every lead created after
 * that settings change would fail at insert time — the failure would surface in a completely
 * different feature from the one that caused it. `format()` therefore re-validates and throws
 * rather than rendering something approximate (ReferenceFormatTemplate.cs:88-92 does the same).
 *
 * MEASURED GRAMMAR (ReferenceFormatTemplate.cs:16-18, :107-121)
 * ============================================================
 *   `{YYYY}`   the four-digit year, zero-padded to 4 (`year.ToString("D4")`, :129)
 *   `{SEQ:n}`  the sequence, zero-padded to `n` digits; `n` matches `[1-9][0-9]*` (:17)
 *   anything else outside braces is literal text, copied through unchanged
 *   any OTHER `{...}` token is UNKNOWN and makes the template invalid (:65-69)
 *
 * A template must contain AT LEAST ONE `{SEQ:n}` token (:71-75). Note the reference's own doc
 * comment (:12) says "exactly one" while its code says `Any(...)` — so `"L-{SEQ:2}-{SEQ:4}"` is
 * VALID in the reference and renders the sequence twice. The CODE is the contract here, not the
 * comment; tightening it to "exactly one" would 422 a template a tenant may already have stored.
 * Flagged in the task file.
 *
 * The literal-token escape hatch is deliberate and load-bearing: a tenant writing `L-{BRANCH}-…`
 * gets a validation failure rather than a silently-empty segment in every lead reference.
 */

/** `\{[^{}]*\}` — ReferenceFormatTemplate.cs:16. Non-greedy by construction; braces cannot nest. */
const TOKEN_PATTERN = /\{[^{}]*\}/g;

/** `^\{SEQ:([1-9][0-9]*)\}$` — ReferenceFormatTemplate.cs:17. No zero width, no leading zero. */
const SEQUENCE_TOKEN_PATTERN = /^\{SEQ:([1-9][0-9]*)\}$/;

const YEAR_TOKEN = '{YYYY}';

export type ReferenceFormatSegmentKind = 'literal' | 'year' | 'sequence' | 'unknown';

export interface ReferenceFormatSegment {
  readonly kind: ReferenceFormatSegmentKind;
  readonly rawText: string;
  /** Zero-pad width; present only on a `sequence` segment. */
  readonly sequenceWidth: number | null;
}

export type ReferenceFormatValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly error: string };

function classifyToken(rawToken: string): ReferenceFormatSegment {
  if (rawToken === YEAR_TOKEN) {
    return { kind: 'year', rawText: YEAR_TOKEN, sequenceWidth: null };
  }

  const sequenceMatch = SEQUENCE_TOKEN_PATTERN.exec(rawToken);
  if (sequenceMatch !== null) {
    return { kind: 'sequence', rawText: rawToken, sequenceWidth: Number(sequenceMatch[1]) };
  }

  return { kind: 'unknown', rawText: rawToken, sequenceWidth: null };
}

/** `ReferenceFormatTemplate.Parse` (:22-48): splits into literal/token segments, judging nothing. */
export function parseReferenceFormat(template: string): ReferenceFormatSegment[] {
  const segments: ReferenceFormatSegment[] = [];
  let cursor = 0;

  // `matchAll` needs the /g flag and yields matches in source order, which is what the reference's
  // cursor arithmetic relies on.
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const index = match.index;
    if (index > cursor) {
      segments.push({ kind: 'literal', rawText: template.slice(cursor, index), sequenceWidth: null });
    }
    segments.push(classifyToken(match[0]));
    cursor = index + match[0].length;
  }

  if (cursor < template.length) {
    segments.push({ kind: 'literal', rawText: template.slice(cursor), sequenceWidth: null });
  }

  return segments;
}

/**
 * `ReferenceFormatTemplate.Validate` (:52-80). Messages are the reference's verbatim — they are
 * what the 422 `detail` shows a tenant admin who mistyped a template.
 */
export function validateReferenceFormat(template: string): ReferenceFormatValidation {
  if (template.trim().length === 0) {
    return { valid: false, error: 'Reference format cannot be empty.' };
  }

  const segments = parseReferenceFormat(template);

  const unknown = segments.find((segment) => segment.kind === 'unknown');
  if (unknown !== undefined) {
    return { valid: false, error: `Unknown reference format token '${unknown.rawText}'.` };
  }

  if (!segments.some((segment) => segment.kind === 'sequence')) {
    return { valid: false, error: 'Reference format must include a {SEQ:n} token.' };
  }

  return { valid: true };
}

/**
 * `ReferenceFormatTemplate.Format` (:86-113). Renders for one year and sequence number.
 *
 * Throws on an invalid template rather than best-effort rendering: the ONLY templates that reach
 * here are ones the settings endpoint already validated, so an invalid one means a row was written
 * around the API and silently emitting a malformed reference would be worse than failing loudly.
 *
 * A sequence WIDER than its pad width is not truncated (`PadLeft` never shortens, :137) — the
 * reference lets the number overflow its padding rather than minting a duplicate reference.
 */
export function formatReference(template: string, year: number, sequence: number): string {
  const validation = validateReferenceFormat(template);
  if (!validation.valid) {
    throw new Error(`Cannot format an invalid reference template: ${validation.error}`);
  }

  let rendered = '';
  for (const segment of parseReferenceFormat(template)) {
    switch (segment.kind) {
      case 'literal':
        rendered += segment.rawText;
        break;
      case 'year':
        rendered += String(year).padStart(4, '0');
        break;
      case 'sequence':
        rendered += String(sequence).padStart(segment.sequenceWidth ?? 1, '0');
        break;
      case 'unknown':
        // Unreachable: validate() rejected it above. Kept so a future grammar addition that forgets
        // a case here is a compile error rather than a silently dropped segment.
        throw new Error(`Unknown reference format token '${segment.rawText}'.`);
    }
  }

  return rendered;
}
