/**
 * Targeted alert re-evaluation, end to end through pgmq (T-034; AC-071; V-089, spec §9.5 Job 4).
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 * ===================================
 * The failure mode for wiring work is not "the code is wrong", it is "the code is never reached".
 * A handler registered under a key nothing publishes, a producer publishing a key nothing handles,
 * or a seam that no composition root ever supplies all look identical to working code from any test
 * that asserts a registry contains a name. So nothing here asserts registration. Every test drives
 * the REAL executor, through the REAL seam, into a REAL pgmq queue, out through the REAL drain
 * loop, and then asserts the ALERT ROW changed. If any link were missing the alert would simply
 * stay open and every one of these would go red.
 *
 * ISOLATED QUEUE, DELIBERATELY
 * ============================
 * This suite creates and drops its own pgmq queue instead of using `alert_reevaluation`. Two
 * reasons: other job suites `purge_queue` the shared one between tests (which would silently eat
 * this suite's messages and turn convergence assertions into vacuous passes), and a suite that
 * purges shared state cannot be run concurrently with anything.
 *
 * THE FIXTURE HAS WORK TO DO
 * ==========================
 * The lead is seeded idle for eight days so the `stalled_lead` rule genuinely matches BEFORE the
 * workflow operation runs — asserted explicitly in `beforeAll`'s successor test rather than
 * assumed. A fixture where the sweep has nothing to do is the classic vacuous scheduling test:
 * unregister the handler entirely and it still passes.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reconcileTenantAlerts } from '../../domains/alerts/index.js';
import {
  startInformationGathering,
  type LeadWorkflowActor,
} from '../../domains/leads/workflow/operations.js';
import { runAlertEvaluationSweep } from '../../jobs/cron/alert-evaluation.js';
import { runLeadInactivityExpirySweep } from '../../jobs/cron/lead-inactivity-expiry.js';
import { runQuoteExpirySweep } from '../../jobs/cron/quote-expiry.js';
import {
  ALERT_REEVALUATE_LEAD_TYPE,
  alertReevaluationKey,
  createAlertReevaluationSeam,
} from '../../jobs/queue/alert-reevaluate-lead.js';
import { createJobRuntime, type JobRuntime } from '../../jobs/runtime.js';
import { registerQueueHandler } from '../../jobs/queue/registry.js';
import { jobMessageEnvelopeSchema, type JobHandler } from '../../jobs/types.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, toTenantId, type Database, type TenantId } from '../../lib/db/index.js';
import { jobLogger, type Logger } from '../../lib/logging/index.js';
import { TestAuthFixtures } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('targeted alert re-evaluation', probe);

const RUN = `t034rq-${process.pid}-${Date.now()}`;
/** pgmq derives table names from this, so it must satisfy the adapter's `SAFE_QUEUE_NAME`. */
const QUEUE = `t034_${process.pid}_${Date.now() % 100_000}`;

const DAY_MS = 86_400_000;

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

const STALLED = 'stalled_lead';

/** A handler that always throws, for the retry/dead-letter leg. Registered once. */
const POISON_TYPE = 'test.t034-always-fails';
const alwaysFailsHandler: JobHandler = {
  name: POISON_TYPE,
  handle: () => Promise.reject(new Error('deliberate handler failure')),
};

function silentLogger(): Logger {
  const log: Logger = {
    context: {},
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
}

/**
 * MEASURED against 20260718003600_alerts.sql: the column is `type` (not `alert_type`) and "open"
 * is `resolved_at is null` (there is no status column).
 */
interface AlertRow extends Record<string, unknown> {
  readonly id: string;
  readonly type: string;
  readonly lead_id: string | null;
  readonly created_at: string;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let runtime: JobRuntime;

  let tenantId: number;
  let tenant: TenantId;
  /** The lead the workflow operation acts on. */
  let subjectLeadId: number;
  /** A second stalled lead in the SAME tenant. Its alerts must never be touched by a targeted run. */
  let bystanderLeadId: number;
  /** A third lead carrying an already-past Sent quote, for the quote-expiry sweep leg. */
  let quoteLeadId: number;
  let actor: LeadWorkflowActor;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(text, params);
  }

  async function insertReturningId(text: string, params: unknown[]): Promise<number> {
    const rows = await query<{ id: string }>(text, params);
    return Number(rows[0]?.id);
  }

  async function seedRef(
    tenant_id: number,
    listType: string,
    name: string,
    options: { reportingCategory?: string; canonicalKey?: string; productLineId?: number } = {},
  ): Promise<number> {
    return await insertReturningId(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          product_line_id, created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, $6, now(), now()) returning id::text as id`,
      [
        tenant_id,
        listType,
        name,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.productLineId ?? null,
      ],
    );
  }

  /** Open alerts for one lead, ordered so two reads are directly comparable. */
  async function openAlerts(leadId: number): Promise<AlertRow[]> {
    return await query<AlertRow>(
      `select id::text as id, type, lead_id::text as lead_id, created_at::text as created_at
         from alerts
        where tenant_id = $1 and lead_id = $2 and resolved_at is null
        order by type`,
      [tenantId, leadId],
    );
  }

  async function openAlertTypes(leadId: number): Promise<string[]> {
    return (await openAlerts(leadId)).map((row) => row.type);
  }

  /** Drains this suite's queue once, with retries disabled from interfering. */
  async function drainOnce(): Promise<Awaited<ReturnType<JobRuntime['consumer']['drain']>>> {
    return await runtime.consumer.drain({ visibilityTimeoutSeconds: 30, retryDelaySeconds: 1 });
  }

  async function queuedMessages(): Promise<{ msg_id: string; read_ct: number; message: unknown }[]> {
    const result = await sql<{ msg_id: string; read_ct: number; message: unknown }>`
      select msg_id::text as msg_id, read_ct, message from pgmq.q_${sql.raw(QUEUE)} order by msg_id
    `.execute(db);
    return [...result.rows];
  }

  async function archivedMessages(): Promise<{ msg_id: string }[]> {
    const result = await sql<{ msg_id: string }>`
      select msg_id::text as msg_id from pgmq.a_${sql.raw(QUEUE)} order by msg_id
    `.execute(db);
    return [...result.rows];
  }

  /** Puts the subject lead back to "stalled eight days" so each test starts from the same state. */
  async function resetSubjectToStalled(): Promise<void> {
    const idle = new Date(Date.now() - 8 * DAY_MS).toISOString();
    await query(
      `update leads set last_activity_at = $3, status_id = $4, updated_at = now()
        where tenant_id = $1 and id = $2`,
      [tenantId, subjectLeadId, idle, assignedStatusId],
    );
    await query(`delete from alerts where tenant_id = $1 and lead_id = $2`, [
      tenantId,
      subjectLeadId,
    ]);
    await query(`delete from lead_status_history where tenant_id = $1 and lead_id = $2`, [
      tenantId,
      subjectLeadId,
    ]);
    await sql`select pgmq.purge_queue(${QUEUE})`.execute(db);
    await reconcileTenantAlerts(db, tenant);
  }

  let assignedStatusId = 0;

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

    await sql`select pgmq.create(${QUEUE})`.execute(db);
    runtime = createJobRuntime({ config, db, queueName: QUEUE });
    registerQueueHandler(alwaysFailsHandler);

    tenantId = await insertReturningId(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-tenant`],
    );
    createdTenants.push(tenantId);
    tenant = toTenantId(tenantId);
    await query('select create_tenant_partitions($1)', [tenantId]);
    await query(
      `insert into tenant_settings
         (tenant_id, unassigned_lead_hours, stalled_lead_days, stalled_quote_days,
          quote_expiry_alert_days, pricing_approval_target_days, sla_assignment_days,
          sla_underwriting_days, sla_received_to_sent_days, high_value_threshold,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, now(), now())`,
      [
        tenantId,
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

    const partyType = await seedRef(tenantId, 'party_type', `${RUN}-type`);
    const productLine = await seedRef(tenantId, 'product_line', `${RUN}-motor`);
    const coverType = await seedRef(tenantId, 'cover_type', `${RUN}-cover`, {
      productLineId: productLine,
    });
    const region = await seedRef(tenantId, 'region', `${RUN}-region`);
    const channel = await seedRef(tenantId, 'request_channel', `${RUN}-channel`);

    assignedStatusId = await seedRef(tenantId, 'lead_status', `${RUN}-Assigned`, {
      reportingCategory: 'open',
      canonicalKey: 'assigned',
    });
    // `start-information-gathering`'s fixed target. Without it the operation throws and the whole
    // suite would fail loudly rather than silently skipping the enqueue.
    await seedRef(tenantId, 'lead_status', `${RUN}-InfoGathering`, {
      reportingCategory: 'open',
      canonicalKey: 'information_gathering',
    });
    // `expire_automatic`'s fixed target, needed by the inactivity sweep test below.
    await seedRef(tenantId, 'lead_status', `${RUN}-Expired`, {
      reportingCategory: 'lost',
      canonicalKey: 'expired',
    });
    // Quote statuses for the quote-expiry sweep leg: `sent` is the legal source, `expired` the
    // fixed target of the quote-side `expire_automatic`.
    const quoteStatusSent = await seedRef(tenantId, 'quote_status', `${RUN}-QSent`, {
      reportingCategory: 'quoted',
      canonicalKey: 'sent',
    });
    await seedRef(tenantId, 'quote_status', `${RUN}-QExpired`, {
      reportingCategory: 'lost',
      canonicalKey: 'expired',
    });

    const party = await insertReturningId(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, `${RUN}-client`, partyType],
    );

    const today = new Date().toISOString().slice(0, 10);
    const idle = new Date(Date.now() - 8 * DAY_MS).toISOString();

    async function seedLead(label: string): Promise<number> {
      return await insertReturningId(
        `insert into leads
           (tenant_id, party_id, lead_ref, date_received, request_channel_id, region_id,
            product_line_id, cover_type_id, policy_term, priority, status_id,
            pricing_approval_state, last_activity_at, source, created_at, updated_at)
         values ($1, $2, $3, $4::date, $5, $6, $7, $8, 'm12', 'normal', $9, 'none', $10,
                 'browser', $10, now())
         returning id::text as id`,
        [tenantId, party, `${RUN}-${label}`, today, channel, region, productLine, coverType, assignedStatusId, idle],
      );
    }

    subjectLeadId = await seedLead('subject');
    bystanderLeadId = await seedLead('bystander');
    quoteLeadId = await seedLead('quote-holder');
    // FRESH, not idle. The inactivity sweep test expires every stalled lead in this tenant, and an
    // already-expired lead makes the quote-expiry cascade illegal — which would silently reduce
    // this suite's cascade assertion to "one message" and hide a dropped seam. Order independence
    // is bought here rather than assumed.
    await query(`update leads set last_activity_at = now() where tenant_id = $1 and id = $2`, [
      tenantId,
      quoteLeadId,
    ]);

    const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
    const quoteId = await insertReturningId(
      `insert into quotes
         (tenant_id, lead_id, quote_ref, status_id, is_current, product_line_id, cover_type_id,
          prepared_date, valid_until, created_at, updated_at)
       values ($1, $2, $3, $4, true, $5, $6, $7::date, $8::date, now(), now())
       returning id::text as id`,
      [tenantId, quoteLeadId, `${RUN}-q1`, quoteStatusSent, productLine, coverType, today, yesterday],
    );
    await query(
      `insert into quote_versions (tenant_id, quote_id, version_no, quoted_premium, is_current, created_at)
       values ($1, $2, 1, 1000::numeric, true, now())`,
      [tenantId, quoteId],
    );

    // The system actor: `executeLeadOperation` skips the permission check for it, which keeps this
    // suite about the job wiring rather than about RBAC (covered by the workflow suites).
    actor = { userId: null, tenantId: tenant, access: null, isSystemActor: true, correlationId: `${RUN}-corr` };

    await reconcileTenantAlerts(db, tenant);
  }, 300_000);

  afterAll(async () => {
    if (!probe.available) return;

    // Data deletion MUST precede `auth.cleanup()`: that call ends the pool these deletes run on,
    // and each delete swallows its error, so the reverse order is a silent no-op.
    for (const id of createdTenants) {
      for (const table of [
        'alerts',
        'user_alert_views',
        'lead_status_history',
        'quote_status_history',
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
        await query(`delete from ${table} where tenant_id = $1`, [id]).catch(() => undefined);
      }
      await query('delete from tenants where id = $1', [id]).catch(() => undefined);
    }
    await query('delete from job_run where correlation_id like $1', [`${RUN}%`]).catch(
      () => undefined,
    );
    await query('delete from job_idempotency_key where tenant_id = any($1::bigint[])', [
      createdTenants,
    ]).catch(() => undefined);

    // Drops q_/a_ together, so this suite leaves no pgmq residue either.
    await sql`select pgmq.drop_queue(${QUEUE})`.execute(db).catch(() => undefined);

    await auth?.cleanup();
    await db?.destroy();
  }, 300_000);

  // -------------------------------------------------------------------------------------------
  // The fixture is not vacuous
  // -------------------------------------------------------------------------------------------

  it('starts with BOTH leads genuinely stalled, so the sweep and the handler have work to do', async () => {
    expect(await openAlertTypes(subjectLeadId)).toContain(STALLED);
    expect(await openAlertTypes(bystanderLeadId)).toContain(STALLED);
  });

  // -------------------------------------------------------------------------------------------
  // AC-071 / V-089: enqueue, drain, converge
  // -------------------------------------------------------------------------------------------

  it('enqueues an alert.reevaluate-lead message keyed {leadId}:{statusHistoryId} when an operation completes', async () => {
    await resetSubjectToStalled();

    await startInformationGathering(
      { db, onLeadChanged: runtime.onLeadChanged },
      subjectLeadId,
      { note: 'wiring' },
      actor,
    );

    const messages = await queuedMessages();
    expect(messages).toHaveLength(1);

    const envelope = jobMessageEnvelopeSchema.parse(messages[0]?.message);
    expect(envelope.type).toBe(ALERT_REEVALUATE_LEAD_TYPE);
    expect(envelope.tenantId).toBe(tenantId);
    expect(envelope.payload).toEqual({ leadId: subjectLeadId });
    // §15: the request's correlation id reached the message.
    expect(envelope.correlationId).toBe(`${RUN}-corr`);

    // The key's event component is THE row the operation just appended — not the clock, not the
    // operation name. Read it back and compare, so a producer that invented a key fails here.
    const history = await query<{ id: string }>(
      `select id::text as id from lead_status_history
        where tenant_id = $1 and lead_id = $2 order by id desc limit 1`,
      [tenantId, subjectLeadId],
    );
    expect(envelope.idempotencyKey).toBe(
      alertReevaluationKey(subjectLeadId, String(history[0]?.id)),
    );
  });

  it('DRAINING the message clears the satisfied alert — the whole chain, not just registration', async () => {
    await resetSubjectToStalled();
    expect(await openAlertTypes(subjectLeadId)).toContain(STALLED);

    await startInformationGathering(
      { db, onLeadChanged: runtime.onLeadChanged },
      subjectLeadId,
      { note: 'wiring' },
      actor,
    );

    const summary = await drainOnce();
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);

    // The operation stamped last_activity_at, so the stalled rule no longer matches.
    expect(await openAlertTypes(subjectLeadId)).not.toContain(STALLED);

    // And the dispatch really went through THIS handler, with counts on the job_run row.
    const runs = await query<{ job_name: string; status: string; counts: unknown }>(
      `select job_name, status, counts from job_run
        where correlation_id = $1 and job_name = $2`,
      [`${RUN}-corr`, ALERT_REEVALUATE_LEAD_TYPE],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');
    expect(runs[0]?.counts).toMatchObject({ leadId: subjectLeadId, resolved: expect.any(Number) });
  });

  it('re-evaluates ONLY the named lead: the bystander’s alert rows are byte-identical afterwards', async () => {
    await resetSubjectToStalled();
    const before = await openAlerts(bystanderLeadId);
    expect(before.length).toBeGreaterThan(0);

    await startInformationGathering(
      { db, onLeadChanged: runtime.onLeadChanged },
      subjectLeadId,
      { note: 'wiring' },
      actor,
    );
    await drainOnce();

    // Identical INCLUDING ids and created_at: a resolve-then-recreate would change both while
    // leaving the type set looking untouched.
    expect(await openAlerts(bystanderLeadId)).toEqual(before);
  });

  it('converges on duplicate delivery: the same message twice leaves rows identical, including ids', async () => {
    await resetSubjectToStalled();
    await startInformationGathering(
      { db, onLeadChanged: runtime.onLeadChanged },
      subjectLeadId,
      { note: 'wiring' },
      actor,
    );

    const original = (await queuedMessages())[0];
    expect(original).toBeDefined();
    await drainOnce();
    const afterFirst = await openAlerts(subjectLeadId);

    // Re-send the IDENTICAL body: this is what an at-least-once transport does after a crash
    // between the handler committing and the broker recording the ack.
    await sql`select pgmq.send(${QUEUE}, ${JSON.stringify(original?.message)}::jsonb)`.execute(db);
    const second = await drainOnce();

    // Skipped by the claimed idempotency key rather than re-executed.
    expect(second.duplicates).toBe(1);
    expect(second.succeeded).toBe(0);
    expect(await openAlerts(subjectLeadId)).toEqual(afterFirst);
  });

  it('converges after a replay that crashed BEFORE the ack (key released with the rollback)', async () => {
    await resetSubjectToStalled();
    await startInformationGathering(
      { db, onLeadChanged: runtime.onLeadChanged },
      subjectLeadId,
      { note: 'wiring' },
      actor,
    );

    // A crash before ack rolls back the handler's effect AND its idempotency claim together, so the
    // redelivery must do the work for real. Simulated by dropping the claim and re-sending, which
    // is the state that transaction leaves behind.
    const original = (await queuedMessages())[0];
    await drainOnce();
    const afterFirst = await openAlerts(subjectLeadId);

    await query('delete from job_idempotency_key where tenant_id = $1', [tenantId]);
    await sql`select pgmq.send(${QUEUE}, ${JSON.stringify(original?.message)}::jsonb)`.execute(db);
    const replay = await drainOnce();

    expect(replay.succeeded).toBe(1);
    // Re-executed for real this time, and STILL the same final state: that is reconciliation
    // rather than deduplication doing the work.
    expect(await openAlerts(subjectLeadId)).toEqual(afterFirst);
  });

  it('five consecutive drains after convergence report no further work', async () => {
    await resetSubjectToStalled();
    await startInformationGathering(
      { db, onLeadChanged: runtime.onLeadChanged },
      subjectLeadId,
      { note: 'wiring' },
      actor,
    );
    await drainOnce();
    const converged = await openAlerts(subjectLeadId);

    for (let i = 0; i < 5; i += 1) {
      const summary = await drainOnce();
      expect(summary.read).toBe(0);
      expect(await openAlerts(subjectLeadId)).toEqual(converged);
    }
  });

  // -------------------------------------------------------------------------------------------
  // AC-071: the sweep is the safety net
  // -------------------------------------------------------------------------------------------

  it('a publish failure does not fail the committed operation, and the sweep converges anyway', async () => {
    await resetSubjectToStalled();

    const brokenSeam = createAlertReevaluationSeam({
      publisher: { enqueue: () => Promise.reject(new Error('queue down')) },
      logger: silentLogger(),
    });

    // The operation must SUCCEED: it is already durable by the time the seam runs.
    await expect(
      startInformationGathering({ db, onLeadChanged: brokenSeam }, subjectLeadId, { note: 'x' }, actor),
    ).resolves.toBe(subjectLeadId);
    expect(await queuedMessages()).toHaveLength(0);

    // The alert is therefore still open — nothing re-evaluated it...
    expect(await openAlertTypes(subjectLeadId)).toContain(STALLED);
    // ...until the every-15-minute sweep does. This is the bound on how stale things can get.
    await runAlertEvaluationSweep(db, { logger: jobLogger({ jobName: 'test', trigger: 'manual', correlationId: `${RUN}-sweep` }) });
    expect(await openAlertTypes(subjectLeadId)).not.toContain(STALLED);
  });

  it('a DROPPED message is survivable: purging before the drain still converges via the sweep', async () => {
    await resetSubjectToStalled();
    await startInformationGathering(
      { db, onLeadChanged: runtime.onLeadChanged },
      subjectLeadId,
      { note: 'wiring' },
      actor,
    );

    await sql`select pgmq.purge_queue(${QUEUE})`.execute(db);
    const summary = await drainOnce();
    expect(summary.read).toBe(0);
    expect(await openAlertTypes(subjectLeadId)).toContain(STALLED);

    await runAlertEvaluationSweep(db, { logger: jobLogger({ jobName: 'test', trigger: 'manual', correlationId: `${RUN}-sweep` }) });
    expect(await openAlertTypes(subjectLeadId)).not.toContain(STALLED);
  });

  // -------------------------------------------------------------------------------------------
  // F-032-2 / AC-066: the EXPIRY sweeps refresh alerts too
  // -------------------------------------------------------------------------------------------

  it('the lead-inactivity sweep publishes a re-evaluation for every lead it expires (AC-066)', async () => {
    // MEASURED FROM THE REFERENCE, not inferred: `LeadInactivityExpiryJob` resolves
    // `LeadOperationExecutor` from its DI scope, and that executor calls
    // `IAlertReevaluationQueue.EnqueueLeadReevaluationAsync` after it commits. So in .NET an
    // AUTOMATIC expiry refreshed the lead's alerts through the same seam a human action does.
    // In TypeScript the deps are constructed by hand, so a sweep that passed a bare `{ db }` would
    // expire everything perfectly and refresh nothing — and no expiry test would notice, because
    // the alerts converge anyway 15 minutes later. This is the assertion that notices.
    await resetSubjectToStalled();
    // Threshold below the fixture's 8 idle days, so the subject is a genuine candidate.
    await query(
      `update tenant_settings set lead_inactivity_expiry_days = 3 where tenant_id = $1`,
      [tenantId],
    );

    await runLeadInactivityExpirySweep(
      db,
      { logger: jobLogger({ jobName: 'test', trigger: 'manual', correlationId: `${RUN}-sweep` }) },
      { onLeadChanged: runtime.onLeadChanged },
    );

    const messages = await queuedMessages();
    const forSubject = messages
      .map((row) => jobMessageEnvelopeSchema.parse(row.message))
      .filter((envelope) => envelope.payload.leadId === subjectLeadId);

    expect(forSubject).toHaveLength(1);
    expect(forSubject[0]?.type).toBe(ALERT_REEVALUATE_LEAD_TYPE);
    expect(forSubject[0]?.tenantId).toBe(tenantId);

    // And draining it actually clears the stalled alert, so the refresh is real rather than a
    // message nobody acts on.
    await drainOnce();
    expect(await openAlertTypes(subjectLeadId)).not.toContain(STALLED);

    await query(`update tenant_settings set lead_inactivity_expiry_days = 60 where tenant_id = $1`, [
      tenantId,
    ]);
  }, 60_000);

  it('the quote-expiry sweep publishes a re-evaluation for the lead whose quote it expires (AC-066)', async () => {
    // Same reference-derived reasoning as the inactivity sweep above, on the OTHER expiry job.
    // Asserted separately rather than assumed from the sibling, because they are two independent
    // `workflowDeps` constructions in two files — and the whole failure mode being guarded here is
    // one call site quietly keeping its bare `{ db }`.
    await sql`select pgmq.purge_queue(${QUEUE})`.execute(db);
    // Restore the quote holder to an open status regardless of what ran before this test.
    await query(
      `update leads set status_id = $3, last_activity_at = now() where tenant_id = $1 and id = $2`,
      [tenantId, quoteLeadId, assignedStatusId],
    );
    // The cascade rule ON, deliberately: this sweep has TWO executor call sites (the quote's own
    // expiry and the lead cascade behind `expire_lead_when_last_quote_expires`), and with the rule
    // off the second is dead code that a bare `{ db }` could hide in indefinitely. The quote lead
    // holds exactly one open quote, so expiring it triggers the cascade.
    await query(
      `update tenant_settings set expire_lead_when_last_quote_expires = true where tenant_id = $1`,
      [tenantId],
    );

    await runQuoteExpirySweep(db, { logger: jobLogger({ jobName: 'test', trigger: 'manual', correlationId: `${RUN}-sweep` }) }, {
      onLeadChanged: runtime.onLeadChanged,
    });

    const forQuoteLead = (await queuedMessages())
      .map((row) => jobMessageEnvelopeSchema.parse(row.message))
      .filter((envelope) => envelope.payload.leadId === quoteLeadId);

    // EXACTLY TWO, one per executor call site: the quote expiry and the lead cascade. Asserting
    // ">= 1" here would let either call site lose its seam unnoticed.
    expect(forQuoteLead).toHaveLength(2);
    expect(forQuoteLead.every((e) => e.type === ALERT_REEVALUATE_LEAD_TYPE)).toBe(true);
    expect(forQuoteLead.every((e) => e.tenantId === tenantId)).toBe(true);
    // Distinct keys: the two events are two units of work, not one deduplicated into nothing.
    expect(new Set(forQuoteLead.map((e) => e.idempotencyKey)).size).toBe(2);

    await query(
      `update tenant_settings set expire_lead_when_last_quote_expires = false where tenant_id = $1`,
      [tenantId],
    );
  }, 60_000);

  // -------------------------------------------------------------------------------------------
  // Retry and dead-letter, on this suite's own queue
  // -------------------------------------------------------------------------------------------

  it('a failing message redelivers up to maxAttempts and is then archived with failed job_run rows', async () => {
    await sql`select pgmq.purge_queue(${QUEUE})`.execute(db);
    const correlationId = `${RUN}-poison`;

    await runtime.publisher.enqueue(
      jobMessageEnvelopeSchema.parse({
        type: POISON_TYPE,
        tenantId,
        correlationId,
        idempotencyKey: `${RUN}:poison`,
        payload: {},
      }),
    );

    const maxAttempts = 3;
    let deadLettered = 0;
    for (let attempt = 0; attempt < maxAttempts + 1; attempt += 1) {
      const summary = await runtime.consumer.drain({
        maxAttempts,
        retryDelaySeconds: 1,
        visibilityTimeoutSeconds: 1,
      });
      deadLettered += summary.deadLettered;
      // The retry delay is real, so wait it out rather than asserting a spin.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }

    expect(deadLettered).toBe(1);
    expect(await queuedMessages()).toHaveLength(0);
    expect(await archivedMessages()).toHaveLength(1);

    const runs = await query<{ status: string }>(
      `select status from job_run where correlation_id = $1`,
      [correlationId],
    );
    expect(runs.length).toBeGreaterThanOrEqual(maxAttempts);
    expect(runs.every((row) => row.status === 'failed')).toBe(true);
  }, 60_000);
});
