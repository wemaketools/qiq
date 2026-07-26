/**
 * Job 1 — the quote-expiry sweep against a real database (T-032; AC-066, AC-068, AC-072; V-083, V-090).
 *
 * Port of `QuoteExpiryJob` + `QuoteStore.ListExpiredCandidatesAsync`. Nothing is stubbed: real
 * tenants with real partitions, real reference data, real quotes, and the real sweep code, because
 * the properties under test — WHICH rows move, which do NOT, and what a second run does — are
 * properties of the composed system against Postgres.
 *
 * THE FIXTURE STRADDLES THE THRESHOLD ON PURPOSE
 * ==============================================
 * The predicate measured from the reference (`QuoteStore.cs:192-199`) is
 *
 *     valid_until IS NOT NULL  AND  valid_until < today(UTC)  AND  canonical_key IN ('sent','revised')
 *
 * so a fixture in which every quote is long past its valid_until could not tell a CORRECT threshold
 * from one that expires everything. Every quote below is placed at a KNOWN offset from the injected
 * `NOW`, and the set deliberately contains the two rows either side of the boundary:
 *
 *   validUntil = today - 1  ->  EXPIRES      (just outside)
 *   validUntil = today      ->  UNTOUCHED    (just inside — `<`, not `<=`)
 *
 * Flipping `<` to `<=` in the repository moves `boundaryToday` and fails `EXPECTED` below; widening
 * or narrowing the status list moves `draftPast`/`revisedPast`/`wonPast`. That is what makes these
 * assertions load-bearing rather than decorative.
 *
 * MEASURED CONTRADICTION WITH THE TASK FILE
 * =========================================
 * T-032's scope line says "open Sent quotes". The reference expires BOTH `sent` AND `revised`
 * (`expirableCanonicalKeys`, QuoteStore.cs:188), and T-026 already ported that into the legality
 * matrix (`expire_automatic` allowed from SENT_REVISED). The reference wins; `revisedPast` pins it.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  QUOTE_EXPIRY_JOB_NAME,
  createQuoteExpiryHandler,
  runQuoteExpirySweep,
} from '../../jobs/cron/quote-expiry.js';
import { runCronJob } from '../../jobs/cron/run-cron-job.js';
import { PgJobRunRepository } from '../../jobs/job-run-repository.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { jobLogger } from '../../lib/logging/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('quote expiry job', probe);

const RUN = `t032qe-${process.pid}-${Date.now()}`;

/** The fixed instant every fixture offset is measured from. */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const TODAY = '2026-06-15';

function dateOffset(offsetDays: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The hand-computed truth table: quote fixture label -> the canonical key it MUST carry after one
 * sweep. Derived from the reference predicate above, not from the implementation.
 */
const EXPECTED: Readonly<Record<string, string>> = {
  /** sent, valid_until = yesterday: the plain positive case. */
  sentPast: 'expired',
  /** revised, valid_until = yesterday: the reference expires Revised too (see header). */
  revisedPast: 'expired',
  /** sent, valid_until = TODAY: `<` excludes it. The boundary row that discriminates `<` from `<=`. */
  boundaryToday: 'sent',
  /** sent, valid_until = tomorrow: comfortably inside. */
  sentFuture: 'sent',
  /** sent, valid_until = NULL: never expirable — a quote with no expiry date cannot lapse. */
  sentNoValidUntil: 'sent',
  /** draft, valid_until = yesterday: excluded by the status list, not by the date. */
  draftPast: 'draft',
  /** won, valid_until = yesterday: a closed quote is never re-opened by a sweep. */
  wonPast: 'won',
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
  /**
   * Active, NOT provisioned tenant_settings, and seeded WITH expirable quotes — the fault injection.
   *
   * The quotes are what make it a fault at all. The sweep reads settings only AFTER finding at least
   * one candidate (the reference's ordering), so an unprovisioned tenant with nothing to expire is
   * a successful no-op, not a failure. `emptyUnprovisionedTenantId` below pins exactly that, and the
   * two together are what prove the ordering rather than assuming it.
   */
  let brokenTenantId: number;
  /** Active, NOT provisioned tenant_settings, and no quotes at all: must succeed as a no-op. */
  let emptyUnprovisionedTenantId: number;

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

  /**
   * `expireLeadRule` is fixed at creation, BEFORE any sweep runs, because the lead cascade fires
   * only in the run that actually expires the quote. Turning the rule on later and sweeping again
   * would cascade nothing — the quote is already Expired and no longer a candidate — so a test that
   * flipped the setting mid-suite would assert a no-op and pass for the wrong reason.
   */
  async function createTenant(
    label: string,
    options: { provisionSettings?: boolean; expireLeadRule?: boolean } = {},
  ): Promise<number> {
    const id = await insertReturningId(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-${label}`],
    );
    createdTenants.push(id);
    await query('select create_tenant_partitions($1)', [id]);

    if (options.provisionSettings !== false) {
      await query(
        `insert into tenant_settings (tenant_id, expire_lead_when_last_quote_expires, created_at, updated_at)
         values ($1, $2, now(), now())`,
        [id, options.expireLeadRule ?? false],
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

  /** Seeds one tenant's whole fixture graph. Every offset here is what makes `EXPECTED` true. */
  async function seedTenantFixtures(tenantId: number, marker: string): Promise<TenantFixture> {
    const partyType = await seedRef(tenantId, 'party_type', `${marker}-type`);
    const productLine = await seedRef(tenantId, 'product_line', `${marker}-motor`);
    const coverType = await seedRef(tenantId, 'cover_type', `${marker}-cover`, {
      productLineId: productLine,
    });
    const region = await seedRef(tenantId, 'region', `${marker}-region`);
    const channel = await seedRef(tenantId, 'request_channel', `${marker}-channel`);

    const leadQuoteSent = await seedRef(tenantId, 'lead_status', `${marker}-QuoteSent`, {
      reportingCategory: 'quoted',
      canonicalKey: 'quote_sent',
    });
    const leadExpired = await seedRef(tenantId, 'lead_status', `${marker}-LeadExpired`, {
      reportingCategory: 'expired',
      canonicalKey: 'expired',
    });

    const quoteStatuses: Record<string, number> = {
      draft: await seedRef(tenantId, 'quote_status', `${marker}-Draft`, {
        reportingCategory: 'open',
        canonicalKey: 'draft',
      }),
      sent: await seedRef(tenantId, 'quote_status', `${marker}-Sent`, {
        reportingCategory: 'quoted',
        canonicalKey: 'sent',
      }),
      revised: await seedRef(tenantId, 'quote_status', `${marker}-Revised`, {
        reportingCategory: 'quoted',
        canonicalKey: 'revised',
      }),
      won: await seedRef(tenantId, 'quote_status', `${marker}-Won`, {
        reportingCategory: 'won',
        canonicalKey: 'won',
      }),
      expired: await seedRef(tenantId, 'quote_status', `${marker}-Expired`, {
        reportingCategory: 'expired',
        canonicalKey: 'expired',
      }),
    };

    const party = await insertReturningId(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, `${marker}-client`, partyType],
    );

    async function seedLead(label: string, statusId: number): Promise<number> {
      return await insertReturningId(
        `insert into leads
           (tenant_id, party_id, lead_ref, date_received, request_channel_id, region_id,
            product_line_id, cover_type_id, policy_term, priority, status_id,
            pricing_approval_state, last_activity_at, source, created_at, updated_at)
         values ($1, $2, $3, $4::date, $5, $6, $7, $8, 'm12', 'normal', $9, 'none', $10, 'browser',
                 now(), now())
         returning id::text as id`,
        [tenantId, party, `${marker}-${label}`, TODAY, channel, region, productLine, coverType, statusId, NOW],
      );
    }

    // `is_current` is a parameter because `quotes_current_guard` permits only ONE current quote per
    // lead — the sibling fixture deliberately puts a second, non-current open quote on one lead.
    async function seedQuote(
      leadId: number,
      label: string,
      statusKey: string,
      validUntil: string | null,
      isCurrent = true,
    ): Promise<number> {
      const statusId = quoteStatuses[statusKey];
      if (statusId === undefined) throw new Error(`no seeded quote status "${statusKey}"`);
      const quoteId = await insertReturningId(
        `insert into quotes
           (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
            prepared_date, valid_until, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, now(), now())
         returning id::text as id`,
        [
          tenantId,
          leadId,
          `${marker}-${label}`,
          statusId,
          isCurrent,
          productLine,
          coverType,
          TODAY,
          validUntil,
        ],
      );
      await query(
        `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
         values ($1, $2, 1, 1000.00, true, now())`,
        [tenantId, quoteId],
      );
      return quoteId;
    }

    const leads: Record<string, number> = {};
    const quotes: Record<string, number> = {};

    // One lead per quote fixture, so a lead-level cascade in one case cannot perturb another.
    for (const [label, statusKey, validUntil] of [
      ['sentPast', 'sent', dateOffset(-1)],
      ['revisedPast', 'revised', dateOffset(-1)],
      ['boundaryToday', 'sent', dateOffset(0)],
      ['sentFuture', 'sent', dateOffset(1)],
      ['sentNoValidUntil', 'sent', null],
      ['draftPast', 'draft', dateOffset(-1)],
      ['wonPast', 'won', dateOffset(-1)],
    ] as const) {
      const leadId = await seedLead(label, leadQuoteSent);
      leads[label] = leadId;
      quotes[label] = await seedQuote(leadId, label, statusKey, validUntil);
    }

    // The lead-cascade fixtures live on their own leads with their own status ids.
    leads.cascadeSolo = await seedLead('cascade-solo', leadQuoteSent);
    quotes.cascadeSolo = await seedQuote(leads.cascadeSolo, 'q-cascade-solo', 'sent', dateOffset(-1));

    leads.cascadeSibling = await seedLead('cascade-sibling', leadQuoteSent);
    quotes.cascadeSibling = await seedQuote(
      leads.cascadeSibling,
      'q-cascade-sibling',
      'sent',
      dateOffset(-1),
    );
    // A SECOND, still-open quote on the same lead: the "no other open quote" guard must hold here.
    quotes.cascadeSiblingOpen = await seedQuote(
      leads.cascadeSibling,
      'q-cascade-sibling-open',
      'sent',
      dateOffset(30),
      false,
    );

    void leadExpired;
    return { tenantId, leads, quotes };
  }

  /** Quote canonical keys by fixture label, read straight from the database. */
  async function quoteKeysByLabel(fixture: TenantFixture): Promise<Record<string, string>> {
    const rows = await query<{ id: string; canonical_key: string | null }>(
      `select q.id::text as id, r.canonical_key
         from quotes q join reference_items r on r.id = q.status_id
        where q.tenant_id = $1`,
      [fixture.tenantId],
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row.canonical_key ?? '']));
    const result: Record<string, string> = {};
    for (const label of Object.keys(EXPECTED)) {
      const quoteId = fixture.quotes[label];
      if (quoteId === undefined) throw new Error(`no seeded quote labelled "${label}"`);
      result[label] = byId.get(quoteId) ?? '';
    }
    return result;
  }

  async function leadKey(tenantId: number, leadId: number): Promise<string> {
    const rows = await query<{ canonical_key: string | null }>(
      `select r.canonical_key from leads l join reference_items r on r.id = l.status_id
        where l.tenant_id = $1 and l.id = $2`,
      [tenantId, leadId],
    );
    return rows[0]?.canonical_key ?? '';
  }

  /** Every quote_status_history row for a tenant, ordered — the idempotency evidence. */
  async function quoteHistory(
    tenantId: number,
  ): Promise<{ id: number; quoteId: number; operation: string; actedBy: number | null }[]> {
    const rows = await query<{
      id: string;
      quote_id: string;
      operation: string;
      acted_by: string | null;
    }>(
      `select id::text as id, quote_id::text as quote_id, operation, acted_by::text as acted_by
         from quote_status_history where tenant_id = $1 order by id`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      quoteId: Number(row.quote_id),
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
    return await runQuoteExpirySweep(
      db,
      { logger: jobLogger({ jobName: QUOTE_EXPIRY_JOB_NAME, correlationId: RUN, trigger: 'manual' }) },
      { now: NOW, ...options },
    );
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    config = loadConfig({
      APP_ENV: 'local',
      LOG_LEVEL: 'error',
      SUPABASE_DATABASE_URL: stack.dbUrl,
      SUPABASE_DIRECT_DATABASE_URL: stack.dbUrl,
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

    actor = await auth.createTestUserWithSession({ label: 'quote-expiry' });
    void actor;

    // Tenant A: the cascade rule OFF. Tenant B: the cascade rule ON. The pair is what makes the
    // rule itself observable — the same fixture graph produces different LEAD outcomes.
    tenantA = await seedTenantFixtures(await createTenant('tenant-a'), `${RUN}-a`);
    tenantB = await seedTenantFixtures(
      await createTenant('tenant-b', { expireLeadRule: true }),
      `${RUN}-b`,
    );
    brokenTenantId = await createTenant('tenant-broken', { provisionSettings: false });
    await seedTenantFixtures(brokenTenantId, `${RUN}-broken`);
    emptyUnprovisionedTenantId = await createTenant('tenant-empty', { provisionSettings: false });
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
      QUOTE_EXPIRY_JOB_NAME,
      `${RUN}%`,
    ]).catch(() => undefined);

    await auth?.cleanup();
    await db?.destroy();
  }, 300_000);

  // -------------------------------------------------------------------------------------------
  // AC-066: only quotes past valid_until, in an expirable status, move
  // -------------------------------------------------------------------------------------------

  it('expires exactly the hand-computed quote set and leaves every other quote untouched', async () => {
    await sweep();

    expect(await quoteKeysByLabel(tenantA)).toEqual(EXPECTED);
  });

  it('leaves the quote whose valid_until is TODAY untouched (the < boundary, not <=)', async () => {
    await sweep();

    const keys = await quoteKeysByLabel(tenantA);
    // Stated separately from the table above so the boundary cannot be lost in a bulk edit: this is
    // the single assertion that distinguishes a correct threshold from one that expires everything.
    expect(keys.boundaryToday).toBe('sent');
    expect(keys.sentPast).toBe('expired');
  });

  it('expires a Revised quote as well as a Sent one (measured from the reference)', async () => {
    await sweep();

    expect((await quoteKeysByLabel(tenantA)).revisedPast).toBe('expired');
  });

  it('excludes non-expirable statuses from the CANDIDATE set, not merely from the outcome', async () => {
    const { counts } = await sweep();

    // Without the canonical-key predicate on the candidate query, a Draft or Won quote past its
    // valid_until would still not MOVE — the legality matrix rejects `expire_automatic` from those
    // statuses — so every row-level assertion in this suite would still pass. What changes is that
    // each becomes a failed candidate on EVERY run: a permanently non-zero failure count and a
    // warning log per closed quote, forever.
    //
    // `quotesFailed` is therefore the assertion that distinguishes "correctly filtered" from
    // "filtered by accident downstream".
    expect(counts.quotesFailed).toBe(0);
  });

  it('writes a system-actor history row and an audit row for each expired quote', async () => {
    await sweep();

    const history = await quoteHistory(tenantA.tenantId);
    const expired = history.filter((row) => row.operation === 'expire_automatic');
    // The four expirable quotes in this tenant: sentPast, revisedPast, cascadeSolo, cascadeSibling.
    expect(expired.map((row) => row.quoteId).sort((a, b) => a - b)).toEqual(
      [
        tenantA.quotes.sentPast,
        tenantA.quotes.revisedPast,
        tenantA.quotes.cascadeSolo,
        tenantA.quotes.cascadeSibling,
      ]
        .map(Number)
        .sort((a, b) => a - b),
    );
    // System actor: no user id is attributed to an automatic transition.
    expect(expired.every((row) => row.actedBy === null)).toBe(true);

    const audits = await auditRows(tenantA.tenantId);
    const quoteAudits = audits.filter((row) => row.action === 'quote.expire_automatic');
    expect(quoteAudits.map((row) => Number(row.entityId)).sort((a, b) => a - b)).toEqual(
      expired.map((row) => row.quoteId).sort((a, b) => a - b),
    );
    expect(quoteAudits.every((row) => row.entityType === 'quote')).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // AC-068: idempotency — a second run is a provable no-op
  // -------------------------------------------------------------------------------------------

  it('running the sweep twice changes nothing the second time (rows byte-identical, ids included)', async () => {
    await sweep();

    const keysAfterFirst = await quoteKeysByLabel(tenantA);
    const historyAfterFirst = await quoteHistory(tenantA.tenantId);
    const auditsAfterFirst = await auditRows(tenantA.tenantId);
    expect(historyAfterFirst.length).toBeGreaterThan(0);

    const second = await sweep();

    // Not merely "the same shape": the SAME ROWS, same ids. A second expire would append new
    // history and audit rows with new ids even though the status column already read 'expired'.
    expect(await quoteKeysByLabel(tenantA)).toEqual(keysAfterFirst);
    expect(await quoteHistory(tenantA.tenantId)).toEqual(historyAfterFirst);
    expect(await auditRows(tenantA.tenantId)).toEqual(auditsAfterFirst);
    // And the run itself reports that it found nothing left to do.
    expect(second.counts.quotesExpired).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // AC-067: the tenant-rule lead cascade
  // -------------------------------------------------------------------------------------------

  it('does not expire the lead when the tenant rule is off, even with no other open quote', async () => {
    await sweep();

    // tenant_settings.expire_lead_when_last_quote_expires defaults to false in this fixture.
    expect(await leadKey(tenantA.tenantId, Number(tenantA.leads.cascadeSolo))).toBe('quote_sent');
  });

  it('expires the lead when the rule is on and the expired quote was the last open one', async () => {
    await sweep();

    expect(await leadKey(tenantB.tenantId, Number(tenantB.leads.cascadeSolo))).toBe('expired');
  });

  it('leaves the lead open when another open quote survives, even with the rule on', async () => {
    await sweep();

    // cascadeSibling has a second Sent quote valid 30 days out: the lead must NOT expire.
    expect(await leadKey(tenantB.tenantId, Number(tenantB.leads.cascadeSibling))).toBe('quote_sent');
    const keys = await query<{ canonical_key: string | null }>(
      `select r.canonical_key from quotes q join reference_items r on r.id = q.status_id
        where q.tenant_id = $1 and q.id = $2`,
      [tenantB.tenantId, tenantB.quotes.cascadeSiblingOpen],
    );
    expect(keys[0]?.canonical_key).toBe('sent');
  });

  // -------------------------------------------------------------------------------------------
  // AC-022: tenant isolation
  // -------------------------------------------------------------------------------------------

  it('never moves a quote belonging to another tenant', async () => {
    await sweep();

    // Same fixtures, independent tenants: the per-label outcome must match exactly, and every row
    // the sweep touched in each tenant belongs to that tenant.
    expect(await quoteKeysByLabel(tenantB)).toEqual(EXPECTED);

    const tenantAQuoteIds = new Set(Object.values(tenantA.quotes).map(Number));
    for (const row of await quoteHistory(tenantA.tenantId)) {
      expect(tenantAQuoteIds.has(row.quoteId)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------------------------
  // AC-072: the sweep — per-tenant isolation of failure, job_run counts
  // -------------------------------------------------------------------------------------------

  it('completes the remaining tenants when one tenant fails, and names the failure', async () => {
    const { counts, failedTenantIds } = await sweep({ batchSize: 2 });

    expect(counts.tenantsProcessed).toBeGreaterThanOrEqual(2);
    // The unprovisioned tenant WITH expirable quotes is the fault injection: it throws, and the
    // sweep still completed the others in the SAME run.
    expect(failedTenantIds).toContain(brokenTenantId);
    expect(await quoteKeysByLabel(tenantA)).toEqual(EXPECTED);
  });

  it('does not fail an unprovisioned tenant that had nothing to expire', async () => {
    const { failedTenantIds } = await sweep();

    // The reference reads tenant_settings only after finding at least one candidate. A tenant with
    // no settings row and no due quotes must therefore be a clean no-op — otherwise every empty
    // tenant in the estate would turn every run red. Its twin, `brokenTenantId`, has the same
    // missing settings row and DOES fail, because it has quotes; the pair is what pins the order.
    expect(failedTenantIds).not.toContain(emptyUnprovisionedTenantId);
    expect(failedTenantIds).toContain(brokenTenantId);
  });

  it('records the run on job_run with per-tenant counts', async () => {
    await query(
      `insert into tenant_settings (tenant_id, created_at, updated_at) values ($1, now(), now())
       on conflict (tenant_id) do nothing`,
      [brokenTenantId],
    );

    const jobRuns = new PgJobRunRepository(db, config.appEnv);
    const handler = createQuoteExpiryHandler(db, { now: NOW });

    const outcome = await runCronJob(
      { db, handlers: new Map([[handler.name, handler]]), jobRuns },
      { jobName: QUOTE_EXPIRY_JOB_NAME, trigger: 'manual', correlationId: `${RUN}-clean` },
    );

    expect(outcome.status).toBe('succeeded');
    expect(outcome.counts?.tenantsFailed).toBe(0);

    const rows = await query<{ status: string; counts: unknown; job_name: string }>(
      `select status, counts, job_name from job_run where correlation_id = $1`,
      [`${RUN}-clean`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_name).toBe(QUOTE_EXPIRY_JOB_NAME);
    expect(rows[0]?.status).toBe('succeeded');
    expect(JSON.stringify(rows[0]?.counts)).toContain('quotesExpired');
  });
});
