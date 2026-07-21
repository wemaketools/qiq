/**
 * The pure TTL-boundary arithmetic behind the T-049 orphaned-upload reaper (AC-024; V-031).
 *
 * The integration suite proves which ROWS and which storage OBJECTS move; this proves the cutoff
 * instant itself is computed correctly, with no database and no fixtures. The reaper deletes a
 * pending attachment only when its `uploaded_at` is STRICTLY OLDER than `now - ttl`, so the exact
 * instant this function returns is the single value separating a safely-abandoned upload from one
 * that may still be in flight.
 */
import { describe, expect, it } from 'vitest';

import { orphanUploadCutoff } from '../../jobs/cron/orphaned-upload-reaper.js';
import { SUPABASE_UPLOAD_TOKEN_TTL_SECONDS } from '../../lib/storage/index.js';

describe('orphanUploadCutoff', () => {
  it('subtracts the whole TTL in seconds from the given instant', () => {
    // 7200s = the Supabase upload-URL TTL (2h). A pending row older than this cannot still be
    // uploading, because its signed URL has already expired.
    expect(orphanUploadCutoff(new Date('2026-06-15T12:00:00.000Z'), 7200)).toBe(
      '2026-06-15T10:00:00.000Z',
    );
  });

  it('preserves sub-hour precision, so the boundary is an instant and not an hour bucket', () => {
    // A URL issued at 11:59:30 must be judged against 11:59:30 two hours on, not a rounded hour.
    expect(orphanUploadCutoff(new Date('2026-06-15T11:59:30.500Z'), 7200)).toBe(
      '2026-06-15T09:59:30.500Z',
    );
  });

  it('treats a zero TTL as "everything strictly before now"', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    expect(orphanUploadCutoff(now, 0)).toBe(now.toISOString());
  });

  it('does not shift by an hour across a DST transition (millisecond arithmetic, not calendar)', () => {
    // The sweep runs in whatever timezone the Vercel/Node process is in. Calendar-aware subtraction
    // would land an hour off around a spring-forward; millisecond arithmetic cannot.
    expect(orphanUploadCutoff(new Date('2026-03-08T12:00:00.000Z'), 7200)).toBe(
      '2026-03-08T10:00:00.000Z',
    );
  });

  it('agrees with the configured Supabase upload-token TTL constant the sweep defaults to', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const expected = new Date(
      now.getTime() - SUPABASE_UPLOAD_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();
    expect(orphanUploadCutoff(now, SUPABASE_UPLOAD_TOKEN_TTL_SECONDS)).toBe(expected);
  });
});
