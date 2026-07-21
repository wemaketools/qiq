-- 20260719000000_job_run.sql
--
-- Owner: T-031 (M-14/M-17, Q-7, N-08, spec §9.5, AC-063).
-- Source: no Liquibase changelog — this table REPLACES Hangfire's own job storage
--   (src/api/.../HangfireSetup.cs + the `hangfire` schema Hangfire created for itself).
--   Hangfire owned a dashboard, a job store and a retry state machine; on Vercel none of that
--   survives, so the parts we actually depended on are re-created explicitly:
--     - Hangfire dashboard      -> `job_run` history + `npm run jobs:status` (A-15, spec §9.4)
--     - Hangfire retry counters -> pgmq `read_ct` + `job_run.attempt` (see 20260719000100)
--     - Hangfire "job succeeded/failed" state -> `job_run.status`
--
-- WHY THIS TABLE EXISTS AT ALL
-- ===========================
-- A serverless job has no console to watch and no process to attach to. If a pg_cron -> pg_net
-- call never arrives, or a queue message fails five times at 03:00, the ONLY durable evidence is a
-- row here. "The handler logs it" is not sufficient: Vercel runtime logs are retained briefly and
-- cannot be queried per tenant. Every job execution — cron sweep, queue message, or manual local
-- run — writes exactly one row per ATTEMPT.
--
-- Rollback/recovery: this is observability history, not business data; it can be truncated without
-- affecting correctness (the sweeps are state-guarded and re-converge). It must NOT be dropped
-- while `job_idempotency_key` exists, since that table references it.

create table job_run (
    id bigint generated always as identity primary key,

    -- The handler name ('quote-expiry', 'alert.reevaluate-lead', ...), not a queue name.
    job_name text not null,

    -- How this execution was triggered. 'cron' = pg_cron -> pg_net -> /api/cron/{job};
    -- 'queue' = a pgmq message drained by /api/queue/drain or `npm run queue:worker`;
    -- 'manual' = a local script or an operator invocation.
    trigger text not null,

    -- N-08 environment stamp, taken from APP_ENV via the typed config module. Preview and
    -- production share a database in no configuration we run, but a restored dump does share a
    -- table — without this column a production incident could be "explained" by a preview run.
    environment text not null,

    -- §15 correlation: the id travels request -> pgmq message -> this row, so one grep spans the
    -- API call that enqueued the work and the job that performed it.
    correlation_id text not null,

    -- Queue executions only: the dedupe key and the pgmq message id behind this attempt.
    idempotency_key text,
    message_id bigint,

    -- 1 for a first delivery; pgmq's read_ct for a redelivery. Makes "this failed 5 times" a
    -- query rather than an inference from row counts.
    attempt integer not null default 1,

    started_at timestamptz not null default now(),
    finished_at timestamptz,
    duration_ms integer,

    status text not null,

    -- Populated only on failure. error_stack is truncated by the writer; a stack is a debugging
    -- aid, not a place to accumulate unbounded text.
    error_class text,
    error_message text,
    error_stack text,

    -- Per-run outcome counters, e.g. {"tenants": 3, "quotesExpired": 12} or {"duplicate": 1}.
    -- Deliberately jsonb: these differ per job and are read by operators, never joined on.
    -- (This is an observability payload, not a queryable core business field — CLAUDE.md's
    -- "no JSONB for queryable core business fields" rule is about the latter.)
    counts jsonb
);

alter table job_run add constraint ck_job_run_trigger
    check (trigger in ('cron', 'queue', 'manual'));

alter table job_run add constraint ck_job_run_environment
    check (environment in ('local', 'preview', 'staging', 'production'));

alter table job_run add constraint ck_job_run_status
    check (status in ('running', 'succeeded', 'failed'));

alter table job_run add constraint ck_job_run_attempt_positive
    check (attempt >= 1);

-- A terminal row without a finish time is a row that cannot be timed, and a 'running' row with a
-- finish time is a lie about a job still in flight. Both are rejected outright rather than left to
-- the writer's discipline: the whole value of this table is that the history can be trusted.
alter table job_run add constraint ck_job_run_terminal_has_finish
    check (
        (status = 'running' and finished_at is null and duration_ms is null)
        or (status <> 'running' and finished_at is not null and duration_ms is not null)
    );

alter table job_run add constraint ck_job_run_duration_non_negative
    check (duration_ms is null or duration_ms >= 0);

-- A failure with no error recorded is indistinguishable from a bug in the recorder. Forbid it.
alter table job_run add constraint ck_job_run_failure_has_error
    check (status <> 'failed' or error_message is not null);

-- "What did this job do lately?" — the jobs:status query and every incident starts here.
create index ix_job_run_job_name_started_at on job_run (job_name, started_at desc);

-- "What is failing / stuck right now?" Partial, because succeeded rows dominate the table and are
-- never the subject of this question.
create index ix_job_run_unhealthy on job_run (started_at desc)
    where status in ('running', 'failed');

-- Tracing one correlation id across the API request and its downstream job.
create index ix_job_run_correlation_id on job_run (correlation_id);

comment on table job_run is
    'Durable per-attempt history of every background job execution (spec §9.5, AC-063). Replaces the Hangfire dashboard/job store; read by `npm run jobs:status`.';
comment on column job_run.attempt is
    'Delivery attempt number: 1 for a first run, pgmq read_ct for a redelivered queue message.';
comment on column job_run.counts is
    'Per-run outcome counters for operators (observability payload, not a queryable business field).';

-- ================================================================================================
-- job_idempotency_key — THE OBJECT THAT MAKES AT-LEAST-ONCE DELIVERY SAFE.
-- ================================================================================================
-- pgmq, like every durable queue worth using, is AT-LEAST-ONCE. A message is redelivered whenever
-- its visibility timeout expires before it is acked — which happens on a handler crash, a Vercel
-- function timeout, or a network failure between committing the effect and deleting the message.
-- The consumer therefore MUST be able to recognise work it has already done.
--
-- The claim and the effect are written in the SAME transaction (see src/server/jobs/queue/drain.ts).
-- That ordering is the entire guarantee:
--   - handler succeeds -> key row and effect commit together -> a redelivery finds the key and
--     skips, so the effect is applied exactly once;
--   - handler throws   -> the key row rolls back WITH the effect -> the retry is free to run again,
--     so a transient failure does not permanently poison the key.
-- A key inserted in its own transaction before the handler would break the second case: the first
-- failure would burn the key and the retry would skip real work. Do not "optimise" it that way.
create table job_idempotency_key (
    -- The natural key supplied by the producer, e.g. '{leadId}:{statusHistoryId}' (spec §9.5).
    key text primary key,
    job_name text not null,
    -- Nullable: cross-tenant/global jobs have no single tenant. No FK — this table outlives the
    -- business rows it describes and must never block a tenant purge.
    tenant_id bigint,
    claimed_at timestamptz not null default now(),
    -- The attempt that won the claim, for tracing a skipped duplicate back to the real execution.
    job_run_id bigint references job_run (id) on delete set null
);

create index ix_job_idempotency_key_claimed_at on job_idempotency_key (claimed_at);

comment on table job_idempotency_key is
    'Claimed idempotency keys for queue messages (spec §9.5). Claimed in the SAME transaction as the handler effect, so a duplicate delivery is a no-op and a failed attempt releases the key.';
