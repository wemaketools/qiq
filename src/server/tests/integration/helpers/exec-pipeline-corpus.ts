/**
 * The shared Executive/Pipeline dashboard corpus (T-036; AC-022, AC-074, AC-077, AC-079).
 *
 * WHY THIS HELPER EXISTS
 * ======================
 * `dashboard-executive.test.ts` and `dashboard-pipeline.test.ts` must aggregate over THE SAME rows,
 * because the two dashboards report overlapping numbers (open pipeline premium, lead-to-quote rate,
 * quotes prepared) and the only way "they agree" is a meaningful claim is if there is exactly one
 * dataset underneath. Seeding it twice would let the two copies drift and turn every cross-dashboard
 * assertion into a tautology about whichever copy the suite happened to read.
 *
 * THE ROW DATA COMES FROM `metrics/fixtures/dashboard-metrics.json`, NOT FROM LITERALS HERE
 * ========================================================================================
 * Same mechanism T-035 established: `loadMetricFixture()` is the one parse path, the unit suite runs
 * the pure functions over it, and this helper INSERTS what it returns. No premium, date or category
 * is retyped, so a fixture edit necessarily moves both sides.
 *
 * WHAT THIS HELPER ADDS ON TOP OF THE T-035 CORPUS, AND WHY
 * ========================================================
 *  - CANONICAL KEYS on the seeded lead statuses. T-035's corpus left `canonical_key` null, which is
 *    legitimate for filter tests but makes the Pipeline funnel DEGENERATE: `lifecycleOrder(null)`
 *    returns the same sentinel for every stage, so every funnel bar reaches 100% and the ordering
 *    logic is unfalsifiable. With real keys the bars are 4/2/1 and the ordering is asserted.
 *  - TWO REQUEST CHANNELS. A single channel makes the Lead-Volume-by-Channel donut a one-slice chart
 *    whose share is 1.0 no matter what the grouping does.
 *  - ALERTS, including one RESOLVED alert that must be excluded everywhere.
 *  - `tenant_settings`, which the dashboards read for currency, high-value threshold and SLA target.
 */
import { loadMetricFixture, type MetricFixture } from '../../../domains/dashboards/metrics/fixtures/load.js';

export type QueryFn = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/**
 * The canonical lead-status key each fixture reporting category is seeded under.
 *
 * Chosen so the lifecycle ORDER is strictly increasing across the progression categories
 * (new=0 < quote_sent=5 < closed_won=7), which is what makes the funnel's cumulative
 * "reached stage S" counts differ from one another at all.
 */
export const CANONICAL_KEY_BY_CATEGORY: Readonly<Record<string, string>> = {
  open: 'new',
  quoted: 'quote_sent',
  won: 'closed_won',
  lost: 'closed_lost',
  expired: 'expired',
};

/** Which dimensions each fixture lead carries. Mirrors T-035's mapping so the two corpora agree. */
export const LEAD_DIMENSIONS: Readonly<
  Record<
    string,
    {
      readonly product: 'P1' | 'P2';
      readonly broker: 'B1' | 'B2' | null;
      readonly region: 'R1' | 'R2';
      readonly channel: 'C1' | 'C2';
      readonly owner: 'restricted' | 'stranger';
    }
  >
> = {
  L1: { product: 'P1', broker: 'B1', region: 'R1', channel: 'C1', owner: 'restricted' },
  L2: { product: 'P1', broker: 'B2', region: 'R2', channel: 'C1', owner: 'restricted' },
  L3: { product: 'P2', broker: 'B1', region: 'R1', channel: 'C1', owner: 'restricted' },
  L4: { product: 'P2', broker: null, region: 'R2', channel: 'C2', owner: 'stranger' },
  L5: { product: 'P1', broker: 'B2', region: 'R1', channel: 'C2', owner: 'stranger' },
};

export interface CorpusIds {
  readonly partyTypeId: number;
  readonly regionR1: number;
  readonly regionR2: number;
  readonly channelC1: number;
  readonly channelC2: number;
  readonly productP1: number;
  readonly productP2: number;
  readonly coverP1: number;
  readonly coverP2: number;
  readonly brokerTypeT1: number;
  readonly brokerTypeT2: number;
  readonly brokerB1: number;
  readonly brokerB2: number;
  readonly rmAssignmentId: number;
  readonly statusIdByCategory: ReadonlyMap<string, number>;
  readonly statusNameByCategory: ReadonlyMap<string, string>;
  readonly leadIdByKey: ReadonlyMap<string, number>;
  readonly quoteIdByKey: ReadonlyMap<string, number>;
  readonly brokerB1Name: string;
  readonly brokerB2Name: string;
  readonly productP1Name: string;
  readonly productP2Name: string;
  readonly channelC1Name: string;
  readonly channelC2Name: string;
}

export interface SeedOptions {
  readonly query: QueryFn;
  readonly tenantId: number;
  readonly runToken: string;
  /** App-user ids the RM-slot assignments point at, keyed by the `owner` field above. */
  readonly ownerUserIds: Readonly<Record<'restricted' | 'stranger', number>>;
  /** The role the tenant's `rm` business-assignment slot is configured with. */
  readonly rmRoleId: number;
  readonly currencyCode: string;
  /** `numeric(18,2)` STRING — never a JS number; see `money.ts`. */
  readonly highValueThreshold: string | null;
  readonly slaReceivedToSentDays: number;
}

/** Seeds reference data, the fixture leads/quotes, assignments and tenant settings. */
export async function seedExecPipelineCorpus(options: SeedOptions): Promise<CorpusIds> {
  const { query, tenantId, runToken } = options;
  const fixture: MetricFixture = loadMetricFixture();

  let sequence = 0;
  const uniqueName = (prefix: string): string => {
    sequence += 1;
    return `${prefix} ${runToken}-${sequence}`;
  };

  async function seedRef(
    listType: string,
    name: string,
    extra: {
      productLineId?: number | null;
      reportingCategory?: string | null;
      canonicalKey?: string | null;
    } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          product_line_id, created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, $6, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        extra.reportingCategory ?? null,
        extra.canonicalKey ?? null,
        extra.productLineId ?? null,
      ],
    );
    return Number(rows[0]?.id);
  }

  const partyTypeId = await seedRef('party_type', uniqueName('Corp'));
  const regionR1 = await seedRef('region', uniqueName('North'));
  const regionR2 = await seedRef('region', uniqueName('South'));
  const channelC1Name = uniqueName('Email');
  const channelC2Name = uniqueName('Phone');
  const channelC1 = await seedRef('request_channel', channelC1Name);
  const channelC2 = await seedRef('request_channel', channelC2Name);
  const productP1Name = uniqueName('Motor');
  const productP2Name = uniqueName('Marine');
  const productP1 = await seedRef('product_line', productP1Name);
  const productP2 = await seedRef('product_line', productP2Name);
  const coverP1 = await seedRef('cover_type', uniqueName('Comp'), { productLineId: productP1 });
  const coverP2 = await seedRef('cover_type', uniqueName('Hull'), { productLineId: productP2 });
  const brokerTypeT1 = await seedRef('broker_type', uniqueName('Tier1'));
  const brokerTypeT2 = await seedRef('broker_type', uniqueName('Tier2'));

  async function seedBroker(name: string, brokerTypeId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into brokers (tenant_id, name, status, broker_type_id, created_at, updated_at)
       values ($1, $2, 'active', $3, now(), now()) returning id::text as id`,
      [tenantId, name, brokerTypeId],
    );
    return Number(rows[0]?.id);
  }

  const brokerB1Name = `B1 Brokers ${runToken}`;
  const brokerB2Name = `B2 Brokers ${runToken}`;
  const brokerB1 = await seedBroker(brokerB1Name, brokerTypeT1);
  const brokerB2 = await seedBroker(brokerB2Name, brokerTypeT2);

  // Lead statuses carry BOTH a reporting category and a canonical key; the key is what the
  // lifecycle ordering (and therefore the whole funnel) is computed from.
  const statusIdByCategory = new Map<string, number>();
  const statusNameByCategory = new Map<string, string>();
  for (const category of ['open', 'quoted', 'won', 'lost', 'expired']) {
    const name = uniqueName(`Status ${category}`);
    statusNameByCategory.set(category, name);
    statusIdByCategory.set(
      category,
      await seedRef('lead_status', name, {
        reportingCategory: category,
        canonicalKey: CANONICAL_KEY_BY_CATEGORY[category] ?? null,
      }),
    );
  }

  const rmRows = await query<{ id: string }>(
    `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
     values ($1, 'rm', $2, now(), now()) returning id::text as id`,
    [tenantId, options.rmRoleId],
  );
  const rmAssignmentId = Number(rmRows[0]?.id);

  const partyRows = await query<{ id: string }>(
    `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
     values ($1, $2, $3, false, now(), now()) returning id::text as id`,
    [tenantId, `Fixture Client ${runToken}`, partyTypeId],
  );
  const partyId = Number(partyRows[0]?.id);

  const leadIdByKey = new Map<string, number>();
  for (const lead of fixture.leads) {
    const dims = LEAD_DIMENSIONS[lead.key];
    if (dims === undefined) throw new Error(`fixture lead ${lead.key} has no dimensions mapping`);
    const statusId = statusIdByCategory.get(lead.reportingCategory);
    if (statusId === undefined) {
      throw new Error(`no seeded status for reporting category ${lead.reportingCategory}`);
    }

    const rows = await query<{ id: string }>(
      `insert into leads
         (tenant_id, party_id, lead_ref, date_received, request_channel_id, broker_id, region_id,
          product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
          next_follow_up_date, source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'm12', 'normal', $11, $12, 'browser',
               now(), now())
       returning id::text as id`,
      [
        tenantId,
        partyId,
        `${runToken}-${lead.key}`,
        lead.dateReceived,
        dims.channel === 'C1' ? channelC1 : channelC2,
        dims.broker === 'B1' ? brokerB1 : dims.broker === 'B2' ? brokerB2 : null,
        dims.region === 'R1' ? regionR1 : regionR2,
        dims.product === 'P1' ? productP1 : productP2,
        dims.product === 'P1' ? coverP1 : coverP2,
        // Money goes to Postgres as a STRING: the driver must not re-widen it through a double.
        lead.estimatedPremium,
        statusId,
        lead.nextFollowUpDate,
      ],
    );
    const leadId = Number(rows[0]?.id);
    leadIdByKey.set(lead.key, leadId);

    await query(
      `insert into lead_assignments
         (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [tenantId, leadId, rmAssignmentId, options.ownerUserIds[dims.owner]],
    );
  }

  // `uq_quotes_current` admits ONE current quote per lead, so only the first quote seeded for a lead
  // carries the marker — which is also what makes `currentQuotedPremium` a well-defined number.
  const leadsWithCurrentQuote = new Set<string>();
  const quoteIdByKey = new Map<string, number>();

  for (const quote of fixture.quotes) {
    const leadId = leadIdByKey.get(quote.leadKey);
    if (leadId === undefined) throw new Error(`fixture quote ${quote.key} has no lead`);
    const statusId = statusIdByCategory.get(quote.reportingCategory);
    if (statusId === undefined) {
      throw new Error(`no seeded status for reporting category ${quote.reportingCategory}`);
    }
    const dims = LEAD_DIMENSIONS[quote.leadKey];
    if (dims === undefined) throw new Error(`fixture quote ${quote.key} has no dimensions`);

    const rows = await query<{ id: string }>(
      `insert into quotes
         (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
          prepared_date, sent_date, decision_date, bound_premium, competitor_premium,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
       returning id::text as id`,
      [
        tenantId,
        leadId,
        `${runToken}-${quote.key}`,
        statusId,
        !leadsWithCurrentQuote.has(quote.leadKey),
        dims.product === 'P1' ? productP1 : productP2,
        dims.product === 'P1' ? coverP1 : coverP2,
        quote.preparedDate,
        quote.sentDate,
        quote.decisionDate === null ? null : `${quote.decisionDate}T00:00:00Z`,
        quote.boundPremium,
        quote.competitorPremium,
      ],
    );
    const quoteId = Number(rows[0]?.id);
    quoteIdByKey.set(quote.key, quoteId);
    leadsWithCurrentQuote.add(quote.leadKey);

    await query(
      `insert into quote_versions
         (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
       values ($1, $2, 1, $3, true, now())`,
      [tenantId, quoteId, quote.currentPremium],
    );
  }

  await query(
    `insert into tenant_settings
       (tenant_id, currency_code, currency_symbol, high_value_threshold,
        sla_received_to_sent_days, created_at, updated_at)
     values ($1, $2, $2, $3, $4, now(), now())`,
    [tenantId, options.currencyCode, options.highValueThreshold, options.slaReceivedToSentDays],
  );

  return {
    partyTypeId,
    regionR1,
    regionR2,
    channelC1,
    channelC2,
    productP1,
    productP2,
    coverP1,
    coverP2,
    brokerTypeT1,
    brokerTypeT2,
    brokerB1,
    brokerB2,
    rmAssignmentId,
    statusIdByCategory,
    statusNameByCategory,
    leadIdByKey,
    quoteIdByKey,
    brokerB1Name,
    brokerB2Name,
    productP1Name,
    productP2Name,
    channelC1Name,
    channelC2Name,
  };
}

export interface SeedAlertOptions {
  readonly query: QueryFn;
  readonly tenantId: number;
  readonly leadId: number;
  readonly quoteId?: number | null;
  readonly type: string;
  readonly severity?: string;
  readonly premiumAtRisk?: string | null;
  /** A RESOLVED alert must be invisible to every dashboard; that is what this flag exists to test. */
  readonly resolved?: boolean;
}

export async function seedAlert(options: SeedAlertOptions): Promise<number> {
  const rows = await options.query<{ id: string }>(
    `insert into alerts
       (tenant_id, type, lead_id, quote_id, severity, premium_at_risk, created_at, resolved_at)
     values ($1, $2, $3, $4, $5, $6, now(), $7)
     returning id::text as id`,
    [
      options.tenantId,
      options.type,
      options.leadId,
      options.quoteId ?? null,
      options.severity ?? 'high',
      options.premiumAtRisk ?? null,
      options.resolved === true ? new Date().toISOString() : null,
    ],
  );
  return Number(rows[0]?.id);
}
