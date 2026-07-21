/**
 * The three pure rule modules the Broker/RM dashboards delegate to (T-037; AC-078, AC-080).
 *
 * Ports of `QuoteIQ.Domain/Metrics/QuadrantClassifier.cs`,
 * `QuoteIQ.Domain/Dashboards/SuggestedActionRule.cs` and
 * `QuoteIQ.Domain/Dashboards/LeadershipInsightRules.cs`.
 *
 * These are unit-tested here rather than only through the dashboards because every one of them is a
 * BOUNDARY rule: median-inclusive "high", strictly-greater "beyond target", null-conversion-is-low.
 * Each of those has a wrong neighbour one character away, and a dashboard assertion over seeded data
 * exercises exactly one point per axis — it cannot see that `>=` became `>`.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyQuadrant,
  median,
  type PerformanceQuadrant,
} from '../../domains/dashboards/quadrant.js';
import {
  SUGGESTED_ACTIONS,
  evaluateSuggestedAction,
  suggestedActionLabel,
  suggestedActionTone,
  type PerformanceProfile,
} from '../../domains/dashboards/suggested-action.js';
import {
  generateLeadershipInsights,
  type InsightSubject,
} from '../../domains/dashboards/insights.js';

describe('median (QuadrantClassifier.Median)', () => {
  it('returns 0 for an empty population so an axis with no data collapses low rather than throwing', () => {
    expect(median([])).toBe(0);
  });

  it('returns the middle value for an odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('returns the mean of the two middle values for an even count', () => {
    expect(median([1, 3, 5, 11])).toBe(4);
  });

  it('orders numerically, not lexically', () => {
    expect(median([9, 10, 100])).toBe(10);
  });
});

describe('classifyQuadrant (QuadrantClassifier.Classify)', () => {
  const cases: ReadonlyArray<[number, number | null, PerformanceQuadrant]> = [
    [10, 0.6, 'high-high'],
    [10, 0.4, 'high-low'],
    [2, 0.6, 'low-high'],
    [2, 0.4, 'low-low'],
  ];

  it.each(cases)('volume %s / conversion %s classifies as %s', (volume, conversion, expected) => {
    expect(classifyQuadrant(volume, conversion, 5, 0.5)).toBe(expected);
  });

  it('treats a value exactly ON its split as HIGH on both axes (inclusive boundary)', () => {
    expect(classifyQuadrant(5, 0.5, 5, 0.5)).toBe('high-high');
  });

  it('treats a null conversion as LOW — an undecided broker is not a high-conversion partner', () => {
    expect(classifyQuadrant(10, null, 5, 0)).toBe('high-low');
  });
});

describe('evaluateSuggestedAction (SuggestedActionRule.Evaluate)', () => {
  const base: PerformanceProfile = {
    conversion: 0.8,
    conversionMedian: 0.5,
    volume: 10,
    volumeMedian: 5,
    wonPremium: '1000.00',
    wonPremiumMedian: '500.00',
    avgTurnaroundDays: 2,
    turnaroundTargetDays: 3,
    overdueFollowUps: 0,
  };

  it('recognizes a star that also out-bills the median', () => {
    expect(evaluateSuggestedAction(base)).toBe('recognizeAndRetain');
  });

  it('says maintain momentum for a strong converter billing below the premium median', () => {
    expect(evaluateSuggestedAction({ ...base, wonPremium: '100.00' })).toBe('maintainMomentum');
  });

  it('says deepen engagement when a star has any overdue follow-up', () => {
    expect(evaluateSuggestedAction({ ...base, overdueFollowUps: 1 })).toBe('deepenEngagement');
  });

  it('says deepen engagement when a star is beyond the turnaround target', () => {
    expect(evaluateSuggestedAction({ ...base, avgTurnaroundDays: 4 })).toBe('deepenEngagement');
  });

  it('treats turnaround EXACTLY at the target as within target (strictly greater is a breach)', () => {
    expect(evaluateSuggestedAction({ ...base, avgTurnaroundDays: 3 })).toBe('recognizeAndRetain');
  });

  it('says provide more leads for an efficient converter below the volume median', () => {
    expect(evaluateSuggestedAction({ ...base, volume: 1 })).toBe('provideMoreLeads');
  });

  it('says coach and support for high volume with weak conversion', () => {
    expect(evaluateSuggestedAction({ ...base, conversion: 0.1 })).toBe('coachAndSupport');
  });

  it('says review relationship for weak conversion AND weak volume', () => {
    expect(evaluateSuggestedAction({ ...base, conversion: 0.1, volume: 1 })).toBe(
      'reviewRelationship',
    );
  });

  it('escalates weak conversion once overdue follow-ups reach the threshold of 3', () => {
    expect(evaluateSuggestedAction({ ...base, conversion: 0.1, overdueFollowUps: 3 })).toBe(
      'escalateAndIntervene',
    );
  });

  it('does NOT escalate at two overdue follow-ups without a turnaround breach', () => {
    expect(evaluateSuggestedAction({ ...base, conversion: 0.1, overdueFollowUps: 2 })).toBe(
      'coachAndSupport',
    );
  });

  it('escalates weak conversion on a turnaround breach combined with any overdue follow-up', () => {
    expect(
      evaluateSuggestedAction({
        ...base,
        conversion: 0.1,
        avgTurnaroundDays: 9,
        overdueFollowUps: 1,
      }),
    ).toBe('escalateAndIntervene');
  });

  it('treats a null conversion (nothing decided) as weak conversion', () => {
    expect(evaluateSuggestedAction({ ...base, conversion: null })).toBe('coachAndSupport');
  });

  it('treats a conversion exactly ON the median as strong (inclusive, matching the quadrant rule)', () => {
    expect(evaluateSuggestedAction({ ...base, conversion: 0.5 })).toBe('recognizeAndRetain');
  });

  it('gives every action a label and a chip tone', () => {
    for (const action of SUGGESTED_ACTIONS) {
      expect(suggestedActionLabel(action).length).toBeGreaterThan(0);
      expect(suggestedActionTone(action).length).toBeGreaterThan(0);
    }
  });

  it('maps the escalation action to the danger chip tone', () => {
    expect(suggestedActionTone('escalateAndIntervene')).toBe('danger');
    expect(suggestedActionLabel('escalateAndIntervene')).toBe('Escalate and intervene');
  });
});

describe('generateLeadershipInsights (LeadershipInsightRules.Generate)', () => {
  const rm = (over: Partial<InsightSubject> & { name: string }): InsightSubject => ({
    conversion: 0.5,
    volume: 4,
    wonPremium: '1000.00',
    avgTurnaroundDays: 2,
    overdueFollowUps: 0,
    openPipelinePremium: '0.00',
    ...over,
  });

  it('emits the five insights in a stable type order when every population is present', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', openPipelinePremium: '7000.00' })],
      brokers: [rm({ name: 'Brokerage', wonPremium: '9000.00' })],
      turnaroundTargetDays: 3,
      followUpCompliance: 0.5,
      currencyCode: 'USD',
    });

    expect(insights.map((insight) => insight.type)).toEqual([
      'topPerformingBroker',
      'underperformingRm',
      'turnaroundAtRisk',
      'followUpCompliance',
      'largestPremiumOpportunity',
    ]);
  });

  it('omits the top-broker insight when no broker has won any premium', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana' })],
      brokers: [rm({ name: 'Brokerage', wonPremium: '0.00' })],
      turnaroundTargetDays: 3,
      followUpCompliance: null,
      currencyCode: 'USD',
    });

    expect(insights.map((insight) => insight.type)).not.toContain('topPerformingBroker');
  });

  it('always emits follow-up compliance, and says nothing was due when it is null', () => {
    const insights = generateLeadershipInsights({
      rms: [],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: null,
      currencyCode: 'USD',
    });

    expect(insights).toHaveLength(1);
    expect(insights[0]?.type).toBe('followUpCompliance');
    expect(insights[0]?.narrative).toBe('No follow-ups were due in this period.');
  });

  it('picks the weakest converter as the underperforming RM', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', conversion: 0.9 }), rm({ name: 'Bo', conversion: 0.1 })],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: 1,
      currencyCode: 'USD',
    });

    const underperformer = insights.find((insight) => insight.type === 'underperformingRm');
    expect(underperformer?.headline).toBe('Underperforming RM: Bo');
    expect(underperformer?.narrative).toBe(
      'Bo has the lowest conversion at 10.0% with 0 overdue follow-up(s).',
    );
  });

  it('ranks an RM with NO decided business last, not first, on the underperformer axis', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', conversion: null }), rm({ name: 'Bo', conversion: 0.1 })],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: 1,
      currencyCode: 'USD',
    });

    expect(insights.find((insight) => insight.type === 'underperformingRm')?.headline).toBe(
      'Underperforming RM: Bo',
    );
  });

  it('states the SLA breach explicitly when the slowest RM is beyond the target', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', avgTurnaroundDays: 9 })],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: 1,
      currencyCode: 'USD',
    });

    expect(insights.find((insight) => insight.type === 'turnaroundAtRisk')?.narrative).toBe(
      'Ana averages 9.0 days to quote, over the 3.0-day SLA target.',
    );
  });

  it('says the slowest RM is still WITHIN target when they are, rather than crying breach', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', avgTurnaroundDays: 3 })],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: 1,
      currencyCode: 'USD',
    });

    expect(insights.find((insight) => insight.type === 'turnaroundAtRisk')?.narrative).toBe(
      'Ana has the slowest turnaround at 3.0 days, within the 3.0-day SLA target.',
    );
  });

  it('omits turnaround-at-risk entirely when no RM has sent a quote', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', avgTurnaroundDays: null })],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: 1,
      currencyCode: 'USD',
    });

    expect(insights.map((insight) => insight.type)).not.toContain('turnaroundAtRisk');
  });

  it('formats premium with the tenant currency code and no decimals', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', openPipelinePremium: '12345.67' })],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: 1,
      currencyCode: 'KES',
    });

    expect(insights.find((insight) => insight.type === 'largestPremiumOpportunity')?.narrative).toBe(
      'Ana is working KES 12,346 of open pipeline premium.',
    );
  });

  it('omits the opportunity insight when no RM has any open pipeline premium', () => {
    const insights = generateLeadershipInsights({
      rms: [rm({ name: 'Ana', openPipelinePremium: '0.00' })],
      brokers: [],
      turnaroundTargetDays: 3,
      followUpCompliance: 1,
      currencyCode: 'USD',
    });

    expect(insights.map((insight) => insight.type)).not.toContain('largestPremiumOpportunity');
  });
});
