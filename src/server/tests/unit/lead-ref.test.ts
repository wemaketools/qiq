/**
 * The two pure lead formulas (T-024, AC-042, AC-043; V-055, V-056).
 *
 * `lead-ref.ts` also owns the SEQUENCE ALLOCATION SQL, which is deliberately NOT tested here: its
 * whole contract is `SELECT ... FOR UPDATE` serialising concurrent transactions, and an in-process
 * test with no database cannot observe that. It is pinned by the parallel-create test in
 * `leads-core.test.ts` instead, which is the only level at which the property is falsifiable.
 *
 * WHAT IS HERE IS EVERYTHING THAT NEEDS NO DATABASE, per CLAUDE.md's "isolate formulas" convention:
 * the template rendering (`LeadReferenceGenerator.Format`) and the high-value priority derivation
 * (`CreateLeadCommandHandler.DerivePriority`, :343-346).
 */
import { describe, expect, it } from 'vitest';

import { LEAD_PRIORITY_HIGH, LEAD_PRIORITY_NORMAL } from '../../domains/leads/schemas.js';
import { derivePriority, formatLeadRef } from '../../domains/leads/lead-ref.js';

describe('formatLeadRef', () => {
  it('renders the tenant template with the year and a zero-padded sequence', () => {
    expect(formatLeadRef('L-{YYYY}-{SEQ:4}', 2026, 4)).toBe('L-2026-0004');
  });

  it('renders a different year segment for the same sequence, so refs never collide across years', () => {
    expect(formatLeadRef('L-{YYYY}-{SEQ:4}', 2027, 4)).toBe('L-2027-0004');
  });

  it('honours the template’s own pad width rather than a fixed one', () => {
    expect(formatLeadRef('Q-{SEQ:6}', 2026, 42)).toBe('Q-000042');
  });

  it('does NOT truncate a sequence wider than its pad width (PadLeft never shortens)', () => {
    // Truncating here would mint a DUPLICATE reference once a tenant passes 10^width leads, which
    // is precisely the failure the reference chose overflow to avoid.
    expect(formatLeadRef('L-{SEQ:2}', 2026, 12_345)).toBe('L-12345');
  });

  it('copies literal text through unchanged, including text with no tokens around it', () => {
    expect(formatLeadRef('BR/{YYYY}/LEAD/{SEQ:3}/X', 2026, 7)).toBe('BR/2026/LEAD/007/X');
  });

  it('renders a template with no year token at all', () => {
    expect(formatLeadRef('LEAD-{SEQ:5}', 2026, 1)).toBe('LEAD-00001');
  });

  it('throws rather than emitting an approximate reference for an invalid template', () => {
    // A malformed template can only arrive by a row written around the settings API; a silently
    // malformed lead ref would be worse than a loud failure.
    expect(() => formatLeadRef('L-{BRANCH}-{SEQ:4}', 2026, 1)).toThrow(/BRANCH/);
  });

  it('throws for a template carrying no sequence token, which could not be unique', () => {
    expect(() => formatLeadRef('L-{YYYY}', 2026, 1)).toThrow(/SEQ/);
  });
});

/**
 * `CreateLeadCommandHandler.DerivePriority` (:343-346) — MEASURED, and note the two null branches
 * and the STRICT comparison. All three are separately observable and each has its own case below.
 */
describe('derivePriority', () => {
  it('is High when the estimated premium is strictly above the tenant threshold', () => {
    expect(derivePriority(150_000, 100_000)).toBe(LEAD_PRIORITY_HIGH);
  });

  it('is Normal when the premium EQUALS the threshold (the comparison is strict `>`)', () => {
    expect(derivePriority(100_000, 100_000)).toBe(LEAD_PRIORITY_NORMAL);
  });

  it('is Normal when the premium is below the threshold', () => {
    expect(derivePriority(50_000, 100_000)).toBe(LEAD_PRIORITY_NORMAL);
  });

  it('is Normal when no premium was supplied, however low the threshold', () => {
    expect(derivePriority(null, 1)).toBe(LEAD_PRIORITY_NORMAL);
  });

  it('is Normal when the tenant has configured NO high-value threshold', () => {
    // A tenant with no threshold must never get an all-High pipeline.
    expect(derivePriority(999_999_999, null)).toBe(LEAD_PRIORITY_NORMAL);
  });

  it('is Normal when both inputs are absent', () => {
    expect(derivePriority(null, null)).toBe(LEAD_PRIORITY_NORMAL);
  });
});
