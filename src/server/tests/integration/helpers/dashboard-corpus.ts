/**
 * ONE seeded corpus for the Broker / RM / Loss dashboard suites (T-037; AC-074, AC-078).
 *
 * WHY A SHARED SEEDER RATHER THAN THREE COPIES
 * ============================================
 * The three dashboards aggregate the SAME leads and quotes along different axes: Broker groups by
 * `leads.broker_id`, RM by the `rm`-slot assignment, Loss by `lost_reason_id`. If each suite seeded
 * its own corpus, "the Broker dashboard's Won-via-Brokers equals the RM dashboard's Won Premium YTD"
 * would be untestable — and those two numbers ARE the same money viewed two ways, so a divergence is
 * exactly the defect worth catching. One corpus makes the cross-dashboard identities assertable.
 *
 * THE LEAD/QUOTE ROWS COME FROM THE SHARED METRIC FIXTURE, NOT FROM LITERALS HERE
 * ==============================================================================
 * `loadMetricFixture()` is the same loader `tests/unit/metric-definitions.test.ts` and
 * `dashboard-filters.test.ts` call (AC-074). Nothing below retypes a premium or a date, so a fixture
 * edit necessarily moves these dashboards' expected values too.
 *
 * THE EXTENSION LEADS (X1, X2) ARE ADDITIONS, AND THEY ARE DELIBERATE
 * ==================================================================
 * The shared fixture carries exactly ONE lost lead (L5) and no lost reasons, competitors or loss
 * commentary at all — it was built for the Executive metrics. Loss Analysis over a single reason
 * with no competitor cannot distinguish "grouped by reason" from "returned everything", cannot
 * exercise the price-gap average at all, and cannot demonstrate P-04 resolvability of a DISABLED
 * lost reason on historical records. X1 and X2 add exactly those, and their premiums/dates are
 * declared here so the hand-computed expectations in each suite can be checked against them.
 */
import { loadMetricFixture } from '../../../domains/dashboards/metrics/fixtures/load.js';

export type Query = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/** Which broker / product / region / owner each corpus lead carries. */
export interface LeadDimensions {
  readonly broker: 'B1' | 'B2' | null;
  readonly product: 'P1' | 'P2';
  readonly region: 'R1' | 'R2';
  readonly owner: 'alice' | 'bob';
}

/**
 * Chosen so every dimension PARTITIONS the corpus (each broker owns a different mix of outcomes,
 * each RM a different mix), rather than merely being present. A dimension that splits 5/0 cannot
 * tell a working filter from an ignored one.
 */
export const LEAD_DIMENSIONS: Readonly<Record<string, LeadDimensions>> = {
  L1: { broker: 'B1', product: 'P1', region: 'R1', owner: 'alice' },
  L2: { broker: 'B2', product: 'P1', region: 'R2', owner: 'alice' },
  L3: { broker: 'B1', product: 'P2', region: 'R1', owner: 'bob' },
  L4: { broker: 'B2', product: 'P2', region: 'R2', owner: 'bob' },
  L5: { broker: null, product: 'P1', region: 'R1', owner: 'bob' },
  X1: { broker: 'B1', product: 'P2', region: 'R1', owner: 'alice' },
  X2: { broker: null, product: 'P1', region: 'R2', owner: 'bob' },
};

/** A lost lead added on top of the shared fixture, with the loss detail the fixture has none of. */
export interface ExtensionLead {
  readonly key: string;
  readonly dateReceived: string;
  readonly estimatedPremium: string;
  readonly lostReason: 'price' | 'coverGaps';
  readonly competitor: string | null;
  readonly competitorPremium: string | null;
  readonly lossComments: string;
  readonly decisionDate: string;
  readonly lostBeforeQuote: boolean;
  /** Deliberately set on a LOST lead — see the insert site. */
  readonly nextFollowUpDate: string | null;
}

export const EXTENSION_LEADS: readonly ExtensionLead[] = [
  {
    key: 'X1',
    dateReceived: '2026-03-10',
    estimatedPremium: '400.00',
    lostReason: 'price',
    competitor: 'Acme Assurance',
    competitorPremium: '320.00',
    lossComments: 'Beaten on price by 20%.',
    decisionDate: '2026-03-22',
    lostBeforeQuote: true,
    nextFollowUpDate: '2026-03-18',
  },
  {
    key: 'X2',
    dateReceived: '2026-03-12',
    // The DISABLED-reason case (P-04): this lead's lost reason is `is_active = false`, and it must
    // still resolve by NAME on this historical record. A dashboard that joined only active
    // reference values would silently drop it — losing 1000.00 of lost premium and one whole
    // reason bar — while every row count still looked plausible.
    estimatedPremium: '1000.00',
    lostReason: 'coverGaps',
    competitor: 'Acme Assurance',
    competitorPremium: '800.00',
    lossComments: 'Wanted broader cover than we would write.',
    decisionDate: '2026-03-25',
    lostBeforeQuote: true,
    nextFollowUpDate: null,
  },
];

/** The reference names, asserted directly by the suites (they are rendered labels). */
export const PRICE_REASON_NAME = 'Price';
export const COVER_GAPS_REASON_NAME = 'Cover gaps';
export const COMPETITOR_NAME = 'Acme Assurance';
export const B1_NAME_SUFFIX = 'Northern Brokers';
export const B2_NAME_SUFFIX = 'Southern Brokers';
export const B1_BRANCH = 'Nairobi';
export const B2_BRANCH = 'Mombasa';
export const B1_CONTACT = 'Primary One';
export const TIER1_NAME = 'Tier 1';
export const TIER2_NAME = 'Tier 2';

/** The SLA target the corpus provisions, so `beyondTarget` is a decided value and not a default. */
export const SLA_TARGET_DAYS = 3;
export const CURRENCY_CODE = 'KES';

export interface CorpusIds {
  readonly partyTypeId: number;
  readonly regionR1: number;
  readonly regionR2: number;
  readonly channelId: number;
  readonly productP1: number;
  readonly productP2: number;
  readonly coverP1: number;
  readonly coverP2: number;
  readonly brokerTypeT1: number;
  readonly brokerTypeT2: number;
  readonly brokerB1: number;
  readonly brokerB2: number;
  readonly priceReasonId: number;
  readonly coverGapsReasonId: number;
  readonly rmAssignmentId: number;
  readonly underwriterAssignmentId: number;
  readonly statusByCategory: ReadonlyMap<string, number>;
  readonly leadIdByKey: ReadonlyMap<string, number>;
  readonly quoteIdByKey: ReadonlyMap<string, number>;
  readonly b1Name: string;
  readonly b2Name: string;
}

export interface SeedCorpusOptions {
  readonly query: Query;
  readonly tenantId: number;
  /** Prefix that makes every seeded name unique to this run. */
  readonly run: string;
  /** The `rm`-slot business assignment role. */
  readonly rmRoleId: number;
  /**
   * The role backing the `underwriter` slot. Distinct from `rmRoleId` only because
   * `uq_business_assignments_tenant_slot` admits one row per (tenant, slot) and the two rows need
   * different roles to be meaningful.
   */
  readonly underwriterRoleId: number;
  readonly aliceUserId: number;
  readonly bobUserId: number;
}

async function insertId(
  query: Query,
  sql: string,
  params: unknown[],
): Promise<number> {
  const rows = await query<{ id: string }>(sql, params);
  return Number(rows[0]?.id);
}

/**
 * Seeds the whole corpus and returns every id the suites need.
 *
 * Reference items are created ACTIVE except the cover-gaps lost reason, which is deactivated after
 * the leads referencing it are written — the order matters only in that it mirrors reality (a value
 * used for years and retired later), and reality is the case P-04 is about.
 */
export async function seedDashboardCorpus(options: SeedCorpusOptions): Promise<CorpusIds> {
  const { query, tenantId, run, rmRoleId, underwriterRoleId, aliceUserId, bobUserId } = options;
  const fixture = loadMetricFixture();

  const name = (label: string): string => `${label} ${run}`;

  const seedRef = async (
    listType: string,
    itemName: string,
    extra: { productLineId?: number | null; reportingCategory?: string | null } = {},
  ): Promise<number> =>
    insertId(
      query,
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, product_line_id,
          created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, now(), now())
       returning id::text as id`,
      [tenantId, listType, itemName, extra.reportingCategory ?? null, extra.productLineId ?? null],
    );

  const partyTypeId = await seedRef('party_type', name('Corporate'));
  const regionR1 = await seedRef('region', name('North'));
  const regionR2 = await seedRef('region', name('South'));
  const channelId = await seedRef('request_channel', name('Email'));
  const productP1 = await seedRef('product_line', name('Motor'));
  const productP2 = await seedRef('product_line', name('Marine'));
  const coverP1 = await seedRef('cover_type', name('Comprehensive'), { productLineId: productP1 });
  const coverP2 = await seedRef('cover_type', name('Hull'), { productLineId: productP2 });
  const brokerTypeT1 = await seedRef('broker_type', TIER1_NAME);
  const brokerTypeT2 = await seedRef('broker_type', TIER2_NAME);

  // Lost reasons: names are asserted verbatim by the suites, so they are NOT run-suffixed.
  const priceReasonId = await seedRef('lost_reason', PRICE_REASON_NAME);
  const coverGapsReasonId = await seedRef('lost_reason', COVER_GAPS_REASON_NAME);

  const statusByCategory = new Map<string, number>();
  for (const category of ['open', 'quoted', 'won', 'lost', 'expired']) {
    statusByCategory.set(
      category,
      await seedRef('lead_status', name(`Status ${category}`), { reportingCategory: category }),
    );
  }

  const b1Name = `${B1_NAME_SUFFIX} ${run}`;
  const b2Name = `${B2_NAME_SUFFIX} ${run}`;
  const brokerB1 = await insertId(
    query,
    `insert into brokers (tenant_id, name, status, broker_type_id, branch, created_at, updated_at)
     values ($1, $2, 'active', $3, $4, now(), now()) returning id::text as id`,
    [tenantId, b1Name, brokerTypeT1, B1_BRANCH],
  );
  const brokerB2 = await insertId(
    query,
    `insert into brokers (tenant_id, name, status, broker_type_id, branch, created_at, updated_at)
     values ($1, $2, 'active', $3, $4, now(), now()) returning id::text as id`,
    [tenantId, b2Name, brokerTypeT2, B2_BRANCH],
  );

  // B1 gets a PRIMARY contact and a non-primary one; B2 gets none, so the table's
  // `primaryContactName` has both a populated and a null case to distinguish.
  await query(
    `insert into broker_contacts (tenant_id, broker_id, name, is_primary, created_at, updated_at)
     values ($1, $2, $3, true, now(), now()), ($1, $2, $4, false, now(), now())`,
    [tenantId, brokerB1, B1_CONTACT, 'Secondary One'],
  );

  const rmAssignmentId = await insertId(
    query,
    `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
     values ($1, 'rm', $2, now(), now()) returning id::text as id`,
    [tenantId, rmRoleId],
  );

  const underwriterAssignmentId = await insertId(
    query,
    `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
     values ($1, 'underwriter', $2, now(), now()) returning id::text as id`,
    [tenantId, underwriterRoleId],
  );

  const partyId = await insertId(
    query,
    `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
     values ($1, $2, $3, false, now(), now()) returning id::text as id`,
    [tenantId, `Corpus Client ${run}`, partyTypeId],
  );

  const leadIdByKey = new Map<string, number>();
  const quoteIdByKey = new Map<string, number>();

  const ownerOf = (key: string): number =>
    LEAD_DIMENSIONS[key]?.owner === 'alice' ? aliceUserId : bobUserId;

  const brokerOf = (key: string): number | null => {
    const broker = LEAD_DIMENSIONS[key]?.broker;
    return broker === 'B1' ? brokerB1 : broker === 'B2' ? brokerB2 : null;
  };

  const productOf = (key: string): number =>
    LEAD_DIMENSIONS[key]?.product === 'P1' ? productP1 : productP2;
  const coverOf = (key: string): number =>
    LEAD_DIMENSIONS[key]?.product === 'P1' ? coverP1 : coverP2;
  const regionOf = (key: string): number =>
    LEAD_DIMENSIONS[key]?.region === 'R1' ? regionR1 : regionR2;

  const insertLead = async (params: {
    key: string;
    dateReceived: string;
    reportingCategory: string;
    estimatedPremium: string | null;
    nextFollowUpDate: string | null;
    lostReasonId: number | null;
    competitor: string | null;
    competitorPremium: string | null;
    lossComments: string | null;
    decisionDate: string | null;
    lostBeforeQuote: boolean | null;
  }): Promise<void> => {
    const statusId = statusByCategory.get(params.reportingCategory);
    if (statusId === undefined) {
      throw new Error(`no seeded status for reporting category ${params.reportingCategory}`);
    }

    const leadId = await insertId(
      query,
      `insert into leads
         (tenant_id, party_id, lead_ref, date_received, request_channel_id, broker_id, region_id,
          product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
          next_follow_up_date, lost_reason_id, competitor, competitor_premium, loss_comments,
          decision_date, lost_before_quote, source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'm12', 'normal', $11, $12, $13, $14, $15,
               $16, $17, $18, 'browser', now(), now())
       returning id::text as id`,
      [
        tenantId,
        partyId,
        `${run}-${params.key}`,
        params.dateReceived,
        channelId,
        brokerOf(params.key),
        regionOf(params.key),
        productOf(params.key),
        coverOf(params.key),
        // Money reaches Postgres as a STRING; it must not be widened through a double on the way.
        params.estimatedPremium,
        statusId,
        params.nextFollowUpDate,
        params.lostReasonId,
        params.competitor,
        params.competitorPremium,
        params.lossComments,
        params.decisionDate === null ? null : `${params.decisionDate}T00:00:00Z`,
        params.lostBeforeQuote,
      ],
    );

    leadIdByKey.set(params.key, leadId);
    await query(
      `insert into lead_assignments
         (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [tenantId, leadId, rmAssignmentId, ownerOf(params.key)],
    );
  };

  for (const lead of fixture.leads) {
    await insertLead({
      key: lead.key,
      dateReceived: lead.dateReceived,
      reportingCategory: lead.reportingCategory,
      estimatedPremium: lead.estimatedPremium,
      nextFollowUpDate: lead.nextFollowUpDate,
      // L5 is the fixture's only lost lead; it gets the Price reason so the reason grouping has a
      // member that also carries a QUOTE (its lost premium comes from the quote, not the estimate).
      lostReasonId: lead.reportingCategory === 'lost' ? priceReasonId : null,
      competitor: null,
      competitorPremium: null,
      lossComments: null,
      decisionDate: null,
      lostBeforeQuote: lead.reportingCategory === 'lost' ? false : null,
    });
  }

  for (const extension of EXTENSION_LEADS) {
    await insertLead({
      key: extension.key,
      dateReceived: extension.dateReceived,
      reportingCategory: 'lost',
      estimatedPremium: extension.estimatedPremium,
      // A LOST lead carrying a long-past follow-up commitment. It must NOT count as an overdue
      // follow-up: chasing a lead we already lost is not work outstanding. Without this row the
      // open-category condition in the overdue predicate is undetectable, because every other lead
      // in the corpus that carries a commitment is still open.
      nextFollowUpDate: extension.nextFollowUpDate,
      lostReasonId: extension.lostReason === 'price' ? priceReasonId : coverGapsReasonId,
      competitor: extension.competitor,
      competitorPremium: extension.competitorPremium,
      lossComments: extension.lossComments,
      decisionDate: extension.decisionDate,
      lostBeforeQuote: extension.lostBeforeQuote,
    });
  }

  // `uq_quotes_current` allows ONE current quote per lead, so only the first quote seeded for a
  // lead carries the marker — the same constraint `dashboard-filters.test.ts` seeds around.
  const leadsWithCurrentQuote = new Set<string>();

  for (const quote of fixture.quotes) {
    const leadId = leadIdByKey.get(quote.leadKey);
    if (leadId === undefined) throw new Error(`fixture quote ${quote.key} has no lead`);
    const statusId = statusByCategory.get(quote.reportingCategory);
    if (statusId === undefined) {
      throw new Error(`no seeded status for reporting category ${quote.reportingCategory}`);
    }

    const quoteId = await insertId(
      query,
      `insert into quotes
         (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
          prepared_date, sent_date, decision_date, bound_premium, competitor_premium,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
       returning id::text as id`,
      [
        tenantId,
        leadId,
        `${run}-${quote.key}`,
        statusId,
        !leadsWithCurrentQuote.has(quote.leadKey),
        productOf(quote.leadKey),
        coverOf(quote.leadKey),
        quote.preparedDate,
        quote.sentDate,
        quote.decisionDate === null ? null : `${quote.decisionDate}T00:00:00Z`,
        quote.boundPremium,
        quote.competitorPremium,
      ],
    );

    quoteIdByKey.set(quote.key, quoteId);
    leadsWithCurrentQuote.add(quote.leadKey);

    await query(
      `insert into quote_versions
         (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
       values ($1, $2, 1, $3, true, now())`,
      [tenantId, quoteId, quote.currentPremium],
    );
  }

  // THE SLOT-DISCRIMINATING ROW.
  //
  // Alice is the UNDERWRITER on L4, which is BOB's lead (Bob holds the `rm` slot on it). Nothing
  // about the unfiltered dashboards changes — the owner projection reads the `rm` slot — but it
  // makes "attribute by the rm slot" FALSIFIABLE: filtering by Alice must not pull in L4 and its
  // 5000.00 of won premium. Without this row, dropping the `ba.slot = 'rm'` condition from
  // `owner.ts` is an undetectable mutation, because every other assignment in the corpus is an
  // `rm` one and the two definitions of ownership coincide.
  const l4Id = leadIdByKey.get('L4');
  if (l4Id === undefined) throw new Error('corpus is missing lead L4');
  await query(
    `insert into lead_assignments
       (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())`,
    [tenantId, l4Id, underwriterAssignmentId, aliceUserId],
  );

  // Retire the cover-gaps reason AFTER the historical lead that used it — P-04's actual shape.
  await query('update reference_items set is_active = false where tenant_id = $1 and id = $2', [
    tenantId,
    coverGapsReasonId,
  ]);

  await query(
    `insert into tenant_settings
       (tenant_id, currency_code, currency_symbol, sla_received_to_sent_days, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (tenant_id) do update
        set currency_code = excluded.currency_code,
            sla_received_to_sent_days = excluded.sla_received_to_sent_days`,
    [tenantId, CURRENCY_CODE, 'KSh', SLA_TARGET_DAYS],
  );

  return {
    partyTypeId,
    regionR1,
    regionR2,
    channelId,
    productP1,
    productP2,
    coverP1,
    coverP2,
    brokerTypeT1,
    brokerTypeT2,
    brokerB1,
    brokerB2,
    priceReasonId,
    coverGapsReasonId,
    rmAssignmentId,
    underwriterAssignmentId,
    statusByCategory,
    leadIdByKey,
    quoteIdByKey,
    b1Name,
    b2Name,
  };
}
