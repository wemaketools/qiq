/**
 * Alert reconciliation against a real database (T-033; AC-069, AC-072; V-086, V-090).
 *
 * Port of `AlertEvaluationJobTests` / `AlertStoreTests`, and deliberately the same shape as the
 * other T-0xx integration suites: real tenants with real partitions, real reference data, real
 * leads and quotes, and the real reconciliation code. Nothing is stubbed, because the properties
 * under test — convergence, resolution, and tenant isolation — are properties of the composed
 * system against Postgres, not of the pure rules (those are pinned in `unit/alert-rules.test.ts`).
 *
 * HOW THE EXPECTATIONS ARE DERIVED
 * ================================
 * Twelve leads are seeded, each engineered around a KNOWN offset from a fixed evaluation instant,
 * and the expected alert-type set for every one of them is written out BY HAND in `EXPECTED` below
 * from the reference's predicates — including the overlaps (a high-value stalled lead legitimately
 * raises four types at once) and one deliberately clean lead that must raise nothing. The
 * assertions compare the database against that hand-computed table, so a rule and its test cannot
 * agree by sharing an implementation.
 *
 * WHY THE FULL SWEEP IS EXERCISED ONLY IN THE LAST TWO TESTS
 * =========================================================
 * `runAlertEvaluationSweep` walks EVERY active tenant in the database — that is its whole job. In
 * a shared local stack that includes the demo seed and whatever other suites are running, so the
 * sweep tests assert per-tenant outcomes and tolerate other tenants being reconciled alongside
 * (which is exactly what happens in production). Everything else drives `reconcileTenantAlerts`
 * for one tenant directly, which is the same code path with the tenant loop removed.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RULE_CLEARED_REASON,
  evaluateForLead,
  reconcileTenantAlerts,
} from '../../domains/alerts/index.js';
import {
  ALERT_EVALUATION_JOB_NAME,
  createAlertEvaluationHandler,
  runAlertEvaluationSweep,
} from '../../jobs/cron/alert-evaluation.js';
import { runCronJob } from '../../jobs/cron/run-cron-job.js';
import { PgJobRunRepository } from '../../jobs/job-run-repository.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, toTenantId, type Database } from '../../lib/db/index.js';
import { jobLogger } from '../../lib/logging/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('alert evaluation', probe);

const RUN = `t033ev-${process.pid}-${Date.now()}`;

/** The fixed evaluation instant every fixture offset is measured from. */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const TODAY = '2026-06-15';

/** Thresholds provisioned on every tenant this suite creates. */
const THRESHOLDS = {
  unassignedLeadHours: 24,
  stalledLeadDays: 7,
  stalledQuoteDays: 5,
  quoteExpiryAlertDays: 7,
  pricingApprovalTargetDays: 3,
  slaAssignmentDays: 1,
  slaUnderwritingDays: 3,
  slaReceivedToSentDays: 5,
  highValueThreshold: '1000000.00',
} as const;

function at(offset: { days?: number; hours?: number }): Date {
  const days = offset.days ?? 0;
  const hours = offset.hours ?? 0;
  return new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000);
}

function dateOffset(offsetDays: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The hand-computed truth table. Keys are fixture labels; values are the alert types that lead MUST
 * raise, derived from the reference predicates and the offsets in `seedTenantFixtures` below.
 */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // new, 30h old: unassigned (30h > 24h) AND assignment SLA (1.25d > 1d).
  unassigned: ['unassigned_lead', 'sla_breach'],
  // follow-up due yesterday, everything else fresh.
  overdue: ['overdue_follow_up'],
  // idle 8d with no quote: stalled (8 > 7) AND received-to-sent SLA (8d > 5d).
  stalledLead: ['stalled_lead', 'sla_breach'],
  // idle 6d WITH an open quote: stalled_quote (6 > 5) only — a quote exists, so neither the
  // stalled_lead population nor the received-to-sent SLA leg applies.
  stalledQuote: ['stalled_quote'],
  // valid_until 3 days out, within the 7-day threshold.
  expiring: ['quote_expiring'],
  // valid_until yesterday.
  expired: ['quote_expired'],
  // 6 days old with no quote: received-to-sent SLA only (idle 1h, so not stalled).
  slaOnly: ['sla_breach'],
  // 2,000,000 estimate, idle 8d, no quote: high-value stalled, plain stalled, received-to-sent SLA,
  // and executive escalation (high-value AND stalled).
  highValue: ['high_value_stalled', 'stalled_lead', 'sla_breach', 'executive_escalation'],
  // approval pending 4d (> 3d target); a far-future quote keeps every other rule quiet.
  pricing: ['pending_pricing_approval'],
  // in underwriting 4d (> 3d SLA); a far-future quote keeps every other rule quiet.
  underwriting: ['awaiting_underwriting'],
  // strategic party idle 8d with a LOW premium: escalation via the strategic leg, plus stalled and
  // the received-to-sent SLA.
  strategic: ['executive_escalation', 'stalled_lead', 'sla_breach'],
  // The control. Fresh, quoted far in the future, nothing due: it must raise NOTHING.
  clean: [],
};

interface TenantFixture {
  readonly tenantId: number;
  readonly leads: Readonly<Record<string, number>>;
  readonly quotes: Readonly<Record<string, number>>;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let actor: TestUserSession;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Active, but deliberately NOT provisioned tenant_settings: the sweep's fault-injection tenant. */
  let brokenTenantId: number;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  async function insertReturningId(sql: string, params: unknown[]): Promise<number> {
    const rows = await query<{ id: string }>(sql, params);
    return Number(rows[0]?.id);
  }

  async function createTenant(label: string, provisionSettings = true): Promise<number> {
    const id = await insertReturningId(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-${label}`],
    );
    createdTenants.push(id);
    await query('select create_tenant_partitions($1)', [id]);

    if (provisionSettings) {
      await query(
        `insert into tenant_settings
           (tenant_id, unassigned_lead_hours, stalled_lead_days, stalled_quote_days,
            quote_expiry_alert_days, pricing_approval_target_days, sla_assignment_days,
            sla_underwriting_days, sla_received_to_sent_days, high_value_threshold,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, now(), now())`,
        [
          id,
          THRESHOLDS.unassignedLeadHours,
          THRESHOLDS.stalledLeadDays,
          THRESHOLDS.stalledQuoteDays,
          THRESHOLDS.quoteExpiryAlertDays,
          THRESHOLDS.pricingApprovalTargetDays,
          THRESHOLDS.slaAssignmentDays,
          THRESHOLDS.slaUnderwritingDays,
          THRESHOLDS.slaReceivedToSentDays,
          THRESHOLDS.highValueThreshold,
        ],
      );
    }
    return id;
  }

  async function seedRef(
    tenantId: number,
    listType: string,
    name: string,
    options: {
      reportingCategory?: string;
      canonicalKey?: string;
      productLineId?: number;
    } = {},
  ): Promise<number> {
    return await insertReturningId(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          product_line_id, created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, $6, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.productLineId ?? null,
      ],
    );
  }

  /**
   * Seeds one tenant's whole fixture graph and returns the ids. Every offset here is what makes
   * `EXPECTED` above true, so the two must be read together.
   */
  async function seedTenantFixtures(tenantId: number, marker: string): Promise<TenantFixture> {
    const partyType = await seedRef(tenantId, 'party_type', `${marker}-type`);
    const productLine = await seedRef(tenantId, 'product_line', `${marker}-motor`);
    const coverType = await seedRef(tenantId, 'cover_type', `${marker}-cover`, {
      productLineId: productLine,
    });
    const region = await seedRef(tenantId, 'region', `${marker}-region`);
    const channel = await seedRef(tenantId, 'request_channel', `${marker}-channel`);

    const statusNew = await seedRef(tenantId, 'lead_status', `${marker}-New`, {
      reportingCategory: 'open',
      canonicalKey: 'new',
    });
    const statusAssigned = await seedRef(tenantId, 'lead_status', `${marker}-Assigned`, {
      reportingCategory: 'open',
      canonicalKey: 'assigned',
    });
    const statusUnderwriting = await seedRef(tenantId, 'lead_status', `${marker}-Underwriting`, {
      reportingCategory: 'open',
      canonicalKey: 'underwriting',
    });
    const quoteStatusSent = await seedRef(tenantId, 'quote_status', `${marker}-Sent`, {
      reportingCategory: 'quoted',
      canonicalKey: 'sent',
    });

    const party = await insertReturningId(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, `${marker}-client`, partyType],
    );
    const strategicParty = await insertReturningId(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, true, now(), now()) returning id::text as id`,
      [tenantId, `${marker}-strategic-client`, partyType],
    );

    async function seedLead(options: {
      label: string;
      statusId: number;
      createdAt: Date;
      lastActivityAt: Date | null;
      nextFollowUpDate?: string | null;
      estimatedPremium?: string | null;
      pricingApprovalState?: string;
      partyId?: number;
    }): Promise<number> {
      return await insertReturningId(
        `insert into leads
           (tenant_id, party_id, lead_ref, date_received, request_channel_id, region_id,
            product_line_id, cover_type_id, estimated_premium, policy_term, priority, status_id,
            pricing_approval_state, next_follow_up_date, last_activity_at, source,
            created_at, updated_at)
         values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9::numeric, 'm12', 'normal', $10, $11,
                 $12::date, $13, 'browser', $14, now())
         returning id::text as id`,
        [
          tenantId,
          options.partyId ?? party,
          `${marker}-${options.label}`,
          TODAY,
          channel,
          region,
          productLine,
          coverType,
          options.estimatedPremium ?? null,
          options.statusId,
          options.pricingApprovalState ?? 'none',
          options.nextFollowUpDate ?? null,
          options.lastActivityAt,
          options.createdAt,
        ],
      );
    }

    async function seedQuote(
      leadId: number,
      label: string,
      validUntil: string | null,
      premium: string,
    ): Promise<number> {
      const quoteId = await insertReturningId(
        `insert into quotes
           (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
            prepared_date, valid_until, created_at, updated_at)
         values ($1, $2, $3, $4, true, $5, $6, $7::date, $8::date, now(), now())
         returning id::text as id`,
        [tenantId, leadId, `${marker}-${label}`, quoteStatusSent, productLine, coverType, TODAY, validUntil],
      );
      await query(
        `insert into quote_versions
           (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
         values ($1, $2, 1, $3::numeric, true, now())`,
        [tenantId, quoteId, premium],
      );
      return quoteId;
    }

    const leads: Record<string, number> = {};
    const quotes: Record<string, number> = {};

    leads.unassigned = await seedLead({
      label: 'unassigned',
      statusId: statusNew,
      createdAt: at({ hours: 30 }),
      lastActivityAt: at({ hours: 30 }),
    });

    leads.overdue = await seedLead({
      label: 'overdue',
      statusId: statusAssigned,
      createdAt: at({ days: 2 }),
      lastActivityAt: at({ hours: 1 }),
      nextFollowUpDate: dateOffset(-1),
    });

    leads.stalledLead = await seedLead({
      label: 'stalled-lead',
      statusId: statusAssigned,
      createdAt: at({ days: 8 }),
      lastActivityAt: at({ days: 8 }),
    });

    leads.stalledQuote = await seedLead({
      label: 'stalled-quote',
      statusId: statusAssigned,
      createdAt: at({ days: 20 }),
      lastActivityAt: at({ days: 6 }),
    });
    quotes.stalledQuote = await seedQuote(leads.stalledQuote, 'q-stalled', dateOffset(30), '250000.00');

    leads.expiring = await seedLead({
      label: 'expiring',
      statusId: statusAssigned,
      createdAt: at({ days: 2 }),
      lastActivityAt: at({ hours: 1 }),
    });
    quotes.expiring = await seedQuote(leads.expiring, 'q-expiring', dateOffset(3), '100.00');

    leads.expired = await seedLead({
      label: 'expired',
      statusId: statusAssigned,
      createdAt: at({ days: 2 }),
      lastActivityAt: at({ hours: 1 }),
    });
    quotes.expired = await seedQuote(leads.expired, 'q-expired', dateOffset(-1), '200.00');

    leads.slaOnly = await seedLead({
      label: 'sla-only',
      statusId: statusAssigned,
      createdAt: at({ days: 6 }),
      lastActivityAt: at({ hours: 1 }),
    });

    leads.highValue = await seedLead({
      label: 'high-value',
      statusId: statusAssigned,
      createdAt: at({ days: 20 }),
      lastActivityAt: at({ days: 8 }),
      estimatedPremium: '2000000.00',
    });

    leads.pricing = await seedLead({
      label: 'pricing',
      statusId: statusAssigned,
      createdAt: at({ days: 10 }),
      lastActivityAt: at({ hours: 1 }),
      pricingApprovalState: 'pending',
    });
    quotes.pricing = await seedQuote(leads.pricing, 'q-pricing', dateOffset(60), '300.00');
    await query(
      `insert into pricing_approvals
         (tenant_id, lead_id, requested_by, requested_at, approver_id, state)
       values ($1, $2, $3, $4, $3, 'pending')`,
      [tenantId, leads.pricing, appUserId(actor), at({ days: 4 })],
    );

    leads.underwriting = await seedLead({
      label: 'underwriting',
      statusId: statusUnderwriting,
      createdAt: at({ days: 10 }),
      lastActivityAt: at({ hours: 1 }),
    });
    quotes.underwriting = await seedQuote(leads.underwriting, 'q-uw', dateOffset(60), '400.00');
    await query(
      `insert into lead_status_history (tenant_id, lead_id, operation, new_status_id, acted_at)
       values ($1, $2, 'send-to-underwriting', $3, $4)`,
      [tenantId, leads.underwriting, statusUnderwriting, at({ days: 4 })],
    );

    leads.strategic = await seedLead({
      label: 'strategic',
      statusId: statusAssigned,
      createdAt: at({ days: 20 }),
      lastActivityAt: at({ days: 8 }),
      estimatedPremium: '100.00',
      partyId: strategicParty,
    });

    leads.clean = await seedLead({
      label: 'clean',
      statusId: statusAssigned,
      createdAt: at({ days: 1 }),
      lastActivityAt: at({ hours: 1 }),
    });
    quotes.clean = await seedQuote(leads.clean, 'q-clean', dateOffset(60), '500.00');

    return { tenantId, leads, quotes };
  }

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) throw new Error(`fixture user ${session.email} has no users row`);
    return Number(session.appUserId);
  }

  /** A seeded lead id by fixture label; throws rather than silently passing `undefined` to SQL. */
  function leadId(fixture: TenantFixture, label: string): number {
    const id = fixture.leads[label];
    if (id === undefined) throw new Error(`no seeded lead labelled "${label}"`);
    return id;
  }

  /** Reconciles ONE tenant, at the fixed instant. */
  async function reconcile(fixture: TenantFixture, onlyLeadId?: number) {
    return await reconcileTenantAlerts(db, toTenantId(fixture.tenantId), {
      now: NOW,
      ...(onlyLeadId === undefined ? {} : { onlyLeadId }),
    });
  }

  /** Open alert types per lead label, read straight from the database. */
  async function openAlertsByLabel(fixture: TenantFixture): Promise<Record<string, string[]>> {
    const rows = await query<{ lead_id: string; type: string }>(
      `select lead_id::text as lead_id, type from alerts
        where tenant_id = $1 and resolved_at is null`,
      [fixture.tenantId],
    );

    const byLeadId = new Map<number, string[]>();
    for (const row of rows) {
      const leadId = Number(row.lead_id);
      const existing = byLeadId.get(leadId);
      if (existing === undefined) byLeadId.set(leadId, [row.type]);
      else existing.push(row.type);
    }

    const result: Record<string, string[]> = {};
    for (const [label, leadId] of Object.entries(fixture.leads)) {
      result[label] = (byLeadId.get(leadId) ?? []).sort();
    }
    return result;
  }

  function expectedByLabel(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(EXPECTED).map(([label, types]) => [label, [...types].sort()]),
    );
  }

  async function alertRows(tenantId: number): Promise<
    { id: number; type: string; leadId: number; quoteId: number | null; severity: string; premium: string | null; resolvedAt: string | null; resolvedReason: string | null }[]
  > {
    const rows = await query<{
      id: string;
      type: string;
      lead_id: string;
      quote_id: string | null;
      severity: string;
      premium_at_risk: string | null;
      resolved_at: string | null;
      resolved_reason: string | null;
    }>(
      `select id::text as id, type, lead_id::text as lead_id, quote_id::text as quote_id, severity,
              premium_at_risk::text as premium_at_risk, resolved_at::text as resolved_at,
              resolved_reason
         from alerts where tenant_id = $1 order by id`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type,
      leadId: Number(row.lead_id),
      quoteId: row.quote_id === null ? null : Number(row.quote_id),
      severity: row.severity,
      premium: row.premium_at_risk,
      resolvedAt: row.resolved_at,
      resolvedReason: row.resolved_reason,
    }));
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    config = loadConfig({
      APP_ENV: 'local',
      LOG_LEVEL: 'error',
      DATABASE_URL: stack.dbUrl,
      DIRECT_DATABASE_URL: stack.dbUrl,
      SUPABASE_URL: stack.apiUrl,
      SUPABASE_ANON_KEY: stack.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
      CRON_SECRET: 'local-cron-secret',
      INTERNAL_JOB_SECRET: 'local-internal-job-secret',
      API_KEY_PEPPER: 'local-api-key-pepper-value',
    });

    auth = new TestAuthFixtures(stack);
    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

    actor = await auth.createTestUserWithSession({ label: 'alert-eval' });

    tenantA = await seedTenantFixtures(await createTenant('tenant-a'), `${RUN}-a`);
    tenantB = await seedTenantFixtures(await createTenant('tenant-b'), `${RUN}-b`);
    brokenTenantId = await createTenant('tenant-broken', false);
  }, 300_000);

  afterAll(async () => {
    if (!probe.available) return;

    // Data deletion MUST precede `auth.cleanup()`: that call ends the pool these deletes run on,
    // and each delete swallows its error, so the reverse order is a silent no-op that leaks this
    // suite's rows into the next run.
    for (const tenantId of createdTenants) {
      for (const table of [
        'alerts',
        'user_alert_views',
        'lead_status_history',
        'pricing_approvals',
        'quote_versions',
        'quotes',
        'lead_assignments',
        'leads',
        'parties',
        'reference_items',
        'tenant_settings',
        'audit_log',
        'user_tenants',
      ]) {
        await query(`delete from ${table} where tenant_id = $1`, [tenantId]).catch(() => undefined);
      }
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }
    await query('delete from job_run where job_name = $1 and correlation_id like $2', [
      ALERT_EVALUATION_JOB_NAME,
      `${RUN}%`,
    ]).catch(() => undefined);

    await auth?.cleanup();
    await db?.destroy();
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // AC-069: every type materializes exactly once
  // ---------------------------------------------------------------------------------------------

  it('creates exactly the hand-computed alert set for every seeded lead', async () => {
    await reconcile(tenantA);

    expect(await openAlertsByLabel(tenantA)).toEqual(expectedByLabel());
  });

  it('covers all eleven alert types across the fixture set', async () => {
    // Guards against a vacuous suite: if a rule stopped firing entirely, the per-lead assertion
    // above would catch it, but only if the fixture set actually exercises every type.
    const seededTypes = new Set(Object.values(EXPECTED).flat());
    expect(seededTypes.size).toBe(11);
  });

  it('raises nothing at all for a lead that matches no rule', async () => {
    await reconcile(tenantA);
    const rows = await alertRows(tenantA.tenantId);
    expect(rows.filter((row) => row.leadId === tenantA.leads.clean)).toEqual([]);
  });

  it('records severity and premium-at-risk from the matching rule', async () => {
    await reconcile(tenantA);
    const rows = await alertRows(tenantA.tenantId);

    const expired = rows.find(
      (row) => row.type === 'quote_expired' && row.leadId === tenantA.leads.expired,
    );
    // Quote-level: critical, carrying the QUOTE's own premium and its quote_id.
    expect(expired).toMatchObject({
      severity: 'critical',
      premium: '200.00',
      quoteId: tenantA.quotes.expired,
    });

    const escalation = rows.find(
      (row) => row.type === 'executive_escalation' && row.leadId === tenantA.leads.highValue,
    );
    // Lead-level: critical, the LEAD's estimate, and no quote_id.
    expect(escalation).toMatchObject({
      severity: 'critical',
      premium: '2000000.00',
      quoteId: null,
    });

    const overdue = rows.find(
      (row) => row.type === 'overdue_follow_up' && row.leadId === tenantA.leads.overdue,
    );
    expect(overdue).toMatchObject({ severity: 'warning', quoteId: null });
  });

  // ---------------------------------------------------------------------------------------------
  // AC-069: idempotency / convergence
  // ---------------------------------------------------------------------------------------------

  it('converges: a second run back-to-back writes nothing and changes no row', async () => {
    await reconcile(tenantA);
    const before = await alertRows(tenantA.tenantId);

    const second = await reconcile(tenantA);

    expect(second.created).toBe(0);
    expect(second.resolved).toBe(0);
    // Identical rows, including ids and created_at — not merely an identical count, which a
    // delete-and-recreate implementation would also satisfy.
    expect(await alertRows(tenantA.tenantId)).toEqual(before);
  });

  it('stays convergent over five consecutive runs', async () => {
    await reconcile(tenantA);
    const baseline = await alertRows(tenantA.tenantId);

    for (let run = 0; run < 5; run += 1) {
      const result = await reconcile(tenantA);
      expect({ created: result.created, resolved: result.resolved }).toEqual({
        created: 0,
        resolved: 0,
      });
    }

    expect(await alertRows(tenantA.tenantId)).toEqual(baseline);
  });

  it('tolerates duplicate delivery: two reconciliations racing insert one row, not two', async () => {
    // Both runs compute the same match set from the same data. Under the reference's plain
    // read-then-insert this is exactly the window where a duplicate open alert appears; the partial
    // unique index plus ON CONFLICT DO NOTHING closes it.
    await query('delete from alerts where tenant_id = $1', [tenantA.tenantId]);

    const [first, second] = await Promise.all([reconcile(tenantA), reconcile(tenantA)]);

    const openCount = (await alertRows(tenantA.tenantId)).filter((row) => row.resolvedAt === null)
      .length;

    // Between them they created the whole set exactly once — no row was created twice.
    expect(first.created + second.created).toBe(openCount);
    expect(first.matched).toBe(second.matched);
    expect(openCount).toBe(first.matched);
  });

  it('cannot store two open alerts of the same type for the same lead (the DB index holds)', async () => {
    await reconcile(tenantA);
    const rows = await alertRows(tenantA.tenantId);
    const existing = rows.find((row) => row.type === 'overdue_follow_up' && row.resolvedAt === null);
    expect(existing).toBeDefined();

    await expect(
      query(
        `insert into alerts (tenant_id, type, lead_id, quote_id, severity, created_at)
         values ($1, 'overdue_follow_up', $2, null, 'warning', now())`,
        [tenantA.tenantId, existing?.leadId],
      ),
    ).rejects.toThrow(/duplicate key|uq_alerts_open_per_type_lead_quote/i);
  });

  // ---------------------------------------------------------------------------------------------
  // AC-069: resolution when the condition clears
  // ---------------------------------------------------------------------------------------------

  it('resolves an alert once its rule stops matching, and leaves the others alone', async () => {
    await reconcile(tenantA);
    const before = await alertRows(tenantA.tenantId);
    const target = before.find(
      (row) => row.type === 'overdue_follow_up' && row.leadId === tenantA.leads.overdue,
    );
    expect(target).toBeDefined();

    // The contextual action a user would take: the follow-up is logged, so the next date moves out.
    await query('update leads set next_follow_up_date = $1::date where tenant_id = $2 and id = $3', [
      dateOffset(5),
      tenantA.tenantId,
      tenantA.leads.overdue,
    ]);

    const result = await reconcile(tenantA);
    expect(result.resolved).toBe(1);
    expect(result.created).toBe(0);

    const after = await alertRows(tenantA.tenantId);
    const resolvedRow = after.find((row) => row.id === target?.id);
    expect(resolvedRow?.resolvedAt).not.toBeNull();
    expect(resolvedRow?.resolvedReason).toBe(RULE_CLEARED_REASON);

    // Every other alert is untouched — resolution is targeted, not a sweep-and-rebuild.
    const untouched = after.filter((row) => row.id !== target?.id);
    expect(untouched).toEqual(before.filter((row) => row.id !== target?.id));

    // Restore for the following tests.
    await query('update leads set next_follow_up_date = $1::date where tenant_id = $2 and id = $3', [
      dateOffset(-1),
      tenantA.tenantId,
      tenantA.leads.overdue,
    ]);
  });

  it('raises a NEW alert when a resolved condition recurs (the partial index permits it)', async () => {
    await reconcile(tenantA);
    const resolvedRows = (await alertRows(tenantA.tenantId)).filter(
      (row) => row.type === 'overdue_follow_up' && row.leadId === tenantA.leads.overdue,
    );

    // The previous test resolved one and this run re-created another: the resolved row still
    // exists as history, and a SECOND open row now exists alongside it.
    expect(resolvedRows.filter((row) => row.resolvedAt !== null).length).toBeGreaterThanOrEqual(1);
    expect(resolvedRows.filter((row) => row.resolvedAt === null)).toHaveLength(1);
  });

  it('resolves every alert on a lead once the lead itself closes', async () => {
    await reconcile(tenantA);
    const openBefore = (await alertRows(tenantA.tenantId)).filter(
      (row) => row.leadId === tenantA.leads.highValue && row.resolvedAt === null,
    );
    expect(openBefore.length).toBeGreaterThan(0);

    // The lead's ORIGINAL status, captured so this test restores the shared fixture. Tests in this
    // suite share one seeded tenant, so a mutation left behind here would silently change the
    // expected alert set for every test that runs afterwards — which is exactly what happened the
    // first time this test was written.
    const originalStatus = (
      await query<{ status_id: string }>(
        'select status_id::text as status_id from leads where tenant_id = $1 and id = $2',
        [tenantA.tenantId, tenantA.leads.highValue],
      )
    )[0]?.status_id;

    const lostStatus = await seedRef(tenantA.tenantId, 'lead_status', `${RUN}-a-Lost`, {
      reportingCategory: 'lost',
      canonicalKey: 'closed_lost',
    });
    await query('update leads set status_id = $1 where tenant_id = $2 and id = $3', [
      lostStatus,
      tenantA.tenantId,
      tenantA.leads.highValue,
    ]);

    await reconcile(tenantA);

    const openAfter = (await alertRows(tenantA.tenantId)).filter(
      (row) => row.leadId === tenantA.leads.highValue && row.resolvedAt === null,
    );
    // A closed lead must not keep raising alerts — and its existing ones must CLEAR, which only
    // happens because closed leads stay in the evaluation context.
    expect(openAfter).toEqual([]);
    expect(openBefore.every((row) => row.resolvedAt === null)).toBe(true);

    await query('update leads set status_id = $1 where tenant_id = $2 and id = $3', [
      originalStatus,
      tenantA.tenantId,
      tenantA.leads.highValue,
    ]);
    // Reopening the lead re-raises its alerts, so the shared fixture is back to its baseline.
    await reconcile(tenantA);
    expect((await openAlertsByLabel(tenantA)).highValue).toHaveLength(EXPECTED.highValue?.length ?? 0);
  });

  // ---------------------------------------------------------------------------------------------
  // Scoped re-evaluation
  // ---------------------------------------------------------------------------------------------

  it('evaluateForLead reconciles only that lead and converges identically', async () => {
    await reconcile(tenantA);
    const before = await alertRows(tenantA.tenantId);

    const scoped = await evaluateForLead(db, toTenantId(tenantA.tenantId), leadId(tenantA, 'overdue'), {
      now: NOW,
    });

    expect({ created: scoped.created, resolved: scoped.resolved }).toEqual({
      created: 0,
      resolved: 0,
    });
    expect(await alertRows(tenantA.tenantId)).toEqual(before);
  });

  it('evaluateForLead clears that lead s alert without touching any other lead s', async () => {
    await reconcile(tenantA);
    const before = await alertRows(tenantA.tenantId);

    await query('update leads set next_follow_up_date = null where tenant_id = $1 and id = $2', [
      tenantA.tenantId,
      tenantA.leads.overdue,
    ]);

    const scoped = await evaluateForLead(db, toTenantId(tenantA.tenantId), leadId(tenantA, 'overdue'), {
      now: NOW,
    });
    expect(scoped.resolved).toBe(1);

    const after = await alertRows(tenantA.tenantId);
    const otherLeadRows = after.filter((row) => row.leadId !== tenantA.leads.overdue);
    // THE failure mode this test exists for: narrowing only the candidate side would compute an
    // empty match set for every other lead and resolve the whole tenant's alerts.
    expect(otherLeadRows).toEqual(before.filter((row) => row.leadId !== tenantA.leads.overdue));

    await query('update leads set next_follow_up_date = $1::date where tenant_id = $2 and id = $3', [
      dateOffset(-1),
      tenantA.tenantId,
      tenantA.leads.overdue,
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // AC-022: tenant isolation
  // ---------------------------------------------------------------------------------------------

  it('never creates an alert referencing another tenant s lead or quote', async () => {
    await reconcile(tenantA);
    await reconcile(tenantB);

    const tenantALeadIds = new Set(Object.values(tenantA.leads));
    const tenantBLeadIds = new Set(Object.values(tenantB.leads));

    for (const row of await alertRows(tenantA.tenantId)) {
      expect(tenantALeadIds.has(row.leadId)).toBe(true);
      expect(tenantBLeadIds.has(row.leadId)).toBe(false);
    }
    for (const row of await alertRows(tenantB.tenantId)) {
      expect(tenantBLeadIds.has(row.leadId)).toBe(true);
      expect(tenantALeadIds.has(row.leadId)).toBe(false);
    }
  });

  it('reconciling one tenant never resolves another tenant s alerts', async () => {
    await reconcile(tenantA);
    await reconcile(tenantB);
    const tenantBBefore = await alertRows(tenantB.tenantId);
    expect(tenantBBefore.length).toBeGreaterThan(0);

    // Clear a condition in tenant A only.
    await query('update leads set next_follow_up_date = null where tenant_id = $1 and id = $2', [
      tenantA.tenantId,
      tenantA.leads.overdue,
    ]);
    await reconcile(tenantA);

    expect(await alertRows(tenantB.tenantId)).toEqual(tenantBBefore);

    await query('update leads set next_follow_up_date = $1::date where tenant_id = $2 and id = $3', [
      dateOffset(-1),
      tenantA.tenantId,
      tenantA.leads.overdue,
    ]);
  });

  it('gives both tenants the same alert set from the same seeded data', async () => {
    await reconcile(tenantA);
    await reconcile(tenantB);

    // Same fixtures, same thresholds, independent tenants: the per-label sets must match exactly.
    expect(await openAlertsByLabel(tenantB)).toEqual(await openAlertsByLabel(tenantA));
  });

  // ---------------------------------------------------------------------------------------------
  // AC-072: the sweep — batching, per-tenant failure isolation, job_run counts
  // ---------------------------------------------------------------------------------------------

  it('sweeps every active tenant and reconciles each one in its own unit of work', async () => {
    await query('delete from alerts where tenant_id = any($1::bigint[])', [
      [tenantA.tenantId, tenantB.tenantId],
    ]);

    const { counts, failedTenantIds } = await runAlertEvaluationSweep(
      db,
      { logger: jobLogger({ jobName: ALERT_EVALUATION_JOB_NAME, correlationId: RUN, trigger: 'manual' }) },
      { now: NOW, batchSize: 2 },
    );

    // Both of this suite's tenants reconciled, in a run that used a batch size smaller than the
    // tenant list — so the keyset paging really did page.
    expect(await openAlertsByLabel(tenantA)).toEqual(expectedByLabel());
    expect(await openAlertsByLabel(tenantB)).toEqual(expectedByLabel());

    expect(counts.tenantsProcessed).toBeGreaterThanOrEqual(2);
    // The unprovisioned tenant is the fault injection: it throws, and the sweep still completed
    // the others in the SAME run.
    expect(failedTenantIds).toContain(brokenTenantId);
  });

  it('records the sweep on job_run with counts, and a partial failure with the failing tenant', async () => {
    const jobRuns = new PgJobRunRepository(db, config.appEnv);
    const handler = createAlertEvaluationHandler(db, { now: NOW });

    const outcome = await runCronJob(
      { db, handlers: new Map([[handler.name, handler]]), jobRuns },
      { jobName: ALERT_EVALUATION_JOB_NAME, trigger: 'manual', correlationId: `${RUN}-partial` },
    );

    // The broken tenant makes this run a PARTIAL failure by design.
    expect(outcome.status).toBe('failed');

    const rows = await query<{
      status: string;
      error_message: string | null;
      job_name: string;
    }>(`select status, error_message, job_name from job_run where correlation_id = $1`, [
      `${RUN}-partial`,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_name).toBe(ALERT_EVALUATION_JOB_NAME);
    expect(rows[0]?.status).toBe('failed');
    // The failing tenant is IDENTIFIED on the row, and the partial counts survive with it.
    expect(rows[0]?.error_message).toContain(String(brokenTenantId));
    expect(rows[0]?.error_message).toContain('tenantsProcessed');

    // Tenant A was still reconciled during that same partially-failed run.
    expect(await openAlertsByLabel(tenantA)).toEqual(expectedByLabel());
  });

  it('records counts and succeeds when every tenant in scope reconciles', async () => {
    // Remove the fault so the sweep can complete cleanly, then assert the SUCCESS shape.
    await query(
      `insert into tenant_settings (tenant_id, created_at, updated_at) values ($1, now(), now())
       on conflict (tenant_id) do nothing`,
      [brokenTenantId],
    );

    const jobRuns = new PgJobRunRepository(db, config.appEnv);
    const handler = createAlertEvaluationHandler(db, { now: NOW });

    const outcome = await runCronJob(
      { db, handlers: new Map([[handler.name, handler]]), jobRuns },
      { jobName: ALERT_EVALUATION_JOB_NAME, trigger: 'manual', correlationId: `${RUN}-clean` },
    );

    expect(outcome.status).toBe('succeeded');
    expect(outcome.counts?.tenantsFailed).toBe(0);
    expect(Number(outcome.counts?.tenantsProcessed)).toBeGreaterThanOrEqual(3);

    const rows = await query<{ status: string; counts: unknown }>(
      `select status, counts from job_run where correlation_id = $1`,
      [`${RUN}-clean`],
    );
    expect(rows[0]?.status).toBe('succeeded');
    expect(JSON.stringify(rows[0]?.counts)).toContain('tenantsProcessed');
  });
});
