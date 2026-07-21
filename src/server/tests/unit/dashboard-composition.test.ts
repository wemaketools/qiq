/**
 * The dashboard payload composition primitives (T-036; AC-074, AC-079).
 *
 * These are the pure functions the Executive Overview and Pipeline & Conversion endpoints are built
 * from. They are unit-tested HERE, separately from the endpoints, because several of their
 * behaviours are only falsifiable on inputs that a realistic seeded corpus does not contain — the
 * half-even rounding midpoint below needs a denominator of 32, and seeding 32 leads to prove a
 * rounding mode would be an absurd way to assert it.
 */
import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  ageDays,
  buildKpi,
  compareStages,
  dayLabel,
  firstOfMonth,
  inRange,
  lastOfMonth,
  lifecycleOrder,
  monthLabel,
  resolvePeriods,
  roundShare,
  todayUtc,
} from '../../domains/dashboards/composition.js';
import { dashboardFilterSchema } from '../../domains/dashboards/filters.js';

describe('roundShare', () => {
  it('rounds a share to four decimal places', () => {
    expect(roundShare(2, 3)).toBe(0.6667);
    expect(roundShare(1, 3)).toBe(0.3333);
    expect(roundShare(4, 9)).toBe(0.4444);
  });

  it('returns exact values without introducing floating-point noise', () => {
    expect(roundShare(3, 5)).toBe(0.6);
    expect(roundShare(1, 4)).toBe(0.25);
    expect(roundShare(5, 5)).toBe(1);
  });

  /**
   * THE ROUNDING MODE, which is the whole reason this is computed on integers.
   *
   * 1/32 is exactly 0.03125 — a true midpoint at the fourth decimal. .NET's `Math.Round(decimal, 4)`
   * rounds HALF TO EVEN and yields 0.0312. A naive `Math.round(x * 1e4) / 1e4` rounds half AWAY from
   * zero and yields 0.0313. Shares are summed and compared against 1 by the charts, so a systematic
   * upward bias at the midpoint is visible in aggregate.
   */
  it('rounds a midpoint to EVEN, not away from zero', () => {
    expect(roundShare(1, 32)).toBe(0.0312);
    expect(roundShare(1, 32)).not.toBe(0.0313);
    // 3/32 = 0.09375 -> the quotient 937 is ODD, so half-even rounds UP to 938.
    expect(roundShare(3, 32)).toBe(0.0938);
  });

  /**
   * A SHARE is not a RATE. An empty population yields 0 (an empty donut renders as an empty ring),
   * whereas the metric-definition rates yield null (an em dash) on a zero denominator.
   */
  it('yields 0 for an empty population rather than null', () => {
    expect(roundShare(0, 0)).toBe(0);
    expect(roundShare(5, 0)).toBe(0);
    expect(roundShare(5, -1)).toBe(0);
  });
});

describe('lifecycleOrder', () => {
  it('orders the guarded canonical statuses along the lifecycle', () => {
    expect(lifecycleOrder('new')).toBe(0);
    expect(lifecycleOrder('quote_sent')).toBeGreaterThan(lifecycleOrder('assigned'));
    expect(lifecycleOrder('closed_won')).toBeGreaterThan(lifecycleOrder('quote_sent'));
    expect(lifecycleOrder('withdrawn')).toBe(10);
  });

  /**
   * An unknown or absent key sorts to the END, never to the front. Sorting a tenant's brand-new
   * custom status first would place an unknown stage at the top of the funnel, where it would read
   * as the entry point every lead passes through.
   */
  it('sorts an unknown or null canonical key last', () => {
    expect(lifecycleOrder(null)).toBe(11);
    expect(lifecycleOrder('a_custom_tenant_status')).toBe(11);
    expect(lifecycleOrder(null)).toBeGreaterThan(lifecycleOrder('withdrawn'));
  });
});

describe('compareStages', () => {
  it('orders by lifecycle position first', () => {
    const stages = [
      { stageName: 'Won', stageCanonicalKey: 'closed_won' },
      { stageName: 'New', stageCanonicalKey: 'new' },
      { stageName: 'Sent', stageCanonicalKey: 'quote_sent' },
    ];
    expect(stages.slice().sort(compareStages).map((stage) => stage.stageCanonicalKey)).toEqual([
      'new',
      'quote_sent',
      'closed_won',
    ]);
  });

  it('falls back to an ordinal name comparison for two unguarded stages', () => {
    const stages = [
      { stageName: 'Zulu', stageCanonicalKey: null },
      { stageName: 'Alpha', stageCanonicalKey: null },
    ];
    expect(stages.slice().sort(compareStages).map((stage) => stage.stageName)).toEqual([
      'Alpha',
      'Zulu',
    ]);
  });
});

describe('date arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('adds months and derives month boundaries', () => {
    expect(addMonths('2026-03-15', -1)).toBe('2026-02-15');
    expect(firstOfMonth('2026-03-15')).toBe('2026-03-01');
    expect(lastOfMonth('2026-02-15')).toBe('2026-02-28');
    // Derived forward from the first of the month, so 31-day months keep their 31st.
    expect(lastOfMonth('2026-03-15')).toBe('2026-03-31');
  });

  it('clamps a negative age to zero rather than reporting a future date as negative', () => {
    expect(ageDays('2026-03-02', '2026-04-01')).toBe(30);
    expect(ageDays('2026-04-10', '2026-04-01')).toBe(0);
    expect(ageDays('2026-04-01', '2026-04-01')).toBe(0);
  });

  it('treats both ends of a range as inclusive', () => {
    const range = { from: '2026-03-01', to: '2026-03-31' };
    expect(inRange('2026-03-01', range)).toBe(true);
    expect(inRange('2026-03-31', range)).toBe(true);
    expect(inRange('2026-02-28', range)).toBe(false);
    expect(inRange('2026-04-01', range)).toBe(false);
  });

  it('reduces an instant to a UTC date', () => {
    expect(todayUtc(new Date('2026-04-01T23:59:59Z'))).toBe('2026-04-01');
    expect(todayUtc(new Date('2026-04-02T00:00:00Z'))).toBe('2026-04-02');
  });
});

describe('trend labels', () => {
  /** Rendered from an explicit table so the axis labels never depend on the host locale. */
  it('formats month and day labels in English regardless of host locale', () => {
    expect(monthLabel('2026-03-01')).toBe('Mar 2026');
    expect(monthLabel('2025-11-01')).toBe('Nov 2025');
    expect(dayLabel('2026-03-04')).toBe('Mar 4');
    expect(dayLabel('2026-04-01')).toBe('Apr 1');
  });
});

describe('resolvePeriods', () => {
  const filter = (values: Record<string, string> = {}): ReturnType<typeof dashboardFilterSchema.parse> =>
    dashboardFilterSchema.parse(values);

  it('treats a fully-supplied range as a custom period compared against the window before it', () => {
    const { period, prior } = resolvePeriods(
      filter({ from: '2026-03-01', to: '2026-03-31' }),
      '2026-04-01',
    );
    expect(period).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    // 31 days ending the day before the range starts.
    expect(prior).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });

  it('defaults to the calendar month containing today, compared against the previous month', () => {
    const { period, prior } = resolvePeriods(filter({}), '2026-03-15');
    expect(period).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    // February's true end, not "31 March minus one month".
    expect(prior).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  /** A half-open filter is NOT a custom period: a delta needs a closed window of known length. */
  it('falls back to the current month when only one end of the range is supplied', () => {
    expect(resolvePeriods(filter({ from: '2026-03-01' }), '2026-04-10').period).toEqual({
      from: '2026-04-01',
      to: '2026-04-30',
    });
  });
});

describe('buildKpi', () => {
  const base = {
    key: 'total_leads',
    label: 'Total Leads',
    leadOrQuote: 'lead',
    kind: 'count',
    goodDirection: 'higherIsBetter',
    drillWidgetKey: 'exec.leads',
  } as const;

  it('computes the delta when both periods have a value', () => {
    const card = buildKpi({ ...base, value: 10, prior: 4 });
    expect(card.delta).toBe(6);
    expect(card.isFavorableDelta).toBe(true);
  });

  /** A missing prior is NOT zero: "+100%" because last month had no business is worse than blank. */
  it('leaves the delta null when the prior period is absent', () => {
    expect(buildKpi({ ...base, value: 10, prior: null }).delta).toBeNull();
    expect(buildKpi({ ...base, value: 10 }).delta).toBeNull();
    expect(buildKpi({ ...base, value: null, prior: 4 }).delta).toBeNull();
  });

  it('marks a fall as favourable only when lower is better', () => {
    expect(buildKpi({ ...base, value: 2, prior: 5 }).isFavorableDelta).toBe(false);
    expect(
      buildKpi({ ...base, goodDirection: 'lowerIsBetter', value: 2, prior: 5 }).isFavorableDelta,
    ).toBe(true);
  });

  /** TRI-STATE: a flat KPI is neither good nor bad and must render uncoloured. */
  it('reports a zero delta as neither favourable nor unfavourable', () => {
    const card = buildKpi({ ...base, value: 5, prior: 5 });
    expect(card.delta).toBe(0);
    expect(card.isFavorableDelta).toBeNull();
  });

  it('carries the lead-vs-quote basis onto the card', () => {
    expect(buildKpi({ ...base, value: 1 }).leadOrQuote).toBe('lead');
    expect(buildKpi({ ...base, leadOrQuote: 'quote', value: 1 }).leadOrQuote).toBe('quote');
  });
});
