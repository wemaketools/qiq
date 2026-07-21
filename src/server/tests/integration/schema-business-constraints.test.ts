/**
 * T-005 / AC-004, AC-005, AC-008 — V-005, V-006, V-009.
 *
 * Negative-insert coverage for every constraint T-005's migrations carry (parties, brokers,
 * broker_contacts, leads, lead_assignments, lead_notes, quotes, quote_versions, quote_assignments,
 * quote_attachments, follow_ups, pricing_approvals, lead_status_history, quote_status_history,
 * alerts, user_alert_views), plus the partitioning behaviour that makes them tenant-scoped.
 *
 * Every constraint case asserts the actual SQLSTATE raised by a deliberately violating statement.
 * Asserting a constraint is merely LISTED in pg_constraint/pg_indexes proves nothing about
 * enforcement: a NOT VALID, mis-targeted, or partition-local constraint would still appear in the
 * catalog while happily accepting the row it is supposed to reject. The alerts partial-unique in
 * particular is easy to get catalog-correct and behaviourally wrong (see the COALESCE cases below),
 * which is why it is exercised from both sides rather than inspected.
 *
 * Each negative case is paired with POSITIVE boundary cases. A constraint that rejected every row
 * would satisfy all the negative assertions on its own, so the positives pin where each rule stops.
 *
 * All work happens inside one transaction with a savepoint per case, so the suite leaves no rows
 * behind and the cases are order-independent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type DatabaseError } from 'pg';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('core business schema constraints (T-005)', probe);

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

/** Every table T-005 creates, all LIST-partitioned on tenant_id. */
const PARTITIONED_TABLES = [
  'alerts',
  'broker_contacts',
  'brokers',
  'follow_ups',
  'lead_assignments',
  'lead_notes',
  'lead_status_history',
  'leads',
  'parties',
  'pricing_approvals',
  'quote_assignments',
  'quote_attachments',
  'quote_status_history',
  'quote_versions',
  'quotes',
  'user_alert_views',
] as const;

const HISTORY_TABLES = ['lead_status_history', 'quote_status_history'] as const;

interface Fixtures {
  tenantId: string;
  otherTenantId: string;
  brokerId: string;
  otherBrokerId: string;
  partyId: string;
  leadId: string;
  otherLeadId: string;
  quoteId: string;
  otherQuoteId: string;
  assignmentId: string;
}

describeStack(title, () => {
  let client: Client;
  let f: Fixtures;

  beforeAll(async () => {
    if (!probe.available) return;
    client = new Client({ connectionString: probe.stack.dbUrl });
    await client.connect();
    await client.query('begin');

    const suffix = `t005c${process.pid}`;

    const tenant = await client.query<{ id: string }>(
      `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
      [`tenant-${suffix}`],
    );
    const otherTenant = await client.query<{ id: string }>(
      `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
      [`tenant-other-${suffix}`],
    );
    const tenantId = tenant.rows[0]!.id;
    const otherTenantId = otherTenant.rows[0]!.id;

    // Slot row for the assignment uniqueness cases; needs a role to point at.
    const role = await client.query<{ id: string }>(
      `insert into roles (tenant_id, name, created_at, updated_at)
       values ($1, $2, now(), now()) returning id`,
      [tenantId, `role-${suffix}`],
    );
    const assignment = await client.query<{ id: string }>(
      `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
       values ($1, $2, 'rm', now(), now()) returning id`,
      [tenantId, role.rows[0]!.id],
    );

    const broker = await client.query<{ id: string }>(
      `insert into brokers (tenant_id, name, created_at, updated_at)
       values ($1, $2, now(), now()) returning id`,
      [tenantId, `broker-${suffix}`],
    );
    const otherBroker = await client.query<{ id: string }>(
      `insert into brokers (tenant_id, name, created_at, updated_at)
       values ($1, $2, now(), now()) returning id`,
      [tenantId, `broker-other-${suffix}`],
    );

    const party = await client.query<{ id: string }>(
      `insert into parties (tenant_id, name, party_type_id, created_at, updated_at)
       values ($1, $2, 1, now(), now()) returning id`,
      [tenantId, `party-${suffix}`],
    );

    const insertLead = async (ref: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                            region_id, product_line_id, cover_type_id, policy_term, status_id,
                            source, created_at, updated_at)
         values ($1, $2, $3, current_date, 1, 1, 1, 1, 'm12', 1, 'browser', now(), now())
         returning id`,
        [tenantId, party.rows[0]!.id, ref],
      );
      return rows[0]!.id;
    };
    const leadId = await insertLead(`LEAD-${suffix}-1`);
    const otherLeadId = await insertLead(`LEAD-${suffix}-2`);

    const insertQuote = async (ref: string, lead: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `insert into quotes (tenant_id, lead_id, quote_ref, status_id, product_line_id,
                             cover_type_id, prepared_date, created_at, updated_at)
         values ($1, $2, $3, 1, 1, 1, current_date, now(), now()) returning id`,
        [tenantId, lead, ref],
      );
      return rows[0]!.id;
    };
    const quoteId = await insertQuote(`QUO-${suffix}-1`, leadId);
    const otherQuoteId = await insertQuote(`QUO-${suffix}-2`, otherLeadId);

    f = {
      tenantId,
      otherTenantId,
      brokerId: broker.rows[0]!.id,
      otherBrokerId: otherBroker.rows[0]!.id,
      partyId: party.rows[0]!.id,
      leadId,
      otherLeadId,
      quoteId,
      otherQuoteId,
      assignmentId: assignment.rows[0]!.id,
    };

    // Seed one row per table so the duplicate cases below have something to collide with.
    await client.query(
      `insert into broker_contacts (tenant_id, broker_id, name, is_primary, created_at, updated_at)
       values ($1, $2, 'Primary Contact', true, now(), now())`,
      [f.tenantId, f.brokerId],
    );
    await client.query(
      `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
       values ($1, $2, 1, 1000.00, true, now())`,
      [f.tenantId, f.quoteId],
    );
    await client.query(
      `insert into lead_assignments (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, 1, now(), now())`,
      [f.tenantId, f.leadId, f.assignmentId],
    );
    await client.query(
      `insert into quote_assignments (tenant_id, quote_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, 1, now(), now())`,
      [f.tenantId, f.quoteId, f.assignmentId],
    );
    await client.query(
      `insert into user_alert_views (tenant_id, user_id, last_opened_at) values ($1, 1, now())`,
      [f.tenantId],
    );
    // A quote-level and a lead-level open alert, for the uniqueness cases.
    await client.query(
      `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
       values ($1, 'stalled_quote', $2, $3, 'high', now())`,
      [f.tenantId, f.leadId, f.quoteId],
    );
    await client.query(
      `insert into alerts (tenant_id, type, lead_id, severity, created_at)
       values ($1, 'stalled_lead', $2, 'medium', now())`,
      [f.tenantId, f.leadId],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  });

  /** Runs a statement inside a savepoint and returns the SQLSTATE it raised, or null. */
  async function violationCode(sql: string, params: readonly unknown[]): Promise<string | null> {
    await client.query('savepoint negative_case');
    try {
      await client.query(sql, [...params]);
      await client.query('release savepoint negative_case');
      return null;
    } catch (error) {
      await client.query('rollback to savepoint negative_case');
      return (error as DatabaseError).code ?? 'unknown';
    }
  }

  /** Runs statements that must ALL succeed, then unwinds them. */
  async function inSavepoint(name: string, body: () => Promise<void>): Promise<void> {
    await client.query(`savepoint ${name}`);
    try {
      await body();
    } finally {
      await client.query(`rollback to savepoint ${name}`);
    }
  }

  interface Case {
    constraint: string;
    expected: string;
    sql: string;
    params: () => readonly unknown[];
  }

  const cases: Case[] = [
    // ---- brokers ---------------------------------------------------------------------------
    {
      constraint: 'uq_brokers_tenant_name (duplicate broker name in one tenant)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into brokers (tenant_id, name, created_at, updated_at)
            values ($1, $2, now(), now())`,
      params: () => [f.tenantId, `broker-t005c${process.pid}`],
    },
    {
      constraint: 'ck_brokers_status (invented third status)',
      expected: CHECK_VIOLATION,
      sql: `insert into brokers (tenant_id, name, status, created_at, updated_at)
            values ($1, $2, 'archived', now(), now())`,
      params: () => [f.tenantId, `broker-bad-status-${process.pid}`],
    },

    // ---- broker_contacts: the one-primary-contact discipline --------------------------------
    {
      constraint: 'uq_broker_contacts_primary (second primary contact for one broker)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into broker_contacts (tenant_id, broker_id, name, is_primary, created_at, updated_at)
            values ($1, $2, 'Second Primary', true, now(), now())`,
      params: () => [f.tenantId, f.brokerId],
    },

    // ---- leads -----------------------------------------------------------------------------
    {
      constraint: 'uq_leads_tenant_lead_ref (duplicate lead_ref in one tenant)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                               region_id, product_line_id, cover_type_id, policy_term, status_id,
                               source, created_at, updated_at)
            values ($1, $2, $3, current_date, 1, 1, 1, 1, 'm12', 1, 'browser', now(), now())`,
      params: () => [f.tenantId, f.partyId, `LEAD-t005c${process.pid}-1`],
    },
    {
      constraint: 'ck_leads_policy_term (unknown policy term)',
      expected: CHECK_VIOLATION,
      sql: `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                               region_id, product_line_id, cover_type_id, policy_term, status_id,
                               source, created_at, updated_at)
            values ($1, $2, $3, current_date, 1, 1, 1, 1, 'm18', 1, 'browser', now(), now())`,
      params: () => [f.tenantId, f.partyId, `LEAD-bad-term-${process.pid}`],
    },
    {
      constraint: 'ck_leads_priority (unknown priority)',
      expected: CHECK_VIOLATION,
      sql: `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                               region_id, product_line_id, cover_type_id, policy_term, priority,
                               status_id, source, created_at, updated_at)
            values ($1, $2, $3, current_date, 1, 1, 1, 1, 'm12', 'urgent', 1, 'browser', now(), now())`,
      params: () => [f.tenantId, f.partyId, `LEAD-bad-prio-${process.pid}`],
    },
    {
      // 'api' vs 'browser' is what makes an intake-ingested lead attributable; a third value would
      // create a phantom source bucket in every report that groups by it.
      constraint: 'ck_leads_source (unknown source)',
      expected: CHECK_VIOLATION,
      sql: `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                               region_id, product_line_id, cover_type_id, policy_term, status_id,
                               source, created_at, updated_at)
            values ($1, $2, $3, current_date, 1, 1, 1, 1, 'm12', 1, 'import', now(), now())`,
      params: () => [f.tenantId, f.partyId, `LEAD-bad-source-${process.pid}`],
    },
    {
      constraint: 'ck_leads_pricing_approval_state (unknown approval state)',
      expected: CHECK_VIOLATION,
      sql: `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                               region_id, product_line_id, cover_type_id, policy_term, status_id,
                               pricing_approval_state, source, created_at, updated_at)
            values ($1, $2, $3, current_date, 1, 1, 1, 1, 'm12', 1, 'escalated', 'browser', now(), now())`,
      params: () => [f.tenantId, f.partyId, `LEAD-bad-pas-${process.pid}`],
    },
    {
      // Q-9: the lead's own region is a required reporting dimension, unlike the party's.
      constraint: 'leads.region_id NOT NULL (required reporting dimension, Q-9)',
      expected: NOT_NULL_VIOLATION,
      sql: `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                               region_id, product_line_id, cover_type_id, policy_term, status_id,
                               source, created_at, updated_at)
            values ($1, $2, $3, current_date, 1, null, 1, 1, 'm12', 1, 'browser', now(), now())`,
      params: () => [f.tenantId, f.partyId, `LEAD-no-region-${process.pid}`],
    },

    // ---- lead_assignments / quote_assignments (slot uniqueness) -----------------------------
    {
      constraint: 'uq_lead_assignments_tenant_lead_role (two assignees in one slot on one lead)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into lead_assignments (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
            values ($1, $2, $3, 999, now(), now())`,
      params: () => [f.tenantId, f.leadId, f.assignmentId],
    },
    {
      constraint: 'uq_quote_assignments_tenant_quote_role (two assignees in one slot on one quote)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into quote_assignments (tenant_id, quote_id, business_assignment_id, user_id, created_at, updated_at)
            values ($1, $2, $3, 999, now(), now())`,
      params: () => [f.tenantId, f.quoteId, f.assignmentId],
    },

    // ---- quotes / quote_versions -------------------------------------------------------------
    {
      constraint: 'uq_quotes_tenant_quote_ref (duplicate quote_ref in one tenant)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into quotes (tenant_id, lead_id, quote_ref, status_id, product_line_id,
                                cover_type_id, prepared_date, created_at, updated_at)
            values ($1, $2, $3, 1, 1, 1, current_date, now(), now())`,
      params: () => [f.tenantId, f.leadId, `QUO-t005c${process.pid}-1`],
    },
    {
      constraint: 'uq_quote_versions_tenant_quote_version (duplicate version_no on one quote)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, created_at)
            values ($1, $2, 1, 2000.00, now())`,
      params: () => [f.tenantId, f.quoteId],
    },
    {
      // The one-current-version discipline. Without this a concurrent Revise pair double-counts
      // quoted premium in every dashboard joining quote.is_current AND version.is_current.
      constraint: 'uq_quote_versions_current (second current version on one quote)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
            values ($1, $2, 2, 2000.00, true, now())`,
      params: () => [f.tenantId, f.quoteId],
    },
    {
      constraint: 'quote_versions.quoted_premium NOT NULL (a version must carry a price)',
      expected: NOT_NULL_VIOLATION,
      sql: `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, created_at)
            values ($1, $2, 9, null, now())`,
      params: () => [f.tenantId, f.quoteId],
    },

    // ---- quote_attachments -------------------------------------------------------------------
    {
      constraint: 'quote_attachments.storage_key NOT NULL (a row that names no object)',
      expected: NOT_NULL_VIOLATION,
      sql: `insert into quote_attachments (tenant_id, quote_id, file_name, content_type, size_bytes,
                                           storage_key, uploaded_at)
            values ($1, $2, 'policy.pdf', 'application/pdf', 1024, null, now())`,
      params: () => [f.tenantId, f.quoteId],
    },

    // ---- pricing_approvals ---------------------------------------------------------------------
    {
      constraint: 'ck_pricing_approvals_state (unknown approval state)',
      expected: CHECK_VIOLATION,
      sql: `insert into pricing_approvals (tenant_id, lead_id, requested_by, requested_at,
                                           approver_id, state)
            values ($1, $2, 1, now(), 2, 'escalated')`,
      params: () => [f.tenantId, f.leadId],
    },

    // ---- follow_ups -----------------------------------------------------------------------------
    {
      constraint: 'follow_ups.outcome_note NOT NULL (a follow-up with no recorded outcome)',
      expected: NOT_NULL_VIOLATION,
      sql: `insert into follow_ups (tenant_id, lead_id, follow_up_date, outcome_note, logged_at)
            values ($1, $2, current_date, null, now())`,
      params: () => [f.tenantId, f.leadId],
    },

    // ---- alerts ---------------------------------------------------------------------------------
    {
      constraint: 'alerts_type_check (unrecognised alert type)',
      expected: CHECK_VIOLATION,
      sql: `insert into alerts (tenant_id, type, lead_id, severity, created_at)
            values ($1, 'made_up_alert', $2, 'high', now())`,
      params: () => [f.tenantId, f.leadId],
    },
    {
      constraint: 'alerts.lead_id NOT NULL (every alert hangs off a lead)',
      expected: NOT_NULL_VIOLATION,
      sql: `insert into alerts (tenant_id, type, lead_id, severity, created_at)
            values ($1, 'stalled_lead', null, 'high', now())`,
      params: () => [f.tenantId],
    },
    {
      // THE Job-3 idempotency guarantee (spec §9.5): a duplicate OPEN quote-level alert.
      constraint: 'uq_alerts_open_per_type_lead_quote (duplicate open alert, quote-level)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
            values ($1, 'stalled_quote', $2, $3, 'high', now())`,
      params: () => [f.tenantId, f.leadId, f.quoteId],
    },
    {
      // The COALESCE(quote_id, 0) half. Without it these rows compare NULL <> NULL and every
      // lead-level alert would be "distinct", enforcing nothing at all for exactly the alerts
      // that have no quote — a catalog-correct, behaviourally useless index.
      constraint: 'uq_alerts_open_per_type_lead_quote (duplicate open alert, lead-level/NULL quote)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into alerts (tenant_id, type, lead_id, severity, created_at)
            values ($1, 'stalled_lead', $2, 'medium', now())`,
      params: () => [f.tenantId, f.leadId],
    },

    // ---- user_alert_views -------------------------------------------------------------------------
    {
      constraint: 'uq_user_alert_views_tenant_user (two badge rows for one user in one tenant)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into user_alert_views (tenant_id, user_id, last_opened_at) values ($1, 1, now())`,
      params: () => [f.tenantId],
    },
  ];

  it.each(cases)('rejects a row violating $constraint', async ({ sql, params, expected }) => {
    expect(await violationCode(sql, params())).toBe(expected);
  });

  // ==========================================================================================
  // POSITIVE BOUNDARY CASES. A constraint that rejected everything would pass every negative
  // case above; these pin where each rule stops so an over-broad constraint fails loudly.
  // ==========================================================================================

  it('allows unlimited NON-primary contacts per broker, and one primary per OTHER broker/tenant', async () => {
    await inSavepoint('primary_scope', async () => {
      // The partial index must not limit a broker to one contact — only to one PRIMARY contact.
      for (const name of ['Second', 'Third', 'Fourth']) {
        await client.query(
          `insert into broker_contacts (tenant_id, broker_id, name, is_primary, created_at, updated_at)
           values ($1, $2, $3, false, now(), now())`,
          [f.tenantId, f.brokerId, name],
        );
      }
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from broker_contacts where tenant_id = $1 and broker_id = $2`,
        [f.tenantId, f.brokerId],
      );
      expect(rows[0]!.count, 'one primary plus three non-primary contacts must coexist').toBe('4');

      // A different broker in the same tenant may have its own primary.
      await client.query(
        `insert into broker_contacts (tenant_id, broker_id, name, is_primary, created_at, updated_at)
         values ($1, $2, 'Other Broker Primary', true, now(), now())`,
        [f.tenantId, f.otherBrokerId],
      );
    });
  });

  it('allows unlimited NON-current versions per quote, and one current per OTHER quote', async () => {
    await inSavepoint('current_version_scope', async () => {
      for (const versionNo of [2, 3, 4]) {
        await client.query(
          `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
           values ($1, $2, $3, 1500.00, false, now())`,
          [f.tenantId, f.quoteId, versionNo],
        );
      }
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from quote_versions where tenant_id = $1 and quote_id = $2`,
        [f.tenantId, f.quoteId],
      );
      expect(rows[0]!.count, 'one current plus three superseded versions must coexist').toBe('4');

      // A different quote may have its own current version.
      await client.query(
        `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
         values ($1, $2, 1, 3000.00, true, now())`,
        [f.tenantId, f.otherQuoteId],
      );
    });
  });

  it('lets a RESOLVED alert be followed by a new OPEN alert for the same type+lead+quote', async () => {
    // This is the property that makes reconciliation re-triggerable: resolving an alert must
    // release the uniqueness slot, or a condition that recurs after being cleared would be
    // permanently unreportable.
    await inSavepoint('alert_recurrence', async () => {
      await client.query(
        `update alerts set resolved_at = now(), resolved_reason = 'condition cleared'
          where tenant_id = $1 and type = 'stalled_quote' and lead_id = $2 and quote_id = $3`,
        [f.tenantId, f.leadId, f.quoteId],
      );
      await client.query(
        `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
         values ($1, 'stalled_quote', $2, $3, 'high', now())`,
        [f.tenantId, f.leadId, f.quoteId],
      );
      const { rows } = await client.query<{ open: string; total: string }>(
        `select count(*) filter (where resolved_at is null)::text as open,
                count(*)::text as total
           from alerts where tenant_id = $1 and type = 'stalled_quote' and lead_id = $2`,
        [f.tenantId, f.leadId],
      );
      expect(rows[0], 'exactly one open alert alongside the retained resolved history').toEqual({
        open: '1',
        total: '2',
      });
    });
  });

  it('allows MANY resolved alerts for the same type+lead+quote (history is not uniqueness-bound)', async () => {
    await inSavepoint('resolved_history', async () => {
      await client.query(
        `update alerts set resolved_at = now() where tenant_id = $1 and type = 'stalled_lead' and lead_id = $2`,
        [f.tenantId, f.leadId],
      );
      for (let i = 0; i < 3; i += 1) {
        await client.query(
          `insert into alerts (tenant_id, type, lead_id, severity, created_at, resolved_at)
           values ($1, 'stalled_lead', $2, 'medium', now(), now())`,
          [f.tenantId, f.leadId],
        );
      }
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from alerts
          where tenant_id = $1 and type = 'stalled_lead' and lead_id = $2 and resolved_at is not null`,
        [f.tenantId, f.leadId],
      );
      expect(rows[0]!.count, 'resolved alerts must accumulate freely').toBe('4');
    });
  });

  it('scopes open-alert uniqueness by type, lead, quote AND tenant rather than collapsing them', async () => {
    // Each insert differs from the seeded open alert in exactly ONE dimension. If any of these is
    // rejected, the index is over-broad and would suppress genuinely distinct alerts.
    await inSavepoint('alert_dimensions', async () => {
      // Different type, same lead+quote.
      await client.query(
        `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
         values ($1, 'quote_expiring', $2, $3, 'high', now())`,
        [f.tenantId, f.leadId, f.quoteId],
      );
      // Same type, different lead.
      await client.query(
        `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
         values ($1, 'stalled_quote', $2, $3, 'high', now())`,
        [f.tenantId, f.otherLeadId, f.otherQuoteId],
      );
      // Same type and lead, different quote.
      await client.query(
        `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
         values ($1, 'stalled_quote', $2, $3, 'high', now())`,
        [f.tenantId, f.leadId, f.otherQuoteId],
      );
      // Same type and lead, quote-level vs lead-level: COALESCE maps NULL to 0, which must NOT
      // collide with a real quote id.
      await client.query(
        `insert into alerts (tenant_id, type, lead_id, severity, created_at)
         values ($1, 'stalled_quote', $2, 'high', now())`,
        [f.tenantId, f.leadId],
      );
      // Same everything, different tenant: uniqueness is per-tenant.
      await client.query(
        `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
         values ($1, 'stalled_quote', $2, $3, 'high', now())`,
        [f.otherTenantId, f.leadId, f.quoteId],
      );
    });
  });

  it('allows every valid alert type, so the check constraint is not accidentally narrow', async () => {
    const types = [
      'unassigned_lead', 'overdue_follow_up', 'stalled_lead', 'stalled_quote',
      'quote_expiring', 'quote_expired', 'sla_breach', 'high_value_stalled',
      'pending_pricing_approval', 'awaiting_underwriting', 'executive_escalation',
    ];
    await inSavepoint('alert_types', async () => {
      for (const [index, type] of types.entries()) {
        await client.query(
          `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
           values ($1, $2, $3, $4, 'low', now())`,
          [f.otherTenantId, type, f.otherLeadId, 1000 + index],
        );
      }
      const { rows } = await client.query<{ count: string }>(
        `select count(distinct type)::text as count from alerts where tenant_id = $1`,
        [f.otherTenantId],
      );
      expect(rows[0]!.count, 'all eleven declared alert types must be insertable').toBe(
        String(types.length),
      );
    });
  });

  it('allows every valid policy term, priority, source and pricing approval state on leads', async () => {
    await inSavepoint('lead_enums', async () => {
      const terms = ['m6', 'm12', 'm24', 'm36', 'other'];
      const priorities = ['normal', 'high'];
      const sources = ['browser', 'api'];
      const states = ['none', 'pending', 'approved', 'rejected'];
      let n = 0;
      for (const term of terms) {
        for (const priority of priorities) {
          for (const source of sources) {
            for (const state of states) {
              n += 1;
              await client.query(
                `insert into leads (tenant_id, party_id, lead_ref, date_received, request_channel_id,
                                    region_id, product_line_id, cover_type_id, policy_term, priority,
                                    status_id, pricing_approval_state, source, created_at, updated_at)
                 values ($1, $2, $3, current_date, 1, 1, 1, 1, $4, $5, 1, $6, $7, now(), now())`,
                [f.otherTenantId, f.partyId, `COMBO-${n}`, term, priority, state, source],
              );
            }
          }
        }
      }
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from leads where tenant_id = $1`,
        [f.otherTenantId],
      );
      expect(rows[0]!.count, 'every valid enum combination must be accepted').toBe(String(n));
    });
  });

  it('allows a party with no region, no segment and no industry (Q-9: never required)', async () => {
    await inSavepoint('party_optionals', async () => {
      await client.query(
        `insert into parties (tenant_id, name, party_type_id, created_at, updated_at)
         values ($1, 'Region-less Party', 1, now(), now())`,
        [f.tenantId],
      );
      // And duplicate party names are permitted (FR-28: warning, not rejection).
      await client.query(
        `insert into parties (tenant_id, name, party_type_id, created_at, updated_at)
         values ($1, 'Region-less Party', 1, now(), now())`,
        [f.tenantId],
      );
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from parties where tenant_id = $1 and name = 'Region-less Party'`,
        [f.tenantId],
      );
      expect(rows[0]!.count, 'duplicate party names must be allowed (FR-28)').toBe('2');
    });
  });

  it('allows a soft-removed attachment alongside live ones (removed_at is the only delete path)', async () => {
    await inSavepoint('attachment_soft_remove', async () => {
      await client.query(
        `insert into quote_attachments (tenant_id, quote_id, file_name, content_type, size_bytes,
                                        storage_key, uploaded_at)
         values ($1, $2, 'live.pdf', 'application/pdf', 10, $3, now())`,
        [f.tenantId, f.quoteId, `tenant-${f.tenantId}/quotes/${f.quoteId}/live.pdf`],
      );
      await client.query(
        `insert into quote_attachments (tenant_id, quote_id, file_name, content_type, size_bytes,
                                        storage_key, uploaded_at, removed_at, removed_by)
         values ($1, $2, 'gone.pdf', 'application/pdf', 10, $3, now(), now(), 7)`,
        [f.tenantId, f.quoteId, `tenant-${f.tenantId}/quotes/${f.quoteId}/gone.pdf`],
      );
      const { rows } = await client.query<{ live: string; removed: string }>(
        `select count(*) filter (where removed_at is null)::text as live,
                count(*) filter (where removed_at is not null)::text as removed
           from quote_attachments where tenant_id = $1 and quote_id = $2`,
        [f.tenantId, f.quoteId],
      );
      expect(rows[0]).toEqual({ live: '1', removed: '1' });
    });
  });

  it('stores money at numeric(18,2) precision without truncating to integers', async () => {
    await inSavepoint('money_precision', async () => {
      const { rows } = await client.query<{ quoted_premium: string }>(
        `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, created_at)
         values ($1, $2, 77, 12345678901234.56, now())
         returning quoted_premium::text as quoted_premium`,
        [f.tenantId, f.quoteId],
      );
      expect(rows[0]!.quoted_premium, 'numeric(18,2) must keep both decimal places').toBe(
        '12345678901234.56',
      );
    });
  });

  // ==========================================================================================
  // History tables: append-only is an APPLICATION discipline here, matching the reference.
  // ==========================================================================================

  it('accepts history rows with a jsonb inputs payload and a null status delta', async () => {
    await inSavepoint('history_insert', async () => {
      await client.query(
        `insert into lead_status_history (tenant_id, lead_id, operation, previous_status_id,
                                          new_status_id, acted_by, acted_at, inputs)
         values ($1, $2, 'assign', null, null, 5, now(), $3::jsonb)`,
        [f.tenantId, f.leadId, JSON.stringify({ note: 'captured dialog input' })],
      );
      await client.query(
        `insert into quote_status_history (tenant_id, quote_id, operation, acted_at, inputs)
         values ($1, $2, 'send', now(), null)`,
        [f.tenantId, f.quoteId],
      );
      const { rows } = await client.query<{ note: string | null }>(
        `select inputs->>'note' as note from lead_status_history where tenant_id = $1 and lead_id = $2`,
        [f.tenantId, f.leadId],
      );
      expect(rows[0]!.note).toBe('captured dialog input');
    });
  });

  it('carries NO update/delete guard on the history tables, matching the .NET reference exactly', async () => {
    // Documented deliberately rather than assumed: the reference database has no triggers and no
    // rules on either history table, so append-only is enforced by the application, not the
    // schema. Adding a guard here would be a silent behavioural divergence that a shape-based
    // schema diff could not see. This test states the real contract so nobody later "fixes" the
    // schema on the assumption that append-only is already enforced.
    const { rows } = await client.query<{ relname: string; guards: string }>(
      `select c.relname,
              (select count(*)::text from pg_trigger t
                where t.tgrelid = c.oid and not t.tgisinternal) as guards
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])
        order by c.relname`,
      [[...HISTORY_TABLES]],
    );
    expect(rows).toEqual([
      { relname: 'lead_status_history', guards: '0' },
      { relname: 'quote_status_history', guards: '0' },
    ]);

    // ...and the consequence is observable: an UPDATE succeeds today.
    await inSavepoint('history_mutable', async () => {
      await client.query(
        `insert into lead_status_history (tenant_id, lead_id, operation, acted_at)
         values ($1, $2, 'note', now())`,
        [f.tenantId, f.leadId],
      );
      const { rowCount } = await client.query(
        `update lead_status_history set operation = 'edited' where tenant_id = $1 and lead_id = $2`,
        [f.tenantId, f.leadId],
      );
      expect(rowCount, 'history rows are physically mutable, as in the reference').toBeGreaterThan(0);
    });
  });

  // ==========================================================================================
  // Partitioning (A-12 / AC-005)
  // ==========================================================================================

  it('LIST-partitions every T-005 table on tenant_id', async () => {
    const { rows } = await client.query<{ relname: string; partstrat: string | null; partcol: string | null }>(
      `select c.relname, p.partstrat::text as partstrat,
              (select a.attname from pg_attribute a
                where a.attrelid = c.oid and a.attnum = p.partattrs[0]) as partcol
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_partitioned_table p on p.partrelid = c.oid
        where n.nspname = 'public' and c.relname = any($1::text[])
        order by c.relname`,
      [[...PARTITIONED_TABLES]],
    );
    expect(rows).toHaveLength(PARTITIONED_TABLES.length);
    for (const table of PARTITIONED_TABLES) {
      const row = rows.find((r) => r.relname === table);
      expect(row, `${table} must exist`).toBeDefined();
      expect(row!.partstrat, `${table} must be LIST-partitioned`).toBe('l');
      expect(row!.partcol, `${table} must be partitioned on tenant_id`).toBe('tenant_id');
    }
  });

  it('creates a DEFAULT partition safety net for every T-005 partitioned table', async () => {
    const { rows } = await client.query<{ parent: string }>(
      `select parent.relname as parent
         from pg_inherits i
         join pg_class child on child.oid = i.inhrelid
         join pg_class parent on parent.oid = i.inhparent
         join pg_namespace n on n.oid = parent.relnamespace
        where n.nspname = 'public'
          and parent.relname = any($1::text[])
          and pg_get_expr(child.relpartbound, child.oid) = 'DEFAULT'
        order by parent.relname`,
      [[...PARTITIONED_TABLES]],
    );
    expect(rows.map((r) => r.parent)).toEqual([...PARTITIONED_TABLES]);
  });

  it('routes rows into the tenant partition, not the DEFAULT one, after create_tenant_partitions', async () => {
    // Behavioural, not catalog-based: T-003's partition function is catalog-driven, so the claim
    // that it picks up T-005's new tables automatically has to be demonstrated by watching where a
    // row actually lands. tableoid names the physical partition holding the row.
    await inSavepoint('partition_routing', async () => {
      const tenant = await client.query<{ id: string }>(
        `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
        [`tenant-routing-${process.pid}`],
      );
      const tenantId = tenant.rows[0]!.id;
      await client.query('select create_tenant_partitions($1)', [tenantId]);

      // Every T-005 table must now have a dedicated partition for this tenant.
      const { rows: created } = await client.query<{ count: string }>(
        `select count(*)::text as count
           from pg_inherits i
           join pg_class child on child.oid = i.inhrelid
           join pg_class parent on parent.oid = i.inhparent
           join pg_namespace n on n.oid = parent.relnamespace
          where n.nspname = 'public'
            and parent.relname = any($1::text[])
            and child.relname = parent.relname || '_p' || $2`,
        [[...PARTITIONED_TABLES], tenantId],
      );
      expect(created[0]!.count, 'a partition per T-005 table must be created').toBe(
        String(PARTITIONED_TABLES.length),
      );

      // And an actual insert must land there rather than in the default partition.
      const party = await client.query<{ id: string; partition: string }>(
        `insert into parties (tenant_id, name, party_type_id, created_at, updated_at)
         values ($1, 'Routed Party', 1, now(), now())
         returning id, tableoid::regclass::text as partition`,
        [tenantId],
      );
      expect(party.rows[0]!.partition).toBe(`parties_p${tenantId}`);

      const alert = await client.query<{ partition: string }>(
        `insert into alerts (tenant_id, type, lead_id, severity, created_at)
         values ($1, 'stalled_lead', 1, 'low', now())
         returning tableoid::regclass::text as partition`,
        [tenantId],
      );
      expect(alert.rows[0]!.partition).toBe(`alerts_p${tenantId}`);

      // The uniqueness guarantee must hold INSIDE the dedicated partition too, not just in the
      // default one — a partition-local index gap would be invisible to every test above.
      const duplicate = await violationCode(
        `insert into alerts (tenant_id, type, lead_id, severity, created_at)
         values ($1, 'stalled_lead', 1, 'low', now())`,
        [tenantId],
      );
      expect(duplicate, 'open-alert uniqueness must hold within the tenant partition').toBe(
        UNIQUE_VIOLATION,
      );
    });
  });
});
