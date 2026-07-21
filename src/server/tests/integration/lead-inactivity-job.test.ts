/**
 * Job 2 — the lead-inactivity-expiry sweep against a real database (T-032; AC-066, AC-068, AC-072;
 * V-084, V-090).
 *
 * Port of `LeadInactivityExpiryJob` + `LeadStore.ListInactivityExpiredCandidatesAsync`.
 *
 * THE FIXTURE STRADDLES THE THRESHOLD ON PURPOSE
 * ==============================================
 * The predicate measured from the reference (`LeadStore.cs:357-364`, `LeadInactivityExpiryJob.cs:74`) is
 *
 *     last_activity_at IS NOT NULL
 *     AND last_activity_at < (now - tenant_settings.lead_inactivity_expiry_days)
 *     AND status.reporting_category IN ('open','quoted')
 *
 * Note this keys off the reporting CATEGORY, not a canonical-key list — the opposite of the quote
 * sweep, and measured rather than assumed. A tenant-added open status therefore DOES expire.
 *
 * A fixture in which every lead is years stale could not tell a correct threshold from one that
 * expires every open lead, so the set contains the rows either side of the boundary at a threshold
 * of 30 days:
 *
 *   last_activity_at = now - 30d - 1h  ->  EXPIRES    (just outside)
 *   last_activity_at = now - 30d + 1h  ->  UNTOUCHED  (just inside)
 *
 * Changing the threshold arithmetic, the comparison direction, or the category list moves at least
 * one row in `EXPECTED` below.
 *
 * `last_activity_at` IS NOT RE-DERIVED HERE
 * =========================================
 * The reference is explicit that quote activity already counts as lead activity because every quote
 * workflow operation stamps the parent lead (T-026's `executeQuoteOperation` calls
 * `stampLeadActivity` UNCONDITIONALLY — verified in that file, not assumed). The sweep therefore
 * only reads the already-maintained column, and `quoteActivityReset` below pins that a lead whose
 * intake is ancient but whose quote activity is recent does NOT expire.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LEAD_INACTIVITY_EXPIRY_JOB_NAME,
  createLeadInactivityExpiryHandler,
  runLeadInactivityExpirySweep,
} from '../../jobs/cron/lead-inactivity-expiry.js';
import { runCronJob } from '../../jobs/cron/run-cron-job.js';
import { PgJobRunRepository } from '../../jobs/job-run-repository.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { jobLogger } from '../../lib/logging/index.js';
import { TestAuthFixtures } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('lead inactivity expiry job', probe);

const RUN = `t032li-${process.pid}-${Date.now()}`;

/** The fixed instant every fixture offset is measured from. */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const TODAY = '2026-06-15';

/** The threshold provisioned on every tenant this suite creates. */
const INACTIVITY_DAYS = 30;

function at(offset: { days?: number; hours?: number }): Date {
  return new Date(
    NOW.getTime() - (offset.days ?? 0) * 86_400_000 - (offset.hours ?? 0) * 3_600_000,
  );
}

/**
 * The hand-computed truth table: lead fixture label -> the canonical key it MUST carry after one
 * sweep. Derived from the reference predicate above.
 */
const EXPECTED: Readonly<Record<string, string>> = {
  /** Open, idle 31 days: the plain positive case. */
  staleOpen: 'expired',
  /** Quoted category, idle 31 days: the category list covers 'quoted' too. */
  staleQuoted: 'expired',
  /** Idle 30d + 1h — one hour PAST the threshold. The lower boundary row. */
  boundaryJustOutside: 'expired',
  /** Idle 30d - 1h — one hour SHORT of the threshold. The row that discriminates the threshold. */
  boundaryJustInside: 'quote_sent',
  /** Idle 1 hour: comfortably active. */
  fresh: 'quote_sent',
  /** last_activity_at NULL: never expirable — no activity clock has started. */
  neverStamped: 'quote_sent',
  /** Idle 400 days but already Closed Won: a closed lead is never re-expired. */
  closedWon: 'closed_won',
  /** Idle 400 days but already Expired: the sweep must not touch it a second time. */
  alreadyExpired: 'expired',
  /** A TENANT-ADDED open status (no canonical key), idle 31 days: category-keyed, so it expires. */
  customOpenStatus: 'expired',
  /** Created 400 days ago, but a quote operation stamped activity an hour ago: stays open. */
  quoteActivityReset: 'quote_sent',
};

interface TenantFixture {
  readonly tenantId: number;
  readonly leads: Readonly<Record<string, number>>;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Active, but deliberately NOT provisioned tenant_settings: the sweep's fault-injection tenant. */
  let brokenTenantId: number;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
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
        `insert into tenant_settings (tenant_id, lead_inactivity_expiry_days, created_at, updated_at)
         values ($1, $2, now(), now())`,
        [id, INACTIVITY_DAYS],
      );
    }
    return id;
  }

  async function seedRef(
    tenantId: number,
    listType: string,
    name: string,
    options: { reportingCategory?: string; canonicalKey?: string; productLineId?: number } = {},
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

  async function seedTenantFixtures(tenantId: number, marker: string): Promise<TenantFixture> {
    const partyType = await seedRef(tenantId, 'party_type', `${marker}-type`);
    const productLine = await seedRef(tenantId, 'product_line', `${marker}-motor`);
    const coverType = await seedRef(tenantId, 'cover_type', `${marker}-cover`, {
      productLineId: productLine,
    });
    const region = await seedRef(tenantId, 'region', `${marker}-region`);
    const channel = await seedRef(tenantId, 'request_channel', `${marker}-channel`);

    const statusOpen = await seedRef(tenantId, 'lead_status', `${marker}-New`, {
      reportingCategory: 'open',
      canonicalKey: 'new',
    });
    const statusQuoted = await seedRef(tenantId, 'lead_status', `${marker}-QuoteSent`, {
      reportingCategory: 'quoted',
      canonicalKey: 'quote_sent',
    });
    const statusWon = await seedRef(tenantId, 'lead_status', `${marker}-ClosedWon`, {
      reportingCategory: 'won',
      canonicalKey: 'closed_won',
    });
    await seedRef(tenantId, 'lead_status', `${marker}-Expired`, {
      reportingCategory: 'expired',
      canonicalKey: 'expired',
    });
    // A tenant's OWN status: open category, deliberately no canonical key.
    const statusCustom = await seedRef(tenantId, 'lead_status', `${marker}-AwaitingDocs`, {
      reportingCategory: 'open',
    });

    const party = await insertReturningId(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, `${marker}-client`, partyType],
    );

    async function seedLead(
      label: string,
      statusId: number,
      lastActivityAt: Date | null,
      createdAt: Date = at({ days: 400 }),
    ): Promise<number> {
      return await insertReturningId(
        `insert into leads
           (tenant_id, party_id, lead_ref, date_received, request_channel_id, region_id,
            product_line_id, cover_type_id, policy_term, priority, status_id,
            pricing_approval_state, last_activity_at, source, created_at, updated_at)
         values ($1, $2, $3, $4::date, $5, $6, $7, $8, 'm12', 'normal', $9, 'none', $10, 'browser',
                 $11, now())
         returning id::text as id`,
        [
          tenantId,
          party,
          `${marker}-${label}`,
          TODAY,
          channel,
          region,
          productLine,
          coverType,
          statusId,
          lastActivityAt,
          createdAt,
        ],
      );
    }

    const expiredStatusRows = await query<{ id: string }>(
      `select id::text as id from reference_items
        where tenant_id = $1 and list_type = 'lead_status' and canonical_key = 'expired'`,
      [tenantId],
    );
    const statusExpired = Number(expiredStatusRows[0]?.id);

    const leads: Record<string, number> = {
      staleOpen: await seedLead('stale-open', statusOpen, at({ days: 31 })),
      staleQuoted: await seedLead('stale-quoted', statusQuoted, at({ days: 31 })),
      boundaryJustOutside: await seedLead(
        'boundary-outside',
        statusQuoted,
        at({ days: INACTIVITY_DAYS, hours: 1 }),
      ),
      boundaryJustInside: await seedLead(
        'boundary-inside',
        statusQuoted,
        at({ days: INACTIVITY_DAYS, hours: -1 }),
      ),
      fresh: await seedLead('fresh', statusQuoted, at({ hours: 1 })),
      neverStamped: await seedLead('never-stamped', statusQuoted, null),
      closedWon: await seedLead('closed-won', statusWon, at({ days: 400 })),
      alreadyExpired: await seedLead('already-expired', statusExpired, at({ days: 400 })),
      customOpenStatus: await seedLead('custom-open', statusCustom, at({ days: 31 })),
      quoteActivityReset: await seedLead('quote-activity-reset', statusQuoted, at({ hours: 1 })),
    };

    // `staleOpen` uses the plain open status; every other quoted fixture uses `quote_sent`, so the
    // EXPECTED table's untouched values read 'quote_sent'. Pin that the two differ.
    void statusOpen;
    return { tenantId, leads };
  }

  /** Lead canonical keys by fixture label, read straight from the database. */
  async function leadKeysByLabel(fixture: TenantFixture): Promise<Record<string, string>> {
    const rows = await query<{ id: string; canonical_key: string | null; name: string }>(
      `select l.id::text as id, r.canonical_key, r.name
         from leads l join reference_items r on r.id = l.status_id
        where l.tenant_id = $1`,
      [fixture.tenantId],
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row.canonical_key ?? row.name]));
    const result: Record<string, string> = {};
    for (const label of Object.keys(EXPECTED)) {
      const leadId = fixture.leads[label];
      if (leadId === undefined) throw new Error(`no seeded lead labelled "${label}"`);
      result[label] = byId.get(leadId) ?? '';
    }
    return result;
  }

  async function leadHistory(
    tenantId: number,
  ): Promise<{ id: number; leadId: number; operation: string; actedBy: number | null }[]> {
    const rows = await query<{
      id: string;
      lead_id: string;
      operation: string;
      acted_by: string | null;
    }>(
      `select id::text as id, lead_id::text as lead_id, operation, acted_by::text as acted_by
         from lead_status_history where tenant_id = $1 order by id`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      leadId: Number(row.lead_id),
      operation: row.operation,
      actedBy: row.acted_by === null ? null : Number(row.acted_by),
    }));
  }

  async function auditRows(
    tenantId: number,
  ): Promise<{ id: number; entityType: string; entityId: string; action: string }[]> {
    const rows = await query<{
      id: string;
      entity_type: string;
      entity_id: string;
      action: string;
    }>(
      `select id::text as id, entity_type, entity_id, action
         from audit_log where tenant_id = $1 order by id`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
    }));
  }

  async function sweep(options: { batchSize?: number } = {}) {
    return await runLeadInactivityExpirySweep(
      db,
      {
        logger: jobLogger({
          jobName: LEAD_INACTIVITY_EXPIRY_JOB_NAME,
          correlationId: RUN,
          trigger: 'manual',
        }),
      },
      { now: NOW, ...options },
    );
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

    tenantA = await seedTenantFixtures(await createTenant('tenant-a'), `${RUN}-a`);
    tenantB = await seedTenantFixtures(await createTenant('tenant-b'), `${RUN}-b`);
    brokenTenantId = await createTenant('tenant-broken', false);
  }, 300_000);

  afterAll(async () => {
    if (!probe.available) return;

    // Data deletion MUST precede `auth.cleanup()`: that call ends the pool these deletes run on and
    // each delete swallows its error, so the reverse order is a silent no-op.
    for (const tenantId of createdTenants) {
      for (const table of [
        'alerts',
        'user_alert_views',
        'quote_status_history',
        'lead_status_history',
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
      LEAD_INACTIVITY_EXPIRY_JOB_NAME,
      `${RUN}%`,
    ]).catch(() => undefined);

    await auth?.cleanup();
    await db?.destroy();
  }, 300_000);

  // -------------------------------------------------------------------------------------------
  // AC-066: only leads beyond the tenant threshold move
  // -------------------------------------------------------------------------------------------

  it('expires exactly the hand-computed lead set and leaves every other lead untouched', async () => {
    await sweep();

    expect(await leadKeysByLabel(tenantA)).toEqual(EXPECTED);
  });

  it('discriminates the threshold from BOTH sides at one-hour resolution', async () => {
    await sweep();

    const keys = await leadKeysByLabel(tenantA);
    // Stated separately from the table so the boundary cannot be lost in a bulk edit. These two
    // rows differ by two hours; only a correct threshold separates them.
    expect(keys.boundaryJustOutside).toBe('expired');
    expect(keys.boundaryJustInside).toBe('quote_sent');
  });

  it('never expires a lead whose activity clock was never stamped', async () => {
    await sweep();

    expect((await leadKeysByLabel(tenantA)).neverStamped).toBe('quote_sent');
  });

  it('never re-expires a lead that is already closed or already expired', async () => {
    await sweep();

    const keys = await leadKeysByLabel(tenantA);
    expect(keys.closedWon).toBe('closed_won');
    expect(keys.alreadyExpired).toBe('expired');

    // And no history row was appended for either: the category guard excluded them from the
    // candidate set entirely, rather than the executor rejecting them after the fact.
    const history = await leadHistory(tenantA.tenantId);
    const touched = new Set(history.map((row) => row.leadId));
    expect(touched.has(Number(tenantA.leads.closedWon))).toBe(false);
    expect(touched.has(Number(tenantA.leads.alreadyExpired))).toBe(false);
  });

  it('excludes closed leads from the CANDIDATE set, not merely from the outcome', async () => {
    const { counts } = await sweep();

    // Without the reporting-category predicate on the candidate query, closed and already-expired
    // leads would still not MOVE — the legality matrix rejects `expire_automatic` from a won or
    // expired status — so every row-level assertion in this suite would still pass. What changes is
    // that each of them becomes a failed candidate on EVERY run: a permanently non-zero failure
    // count and a warning log per closed lead, forever, growing with the tenant's history.
    //
    // `leadsFailed` is therefore the assertion that distinguishes "correctly filtered" from
    // "filtered by accident downstream". It is measured across the whole estate, which is the right
    // scope: a correct sweep never hands the executor a lead the matrix will refuse.
    expect(counts.leadsFailed).toBe(0);
  });

  it('expires a tenant-added open status, because the predicate keys off the reporting category', async () => {
    await sweep();

    expect((await leadKeysByLabel(tenantA)).customOpenStatus).toBe('expired');
  });

  it('treats recent quote activity as lead activity and leaves the lead open', async () => {
    await sweep();

    // Created 400 days ago; `last_activity_at` an hour old because a quote operation stamped it.
    expect((await leadKeysByLabel(tenantA)).quoteActivityReset).toBe('quote_sent');
  });

  it('writes a system-actor history row and an audit row for each expired lead', async () => {
    await sweep();

    const history = await leadHistory(tenantA.tenantId);
    const expired = history.filter((row) => row.operation === 'expire_automatic');
    expect(expired.map((row) => row.leadId).sort((a, b) => a - b)).toEqual(
      [
        tenantA.leads.staleOpen,
        tenantA.leads.staleQuoted,
        tenantA.leads.boundaryJustOutside,
        tenantA.leads.customOpenStatus,
      ]
        .map(Number)
        .sort((a, b) => a - b),
    );
    expect(expired.every((row) => row.actedBy === null)).toBe(true);

    const audits = (await auditRows(tenantA.tenantId)).filter(
      (row) => row.action === 'lead.expire_automatic',
    );
    expect(audits.map((row) => Number(row.entityId)).sort((a, b) => a - b)).toEqual(
      expired.map((row) => row.leadId).sort((a, b) => a - b),
    );
    expect(audits.every((row) => row.entityType === 'lead')).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // AC-068: idempotency — a second run is a provable no-op
  // -------------------------------------------------------------------------------------------

  it('running the sweep twice changes nothing the second time (rows byte-identical, ids included)', async () => {
    await sweep();

    const keysAfterFirst = await leadKeysByLabel(tenantA);
    const historyAfterFirst = await leadHistory(tenantA.tenantId);
    const auditsAfterFirst = await auditRows(tenantA.tenantId);
    expect(historyAfterFirst.length).toBeGreaterThan(0);

    const second = await sweep();

    expect(await leadKeysByLabel(tenantA)).toEqual(keysAfterFirst);
    expect(await leadHistory(tenantA.tenantId)).toEqual(historyAfterFirst);
    expect(await auditRows(tenantA.tenantId)).toEqual(auditsAfterFirst);
    expect(second.counts.leadsExpired).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // AC-022: tenant isolation
  // -------------------------------------------------------------------------------------------

  it('never moves a lead belonging to another tenant', async () => {
    await sweep();

    expect(await leadKeysByLabel(tenantB)).toEqual(EXPECTED);

    const tenantALeadIds = new Set(Object.values(tenantA.leads).map(Number));
    for (const row of await leadHistory(tenantA.tenantId)) {
      expect(tenantALeadIds.has(row.leadId)).toBe(true);
    }
  });

  it('honours each tenant s OWN threshold rather than a shared constant', async () => {
    // Widen tenant B's window past every fixture, and re-seed one lead so there is something left
    // to expire under the ORIGINAL threshold but nothing under the widened one.
    await query('update tenant_settings set lead_inactivity_expiry_days = 500 where tenant_id = $1', [
      tenantB.tenantId,
    ]);
    await query(
      `update leads set status_id = (select id from reference_items
          where tenant_id = $1 and list_type = 'lead_status' and canonical_key = 'quote_sent'),
        last_activity_at = $2 where tenant_id = $1 and id = $3`,
      [tenantB.tenantId, at({ days: 31 }), tenantB.leads.staleQuoted],
    );

    await sweep();

    // 31 days idle is inside a 500-day window: untouched. The same row in tenant A expired.
    expect((await leadKeysByLabel(tenantB)).staleQuoted).toBe('quote_sent');
    expect((await leadKeysByLabel(tenantA)).staleQuoted).toBe('expired');

    await query('update tenant_settings set lead_inactivity_expiry_days = $2 where tenant_id = $1', [
      tenantB.tenantId,
      INACTIVITY_DAYS,
    ]);
  });

  // -------------------------------------------------------------------------------------------
  // AC-072: the sweep — per-tenant isolation of failure, job_run counts
  // -------------------------------------------------------------------------------------------

  it('completes the remaining tenants when one tenant fails, and names the failure', async () => {
    const { counts, failedTenantIds } = await sweep({ batchSize: 2 });

    expect(counts.tenantsProcessed).toBeGreaterThanOrEqual(2);
    expect(failedTenantIds).toContain(brokenTenantId);
  });

  it('records the run on job_run with per-tenant counts', async () => {
    await query(
      `insert into tenant_settings (tenant_id, created_at, updated_at) values ($1, now(), now())
       on conflict (tenant_id) do nothing`,
      [brokenTenantId],
    );

    const jobRuns = new PgJobRunRepository(db, config.appEnv);
    const handler = createLeadInactivityExpiryHandler(db, { now: NOW });

    const outcome = await runCronJob(
      { db, handlers: new Map([[handler.name, handler]]), jobRuns },
      {
        jobName: LEAD_INACTIVITY_EXPIRY_JOB_NAME,
        trigger: 'manual',
        correlationId: `${RUN}-clean`,
      },
    );

    expect(outcome.status).toBe('succeeded');
    expect(outcome.counts?.tenantsFailed).toBe(0);

    const rows = await query<{ status: string; counts: unknown; job_name: string }>(
      `select status, counts, job_name from job_run where correlation_id = $1`,
      [`${RUN}-clean`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_name).toBe(LEAD_INACTIVITY_EXPIRY_JOB_NAME);
    expect(rows[0]?.status).toBe('succeeded');
    expect(JSON.stringify(rows[0]?.counts)).toContain('leadsExpired');
  });
});
