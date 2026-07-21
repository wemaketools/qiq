/**
 * The pure half of the Parties duplicate-name warning (T-023, AC-041; V-053).
 *
 * WHAT IS AND IS NOT PURE HERE — READ BEFORE ADDING A CASE
 * =======================================================
 * The task file's test plan calls for "duplicate-name normalization rules (pure)", which presumes
 * the reference detects duplicates by NORMALIZING a name and comparing for equality. It does not.
 * `PartyStore.FindSimilarByNameAsync` (src/api/QuoteIQ.Infrastructure/Parties/PartyStore.cs:189-206)
 * runs a pg_trgm `similarity(name, $1) >= 0.4` query in Postgres and orders by that score. There is
 * no normalization step and no equality comparison to port.
 *
 * So the genuinely pure surface is small and is exactly what this file covers: the name the write
 * path persists and then matches on (`command.Name.Trim()`,
 * CreatePartyCommandHandler.cs:65 / UpdatePartyCommandHandler.cs:68) and the two threshold/limit
 * constants the query is parameterised by. The SIMILARITY behaviour itself is a database property
 * and is proven in `parties.test.ts` against real rows — asserting it here against a reimplemented
 * trigram scorer would be testing a stub, not the shipped query.
 */
import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_NAME_SIMILARITY_THRESHOLD,
  MAX_DUPLICATE_MATCHES,
  TYPE_AHEAD_SIMILARITY_THRESHOLD,
  normalizePartyName,
} from '../../domains/parties/name-matching.js';

describe('normalizePartyName', () => {
  it('trims leading and trailing whitespace, matching the reference Name.Trim()', () => {
    expect(normalizePartyName('  Acme Insurance Ltd  ')).toBe('Acme Insurance Ltd');
  });

  it('trims newlines and tabs, not only spaces', () => {
    expect(normalizePartyName('\t\nAcme Insurance Ltd\r\n')).toBe('Acme Insurance Ltd');
  });

  it('preserves interior whitespace, casing and punctuation — the reference normalizes NEITHER', () => {
    // This is the assertion that would fail if someone "helpfully" added case-folding or
    // punctuation-stripping here: pg_trgm already tolerates those variants, and collapsing them in
    // application code would change which name is PERSISTED, not just which ones are matched.
    expect(normalizePartyName('  ACME  Insurance,  Ltd.  ')).toBe('ACME  Insurance,  Ltd.');
  });

  it('reduces an all-whitespace name to the empty string the required-name rule then rejects', () => {
    expect(normalizePartyName('   ')).toBe('');
  });
});

describe('similarity constants', () => {
  it('uses the reference duplicate-warning threshold of 0.4 (PartyStore.cs:39)', () => {
    expect(DUPLICATE_NAME_SIMILARITY_THRESHOLD).toBe(0.4);
  });

  it('uses the reference type-ahead threshold of 0.3 (PartyStore.cs:38)', () => {
    expect(TYPE_AHEAD_SIMILARITY_THRESHOLD).toBe(0.3);
  });

  it('holds the duplicate warning to a stricter bar than type-ahead search, as the reference does', () => {
    // The ORDER of the two matters more than either number: a warning bar at or below the
    // type-ahead bar would nag on every loosely-related name the search box would have offered.
    expect(DUPLICATE_NAME_SIMILARITY_THRESHOLD).toBeGreaterThan(TYPE_AHEAD_SIMILARITY_THRESHOLD);
  });

  it('caps the warning at the reference 5 matches (PartyStore.cs:40)', () => {
    expect(MAX_DUPLICATE_MATCHES).toBe(5);
  });
});
