/**
 * The eleven alert rule predicates (T-033; AC-069; V-086).
 *
 * Port of `src/api/tests/QuoteIQ.Domain.Tests/Alerts/AlertRuleTests.cs`, and deliberately the same
 * shape: plain fixtures, no database, one describe per rule, and a TRIGGER and a NON-TRIGGER case
 * for every predicate plus its threshold boundary.
 *
 * WHY THE BOUNDARIES ARE PINNED INDIVIDUALLY
 * ==========================================
 * Every one of these rules is a comparison against a tenant-configured threshold, and the reference
 * uses STRICT comparison everywhere ("strictly exceeds", `>` not `>=`). An off-by-one here does not
 * crash and does not look wrong: it raises alerts a day early or a day late, forever, for every
 * tenant. So each rule is tested at exactly-the-threshold (must NOT fire) as well as just past it.
 *
 * EXPECTATIONS ARE COMPUTED INDEPENDENTLY OF THE IMPLEMENTATION
 * ============================================================
 * Fixtures are built from `now` minus a literal number of days/hours and the expected candidate set
 * is written out by hand, so a test cannot pass by echoing the same helper the rule used.
 */
import { describe, expect, it } from 'vitest';

import { ALERT_RULES, evaluateAllRules, ruleFor } from '../../domains/alerts/rules/index.js';
import {
  ALERT_TYPES,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertThresholds,
  type LeadAlertSnapshot,
  type QuoteAlertSnapshot,
} from '../../domains/alerts/rules/types.js';

/** A fixed evaluation instant. `today` is its UTC date, exactly as the context builder derives it. */
const NOW = new Date('2026-07-20T12:00:00.000Z');
const TODAY = '2026-07-20';

const THRESHOLDS: AlertThresholds = {
  unassignedLeadHours: 24,
  stalledLeadDays: 7,
  stalledQuoteDays: 5,
  quoteExpiryAlertDays: 7,
  pricingApprovalTargetDays: 3,
  slaAssignmentDays: 1,
  slaUnderwritingDays: 3,
  slaReceivedToSentDays: 5,
  highValueThreshold: '1000000.00',
};

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

/** `yyyy-MM-dd`, `offsetDays` from TODAY (negative = in the past). */
function dateOffset(offsetDays: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function quote(overrides: Partial<QuoteAlertSnapshot> = {}): QuoteAlertSnapshot {
  return {
    quoteId: 900,
    leadId: 100,
    reportingCategory: 'quoted',
    validUntil: null,
    quotedPremium: '250000.00',
    ...overrides,
  };
}

function lead(overrides: Partial<LeadAlertSnapshot> = {}): LeadAlertSnapshot {
  return {
    leadId: 100,
    statusCanonicalKey: 'assigned',
    reportingCategory: 'open',
    createdAt: daysAgo(1),
    lastActivityAt: daysAgo(1),
    nextFollowUpDate: null,
    pricingApprovalState: 'none',
    pricingPendingSince: null,
    underwritingEnteredAt: null,
    estimatedPremium: null,
    isStrategicParty: false,
    quotes: [],
    ...overrides,
  };
}

function contextOf(
  leads: readonly LeadAlertSnapshot[],
  thresholds: Partial<AlertThresholds> = {},
): AlertEvaluationContext {
  return {
    thresholds: { ...THRESHOLDS, ...thresholds },
    today: TODAY,
    now: NOW,
    leads,
  };
}

/** Runs ONE rule and returns its candidates. */
function run(
  type: (typeof ALERT_TYPES)[number],
  leads: readonly LeadAlertSnapshot[],
  thresholds: Partial<AlertThresholds> = {},
): readonly AlertCandidate[] {
  return ruleFor(type).evaluate(contextOf(leads, thresholds));
}

describe('the rule catalog', () => {
  it('contains exactly one rule per alert type, in the reference order', () => {
    expect(ALERT_RULES.map((rule) => rule.type)).toEqual([...ALERT_TYPES]);
  });

  it('has eleven rules (the fixed alerts_type_check set)', () => {
    expect(ALERT_RULES).toHaveLength(11);
    expect(ALERT_TYPES).toHaveLength(11);
  });

  it('evaluateAllRules returns the union of every rule s candidates', () => {
    // One lead that trips exactly two rules: overdue follow-up and stalled lead.
    const subject = lead({
      lastActivityAt: daysAgo(30),
      nextFollowUpDate: dateOffset(-3),
      createdAt: daysAgo(30),
      statusCanonicalKey: 'assigned',
    });

    const types = evaluateAllRules(contextOf([subject]))
      .map((candidate) => candidate.type)
      .sort();

    // sla_breach also fires: no quote yet and age 30d > slaReceivedToSentDays 5.
    expect(types).toEqual(['overdue_follow_up', 'sla_breach', 'stalled_lead']);
  });
});

// -----------------------------------------------------------------------------------------------
// unassigned_lead — UnassignedLeadRule.cs
// -----------------------------------------------------------------------------------------------

describe('unassigned_lead', () => {
  const newLead = (overrides: Partial<LeadAlertSnapshot> = {}): LeadAlertSnapshot =>
    lead({ statusCanonicalKey: 'new', ...overrides });

  it('fires for a new lead older than the unassigned-hours threshold', () => {
    expect(run('unassigned_lead', [newLead({ createdAt: hoursAgo(25) })])).toEqual([
      {
        type: 'unassigned_lead',
        leadId: 100,
        quoteId: null,
        severity: 'warning',
        premiumAtRisk: null,
      },
    ]);
  });

  it('does not fire exactly AT the threshold (the comparison is strict)', () => {
    expect(run('unassigned_lead', [newLead({ createdAt: hoursAgo(24) })])).toEqual([]);
  });

  it('does not fire for a lead that has left the new status', () => {
    expect(
      run('unassigned_lead', [newLead({ statusCanonicalKey: 'assigned', createdAt: hoursAgo(99) })]),
    ).toEqual([]);
  });

  it('does not fire for a closed lead however old', () => {
    expect(
      run('unassigned_lead', [
        newLead({ createdAt: hoursAgo(999), reportingCategory: 'lost' }),
      ]),
    ).toEqual([]);
  });

  it('carries the lead premium-at-risk, preferring the intake estimate over quoted premium', () => {
    const candidates = run('unassigned_lead', [
      newLead({
        createdAt: hoursAgo(48),
        estimatedPremium: '4321.00',
        quotes: [quote({ quotedPremium: '999999.00' })],
      }),
    ]);
    expect(candidates[0]?.premiumAtRisk).toBe('4321.00');
  });

  it('falls back to the HIGHEST quoted premium when there is no intake estimate', () => {
    const candidates = run('unassigned_lead', [
      newLead({
        createdAt: hoursAgo(48),
        quotes: [
          quote({ quoteId: 1, quotedPremium: '900.00' }),
          quote({ quoteId: 2, quotedPremium: '1100.00' }),
          quote({ quoteId: 3, quotedPremium: '1000.00' }),
        ],
      }),
    ]);
    // Exact-cent comparison, not lexicographic: '900.00' must not beat '1100.00'.
    expect(candidates[0]?.premiumAtRisk).toBe('1100.00');
  });
});

// -----------------------------------------------------------------------------------------------
// overdue_follow_up — OverdueFollowUpRule.cs
// -----------------------------------------------------------------------------------------------

describe('overdue_follow_up', () => {
  it('fires when the next follow-up date is in the past', () => {
    expect(run('overdue_follow_up', [lead({ nextFollowUpDate: dateOffset(-1) })])).toEqual([
      {
        type: 'overdue_follow_up',
        leadId: 100,
        quoteId: null,
        severity: 'warning',
        premiumAtRisk: null,
      },
    ]);
  });

  it('does not fire when the follow-up is due TODAY', () => {
    expect(run('overdue_follow_up', [lead({ nextFollowUpDate: TODAY })])).toEqual([]);
  });

  it('does not fire when there is no follow-up date at all', () => {
    expect(run('overdue_follow_up', [lead({ nextFollowUpDate: null })])).toEqual([]);
  });

  it('does not fire on a closed lead', () => {
    expect(
      run('overdue_follow_up', [
        lead({ nextFollowUpDate: dateOffset(-30), reportingCategory: 'won' }),
      ]),
    ).toEqual([]);
  });

  it('ignores followUpOverdueGraceDays, exactly as the reference does', () => {
    // MEASURED CONTRADICTION, RECORDED RATHER THAN INVENTED: tenant_settings carries
    // follow_up_overdue_grace_days, and OverdueFollowUpRule.cs:12-19 never reads it — the predicate
    // is a bare `NextFollowUpDate < Today`. Adding the grace here would change every tenant's alert
    // set relative to the system being replaced, so the port keeps the reference behaviour and the
    // task file flags the unused setting.
    expect(run('overdue_follow_up', [lead({ nextFollowUpDate: dateOffset(-1) })])).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
// stalled_lead — StalledLeadRule.cs
// -----------------------------------------------------------------------------------------------

describe('stalled_lead', () => {
  it('fires for an open, quote-less lead idle beyond stalledLeadDays', () => {
    expect(run('stalled_lead', [lead({ lastActivityAt: daysAgo(8) })])).toEqual([
      { type: 'stalled_lead', leadId: 100, quoteId: null, severity: 'warning', premiumAtRisk: null },
    ]);
  });

  it('does not fire exactly AT stalledLeadDays', () => {
    expect(run('stalled_lead', [lead({ lastActivityAt: daysAgo(7) })])).toEqual([]);
  });

  it('does not fire once the lead has a quote (that is stalled_quote s population)', () => {
    expect(
      run('stalled_lead', [lead({ lastActivityAt: daysAgo(90), quotes: [quote()] })]),
    ).toEqual([]);
  });

  it('does not fire for a lead with no activity timestamp at all', () => {
    expect(run('stalled_lead', [lead({ lastActivityAt: null })])).toEqual([]);
  });

  it('does not fire on a closed lead', () => {
    expect(
      run('stalled_lead', [lead({ lastActivityAt: daysAgo(90), reportingCategory: 'expired' })]),
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// stalled_quote — StalledQuoteRule.cs
// -----------------------------------------------------------------------------------------------

describe('stalled_quote', () => {
  it('fires once per OPEN quote, keyed by the parent lead s last activity', () => {
    const candidates = run('stalled_quote', [
      lead({
        lastActivityAt: daysAgo(6),
        quotes: [
          quote({ quoteId: 11, quotedPremium: '100.00' }),
          quote({ quoteId: 12, quotedPremium: '200.00' }),
          quote({ quoteId: 13, reportingCategory: 'lost' }),
        ],
      }),
    ]);

    expect(candidates).toEqual([
      {
        type: 'stalled_quote',
        leadId: 100,
        quoteId: 11,
        severity: 'warning',
        premiumAtRisk: '100.00',
      },
      {
        type: 'stalled_quote',
        leadId: 100,
        quoteId: 12,
        severity: 'warning',
        premiumAtRisk: '200.00',
      },
    ]);
  });

  it('does not fire exactly AT stalledQuoteDays', () => {
    expect(run('stalled_quote', [lead({ lastActivityAt: daysAgo(5), quotes: [quote()] })])).toEqual(
      [],
    );
  });

  it('carries the QUOTE s premium, not the lead s estimate', () => {
    const candidates = run('stalled_quote', [
      lead({
        lastActivityAt: daysAgo(30),
        estimatedPremium: '5.00',
        quotes: [quote({ quotedPremium: '777.00' })],
      }),
    ]);
    expect(candidates[0]?.premiumAtRisk).toBe('777.00');
  });

  it('still fires on a CLOSED lead with an open quote, matching the reference', () => {
    // MEASURED: StalledQuoteRule.cs:16-25 has no `lead.IsOpen` filter, unlike every other
    // lead-level rule. Quote openness alone gates it. Pinned so a later "tidy-up" that adds the
    // missing-looking filter has to change this test deliberately.
    expect(
      run('stalled_quote', [
        lead({ reportingCategory: 'lost', lastActivityAt: daysAgo(30), quotes: [quote()] }),
      ]),
    ).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
// quote_expiring — QuoteExpiringRule.cs
// -----------------------------------------------------------------------------------------------

describe('quote_expiring', () => {
  it('fires for an open quote expiring within the threshold', () => {
    expect(
      run('quote_expiring', [lead({ quotes: [quote({ quoteId: 21, validUntil: dateOffset(3) })] })]),
    ).toEqual([
      {
        type: 'quote_expiring',
        leadId: 100,
        quoteId: 21,
        severity: 'warning',
        premiumAtRisk: '250000.00',
      },
    ]);
  });

  it('fires exactly AT the threshold (this comparison is inclusive, unlike the day thresholds)', () => {
    expect(
      run('quote_expiring', [lead({ quotes: [quote({ validUntil: dateOffset(7) })] })]),
    ).toHaveLength(1);
  });

  it('does not fire one day beyond the threshold', () => {
    expect(run('quote_expiring', [lead({ quotes: [quote({ validUntil: dateOffset(8) })] })])).toEqual(
      [],
    );
  });

  it('fires when the quote expires TODAY (not yet in the past)', () => {
    expect(run('quote_expiring', [lead({ quotes: [quote({ validUntil: TODAY })] })])).toHaveLength(
      1,
    );
  });

  it('does not fire once the date has passed (that is quote_expired s population)', () => {
    expect(
      run('quote_expiring', [lead({ quotes: [quote({ validUntil: dateOffset(-1) })] })]),
    ).toEqual([]);
  });

  it('does not fire for a closed quote', () => {
    expect(
      run('quote_expiring', [
        lead({ quotes: [quote({ validUntil: dateOffset(1), reportingCategory: 'won' })] }),
      ]),
    ).toEqual([]);
  });

  it('does not fire for a quote with no validity date', () => {
    expect(run('quote_expiring', [lead({ quotes: [quote({ validUntil: null })] })])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// quote_expired — QuoteExpiredRule.cs
// -----------------------------------------------------------------------------------------------

describe('quote_expired', () => {
  it('fires for an open quote whose validity date has passed, at critical severity', () => {
    expect(
      run('quote_expired', [lead({ quotes: [quote({ quoteId: 31, validUntil: dateOffset(-1) })] })]),
    ).toEqual([
      {
        type: 'quote_expired',
        leadId: 100,
        quoteId: 31,
        severity: 'critical',
        premiumAtRisk: '250000.00',
      },
    ]);
  });

  it('does not fire on the expiry day itself', () => {
    expect(run('quote_expired', [lead({ quotes: [quote({ validUntil: TODAY })] })])).toEqual([]);
  });

  it('does not fire for a closed quote', () => {
    expect(
      run('quote_expired', [
        lead({ quotes: [quote({ validUntil: dateOffset(-30), reportingCategory: 'expired' })] }),
      ]),
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// sla_breach — SlaBreachRule.cs
// -----------------------------------------------------------------------------------------------

describe('sla_breach', () => {
  it('fires on the assignment leg: a new lead older than slaAssignmentDays', () => {
    expect(
      run('sla_breach', [
        // Quote present so the received-to-sent leg cannot be what fires.
        lead({ statusCanonicalKey: 'new', createdAt: daysAgo(2), quotes: [quote()] }),
      ]),
    ).toEqual([
      {
        type: 'sla_breach',
        leadId: 100,
        quoteId: null,
        severity: 'critical',
        // No intake estimate, so premium-at-risk falls back to the highest quoted premium — which
        // is the fixture quote's 250000.00, not null.
        premiumAtRisk: '250000.00',
      },
    ]);
  });

  it('does not fire on the assignment leg exactly AT slaAssignmentDays', () => {
    expect(
      run('sla_breach', [
        lead({ statusCanonicalKey: 'new', createdAt: daysAgo(1), quotes: [quote()] }),
      ]),
    ).toEqual([]);
  });

  it('fires on the received-to-sent leg: no quote yet, older than slaReceivedToSentDays', () => {
    expect(
      run('sla_breach', [
        lead({ statusCanonicalKey: 'assigned', createdAt: daysAgo(6), quotes: [] }),
      ]),
    ).toHaveLength(1);
  });

  it('does not fire on the received-to-sent leg exactly AT slaReceivedToSentDays', () => {
    expect(
      run('sla_breach', [
        lead({ statusCanonicalKey: 'assigned', createdAt: daysAgo(5), quotes: [] }),
      ]),
    ).toEqual([]);
  });

  it('emits ONE candidate when both legs breach, never two', () => {
    expect(
      run('sla_breach', [lead({ statusCanonicalKey: 'new', createdAt: daysAgo(90), quotes: [] })]),
    ).toHaveLength(1);
  });

  it('does not fire on a closed lead', () => {
    expect(
      run('sla_breach', [
        lead({ statusCanonicalKey: 'new', createdAt: daysAgo(90), reportingCategory: 'won' }),
      ]),
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// high_value_stalled — HighValueStalledRule.cs
// -----------------------------------------------------------------------------------------------

describe('high_value_stalled', () => {
  const highValue = (overrides: Partial<LeadAlertSnapshot> = {}): LeadAlertSnapshot =>
    lead({ estimatedPremium: '1000000.01', ...overrides });

  it('fires when a high-value lead is STALE', () => {
    expect(run('high_value_stalled', [highValue({ lastActivityAt: daysAgo(8) })])).toEqual([
      {
        type: 'high_value_stalled',
        leadId: 100,
        quoteId: null,
        severity: 'critical',
        premiumAtRisk: '1000000.01',
      },
    ]);
  });

  it('fires when a high-value lead has an OVERDUE follow-up', () => {
    expect(
      run('high_value_stalled', [
        highValue({ lastActivityAt: daysAgo(1), nextFollowUpDate: dateOffset(-1) }),
      ]),
    ).toHaveLength(1);
  });

  it('fires when a high-value lead is BLOCKED on a pricing approval beyond target', () => {
    expect(
      run('high_value_stalled', [
        highValue({
          lastActivityAt: daysAgo(1),
          pricingApprovalState: 'pending',
          pricingPendingSince: daysAgo(4),
        }),
      ]),
    ).toHaveLength(1);
  });

  it('does not fire for a high-value lead that is none of stale, overdue or blocked', () => {
    expect(run('high_value_stalled', [highValue({ lastActivityAt: daysAgo(1) })])).toEqual([]);
  });

  it('does not fire when the premium equals the threshold exactly (strictly exceeds)', () => {
    expect(
      run('high_value_stalled', [
        highValue({ estimatedPremium: '1000000.00', lastActivityAt: daysAgo(30) }),
      ]),
    ).toEqual([]);
  });

  it('fires one cent above the threshold — the comparison is exact, not floating point', () => {
    expect(
      run('high_value_stalled', [
        highValue({ estimatedPremium: '1000000.01', lastActivityAt: daysAgo(30) }),
      ]),
    ).toHaveLength(1);
  });

  it('is disabled entirely when the tenant has no high-value threshold', () => {
    expect(
      run('high_value_stalled', [highValue({ lastActivityAt: daysAgo(90) })], {
        highValueThreshold: null,
      }),
    ).toEqual([]);
  });

  it('does not fire on a closed lead', () => {
    expect(
      run('high_value_stalled', [
        highValue({ lastActivityAt: daysAgo(90), reportingCategory: 'lost' }),
      ]),
    ).toEqual([]);
  });

  it('uses the post-quote stall threshold once the lead has a quote', () => {
    // stalledQuoteDays is 5 and stalledLeadDays is 7: idle 6 days is stalled ONLY with a quote.
    const withQuote = highValue({ lastActivityAt: daysAgo(6), quotes: [quote()] });
    const withoutQuote = highValue({ lastActivityAt: daysAgo(6), quotes: [] });

    expect(run('high_value_stalled', [withQuote])).toHaveLength(1);
    expect(run('high_value_stalled', [withoutQuote])).toEqual([]);
  });

  it('does not react to an EXPIRING quote — that is executive escalation s composition only', () => {
    // The two high-value compositions differ deliberately (HighValueStalledRule.cs:9-19).
    expect(
      run('high_value_stalled', [
        highValue({ lastActivityAt: daysAgo(1), quotes: [quote({ validUntil: dateOffset(1) })] }),
      ]),
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// pending_pricing_approval — PendingPricingApprovalRule.cs
// -----------------------------------------------------------------------------------------------

describe('pending_pricing_approval', () => {
  it('fires when an approval has been pending beyond the target', () => {
    expect(
      run('pending_pricing_approval', [
        lead({ pricingApprovalState: 'pending', pricingPendingSince: daysAgo(4) }),
      ]),
    ).toEqual([
      {
        type: 'pending_pricing_approval',
        leadId: 100,
        quoteId: null,
        severity: 'warning',
        premiumAtRisk: null,
      },
    ]);
  });

  it('does not fire exactly AT the target', () => {
    expect(
      run('pending_pricing_approval', [
        lead({ pricingApprovalState: 'pending', pricingPendingSince: daysAgo(3) }),
      ]),
    ).toEqual([]);
  });

  it('does not fire once the approval is no longer pending', () => {
    expect(
      run('pending_pricing_approval', [
        lead({ pricingApprovalState: 'approved', pricingPendingSince: daysAgo(90) }),
      ]),
    ).toEqual([]);
  });

  it('does not fire when the pending timestamp is missing', () => {
    expect(
      run('pending_pricing_approval', [
        lead({ pricingApprovalState: 'pending', pricingPendingSince: null }),
      ]),
    ).toEqual([]);
  });

  it('still fires on a CLOSED lead, matching the reference', () => {
    // MEASURED: PendingPricingApprovalRule.cs:18-24 has no IsOpen filter.
    expect(
      run('pending_pricing_approval', [
        lead({
          reportingCategory: 'lost',
          pricingApprovalState: 'pending',
          pricingPendingSince: daysAgo(90),
        }),
      ]),
    ).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
// awaiting_underwriting — AwaitingUnderwritingRule.cs
// -----------------------------------------------------------------------------------------------

describe('awaiting_underwriting', () => {
  it('fires for a lead in underwriting beyond the underwriting SLA', () => {
    expect(
      run('awaiting_underwriting', [
        lead({ statusCanonicalKey: 'underwriting', underwritingEnteredAt: daysAgo(4) }),
      ]),
    ).toEqual([
      {
        type: 'awaiting_underwriting',
        leadId: 100,
        quoteId: null,
        severity: 'warning',
        premiumAtRisk: null,
      },
    ]);
  });

  it('does not fire exactly AT the underwriting SLA', () => {
    expect(
      run('awaiting_underwriting', [
        lead({ statusCanonicalKey: 'underwriting', underwritingEnteredAt: daysAgo(3) }),
      ]),
    ).toEqual([]);
  });

  it('does not fire for a lead that has left underwriting', () => {
    expect(
      run('awaiting_underwriting', [
        lead({ statusCanonicalKey: 'pricing', underwritingEnteredAt: daysAgo(90) }),
      ]),
    ).toEqual([]);
  });

  it('does not fire without a recorded entry into underwriting', () => {
    expect(
      run('awaiting_underwriting', [
        lead({ statusCanonicalKey: 'underwriting', underwritingEnteredAt: null }),
      ]),
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// executive_escalation — ExecutiveEscalationRule.cs
// -----------------------------------------------------------------------------------------------

describe('executive_escalation', () => {
  const highValue = (overrides: Partial<LeadAlertSnapshot> = {}): LeadAlertSnapshot =>
    lead({ estimatedPremium: '2000000.00', ...overrides });

  it('fires for high-value AND stalled', () => {
    expect(run('executive_escalation', [highValue({ lastActivityAt: daysAgo(8) })])).toEqual([
      {
        type: 'executive_escalation',
        leadId: 100,
        quoteId: null,
        severity: 'critical',
        premiumAtRisk: '2000000.00',
      },
    ]);
  });

  it('fires for high-value AND overdue', () => {
    expect(
      run('executive_escalation', [
        highValue({ lastActivityAt: daysAgo(1), nextFollowUpDate: dateOffset(-2) }),
      ]),
    ).toHaveLength(1);
  });

  it('fires for high-value AND an expiring quote', () => {
    expect(
      run('executive_escalation', [
        highValue({
          lastActivityAt: daysAgo(1),
          quotes: [quote({ validUntil: dateOffset(2) })],
        }),
      ]),
    ).toHaveLength(1);
  });

  it('does NOT treat an already-expired quote as expiring', () => {
    expect(
      run('executive_escalation', [
        highValue({ lastActivityAt: daysAgo(1), quotes: [quote({ validUntil: dateOffset(-1) })] }),
      ]),
    ).toEqual([]);
  });

  it('does not fire for high-value alone', () => {
    expect(run('executive_escalation', [highValue({ lastActivityAt: daysAgo(1) })])).toEqual([]);
  });

  it('fires for a STRATEGIC party that is stalled, regardless of value', () => {
    expect(
      run('executive_escalation', [
        lead({ isStrategicParty: true, estimatedPremium: '1.00', lastActivityAt: daysAgo(8) }),
      ]),
    ).toHaveLength(1);
  });

  it('does not fire for a strategic party that is merely overdue', () => {
    // The strategic leg is stalled-only; only the high-value leg reacts to overdue/expiring.
    expect(
      run('executive_escalation', [
        lead({
          isStrategicParty: true,
          estimatedPremium: '1.00',
          lastActivityAt: daysAgo(1),
          nextFollowUpDate: dateOffset(-5),
        }),
      ]),
    ).toEqual([]);
  });

  it('is disabled on the high-value leg when the tenant has no threshold, but the strategic leg survives', () => {
    const strategic = lead({ isStrategicParty: true, lastActivityAt: daysAgo(30) });
    const rich = highValue({ lastActivityAt: daysAgo(30) });

    expect(run('executive_escalation', [rich], { highValueThreshold: null })).toEqual([]);
    expect(run('executive_escalation', [strategic], { highValueThreshold: null })).toHaveLength(1);
  });

  it('does not fire on a closed lead', () => {
    expect(
      run('executive_escalation', [
        highValue({ lastActivityAt: daysAgo(90), reportingCategory: 'won' }),
      ]),
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// Cross-cutting
// -----------------------------------------------------------------------------------------------

describe('every rule', () => {
  it('returns no candidates for an empty tenant', () => {
    for (const rule of ALERT_RULES) {
      expect(rule.evaluate(contextOf([]))).toEqual([]);
    }
  });

  it('emits candidates only for the type it owns', () => {
    // One lead engineered to trip as many rules as possible at once.
    const busy = lead({
      statusCanonicalKey: 'underwriting',
      createdAt: daysAgo(60),
      lastActivityAt: daysAgo(60),
      nextFollowUpDate: dateOffset(-5),
      pricingApprovalState: 'pending',
      pricingPendingSince: daysAgo(60),
      underwritingEnteredAt: daysAgo(60),
      estimatedPremium: '9000000.00',
      isStrategicParty: true,
      quotes: [quote({ validUntil: dateOffset(2) }), quote({ quoteId: 902, validUntil: dateOffset(-2) })],
    });

    for (const rule of ALERT_RULES) {
      for (const candidate of rule.evaluate(contextOf([busy]))) {
        expect(candidate.type).toBe(rule.type);
      }
    }
  });

  it('never emits two candidates with the same (type, lead, quote) key', () => {
    // The DB uniqueness index makes a duplicate OPEN alert impossible; a rule that produced one
    // would turn that guarantee into an insert conflict on every sweep.
    const busy = lead({
      statusCanonicalKey: 'new',
      createdAt: daysAgo(60),
      lastActivityAt: daysAgo(60),
      nextFollowUpDate: dateOffset(-5),
      estimatedPremium: '9000000.00',
      quotes: [quote({ quoteId: 1, validUntil: dateOffset(1) }), quote({ quoteId: 2 })],
    });

    const keys = evaluateAllRules(contextOf([busy])).map(
      (candidate) => `${candidate.type}:${String(candidate.leadId)}:${String(candidate.quoteId)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is a pure function of its context — the same input evaluates identically twice', () => {
    const leads = [
      lead({ statusCanonicalKey: 'new', createdAt: daysAgo(60), lastActivityAt: daysAgo(60) }),
      lead({ leadId: 101, nextFollowUpDate: dateOffset(-1) }),
    ];
    expect(evaluateAllRules(contextOf(leads))).toEqual(evaluateAllRules(contextOf(leads)));
  });
});
