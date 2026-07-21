/**
 * Demo seed PLAN invariants and — the load-bearing part — alert coverage (T-041; AC-085/AC-086).
 *
 * The plan is a pure function, so the properties a demo dataset lives or dies by are testable
 * without a database:
 *   - the documented volumes are met;
 *   - every quote has a lead and exactly one current version;
 *   - the plan is deterministic (reproducible from the fixed seed);
 *   - and DECISIVELY: the seeded records satisfy the REAL alert-rule predicates for every one of the
 *     eleven alert types. This is exactly the check a shallow "300 leads exist" test would pass while
 *     an evaluation run fired nothing. We import the actual rules and run them over the plan.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDemoPlan,
  type DemoPlan,
  type LeadRow,
} from '../../../../scripts/db/demo-data/plan.js';
import { TENANTS } from '../../../../scripts/db/demo-data/catalog.js';
import { DEMO_MINIMUMS } from '../../../../scripts/db/demo-data/verify.js';
import {
  evaluateAllRules,
  ALERT_TYPES,
  type AlertEvaluationContext,
  type AlertThresholds,
  type LeadAlertSnapshot,
  type QuoteAlertSnapshot,
} from '../../domains/alerts/rules/index.js';

const NOW = new Date('2026-07-20T09:00:00Z');
const PERMISSION_CODES = ['leads.view', 'quotes.view', 'dashboards.view_executive'];

function build(): DemoPlan {
  return buildDemoPlan({ now: NOW, allPermissionCodes: PERMISSION_CODES });
}

/** The SHIPPED tenant_settings defaults the alert rules read (20260718002200_tenant_settings.sql). */
function thresholdsFor(tenantIndex: number): AlertThresholds {
  const tenant = TENANTS[tenantIndex - 1];
  return {
    unassignedLeadHours: 24,
    stalledLeadDays: 7,
    stalledQuoteDays: 7,
    quoteExpiryAlertDays: 7,
    pricingApprovalTargetDays: 3,
    slaAssignmentDays: 1,
    slaUnderwritingDays: 3,
    slaReceivedToSentDays: 5,
    highValueThreshold: tenant?.highValueThreshold ?? null,
  };
}

/** Rebuilds the alert evaluation context for one tenant straight from the plan rows. */
function contextForTenant(plan: DemoPlan, tenantIndex: number): AlertEvaluationContext {
  const tenant = TENANTS[tenantIndex - 1];
  if (tenant === undefined) throw new Error('unknown tenant');
  const tenantId = tenant.id;

  const leadStatusById = new Map<number, { canonical: string | null; category: string | null }>();
  const quoteStatusById = new Map<number, string | null>();
  for (const item of plan.referenceItems) {
    if (item.tenant_id !== tenantId) continue;
    if (item.list_type === 'lead_status') {
      leadStatusById.set(item.id, { canonical: item.canonical_key, category: item.reporting_category });
    } else if (item.list_type === 'quote_status') {
      quoteStatusById.set(item.id, item.reporting_category);
    }
  }

  const strategicByParty = new Map<number, boolean>();
  for (const party of plan.parties) {
    if (party.tenant_id === tenantId) strategicByParty.set(party.id, party.is_strategic);
  }

  const currentPremiumByQuote = new Map<number, string>();
  for (const version of plan.quoteVersions) {
    if (version.tenant_id === tenantId && version.is_current) {
      currentPremiumByQuote.set(version.quote_id, version.quoted_premium);
    }
  }

  const quotesByLead = new Map<number, QuoteAlertSnapshot[]>();
  for (const quote of plan.quotes) {
    if (quote.tenant_id !== tenantId) continue;
    const snapshot: QuoteAlertSnapshot = {
      quoteId: quote.id,
      leadId: quote.lead_id,
      reportingCategory: quoteStatusById.get(quote.status_id) ?? null,
      validUntil: quote.valid_until,
      quotedPremium: currentPremiumByQuote.get(quote.id) ?? '0.00',
    };
    const list = quotesByLead.get(quote.lead_id);
    if (list === undefined) quotesByLead.set(quote.lead_id, [snapshot]);
    else list.push(snapshot);
  }

  const pendingSince = new Map<number, Date>();
  for (const approval of plan.pricingApprovals) {
    if (approval.tenant_id !== tenantId || approval.state !== 'pending') continue;
    const at = new Date(approval.requested_at);
    const existing = pendingSince.get(approval.lead_id);
    if (existing === undefined || at > existing) pendingSince.set(approval.lead_id, at);
  }

  const underwritingSince = new Map<number, Date>();
  const underwritingStatusIds = new Set(
    [...leadStatusById.entries()].filter(([, v]) => v.canonical === 'underwriting').map(([id]) => id),
  );
  for (const history of plan.leadHistory) {
    if (history.tenant_id !== tenantId || history.new_status_id === null) continue;
    if (!underwritingStatusIds.has(history.new_status_id)) continue;
    const at = new Date(history.acted_at);
    const existing = underwritingSince.get(history.lead_id);
    if (existing === undefined || at > existing) underwritingSince.set(history.lead_id, at);
  }

  const leads: LeadAlertSnapshot[] = plan.leads
    .filter((lead) => lead.tenant_id === tenantId)
    .map((lead: LeadRow) => {
      const status = leadStatusById.get(lead.status_id) ?? { canonical: null, category: null };
      return {
        leadId: lead.id,
        statusCanonicalKey: status.canonical,
        reportingCategory: status.category,
        createdAt: new Date(lead.created_at),
        lastActivityAt: lead.last_activity_at === null ? null : new Date(lead.last_activity_at),
        nextFollowUpDate: lead.next_follow_up_date,
        pricingApprovalState: lead.pricing_approval_state,
        pricingPendingSince: pendingSince.get(lead.id) ?? null,
        underwritingEnteredAt: underwritingSince.get(lead.id) ?? null,
        estimatedPremium: lead.estimated_premium,
        isStrategicParty: strategicByParty.get(lead.party_id) ?? false,
        quotes: quotesByLead.get(lead.id) ?? [],
      };
    });

  return { thresholds: thresholdsFor(tenantIndex), today: NOW.toISOString().slice(0, 10), now: NOW, leads };
}

describe('demo seed plan volumes and invariants', () => {
  const plan = build();

  it('meets or exceeds every documented AC-085 minimum', () => {
    expect(plan.tenants.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.tenants);
    expect(plan.users.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.users);
    expect(plan.brokers.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.brokers);
    expect(plan.parties.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.parties);
    expect(plan.leads.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.leads);
    expect(plan.quotes.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.quotes);
    expect(plan.followUps.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.followUps);
    expect(plan.pricingApprovals.length).toBeGreaterThanOrEqual(DEMO_MINIMUMS.pricingApprovals);
  });

  it('gives every quote a lead in the same tenant', () => {
    const leadKeys = new Set(plan.leads.map((l) => `${String(l.tenant_id)}:${String(l.id)}`));
    const orphans = plan.quotes.filter(
      (q) => !leadKeys.has(`${String(q.tenant_id)}:${String(q.lead_id)}`),
    );
    expect(orphans).toEqual([]);
  });

  it('gives every quote exactly one current version', () => {
    const currentByQuote = new Map<number, number>();
    for (const version of plan.quoteVersions) {
      if (!version.is_current) continue;
      currentByQuote.set(version.quote_id, (currentByQuote.get(version.quote_id) ?? 0) + 1);
    }
    const bad = plan.quotes.filter((q) => currentByQuote.get(q.id) !== 1);
    expect(bad.map((q) => q.id)).toEqual([]);
  });

  it('marks exactly one current quote per lead that has quotes', () => {
    const byLead = new Map<number, number>();
    for (const quote of plan.quotes) {
      if (quote.is_current) byLead.set(quote.lead_id, (byLead.get(quote.lead_id) ?? 0) + 1);
    }
    const overCurrent = [...byLead.values()].filter((n) => n !== 1);
    expect(overCurrent).toEqual([]);
  });

  it('is deterministic: two builds at the same instant are byte-identical', () => {
    const a = JSON.stringify(build());
    const b = JSON.stringify(build());
    expect(a).toBe(b);
  });

  it('uses unique explicit ids per table (no id collisions)', () => {
    const leadIds = new Set(plan.leads.map((l) => l.id));
    expect(leadIds.size).toBe(plan.leads.length);
    const quoteIds = new Set(plan.quotes.map((q) => q.id));
    expect(quoteIds.size).toBe(plan.quotes.length);
  });
});

describe('demo seed lights up every alert type (real rules over the plan)', () => {
  const plan = build();

  for (const tenant of TENANTS) {
    it(`fires all 11 alert types for tenant ${String(tenant.index)}`, () => {
      const context = contextForTenant(plan, tenant.index);
      const candidates = evaluateAllRules(context);
      const firedTypes = new Set(candidates.map((c) => c.type));
      const missing = ALERT_TYPES.filter((type) => !firedTypes.has(type));
      expect(missing, `alert types with no candidate in tenant ${String(tenant.index)}`).toEqual([]);
    });
  }
});
