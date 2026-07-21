/**
 * The lead/quote reference-format template grammar (T-020, AC-037; test_plan.unit).
 *
 * Pure grammar checks, no database. These matter beyond the settings endpoint: T-024's reference
 * generator renders the very templates this validator admits, so every case below is simultaneously
 * a statement about which templates a tenant may store AND which ones lead creation must be able to
 * render. The two are asserted together (`accepts` cases are also rendered) precisely so the pair
 * cannot drift apart.
 *
 * Measured against `src/api/QuoteIQ.Domain/Settings/ReferenceFormatTemplate.cs`.
 */
import { describe, expect, it } from 'vitest';

import {
  formatReference,
  parseReferenceFormat,
  validateReferenceFormat,
} from '../../domains/business-rules/reference-format.js';

describe('validateReferenceFormat', () => {
  it('accepts the column-default lead and quote templates', () => {
    // 20260718002200_tenant_settings.sql:66-67 — a default the validator rejected would make every
    // freshly provisioned tenant unable to save its own settings back unchanged.
    expect(validateReferenceFormat('L-{YYYY}-{SEQ:4}')).toEqual({ valid: true });
    expect(validateReferenceFormat('Q-{YYYY}-{SEQ:4}')).toEqual({ valid: true });
  });

  it('accepts a template with a sequence token and no year token', () => {
    expect(validateReferenceFormat('LEAD{SEQ:6}')).toEqual({ valid: true });
  });

  it.each([
    ['', 'Reference format cannot be empty.'],
    ['   ', 'Reference format cannot be empty.'],
  ])('rejects the empty template %j with the reference message', (template, error) => {
    expect(validateReferenceFormat(template)).toEqual({ valid: false, error });
  });

  it('rejects an unrecognized token, naming it verbatim', () => {
    expect(validateReferenceFormat('L-{BRANCH}-{SEQ:4}')).toEqual({
      valid: false,
      error: "Unknown reference format token '{BRANCH}'.",
    });
  });

  it('reports the FIRST unknown token when a template has several', () => {
    // Order is observable in the 422 detail; the reference takes `FirstOrDefault` (:65).
    expect(validateReferenceFormat('{A}{B}{SEQ:2}')).toEqual({
      valid: false,
      error: "Unknown reference format token '{A}'.",
    });
  });

  it('rejects a template with no sequence token, even when otherwise well-formed', () => {
    // Without this the tenant's every lead would share one reference.
    expect(validateReferenceFormat('L-{YYYY}')).toEqual({
      valid: false,
      error: 'Reference format must include a {SEQ:n} token.',
    });
  });

  it('rejects a pure-literal template', () => {
    expect(validateReferenceFormat('LEAD')).toEqual({
      valid: false,
      error: 'Reference format must include a {SEQ:n} token.',
    });
  });

  it.each([
    '{SEQ:0}', // zero width — `[1-9][0-9]*` excludes it
    '{SEQ:04}', // leading zero
    '{SEQ}', // no width at all
    '{SEQ:}', // empty width
    '{SEQ:n}', // the literal placeholder from the docs
    '{seq:4}', // lower case: the reference pattern is case-SENSITIVE
    '{yyyy}',
  ])('rejects the malformed sequence/year token %s as unknown', (template) => {
    const result = validateReferenceFormat(`L-${template}`);
    expect(result.valid).toBe(false);
    expect(result.valid ? '' : result.error).toBe(
      `Unknown reference format token '${template}'.`,
    );
  });

  it('accepts a repeated sequence token, matching the reference CODE rather than its comment', () => {
    // ReferenceFormatTemplate.cs:12 says "exactly one"; :71-75 is `Any(...)`. Preserving the code
    // keeps a template a tenant may already have stored from suddenly 422-ing on the next save.
    expect(validateReferenceFormat('{SEQ:2}-{SEQ:4}')).toEqual({ valid: true });
  });

  it('treats an unmatched brace as literal text rather than a token', () => {
    // `\{[^{}]*\}` needs both braces; a stray one never matches and stays literal.
    expect(validateReferenceFormat('L-{SEQ:4}')).toEqual({ valid: true });
    expect(validateReferenceFormat('L{-{SEQ:4}')).toEqual({ valid: true });
  });
});

describe('parseReferenceFormat', () => {
  it('splits literals, year and sequence in source order', () => {
    expect(parseReferenceFormat('L-{YYYY}-{SEQ:4}')).toEqual([
      { kind: 'literal', rawText: 'L-', sequenceWidth: null },
      { kind: 'year', rawText: '{YYYY}', sequenceWidth: null },
      { kind: 'literal', rawText: '-', sequenceWidth: null },
      { kind: 'sequence', rawText: '{SEQ:4}', sequenceWidth: 4 },
    ]);
  });

  it('emits a trailing literal after the last token', () => {
    expect(parseReferenceFormat('{SEQ:2}/X')).toEqual([
      { kind: 'sequence', rawText: '{SEQ:2}', sequenceWidth: 2 },
      { kind: 'literal', rawText: '/X', sequenceWidth: null },
    ]);
  });

  it('classifies an unrecognized token without judging the template', () => {
    expect(parseReferenceFormat('{NOPE}')).toEqual([
      { kind: 'unknown', rawText: '{NOPE}', sequenceWidth: null },
    ]);
  });
});

describe('formatReference', () => {
  it('renders the default template with a zero-padded sequence', () => {
    expect(formatReference('L-{YYYY}-{SEQ:4}', 2026, 7)).toBe('L-2026-0007');
  });

  it('zero-pads the year to four digits', () => {
    expect(formatReference('{YYYY}-{SEQ:1}', 26, 1)).toBe('0026-1');
  });

  it('does NOT truncate a sequence wider than its pad width', () => {
    // PadLeft never shortens (:137). Truncating would mint duplicate references at the rollover,
    // which is worse than an over-wide one.
    expect(formatReference('{SEQ:2}', 2026, 12345)).toBe('12345');
  });

  it('copies literal text through unchanged, including punctuation', () => {
    expect(formatReference('QIQ/{YYYY}/{SEQ:3}!', 2026, 42)).toBe('QIQ/2026/042!');
  });

  it('renders every occurrence of a repeated sequence token', () => {
    expect(formatReference('{SEQ:2}-{SEQ:4}', 2026, 5)).toBe('05-0005');
  });

  it('throws rather than rendering an invalid template', () => {
    // The generator's fail-loud contract: a template that reached persistence around the API must
    // not produce a malformed-but-plausible reference.
    expect(() => formatReference('L-{YYYY}', 2026, 1)).toThrow(
      /Reference format must include a \{SEQ:n\} token\./,
    );
    expect(() => formatReference('{BRANCH}{SEQ:2}', 2026, 1)).toThrow(
      /Unknown reference format token '\{BRANCH\}'\./,
    );
  });
});
