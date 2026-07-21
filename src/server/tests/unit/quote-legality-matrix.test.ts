/**
 * The quote legality matrix, exhaustively (T-026; AC-050, AC-053, AC-054, V-064).
 *
 * THE EXPECTATIONS BELOW ARE AN INDEPENDENT TRANSCRIPTION, NOT A RE-EXPORT
 * =======================================================================
 * `EXPECTED_RULES` is hand-transcribed from `QuoteIQ.Domain/Workflow/QuoteWorkflow.cs:73-104`, one
 * literal at a time, exactly as `lead-legality-matrix.test.ts` does for the lead side. It
 * deliberately does NOT read `QUOTE_OPERATION_MATRIX` — a table derived from the module under test
 * would agree with any mutation of that module and prove nothing.
 *
 * TWO KINDS OF "CURRENT STATUS" LIVE IN THIS FEATURE AND ONLY ONE IS A MATRIX ROW
 * ==============================================================================
 * `create`'s legality is a property of the LEAD's reporting category (there is no quote yet), so it
 * is `isLegalToCreateQuote` rather than a matrix row (`QuoteOperation.Create`'s doc comment states
 * this outright). The sweep below therefore covers the seven quote-status-keyed operations, and
 * `create` gets its own category-driven cases.
 */
import { describe, expect, it } from 'vitest';

import {
  QUOTE_OPERATIONS,
  QUOTE_OPERATION_MATRIX,
  QUOTE_OPERATION_PERMISSIONS,
  QUOTE_STATUS_KEYS,
  QUOTE_EXPIRE_OPERATION,
  availableQuoteOperations,
  isLegalToCreateQuote,
  isQuoteOperationLegal,
  legalQuoteOperations,
  resolveFixedQuoteTarget,
  type QuoteOperationName,
} from '../../domains/quotes/workflow/legality.js';

/** Every canonical quote-status key (QuoteStatusKeys.cs:12-18), plus null for a tenant-added status. */
const ALL_STATUS_KEYS = [
  'draft',
  'sent',
  'revised',
  'won',
  'lost',
  'expired',
  'withdrawn',
] as const;

/** Every reporting category (ReportingCategory.cs:10-15). */
const ALL_CATEGORIES = ['open', 'quoted', 'won', 'lost', 'expired', 'withdrawn'] as const;

interface ExpectedRule {
  readonly keys: readonly string[];
  readonly target: { readonly mode: 'unchanged' } | { readonly mode: 'fixed'; readonly key: string };
}

/** Transcribed from QuoteWorkflow.Matrix (:73-104), literal by literal. */
const EXPECTED_RULES: Readonly<Record<string, ExpectedRule>> = {
  // "Assign / Reassign | Draft, Sent, Revised" -- never changes the quote's own status.
  assign: { keys: ['draft', 'sent', 'revised'], target: { mode: 'unchanged' } },

  // "Send | Draft" ONLY. The reference flags this as a deliberate, resolved conflict: the prose
  // brief said "draft/revised", V-046 said Send is not present on a Revised quote, and the
  // reference followed V-046. Ported as the reference resolved it.
  send: { keys: ['draft'], target: { mode: 'fixed', key: 'sent' } },

  // "Revise | Sent" -- a Revised quote cannot be revised a second time in this model.
  revise: { keys: ['sent'], target: { mode: 'fixed', key: 'revised' } },

  'mark-won': { keys: ['sent', 'revised'], target: { mode: 'fixed', key: 'won' } },
  'mark-lost': { keys: ['sent', 'revised'], target: { mode: 'fixed', key: 'lost' } },
  withdraw: { keys: ['draft', 'sent', 'revised'], target: { mode: 'fixed', key: 'withdrawn' } },

  // "Set current | Draft, Sent, Revised" (PRD 7.3, V-049) -- never changes the quote's own status.
  'set-current': { keys: ['draft', 'sent', 'revised'], target: { mode: 'unchanged' } },

  // The automatic, past-valid-until expiry: legal from Sent/Revised, never human-invocable.
  expire_automatic: { keys: ['sent', 'revised'], target: { mode: 'fixed', key: 'expired' } },
};

describe('quote legality matrix', () => {
  it('covers every operation the module exposes, and no more', () => {
    const moduleOperations = Object.keys(QUOTE_OPERATION_MATRIX).sort();
    expect(moduleOperations).toEqual(Object.keys(EXPECTED_RULES).sort());
  });

  it('exposes exactly the seven human-invocable operations, in the reference enum order', () => {
    // Order is load-bearing: `GetLegalOperations` projects the matrix in declaration order, so the
    // 409 hint and `availableOperations` are ordered lists the SPA and the tests compare elementwise.
    expect([...QUOTE_OPERATIONS]).toEqual([
      'assign',
      'send',
      'revise',
      'mark-won',
      'mark-lost',
      'withdraw',
      'set-current',
    ]);
  });

  it('declares the seven guarded canonical status keys', () => {
    expect(Object.values(QUOTE_STATUS_KEYS).sort()).toEqual([...ALL_STATUS_KEYS].sort());
  });

  const sweep: {
    operation: QuoteOperationName;
    key: string | null;
  }[] = [];
  for (const operation of Object.keys(EXPECTED_RULES) as QuoteOperationName[]) {
    for (const key of [...ALL_STATUS_KEYS, null]) sweep.push({ operation, key });
  }

  it.each(sweep)('isQuoteOperationLegal($operation, $key)', ({ operation, key }) => {
    const expected = key !== null && EXPECTED_RULES[operation]!.keys.includes(key);
    expect(isQuoteOperationLegal(operation, key)).toBe(expected);
  });

  it('never reports any operation legal from a null canonical key', () => {
    // A tenant-added custom quote status carries no canonical key. Unlike the LEAD matrix (which
    // has category-wide rows), every quote rule is keyed by canonical key alone, so a custom status
    // inherits nothing. Measured: `IsLegal` returns false whenever currentCanonicalKey is null.
    for (const operation of Object.keys(EXPECTED_RULES) as QuoteOperationName[]) {
      expect(isQuoteOperationLegal(operation, null)).toBe(false);
    }
  });

  it.each([...ALL_STATUS_KEYS, null])('legalQuoteOperations(%s) excludes the automatic expiry', (key) => {
    const legal = legalQuoteOperations(key);
    expect(legal).not.toContain(QUOTE_EXPIRE_OPERATION);

    const expected = QUOTE_OPERATIONS.filter(
      (operation) => key !== null && EXPECTED_RULES[operation]!.keys.includes(key),
    );
    expect(legal).toEqual(expected);
  });

  it('lists Send only for a Draft quote, and never for a Revised one', () => {
    // Pinned separately because it is the reference's one explicitly flagged conflict resolution:
    // a status-set assertion elsewhere could pass while this specific pair silently flipped.
    expect(legalQuoteOperations('draft')).toContain('send');
    expect(legalQuoteOperations('revised')).not.toContain('send');
    expect(legalQuoteOperations('sent')).not.toContain('send');
  });

  it('lists Revise only for a Sent quote', () => {
    expect(legalQuoteOperations('sent')).toContain('revise');
    expect(legalQuoteOperations('draft')).not.toContain('revise');
    expect(legalQuoteOperations('revised')).not.toContain('revise');
  });

  it.each([...ALL_STATUS_KEYS, null])('offers no operation at all from terminal status %s', (key) => {
    if (key === 'draft' || key === 'sent' || key === 'revised') return;
    expect(legalQuoteOperations(key)).toEqual([]);
  });

  it.each(Object.keys(EXPECTED_RULES))('resolveFixedQuoteTarget(%s)', (operation) => {
    const expected = EXPECTED_RULES[operation]!.target;
    const actual = resolveFixedQuoteTarget(operation as QuoteOperationName);
    expect(actual).toBe(expected.mode === 'unchanged' ? null : expected.key);
  });

  it('maps every human operation to its reference permission code', () => {
    // Transcribed from QuoteOperationPermissions.Map (:22-31).
    expect(QUOTE_OPERATION_PERMISSIONS).toEqual({
      assign: 'quotes.assign',
      send: 'quotes.mark_sent',
      revise: 'quotes.revise',
      'mark-won': 'quotes.close_won',
      'mark-lost': 'quotes.close_lost',
      withdraw: 'quotes.withdraw',
      'set-current': 'quotes.set_current',
    });
  });

  describe('availableQuoteOperations', () => {
    it('intersects legality with the caller permissions', () => {
      const held = new Set(['quotes.mark_sent', 'quotes.withdraw']);
      expect(availableQuoteOperations('draft', (p) => held.has(p))).toEqual(['send', 'withdraw']);
    });

    it('is empty for a caller holding nothing, even from a status with legal operations', () => {
      expect(availableQuoteOperations('sent', () => false)).toEqual([]);
    });

    it('never surfaces the automatic expiry even for an all-permissions caller', () => {
      for (const key of [...ALL_STATUS_KEYS, null]) {
        expect(availableQuoteOperations(key, () => true)).not.toContain(QUOTE_EXPIRE_OPERATION);
      }
    });
  });

  describe('isLegalToCreateQuote (the LEAD-side rule)', () => {
    it.each(ALL_CATEGORIES)('category %s', (category) => {
      // "Open or Quoted" — PRD 7.3 multi-option quoting explicitly allows a second quote after the
      // lead has already reached Quote Sent (the Quoted category).
      expect(isLegalToCreateQuote(category)).toBe(category === 'open' || category === 'quoted');
    });

    it('is illegal when the lead status carries no reporting category at all', () => {
      expect(isLegalToCreateQuote(null)).toBe(false);
    });
  });
});
