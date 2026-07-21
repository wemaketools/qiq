/**
 * The pure threshold arithmetic behind the T-032 expiry sweeps (AC-066; V-083, V-084).
 *
 * The integration suites prove which ROWS move; this proves the cutoff itself is computed
 * correctly, with no database and no fixtures — including the DST case, which no integration
 * fixture can exercise because the boundary rows are seeded in UTC.
 */
import { describe, expect, it } from 'vitest';

import { inactivityThreshold } from '../../jobs/cron/lead-inactivity-expiry.js';

describe('inactivityThreshold', () => {
  it('subtracts whole days from the given instant', () => {
    expect(inactivityThreshold(new Date('2026-06-15T12:00:00.000Z'), 30)).toBe(
      '2026-05-16T12:00:00.000Z',
    );
  });

  it('preserves the time of day exactly, so the cutoff is an instant and not a date', () => {
    // A lead that went quiet at 11:59 on the cutoff day must not be judged by a midnight boundary.
    expect(inactivityThreshold(new Date('2026-06-15T23:59:59.000Z'), 1)).toBe(
      '2026-06-14T23:59:59.000Z',
    );
  });

  it('treats zero days as "everything before now"', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    expect(inactivityThreshold(now, 0)).toBe(now.toISOString());
  });

  it('does not shift by an hour across a DST transition', () => {
    // 2026-03-08 is the US spring-forward date. Calendar-aware day arithmetic (setDate) would land
    // an hour off here in a non-UTC process timezone; millisecond arithmetic cannot.
    expect(inactivityThreshold(new Date('2026-03-10T12:00:00.000Z'), 7)).toBe(
      '2026-03-03T12:00:00.000Z',
    );
  });

  it('spans month and year boundaries by real elapsed time', () => {
    expect(inactivityThreshold(new Date('2026-01-05T00:00:00.000Z'), 10)).toBe(
      '2025-12-26T00:00:00.000Z',
    );
    // 2028 is a leap year: 60 days back from 1 May crosses 29 February.
    expect(inactivityThreshold(new Date('2028-05-01T00:00:00.000Z'), 60)).toBe(
      '2028-03-02T00:00:00.000Z',
    );
  });
});
