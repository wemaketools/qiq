/**
 * Attachment storage-key construction and filename sanitization (T-027; AC-056, V-071, V-072).
 *
 * Port of `src/api/tests/QuoteIQ.Application.Tests/Quotes/Attachments/AttachmentStorageKeySanitizeTests.cs`
 * against `AttachmentStorageKey.cs`.
 *
 * THIS IS THE PATH-TRAVERSAL BOUNDARY, AND IT IS THE ONLY ONE
 * ==========================================================
 * The object key is the ONLY thing separating one tenant's bytes from another's in the bucket —
 * Supabase Storage has no tenant concept, and RLS is not adopted (Q-10), so nothing sits beneath
 * this function. The tenant/quote/attachment segments come from server-verified ids; the ONLY
 * attacker-controlled input is the filename, and `sanitize` is what stops it from contributing a
 * path separator, a `..` segment, or anything else that could re-point the key at another tenant's
 * prefix. Every traversal case below asserts the FULL resulting key, not merely that the sanitized
 * fragment "looks clean" — an assertion on the fragment alone would pass even if `buildKey`
 * interpolated it before the tenant segment.
 */
import { describe, expect, it } from 'vitest';

import { buildAttachmentKey, sanitizeAttachmentFileName } from '../../lib/storage/index.js';

describe('sanitizeAttachmentFileName', () => {
  it('keeps letters, digits, dot, dash and underscore unchanged', () => {
    expect(sanitizeAttachmentFileName('Quarterly_Report-2026.v2.pdf')).toBe(
      'Quarterly_Report-2026.v2.pdf',
    );
  });

  it.each([
    ['../../../etc/passwd', 'passwd'],
    ['..\\..\\evil.exe', 'evil.exe'],
    ['/absolute/path/report.pdf', 'report.pdf'],
    ['C:\\Users\\victim\\secret.docx', 'secret.docx'],
    ['nested/deeper/file.png', 'file.png'],
  ])('strips every directory component of %j', (input, expected) => {
    expect(sanitizeAttachmentFileName(input)).toBe(expected);
  });

  it('never returns a value containing a path separator or a parent-directory segment', () => {
    for (const hostile of ['../../x', 'a/b/../../c.pdf', '..%2f..%2fx.pdf', './../.././x']) {
      const sanitized = sanitizeAttachmentFileName(hostile);
      expect(sanitized).not.toContain('/');
      expect(sanitized).not.toContain('\\');
      expect(sanitized).not.toBe('..');
      expect(sanitized.startsWith('..')).toBe(false);
    }
  });

  it('replaces every character outside the allow-list with an underscore', () => {
    // ' ' '#' '&' '*' '(' ')' -> one '_' each, so `*(` becomes exactly two underscores.
    expect(sanitizeAttachmentFileName('in voice#1&2*(x).pdf')).toBe('in_voice_1_2__x_.pdf');
  });

  it('strips control characters, including a NUL truncation attempt', () => {
    expect(sanitizeAttachmentFileName('report.pdf\u0000.exe')).toBe('report.pdf_.exe');
    expect(sanitizeAttachmentFileName('a\r\nb.pdf')).toBe('a__b.pdf');
  });

  it('trims leading dots so a hidden-file name cannot be produced', () => {
    expect(sanitizeAttachmentFileName('.htaccess')).toBe('htaccess');
    expect(sanitizeAttachmentFileName('...hidden.pdf')).toBe('hidden.pdf');
  });

  it('falls back to "attachment" when nothing legible survives', () => {
    expect(sanitizeAttachmentFileName('...')).toBe('attachment');
    expect(sanitizeAttachmentFileName('/')).toBe('attachment');
    expect(sanitizeAttachmentFileName('')).toBe('attachment');
    expect(sanitizeAttachmentFileName('___')).toBe('attachment');
  });

  it('caps the sanitized name at 150 characters', () => {
    const sanitized = sanitizeAttachmentFileName(`${'a'.repeat(400)}.pdf`);
    expect(sanitized).toHaveLength(150);
  });
});

describe('buildAttachmentKey', () => {
  it('builds the reference key scheme t{tenantId}/quotes/{quoteId}/{attachmentId}_{fileName}', () => {
    expect(buildAttachmentKey(7, 42, 99, 'report.pdf')).toBe('t7/quotes/42/99_report.pdf');
  });

  it('confines a traversal filename inside the tenant prefix', () => {
    // The whole key, not just the fragment: this is what proves the sanitized name cannot escape.
    expect(buildAttachmentKey(7, 42, 99, sanitizeAttachmentFileName('../../../t8/evil.pdf'))).toBe(
      't7/quotes/42/99_evil.pdf',
    );
  });

  it('produces keys under distinct tenant prefixes for distinct tenants', () => {
    const a = buildAttachmentKey(1, 5, 5, 'x.pdf');
    const b = buildAttachmentKey(2, 5, 5, 'x.pdf');

    expect(a).toBe('t1/quotes/5/5_x.pdf');
    expect(b).toBe('t2/quotes/5/5_x.pdf');
    expect(a.startsWith('t1/')).toBe(true);
    expect(b.startsWith('t2/')).toBe(true);
  });

  it('rejects a non-positive or non-integer id rather than emitting a malformed key', () => {
    expect(() => buildAttachmentKey(0, 1, 1, 'x.pdf')).toThrow(/tenant/i);
    expect(() => buildAttachmentKey(1, -3, 1, 'x.pdf')).toThrow(/quote/i);
    expect(() => buildAttachmentKey(1, 1, 1.5, 'x.pdf')).toThrow(/attachment/i);
  });
});
