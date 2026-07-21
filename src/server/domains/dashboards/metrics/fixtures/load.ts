/**
 * The one loader for the shared metric fixtures (spec P-10, AC-074, T-035).
 *
 * WHY A LOADER AND NOT `import fixture from './x.json'`
 * ====================================================
 * Two reasons, and the second is the load-bearing one.
 *
 *  1. The project is `module: nodenext`. A JSON import needs an `with { type: 'json' }` attribute
 *     and there is not one anywhere else in this codebase; adding the first one here would make
 *     this module the thing that breaks if the bundler/runtime pair ever disagrees about them.
 *
 *  2. AC-074 requires the unit suite and the integration suite to demonstrably share ONE dataset.
 *     A single parse path is what makes that true rather than merely likely: both suites call
 *     `loadMetricFixture()`, so there is no second copy that could be edited independently and no
 *     module-graph fork where one consumer gets a stale build artifact and the other gets source.
 *     `$`-prefixed keys are stripped here, so the hand-computation notes live next to the numbers
 *     they justify without leaking into the typed shape.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Money } from '../../money.js';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/** One lead row of the shared dataset. */
export interface FixtureLead {
  readonly key: string;
  readonly dateReceived: string;
  readonly reportingCategory: string;
  readonly estimatedPremium: Money | null;
  readonly hasQuote: boolean;
  readonly nextFollowUpDate: string | null;
}

/** One quote row of the shared dataset. */
export interface FixtureQuote {
  readonly key: string;
  readonly leadKey: string;
  readonly preparedDate: string;
  readonly sentDate: string | null;
  readonly reportingCategory: string;
  readonly decisionDate: string | null;
  readonly currentPremium: Money;
  readonly boundPremium: Money | null;
  readonly competitorPremium: Money | null;
}

/** Every hand-computed expectation, asserted by BOTH the unit suite and the SQL-parity suite. */
export interface FixtureExpectations {
  readonly totalLeadsReceived: number;
  readonly leadsWithQuote: number;
  readonly leadToQuoteRate: number;
  readonly totalQuotesPrepared: number;
  readonly quotesSent: number;
  readonly quoteToProposalRate: number;
  readonly wonQuotes: number;
  readonly lostQuotes: number;
  readonly decidedQuotes: number;
  readonly quoteToWinRate: number;
  readonly proposalToWinRate: number;
  readonly quotedPremium: Money;
  readonly boundPremium: Money;
  readonly openQuotePremium: Money;
  readonly openLeadEstimatedPremium: Money;
  readonly openPipelinePremium: Money;
  readonly averageTurnaroundDays: number;
  readonly slaStatus: string;
  readonly averageLeadAgeDays: number;
  readonly averageQuoteAgeDays: number;
  readonly followUpRequired: number;
  readonly followUpOnTime: number;
  readonly followUpCompliance: number;
  readonly averagePriceGap: number;
  readonly executiveAgingBuckets: Readonly<Record<string, number>>;
  readonly pipelineAgingBuckets: Readonly<Record<string, number>>;
}

export interface MetricFixture {
  readonly period: { readonly from: string; readonly to: string };
  readonly today: string;
  readonly slaTargetDays: number;
  readonly leads: readonly FixtureLead[];
  readonly quotes: readonly FixtureQuote[];
  readonly expected: FixtureExpectations;
}

/** Alert-snapshot shape the escalation rule consumes. */
export interface FixtureEscalationLead {
  readonly isOpen: boolean;
  readonly premiumAtRisk: Money | null;
  readonly isStrategicParty: boolean;
  readonly hasAnyQuote: boolean;
  readonly lastActivityAt: string | null;
  readonly nextFollowUpDate: string | null;
  readonly quotes: readonly { readonly isOpen: boolean; readonly validUntil: string | null }[];
}

export interface FixtureEscalationSettings {
  readonly highValueThreshold: Money | null;
  readonly stalledLeadDays: number;
  readonly stalledQuoteDays: number;
  readonly quoteExpiryAlertDays: number;
}

export interface EscalationFixture {
  readonly settings: FixtureEscalationSettings;
  readonly now: string;
  readonly today: string;
  readonly cases: readonly {
    readonly name: string;
    readonly lead: FixtureEscalationLead;
    readonly expected: boolean;
  }[];
  readonly unsetThreshold: {
    readonly settings: FixtureEscalationSettings;
    readonly lead: FixtureEscalationLead;
    readonly expected: boolean;
  };
}

/** Drops the `$`-prefixed annotation keys the JSON carries for the human reader. */
function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith('$'))
        .map(([key, inner]) => [key, stripAnnotations(inner)]),
    );
  }
  return value;
}

function read<T>(fileName: string): T {
  return stripAnnotations(JSON.parse(readFileSync(join(FIXTURE_DIR, fileName), 'utf8'))) as T;
}

export function loadMetricFixture(): MetricFixture {
  return read<MetricFixture>('dashboard-metrics.json');
}

export function loadEscalationFixture(): EscalationFixture {
  return read<EscalationFixture>('executive-escalation.json');
}
