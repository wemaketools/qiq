/**
 * The lead legality matrix, exhaustively (T-025; AC-047, V-060).
 *
 * THE EXPECTATIONS BELOW ARE AN INDEPENDENT TRANSCRIPTION, NOT A RE-EXPORT
 * =======================================================================
 * `EXPECTED_RULES` is hand-transcribed from `QuoteIQ.Domain/Workflow/LeadWorkflow.cs:82-172`, one
 * literal at a time. It deliberately does NOT read `LEAD_OPERATION_MATRIX` — a table derived from
 * the module under test would agree with any mutation of that module and prove nothing. Because the
 * two are independent, the generated 936-case sweep below is a real oracle: changing either the
 * module's allowed keys or its allowed categories fails it.
 *
 * EXHAUSTIVENESS IS ASSERTED, NOT ASSUMED (V-060)
 * ==============================================
 * Adding an operation to the module without adding its expectation row here fails
 * `covers every operation the module exposes`; adding a status key or reporting category likewise
 * fails its own guard. The sweep then covers every operation x canonical key x reporting category
 * combination, including the null canonical key a tenant-added custom status carries.
 */
import { describe, expect, it } from 'vitest';

import {
  LEAD_OPERATIONS,
  LEAD_OPERATION_MATRIX,
  LEAD_REPORTING_CATEGORIES,
  LEAD_STATUS_KEYS,
  isLeadOperationLegal,
  legalLeadOperations,
  resolveFixedLeadTarget,
  type LeadOperationName,
} from '../../domains/leads/workflow/legality.js';

/** Every canonical lead-status key (LeadStatusKeys.cs:12-22), plus null for a tenant-added status. */
const ALL_STATUS_KEYS = [
  'new',
  'assigned',
  'information_gathering',
  'underwriting',
  'pricing',
  'quote_sent',
  'negotiation',
  'closed_won',
  'closed_lost',
  'expired',
  'withdrawn',
] as const;

/** Every reporting category (ReportingCategory.cs:10-15). */
const ALL_CATEGORIES = ['open', 'quoted', 'won', 'lost', 'expired', 'withdrawn'] as const;

interface ExpectedRule {
  readonly keys: readonly string[];
  readonly categories: readonly string[];
  readonly target:
    | { readonly mode: 'unchanged' }
    | { readonly mode: 'fixed'; readonly key: string }
    | { readonly mode: 'assign' }
    | { readonly mode: 'history' };
}

/** Transcribed from LeadWorkflow.Matrix, literal by literal. */
const EXPECTED_RULES: Readonly<Record<string, ExpectedRule>> = {
  // "Assign / Reassign | New, or any open status (reassign)" (:85-88).
  assign: { keys: ['new'], categories: ['open', 'quoted'], target: { mode: 'assign' } },
  // "Start information gathering | Assigned, Underwriting, Pricing" (:91-95).
  'start-information-gathering': {
    keys: ['assigned', 'underwriting', 'pricing'],
    categories: [],
    target: { mode: 'fixed', key: 'information_gathering' },
  },
  // "Send to underwriting | Assigned, Information Gathering" (:98-102).
  'send-to-underwriting': {
    keys: ['assigned', 'information_gathering'],
    categories: [],
    target: { mode: 'fixed', key: 'underwriting' },
  },
  // "Start pricing | Assigned, Information Gathering, Underwriting" (:105-109).
  'start-pricing': {
    keys: ['assigned', 'information_gathering', 'underwriting'],
    categories: [],
    target: { mode: 'fixed', key: 'pricing' },
  },
  // The three pricing sub-state operations: "Pricing" only, lead status untouched (:112-127).
  'request-pricing-approval': { keys: ['pricing'], categories: [], target: { mode: 'unchanged' } },
  'approve-pricing': { keys: ['pricing'], categories: [], target: { mode: 'unchanged' } },
  'reject-pricing': { keys: ['pricing'], categories: [], target: { mode: 'unchanged' } },
  // "Log follow-up | ... (any open status permitted)" — category-wide, no status change (:130-133).
  'log-follow-up': { keys: [], categories: ['open', 'quoted'], target: { mode: 'unchanged' } },
  // "Start negotiation | Quote Sent" (:136-140).
  'start-negotiation': {
    keys: ['quote_sent'],
    categories: [],
    target: { mode: 'fixed', key: 'negotiation' },
  },
  // "Mark lost | Any open status" (:143-147).
  'mark-lost': {
    keys: [],
    categories: ['open', 'quoted'],
    target: { mode: 'fixed', key: 'closed_lost' },
  },
  // "Withdraw | Any open status" (:150-154).
  withdraw: {
    keys: [],
    categories: ['open', 'quoted'],
    target: { mode: 'fixed', key: 'withdrawn' },
  },
  // "Reopen | Closed Lost, Expired, Withdrawn" — Closed Won deliberately excluded (:159-162).
  reopen: {
    keys: ['closed_lost', 'expired', 'withdrawn'],
    categories: [],
    target: { mode: 'history' },
  },
  // The automatic inactivity expiry (:167-171): legal category-wide but never human-invocable.
  expire_automatic: {
    keys: [],
    categories: ['open', 'quoted'],
    target: { mode: 'fixed', key: 'expired' },
  },
};

/** The reference's own rule (LeadWorkflow.IsLegal, :179-189), re-derived from the transcription. */
function expectLegal(operation: string, key: string | null, category: string | null): boolean {
  const rule = EXPECTED_RULES[operation];
  if (rule === undefined) throw new Error(`no expectation transcribed for '${operation}'`);
  if (key !== null && rule.keys.includes(key)) return true;
  return category !== null && rule.categories.includes(category);
}

describe('lead legality matrix', () => {
  it('covers every operation the module exposes, and no more', () => {
    // V-060's exhaustiveness guard: a new operation with no transcribed expectation fails here
    // rather than silently sweeping zero cases.
    expect([...Object.keys(LEAD_OPERATION_MATRIX)].sort()).toEqual(
      [...Object.keys(EXPECTED_RULES)].sort(),
    );
  });

  it('exposes exactly the eleven canonical status keys and six reporting categories', () => {
    expect([...Object.values(LEAD_STATUS_KEYS)].sort()).toEqual([...ALL_STATUS_KEYS].sort());
    expect([...LEAD_REPORTING_CATEGORIES].sort()).toEqual([...ALL_CATEGORIES].sort());
  });

  it('excludes the automatic expiry operation from the human-invocable operation list', () => {
    // LeadOperation.Expire is invoked only by the T-032 inactivity job under the system actor; it
    // must never surface in a 409 hint or in availableOperations (LeadWorkflow.cs:191-202).
    expect(LEAD_OPERATIONS).not.toContain('expire_automatic');
    expect(LEAD_OPERATION_MATRIX['expire_automatic']).toBeDefined();
  });

  describe('operation x canonical key x reporting category', () => {
    for (const operation of Object.keys(EXPECTED_RULES)) {
      for (const key of [...ALL_STATUS_KEYS, null]) {
        for (const category of ALL_CATEGORIES) {
          const expected = expectLegal(operation, key, category);
          it(`${operation} from ${key ?? '<custom>'} / ${category} is ${expected ? 'legal' : 'illegal'}`, () => {
            expect(isLeadOperationLegal(operation as LeadOperationName, key, category)).toBe(
              expected,
            );
          });
        }
      }
    }
  });

  it('treats a null reporting category as legal only via an exact canonical-key match', () => {
    // Both null is the "unknown status" case: nothing may be invoked (LeadWorkflow.cs:183-188).
    expect(isLeadOperationLegal('assign', null, null)).toBe(false);
    expect(isLeadOperationLegal('assign', 'new', null)).toBe(true);
    expect(isLeadOperationLegal('mark-lost', 'new', null)).toBe(false);
  });

  describe('legalLeadOperations', () => {
    it('lists the four category-wide operations plus assign from New', () => {
      expect(legalLeadOperations('new', 'open')).toEqual([
        'assign',
        'log-follow-up',
        'mark-lost',
        'withdraw',
      ]);
    });

    it('lists the pricing sub-state operations from Pricing', () => {
      expect(legalLeadOperations('pricing', 'open')).toEqual([
        'assign',
        'start-information-gathering',
        'request-pricing-approval',
        'approve-pricing',
        'reject-pricing',
        'log-follow-up',
        'mark-lost',
        'withdraw',
      ]);
    });

    it('lists only reopen from a terminal Closed Lost status', () => {
      expect(legalLeadOperations('closed_lost', 'lost')).toEqual(['reopen']);
    });

    it('lists nothing from Closed Won — a won lead is never undone by a lead operation', () => {
      expect(legalLeadOperations('closed_won', 'won')).toEqual([]);
    });

    it('gives a tenant-added open status the category-wide operations only', () => {
      // The flagged resolution in LeadWorkflow.cs:63-74: a custom status inherits the four
      // category-level operations but none of the narrowly canonical-key-scoped ones.
      expect(legalLeadOperations(null, 'open')).toEqual([
        'assign',
        'log-follow-up',
        'mark-lost',
        'withdraw',
      ]);
    });

    it('never offers the automatic expiry operation from any open status', () => {
      for (const category of ALL_CATEGORIES) {
        for (const key of [...ALL_STATUS_KEYS, null]) {
          expect(legalLeadOperations(key, category)).not.toContain('expire_automatic');
        }
      }
    });
  });

  describe('resolveFixedLeadTarget', () => {
    for (const [operation, rule] of Object.entries(EXPECTED_RULES)) {
      if (rule.target.mode === 'fixed') {
        const target = rule.target.key;
        it(`${operation} always targets ${target}`, () => {
          for (const key of [...ALL_STATUS_KEYS, null]) {
            expect(resolveFixedLeadTarget(operation as LeadOperationName, key)).toBe(target);
          }
        });
      }

      if (rule.target.mode === 'unchanged') {
        it(`${operation} leaves the lead status unchanged`, () => {
          for (const key of [...ALL_STATUS_KEYS, null]) {
            expect(resolveFixedLeadTarget(operation as LeadOperationName, key)).toBeNull();
          }
        });
      }
    }

    it('moves New to Assigned on first assignment and leaves every other status alone', () => {
      // LeadWorkflow.cs:217-218 — the only operation whose target depends on the current status.
      expect(resolveFixedLeadTarget('assign', 'new')).toBe('assigned');
      for (const key of [...ALL_STATUS_KEYS.filter((k) => k !== 'new'), null]) {
        expect(resolveFixedLeadTarget('assign', key)).toBeNull();
      }
    });

    it('refuses to resolve reopen, whose target needs status history', () => {
      // LeadWorkflow.cs:219-221 throws rather than returning a plausible-looking wrong answer.
      expect(() => resolveFixedLeadTarget('reopen', 'closed_lost')).toThrow(/history/i);
    });
  });
});
