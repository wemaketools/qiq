/**
 * Attachment content rules: allow-list, extension agreement, magic-number signatures and the
 * per-tenant size cap (T-027; AC-056, AC-057, V-071, V-073).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Quotes/Attachments/FileSignatureValidator.cs`. The
 * reference required all THREE of declared content type, filename extension and leading bytes to
 * agree; this port keeps all three, but they no longer run at the same moment — see
 * `attachments.service.ts`. The first two are checked BEFORE a signed upload URL is issued (the
 * server has both without the bytes); the magic-number check can only run AFTER the object lands,
 * at confirm. The rules themselves are pure and identical, which is what this suite pins.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
  exceedsSizeCap,
  isAllowedAttachmentContentType,
  isExtensionAllowedForContentType,
  matchesDeclaredSignature,
} from '../../domains/quotes/attachment-content.js';

/** Leading bytes of a genuine file of each allow-listed type. */
const SIGNATURES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'application/msword': [0xd0, 0xcf, 0x11, 0xe0],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    0x50, 0x4b, 0x03, 0x04,
  ],
};

describe('the attachment content-type allow-list', () => {
  it('is exactly the five reference types (PNG, JPEG, PDF, DOC, DOCX)', () => {
    expect([...ALLOWED_ATTACHMENT_CONTENT_TYPES].sort()).toEqual(
      [
        'application/msword',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png',
      ].sort(),
    );
  });

  it.each(Object.keys(SIGNATURES))('admits %s', (contentType) => {
    expect(isAllowedAttachmentContentType(contentType)).toBe(true);
  });

  it.each([
    'application/x-msdownload',
    'image/svg+xml',
    'text/html',
    'application/zip',
    'application/octet-stream',
    'image/PNG',
    ' image/png',
    '',
  ])('rejects %j', (contentType) => {
    expect(isAllowedAttachmentContentType(contentType)).toBe(false);
  });
});

describe('extension agreement with the declared content type', () => {
  it.each([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/jpeg', '.jpeg'],
    ['application/pdf', '.pdf'],
    ['application/msword', '.doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ])('accepts %s with %s', (contentType, extension) => {
    expect(isExtensionAllowedForContentType(contentType, extension)).toBe(true);
  });

  it('normalizes the extension case, matching Path.GetExtension().ToLowerInvariant()', () => {
    expect(isExtensionAllowedForContentType('application/pdf', '.PDF')).toBe(true);
  });

  it.each([
    // The renamed-executable case the reference's AC-077 note calls out by name.
    ['application/pdf', '.exe'],
    ['application/pdf', '.png'],
    ['image/png', '.jpg'],
    ['application/msword', '.docx'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc'],
    ['application/pdf', ''],
  ])('rejects %s declared with %j', (contentType, extension) => {
    expect(isExtensionAllowedForContentType(contentType, extension)).toBe(false);
  });

  it('rejects a disallowed content type regardless of extension', () => {
    expect(isExtensionAllowedForContentType('application/zip', '.zip')).toBe(false);
  });
});

describe('magic-number agreement with the declared content type', () => {
  it.each(Object.entries(SIGNATURES))('accepts genuine %s bytes', (contentType, bytes) => {
    // Trailing bytes beyond the signature must not matter.
    const header = Uint8Array.from([...bytes, 0x00, 0x11, 0x22, 0x33]);
    expect(matchesDeclaredSignature(contentType, header)).toBe(true);
  });

  it('rejects an executable renamed and declared as a PDF (MZ header)', () => {
    expect(matchesDeclaredSignature('application/pdf', Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]))).toBe(
      false,
    );
  });

  it('rejects a PNG declared as a DOCX', () => {
    expect(
      matchesDeclaredSignature(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        Uint8Array.from(SIGNATURES['image/png'] as number[]),
      ),
    ).toBe(false);
  });

  it('rejects a header shorter than the signature rather than accepting a prefix match', () => {
    expect(matchesDeclaredSignature('application/pdf', Uint8Array.from([0x25, 0x50]))).toBe(false);
    expect(matchesDeclaredSignature('application/pdf', new Uint8Array(0))).toBe(false);
  });

  it('rejects a content type that is not allow-listed even when bytes are supplied', () => {
    expect(matchesDeclaredSignature('application/zip', Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe(
      false,
    );
  });

  it('accepts a ZIP-family file declared as DOCX — the documented reference caveat', () => {
    // `FileSignatureValidator`'s own caveat: DOCX/XLSX/PPTX/.zip share `50 4B 03 04`, so a renamed
    // .xlsx declared as .docx passes. Pinned so the limitation is a KNOWN property, not a surprise.
    expect(
      matchesDeclaredSignature(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      ),
    ).toBe(true);
  });
});

describe('the per-tenant size cap', () => {
  it('treats the cap as megabytes of 1024*1024 bytes, matching BytesPerMegabyte', () => {
    expect(exceedsSizeCap(10 * 1024 * 1024, 10)).toBe(false);
    expect(exceedsSizeCap(10 * 1024 * 1024 + 1, 10)).toBe(true);
  });

  it('admits a full 10 MB upload at the default cap (Q-22: 10 MB is required)', () => {
    expect(exceedsSizeCap(10_485_760, 10)).toBe(false);
  });

  it('honours a non-default tenant cap in both directions', () => {
    expect(exceedsSizeCap(3 * 1024 * 1024, 2)).toBe(true);
    expect(exceedsSizeCap(3 * 1024 * 1024, 25)).toBe(false);
  });
});
