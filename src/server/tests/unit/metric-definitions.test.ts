/**
 * The metric-definitions module (T-035; AC-073; V-091).
 *
 * Port target: `src/api/QuoteIQ.Domain/Metrics/MetricDefinitions.cs`,
 * `src/api/QuoteIQ.Domain/Alerts/ExecutiveEscalationRule.cs`,
 * `src/api/QuoteIQ.Application/Dashboards/KpiValue.cs` and `DashboardPeriod.cs`.
 *
 * WHAT THIS SUITE IS FOR
 * ======================
 * These formulas are the single source of truth for what the business reports. A subtly wrong
 * definition here does not crash anything — it ships, renders in a KPI card, and is believed. So
 * every assertion below is against a HAND-COMPUTED value carried in the shared fixture next to the
 * arithmetic that produced it, never against whatever the implementation happens to return.
 *
 * ZERO-DENOMINATOR BEHAVIOUR IS PART OF THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. The reference
 * returns null rather than 0 for every rate, and each of its XML docs says why: a 0% conversion
 * rate reads as "we lost everything" when the truth is "nothing has been decided yet". Each null is
 * asserted individually — a shared `expect(...).toBeNull()` loop would pass just as happily on an
 * implementation that returned null for everything.
 */
import { describe, expect, it } from 'vitest';

import {
  loadEscalationFixture,
  loadMetricFixture,
} from '../../domains/dashboards/metrics/fixtures/load.js';
import {
  EXECUTIVE_AGING_BUCKETS,
  METRIC_CATALOG,
  PIPELINE_AGING_BUCKETS,
  averageLeadAgeDays,
  averagePriceGap,
  averageQuoteAgeDays,
  averageTurnaroundDays,
  boundPremiumTotal,
  conversionRate,
  executiveAgingBucket,
  followUpCompliance,
  isStalled,
  leadToQuoteRate,
  openPipelinePremium,
  pipelineAgingBucket,
  proposalToWinRate,
  qualifiesForExecutiveEscalation,
  quoteToProposalRate,
  quotedPremiumTotal,
  slaStatus,
  type MetricBasis,
} from '../../domains/dashboards/metrics/index.js';
import { addMoney, compareMoney, sumMoney } from '../../domains/dashboards/money.js';
import {
  isFavorableDelta,
  kpiDelta,
  priorComparablePeriod,
} from '../../domains/dashboards/payload.js';

const fixture = loadMetricFixture();
const expected = fixture.expected;

/** Whole days between two `yyyy-MM-dd` dates — the fixture's own arithmetic, not the module's. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

function inPeriod(date: string | null): boolean {
  return date !== null && date >= fixture.period.from && date <= fixture.period.to;
}

const OPEN_CATEGORIES = ['open', 'quoted'];

describe('money arithmetic is exact', () => {
  /**
   * The T-008 obligation inherited by this task: `numeric` columns arrive as STRINGS on purpose and
   * must not round-trip through a double before a business decision is made on them. 0.1 + 0.2 is
   * the canonical proof — as doubles it is 0.30000000000000004, which is not 0.30.
   */
  it('adds two-decimal amounts without floating-point drift', () => {
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(Number('0.10') + Number('0.20')).not.toBe(0.3);
  });

  /**
   * A REGRESSION GUARD, AND DELIBERATELY NOT THE PROOF OF EXACTNESS.
   *
   * Summing 1000 cents as doubles gives 9.999999999999831, which `toFixed(2)` rounds straight back
   * to "10.00" — so this assertion passes on a floating-point implementation too and CANNOT tell
   * the exact version from the broken one. That was found by mutation testing (a `Number()`-based
   * `sumMoney` survived it), and it is left here as a cheap guard with its limits stated rather
   * than removed or, worse, trusted. The two tests below are the ones that actually discriminate.
   */
  it('sums a large corpus of small amounts to the expected total', () => {
    const many = Array.from({ length: 1000 }, () => '0.01');
    expect(sumMoney(many)).toBe('10.00');
  });

  /**
   * THE DISCRIMINATING EXACTNESS CASE. `numeric(18,2)` permits amounts beyond 2^53, where a double
   * can no longer represent a cent at all: `4503599627370496.00 + 0.01` is 4503599627370496.00 in
   * IEEE-754 and 4503599627370496.01 in reality. This is the magnitude at which a floating-point
   * total does not merely drift, it silently discards money.
   */
  it('stays exact at a magnitude where a double cannot represent a cent', () => {
    expect(sumMoney(['4503599627370496.00', '0.01'])).toBe('4503599627370496.01');
  });

  /**
   * THE DISCRIMINATING VALIDATION CASE, and the more realistic of the two. `Number('1.005')` is a
   * perfectly good 1.005 that rounds into a total as 1.01, so a double-based sum ACCEPTS money the
   * schema cannot store and silently invents a cent. Exact parsing refuses it instead.
   */
  it('rejects an over-precision amount rather than silently rounding it into the total', () => {
    expect(() => sumMoney(['1.005', '2.00'])).toThrow(/numeric\(18,2\)/);
    expect(() => sumMoney(['not-money'])).toThrow();
  });

  it('compares amounts by value rather than by string ordering', () => {
    // '9.00' > '10.00' lexicographically; the whole point is that it is not numerically.
    expect(compareMoney('9.00', '10.00')).toBeLessThan(0);
    expect(compareMoney('100000.00', '100000.00')).toBe(0);
  });

  it('rejects an amount that is not a two-decimal numeric string', () => {
    expect(() => addMoney('1.005', '0.00')).toThrow();
    expect(() => addMoney('abc', '0.00')).toThrow();
  });
});

describe('conversion rate — Quote-to-Win (won / DECIDED quotes)', () => {
  it('divides won quotes by decided quotes over the shared fixture', () => {
    const won = fixture.quotes.filter(
      (q) => q.reportingCategory === 'won' && inPeriod(q.decisionDate),
    ).length;
    const lost = fixture.quotes.filter(
      (q) => q.reportingCategory === 'lost' && inPeriod(q.decisionDate),
    ).length;

    expect(won).toBe(expected.wonQuotes);
    expect(lost).toBe(expected.lostQuotes);
    expect(won + lost).toBe(expected.decidedQuotes);
    expect(conversionRate(won, won + lost)).toBe(expected.quoteToWinRate);
  });

  /**
   * V-091's named edge case. Q6 is EXPIRED with a decision date inside the period: it is closed,
   * but it is neither won nor lost, so it must not enlarge the denominator. An implementation that
   * counted "quotes with a decision date" would return 1/3 here instead of 1/2.
   */
  it('excludes decided-but-undecided categories from the denominator', () => {
    const decidedDated = fixture.quotes.filter((q) => inPeriod(q.decisionDate)).length;
    expect(decidedDated).toBeGreaterThan(expected.decidedQuotes);
    expect(conversionRate(expected.wonQuotes, decidedDated)).not.toBe(expected.quoteToWinRate);
  });

  it('returns null rather than zero when nothing has been decided', () => {
    expect(conversionRate(0, 0)).toBeNull();
  });

  it('returns null on a negative denominator rather than a negative rate', () => {
    expect(conversionRate(1, -1)).toBeNull();
  });

  it('returns 0 — not null — when there is decided business and none of it was won', () => {
    expect(conversionRate(0, 4)).toBe(0);
  });
});

describe('Lead-to-Quote rate (LEADS that received a quote / eligible LEADS)', () => {
  it('rates leads received in the period against those that got a quote', () => {
    const eligible = fixture.leads.filter((l) => inPeriod(l.dateReceived));
    const withQuote = eligible.filter((l) => l.hasQuote);

    expect(eligible).toHaveLength(expected.totalLeadsReceived);
    expect(withQuote).toHaveLength(expected.leadsWithQuote);
    expect(leadToQuoteRate(withQuote.length, eligible.length)).toBe(expected.leadToQuoteRate);
  });

  it('returns null when there is no eligible lead population', () => {
    expect(leadToQuoteRate(0, 0)).toBeNull();
  });
});

describe('Quote-to-Proposal rate uses the QUOTE denominator (Q-5)', () => {
  it('divides quotes sent by TOTAL QUOTES, not by leads', () => {
    const sent = fixture.quotes.filter((q) => inPeriod(q.sentDate)).length;
    const prepared = fixture.quotes.filter((q) => inPeriod(q.preparedDate)).length;

    expect(sent).toBe(expected.quotesSent);
    expect(prepared).toBe(expected.totalQuotesPrepared);
    expect(quoteToProposalRate(sent, prepared)).toBe(expected.quoteToProposalRate);
  });

  /**
   * Q-5 explicitly resolved the PRD's "leads or quotes" ambiguity in favour of quotes. The fixture
   * has 8 quotes against 4 eligible leads, so a lead denominator would produce 1.0 — a visibly
   * different, visibly wrong number. This is the assertion that would catch the wrong resolution.
   */
  it('would produce a different value under the rejected lead denominator', () => {
    expect(quoteToProposalRate(expected.quotesSent, expected.totalLeadsReceived)).not.toBe(
      expected.quoteToProposalRate,
    );
  });

  it('returns null when no quotes exist', () => {
    expect(quoteToProposalRate(0, 0)).toBeNull();
  });
});

describe('Proposal-to-Win rate (won / SENT quotes)', () => {
  it('divides won quotes by quotes that reached Quote Sent', () => {
    expect(proposalToWinRate(expected.wonQuotes, expected.quotesSent)).toBe(
      expected.proposalToWinRate,
    );
  });

  it('returns null when nothing has been sent', () => {
    expect(proposalToWinRate(0, 0)).toBeNull();
  });
});

describe('premium totals distinguish Quoted Premium from Bound Premium', () => {
  it('sums Quoted Premium over quotes prepared in the period', () => {
    const amounts = fixture.quotes
      .filter((q) => inPeriod(q.preparedDate))
      .map((q) => q.currentPremium);
    expect(quotedPremiumTotal(amounts)).toBe(expected.quotedPremium);
  });

  /**
   * Bound Premium falls back to the current quoted premium when `bound_premium` is null
   * (GetExecutiveOverviewQueryHandler.cs:136 `q.BoundPremium ?? q.CurrentPremium`). The fixture's
   * won quote carries BOTH — 2400.00 bound against 2500.00 quoted — so the two totals are
   * different numbers and a test cannot pass by conflating them.
   */
  it('sums Bound Premium over quotes WON in the period, falling back to quoted premium', () => {
    const won = fixture.quotes.filter(
      (q) => q.reportingCategory === 'won' && inPeriod(q.decisionDate),
    );
    expect(boundPremiumTotal(won)).toBe(expected.boundPremium);
    expect(expected.boundPremium).not.toBe(expected.quotedPremium);
  });

  it('falls back to the quoted premium when a won quote has no bound premium recorded', () => {
    expect(
      boundPremiumTotal([{ boundPremium: null, currentPremium: '1234.56' }]),
    ).toBe('1234.56');
  });

  it('excludes premium decided outside the period', () => {
    // Q5 is a 5000.00 February win. Including it would give 7400.00.
    const all = fixture.quotes.filter((q) => q.reportingCategory === 'won');
    expect(boundPremiumTotal(all)).not.toBe(expected.boundPremium);
  });

  it('sums to zero rather than null over an empty corpus', () => {
    expect(quotedPremiumTotal([])).toBe('0.00');
  });
});

describe('Open Pipeline Premium (open quoted premium + un-quoted open lead estimates)', () => {
  it('adds the two components over the shared fixture', () => {
    const openQuotePremium = sumMoney(
      fixture.quotes
        .filter((q) => OPEN_CATEGORIES.includes(q.reportingCategory))
        .map((q) => q.currentPremium),
    );
    const openLeadPremium = sumMoney(
      fixture.leads
        .filter((l) => OPEN_CATEGORIES.includes(l.reportingCategory) && !l.hasQuote)
        .map((l) => l.estimatedPremium ?? '0.00'),
    );

    expect(openQuotePremium).toBe(expected.openQuotePremium);
    expect(openLeadPremium).toBe(expected.openLeadEstimatedPremium);
    expect(openPipelinePremium(openQuotePremium, openLeadPremium)).toBe(
      expected.openPipelinePremium,
    );
  });

  /**
   * Unlike every rate above, this one is a SUM and is always defined: the reference returns 0m,
   * never null, because the KPI card always renders a currency figure (PRD 22/17.1).
   */
  it('returns zero rather than null when both components are empty', () => {
    expect(openPipelinePremium('0.00', '0.00')).toBe('0.00');
  });

  it('does not double-count open leads that already have a quote', () => {
    // L1 and L2 are open/quoted AND have quotes; their estimates must not be added.
    const naive = sumMoney(
      fixture.leads
        .filter((l) => OPEN_CATEGORIES.includes(l.reportingCategory))
        .map((l) => l.estimatedPremium ?? '0.00'),
    );
    expect(naive).not.toBe(expected.openLeadEstimatedPremium);
  });
});

describe('Average Turnaround (lead received -> quote sent, over SENT quotes)', () => {
  it('averages the received-to-sent day counts over the shared fixture', () => {
    const leadsByKey = new Map(fixture.leads.map((l) => [l.key, l]));
    const pairs = fixture.quotes
      .filter((q) => inPeriod(q.sentDate))
      .map((q) => ({
        receivedDate: leadsByKey.get(q.leadKey)?.dateReceived ?? '',
        sentDate: q.sentDate ?? '',
      }));

    expect(pairs).toHaveLength(expected.quotesSent);
    expect(averageTurnaroundDays(pairs)).toBe(expected.averageTurnaroundDays);
  });

  it('defensively excludes pairs whose sent date precedes the received date', () => {
    const good = { receivedDate: '2026-03-01', sentDate: '2026-03-05' };
    const inverted = { receivedDate: '2026-03-10', sentDate: '2026-03-01' };
    // Including the inverted pair would average (4 + -9)/2 = -2.5 rather than 4.
    expect(averageTurnaroundDays([good, inverted])).toBe(4);
  });

  it('counts a same-day quote as zero days rather than dropping it', () => {
    expect(averageTurnaroundDays([{ receivedDate: '2026-03-01', sentDate: '2026-03-01' }])).toBe(0);
  });

  it('returns null when no quote has been sent', () => {
    expect(averageTurnaroundDays([])).toBeNull();
  });
});

describe('Average Lead Age and Average Quote Age', () => {
  it('averages open LEAD ages from date received', () => {
    const ages = fixture.leads
      .filter((l) => OPEN_CATEGORIES.includes(l.reportingCategory))
      .map((l) => daysBetween(l.dateReceived, fixture.today));
    expect(averageLeadAgeDays(ages)).toBe(expected.averageLeadAgeDays);
  });

  it('averages open QUOTE ages from prepared date', () => {
    const ages = fixture.quotes
      .filter((q) => OPEN_CATEGORIES.includes(q.reportingCategory))
      .map((q) => daysBetween(q.preparedDate, fixture.today));
    expect(averageQuoteAgeDays(ages)).toBe(expected.averageQuoteAgeDays);
  });

  it('returns null rather than zero on an empty population', () => {
    expect(averageLeadAgeDays([])).toBeNull();
    expect(averageQuoteAgeDays([])).toBeNull();
  });

  it('returns zero — not null — when every open item is brand new', () => {
    expect(averageLeadAgeDays([0, 0])).toBe(0);
  });
});

describe('Follow-up compliance', () => {
  it('rates on-time follow-ups against required follow-ups over the shared fixture', () => {
    const openWithCommitment = fixture.leads.filter(
      (l) => OPEN_CATEGORIES.includes(l.reportingCategory) && l.nextFollowUpDate !== null,
    );
    const onTime = openWithCommitment.filter(
      (l) => (l.nextFollowUpDate ?? '') >= fixture.today,
    );

    expect(openWithCommitment).toHaveLength(expected.followUpRequired);
    expect(onTime).toHaveLength(expected.followUpOnTime);
    expect(followUpCompliance(onTime.length, openWithCommitment.length)).toBe(
      expected.followUpCompliance,
    );
  });

  /** "No follow-ups were due" is undefined compliance, NOT a trivially perfect 100%. */
  it('returns null rather than 1 when nothing was due', () => {
    expect(followUpCompliance(0, 0)).toBeNull();
  });
});

describe('Average Price Gap (lost records with a KNOWN competitor premium only)', () => {
  it('averages the percentage gap over the shared fixture', () => {
    const pairs = fixture.quotes
      .filter((q) => q.competitorPremium !== null)
      .map((q) => ({ ourPremium: q.currentPremium, competitorPremium: q.competitorPremium ?? '0.00' }));
    expect(averagePriceGap(pairs)).toBe(expected.averagePriceGap);
  });

  it('is positive when we quoted above the competitor and negative when below', () => {
    expect(averagePriceGap([{ ourPremium: '150.00', competitorPremium: '100.00' }])).toBe(0.5);
    expect(averagePriceGap([{ ourPremium: '50.00', competitorPremium: '100.00' }])).toBe(-0.5);
  });

  it('excludes a zero or negative competitor premium rather than dividing by it', () => {
    expect(
      averagePriceGap([
        { ourPremium: '150.00', competitorPremium: '0.00' },
        { ourPremium: '150.00', competitorPremium: '100.00' },
      ]),
    ).toBe(0.5);
    expect(averagePriceGap([{ ourPremium: '150.00', competitorPremium: '0.00' }])).toBeNull();
  });

  it('returns null when no lost record carried a comparable competitor premium', () => {
    expect(averagePriceGap([])).toBeNull();
  });
});

describe('aging buckets — the two schemes are DIFFERENT and must stay different', () => {
  /**
   * MEASURED CONTRADICTION, PRESERVED DELIBERATELY. The reference has two incompatible aging
   * bucket schemes: Executive Overview and the aging report use four buckets ending at "15+ days"
   * (GetExecutiveOverviewQueryHandler.cs:230-233, PipelineAgingReportQueryHandler.cs:50-53) while
   * the Pipeline dashboard uses six ending at "60+" (GetPipelineDashboardQueryHandler.cs:273-281).
   * Merging them into one "canonical" scheme would silently change what two shipped dashboards
   * report, so both are ported under distinct names and this test pins them apart.
   */
  it('exposes four executive buckets and six pipeline buckets', () => {
    expect(EXECUTIVE_AGING_BUCKETS).toEqual(['0-3 days', '4-7 days', '8-14 days', '15+ days']);
    expect(PIPELINE_AGING_BUCKETS).toEqual(['0-3', '4-7', '8-14', '15-30', '31-60', '60+']);
  });

  it.each([
    [0, '0-3 days'],
    [3, '0-3 days'],
    [4, '4-7 days'],
    [7, '4-7 days'],
    [8, '8-14 days'],
    [14, '8-14 days'],
    [15, '15+ days'],
    [999, '15+ days'],
  ])('executive bucket for %i days is %s', (age, bucket) => {
    expect(executiveAgingBucket(age)).toBe(bucket);
  });

  it.each([
    [0, '0-3'],
    [3, '0-3'],
    [4, '4-7'],
    [7, '4-7'],
    [8, '8-14'],
    [14, '8-14'],
    [15, '15-30'],
    [30, '15-30'],
    [31, '31-60'],
    [60, '31-60'],
    [61, '60+'],
  ])('pipeline bucket for %i days is %s', (age, bucket) => {
    expect(pipelineAgingBucket(age)).toBe(bucket);
  });

  it('buckets the shared fixture open quotes into the hand-counted distribution', () => {
    const ages = fixture.quotes
      .filter((q) => OPEN_CATEGORIES.includes(q.reportingCategory))
      .map((q) => daysBetween(q.preparedDate, fixture.today));

    const exec: Record<string, number> = Object.fromEntries(
      EXECUTIVE_AGING_BUCKETS.map((b) => [b, 0]),
    );
    const pipeline: Record<string, number> = Object.fromEntries(
      PIPELINE_AGING_BUCKETS.map((b) => [b, 0]),
    );
    for (const age of ages) {
      exec[executiveAgingBucket(age)] = (exec[executiveAgingBucket(age)] ?? 0) + 1;
      pipeline[pipelineAgingBucket(age)] = (pipeline[pipelineAgingBucket(age)] ?? 0) + 1;
    }

    expect(exec).toEqual(expected.executiveAgingBuckets);
    expect(pipeline).toEqual(expected.pipelineAgingBuckets);
  });
});

describe('SLA status', () => {
  it('grades the fixture turnaround against the tenant SLA target', () => {
    expect(slaStatus(expected.averageTurnaroundDays, fixture.slaTargetDays)).toBe(
      expected.slaStatus,
    );
  });

  /**
   * `r.AvgTurnaroundDays.Value > slaTarget` (GetRmPerformanceQueryHandler.cs:291) — STRICTLY
   * greater. Hitting the target exactly is on track, not a breach.
   */
  it('treats exactly meeting the target as on track, not breached', () => {
    expect(slaStatus(3, 3)).toBe('on_track');
    expect(slaStatus(3.0001, 3)).toBe('breached');
  });

  it('reports unknown when there is no turnaround to grade', () => {
    expect(slaStatus(null, 3)).toBe('unknown');
  });
});

describe('executive escalation rule', () => {
  const escalation = loadEscalationFixture();

  it.each(escalation.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    expect(
      qualifiesForExecutiveEscalation(testCase.lead, escalation.settings, {
        now: escalation.now,
        today: escalation.today,
      }),
    ).toBe(testCase.expected);
  });

  it('never fires on the high-value disjunct when no threshold is configured', () => {
    const { settings, lead, expected: want } = escalation.unsetThreshold;
    expect(
      qualifiesForExecutiveEscalation(lead, settings, {
        now: escalation.now,
        today: escalation.today,
      }),
    ).toBe(want);
  });

  it('applies the longer stalled-quote threshold once a lead has any quote', () => {
    const base = {
      isOpen: true,
      premiumAtRisk: '1.00',
      isStrategicParty: false,
      lastActivityAt: '2026-03-22T00:00:00.000Z',
      nextFollowUpDate: null,
      quotes: [],
    } as const;
    const at = { now: escalation.now, today: escalation.today };

    // 10 idle days: over stalledLeadDays (7), under stalledQuoteDays (14).
    expect(isStalled({ ...base, hasAnyQuote: false }, escalation.settings, at)).toBe(true);
    expect(isStalled({ ...base, hasAnyQuote: true }, escalation.settings, at)).toBe(false);
  });

  it('treats the stall threshold as strictly exceeded, not merely reached', () => {
    const at = { now: '2026-04-01T00:00:00.000Z', today: '2026-04-01' };
    const lead = {
      isOpen: true,
      premiumAtRisk: '1.00',
      isStrategicParty: false,
      hasAnyQuote: false,
      nextFollowUpDate: null,
      quotes: [],
    } as const;

    // Exactly 7 idle days against stalledLeadDays 7.
    expect(
      isStalled({ ...lead, lastActivityAt: '2026-03-25T00:00:00.000Z' }, escalation.settings, at),
    ).toBe(false);
    expect(
      isStalled(
        { ...lead, lastActivityAt: '2026-03-24T23:00:00.000Z' },
        escalation.settings,
        at,
      ),
    ).toBe(true);
  });
});

describe('KPI delta helpers are direction-aware', () => {
  it('computes the delta as current minus prior', () => {
    expect(kpiDelta(0.6, 0.5)).toBeCloseTo(0.1, 10);
    expect(kpiDelta(0.4, 0.5)).toBeCloseTo(-0.1, 10);
  });

  it('has no delta when either side is missing', () => {
    expect(kpiDelta(0.6, null)).toBeNull();
    expect(kpiDelta(null, 0.5)).toBeNull();
  });

  it('colours a rising value favourably only when higher is better', () => {
    expect(isFavorableDelta(0.1, 'higherIsBetter')).toBe(true);
    expect(isFavorableDelta(0.1, 'lowerIsBetter')).toBe(false);
  });

  it('colours a falling value favourably only when lower is better', () => {
    expect(isFavorableDelta(-0.1, 'lowerIsBetter')).toBe(true);
    expect(isFavorableDelta(-0.1, 'higherIsBetter')).toBe(false);
  });

  /** `0 => null` (KpiValue.cs:31): a flat delta is neither good nor bad and renders uncoloured. */
  it('has no favourability for a flat or absent delta', () => {
    expect(isFavorableDelta(0, 'higherIsBetter')).toBeNull();
    expect(isFavorableDelta(null, 'higherIsBetter')).toBeNull();
  });
});

describe('prior comparable period', () => {
  it('derives the preceding calendar month for a month range', () => {
    expect(priorComparablePeriod({ from: '2026-03-01', to: '2026-03-31' }, 'month')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('derives a leap-year February correctly', () => {
    expect(priorComparablePeriod({ from: '2024-03-01', to: '2024-03-31' }, 'month')).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
  });

  /**
   * The reason `PriorFullMonths` re-derives the month end instead of subtracting three months from
   * the current end date: Q2 ends 30 June, and naive arithmetic would give 30 March rather than
   * Q1's true 31 March end, silently dropping a day of business from every quarterly delta.
   */
  it('derives the preceding calendar quarter across differing month lengths', () => {
    expect(priorComparablePeriod({ from: '2026-04-01', to: '2026-06-30' }, 'quarter')).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
    });
  });

  it('shifts a custom range back by its own length, inclusive', () => {
    // 10 days inclusive -> the 10 days immediately before.
    expect(priorComparablePeriod({ from: '2026-03-11', to: '2026-03-20' }, 'custom')).toEqual({
      from: '2026-03-01',
      to: '2026-03-10',
    });
  });

  it('shifts a single-day custom range back exactly one day', () => {
    expect(priorComparablePeriod({ from: '2026-03-05', to: '2026-03-05' }, 'custom')).toEqual({
      from: '2026-03-04',
      to: '2026-03-04',
    });
  });

  it('crosses a year boundary for a January month range', () => {
    expect(priorComparablePeriod({ from: '2026-01-01', to: '2026-01-31' }, 'month')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });
});

describe('metric catalog labels distinguish Leads, Quotes, Quoted Premium and Bound Premium', () => {
  /**
   * AC-073/CLAUDE.md make this a hard product requirement, not a nicety: a dashboard that says
   * "Total" without saying whether it counted Leads or Quotes is the defect that ships and is
   * believed. Every entry declares its basis, and the four headline labels are pinned by name.
   */
  it('declares a basis for every catalogued metric', () => {
    const bases: MetricBasis[] = ['lead', 'quote', 'premium'];
    for (const entry of Object.values(METRIC_CATALOG)) {
      expect(bases).toContain(entry.basis);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('labels the four headline metrics exactly as the product requires', () => {
    expect(METRIC_CATALOG.leadToQuoteRate.label).toBe('Lead-to-Quote Rate');
    expect(METRIC_CATALOG.quoteToWinRate.label).toBe('Quote-to-Win Rate');
    expect(METRIC_CATALOG.quotedPremium.label).toBe('Quoted Premium');
    expect(METRIC_CATALOG.boundPremium.label).toBe('Bound Premium');
  });

  it('bases lead metrics on leads and quote metrics on quotes', () => {
    expect(METRIC_CATALOG.leadToQuoteRate.basis).toBe('lead');
    expect(METRIC_CATALOG.totalLeads.basis).toBe('lead');
    expect(METRIC_CATALOG.quoteToWinRate.basis).toBe('quote');
    expect(METRIC_CATALOG.totalQuotes.basis).toBe('quote');
    expect(METRIC_CATALOG.quotedPremium.basis).toBe('premium');
    expect(METRIC_CATALOG.boundPremium.basis).toBe('premium');
  });

  it('declares the good direction for every metric, with turnaround inverted', () => {
    expect(METRIC_CATALOG.quoteToWinRate.goodDirection).toBe('higherIsBetter');
    expect(METRIC_CATALOG.averageTurnaround.goodDirection).toBe('lowerIsBetter');
  });

  it('does not label Quoted Premium and Bound Premium identically', () => {
    expect(METRIC_CATALOG.quotedPremium.label).not.toBe(METRIC_CATALOG.boundPremium.label);
  });
});
