/**
 * Party name handling for the FR-28 duplicate-name warning (T-023, AC-041).
 *
 * Port of the constants and the trim in `PartyStore.cs:38-40` and
 * `CreatePartyCommandHandler.cs:65` / `UpdatePartyCommandHandler.cs:68`.
 *
 * THERE IS NO "NAME NORMALIZATION" TO PORT, AND THAT IS A MEASURED FINDING
 * =======================================================================
 * The duplicate check is NOT normalize-then-compare-equal. `PartyStore.FindSimilarByNameAsync`
 * (:189-206) asks Postgres for `similarity(name, $1) >= 0.4` over the tenant's rows, ordered by
 * that score, capped at 5. Case, punctuation and whitespace variants are absorbed by pg_trgm
 * itself, which is why the reference never folds them in application code — and why this module
 * deliberately does not either. `normalizePartyName` is the trim the reference applies to the value
 * it PERSISTS, nothing more; adding case-folding here would silently change stored party names.
 *
 * The two thresholds are the reference's documented product judgment (PartyStore.cs:16-34), not a
 * spec-fixed number: type-ahead is deliberately loose (one extra list row is cheap) and the warning
 * is deliberately stricter (a banner on a loosely-related name is noise). They are named here so the
 * repository's two queries and the unit test read the same constant.
 */

/** `PartyStore.TypeAheadSimilarityThreshold` (:38) — pg_trgm's own documented default. */
export const TYPE_AHEAD_SIMILARITY_THRESHOLD = 0.3;

/** `PartyStore.DuplicateNameSimilarityThreshold` (:39) — stricter than type-ahead, on purpose. */
export const DUPLICATE_NAME_SIMILARITY_THRESHOLD = 0.4;

/** `PartyStore.MaxDuplicateMatches` (:40). */
export const MAX_DUPLICATE_MATCHES = 5;

/**
 * The name the write path persists and then matches on: `command.Name.Trim()`.
 *
 * JavaScript's `String.prototype.trim` strips the same Unicode whitespace set .NET's
 * `String.Trim()` does (both are whitespace-category based), so this is a faithful port rather than
 * an ASCII-only approximation.
 */
export function normalizePartyName(name: string): string {
  return name.trim();
}
