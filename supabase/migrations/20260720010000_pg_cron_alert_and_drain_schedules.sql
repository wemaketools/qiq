-- 20260720010000_pg_cron_alert_and_drain_schedules.sql
--
-- Owner: T-034. The remaining two pg_cron schedules (M-13, M-16, M-22, AC-068, V-085, spec §9.5
-- Jobs 3-4), plus a correctness fix to the T-032 helper they share.
--
--   alert-evaluation   '*/15 * * * *'  -> GET  /api/cron/alert-evaluation
--   queue-drain        '* * * * *'     -> POST /api/queue/drain
--
-- ALL SCHEDULES ARE UTC, matching 20260720000000_pg_cron_expiry_schedules.sql and
-- docs/background-jobs.md. Read that migration's header first: the `job_cron_config` mechanism, the
-- "no URL and no secret is committed" rule, and the empty-config-is-a-NOTICE local behaviour are
-- all defined there and are reused verbatim here rather than reinvented.
--
-- ============================================================================================
-- FIX: pg_net's FUNCTIONS LIVE IN SCHEMA `net`, NOT `extensions`.
-- ============================================================================================
-- `invoke_cron_endpoint` shipped calling `extensions.http_get(...)`. That function does not exist.
-- The pg_net EXTENSION is registered in the `extensions` schema (`\dx` shows `pg_net | extensions`),
-- which is what the original reasonably inferred from — but pg_net creates and owns its own `net`
-- schema and installs `http_get`/`http_post`/`http_delete` THERE regardless of where the extension
-- itself is registered. Measured on the local stack:
--
--   to_regprocedure('extensions.http_get(text,jsonb,jsonb,integer)')  -> NULL
--   to_regprocedure('net.http_get(text,jsonb,jsonb,integer)')         -> present
--
-- and calling the helper with a populated config row raised:
--
--   function extensions.http_get(url => text, headers => jsonb, timeout_milliseconds => integer)
--   does not exist
--
-- So every deployed sweep would have failed at its scheduled minute, forever, with the failure
-- visible only in the Postgres log. This survived review because the existing assertions check the
-- helper's SOURCE TEXT (`prosrc` contains the path expression) and the `cron.job` rows — neither of
-- which requires the function to resolve, let alone run. `pg-cron-schedules.test.ts` now EXECUTES
-- both helpers against a rolled-back config row, which is the assertion that would have caught it.
--
-- `create or replace` is the forward fix; the original migration is left as applied history.

-- --------------------------------------------------------------------------------------------
-- Configuration: the drain endpoint authenticates against a DIFFERENT secret
-- --------------------------------------------------------------------------------------------

-- /api/cron/* checks CRON_SECRET; /api/queue/drain checks INTERNAL_JOB_SECRET (src/server/jobs/
-- http.ts). They are separate values on purpose — the cron secret is handed to the database, and a
-- single shared secret would mean a leak of it also authorizes draining the queue. So the config
-- table needs the second one.
--
-- NULLABLE, and the drain helper NOTICEs and returns when it is absent: an environment that has
-- configured the cron path but not the drain path is a real state (and the universal local state),
-- and it must not turn every minute into a logged error.
alter table public.job_cron_config
    add column if not exists internal_job_secret text;

comment on column public.job_cron_config.internal_job_secret is
    'The INTERNAL_JOB_SECRET value /api/queue/drain authenticates against (T-034). Separate from '
    'cron_secret so a leak of one does not authorize the other. NULL = drain schedule no-ops.';

-- --------------------------------------------------------------------------------------------
-- The invocation helpers
-- --------------------------------------------------------------------------------------------

create or replace function public.invoke_cron_endpoint(job_name text)
returns void
language plpgsql
security definer
-- `net` added: this is the fix described in the header.
set search_path = public, extensions, net
as $$
declare
    config public.job_cron_config;
begin
    select * into config from public.job_cron_config limit 1;

    if not found then
        -- The expected state locally. Not an error: see the T-032 migration's header.
        raise notice 'invoke_cron_endpoint(%): job_cron_config is empty; skipping. This is expected in local development, where npm run cron:run drives the sweeps.', job_name;
        return;
    end if;

    -- Fire-and-forget: pg_net queues the request and returns immediately, so a slow or unreachable
    -- endpoint can never block the cron worker or hold a transaction open. The endpoint's own
    -- job_run row is the durable record of what happened.
    perform net.http_get(
        url := config.base_url || '/api/cron/' || job_name,
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || config.cron_secret,
            'Content-Type', 'application/json'
        ),
        timeout_milliseconds := 5000
    );
end;
$$;

comment on function public.invoke_cron_endpoint(text) is
    'Calls /api/cron/{job_name} on the configured origin with the CRON_SECRET bearer header via '
    'pg_net (net.http_get). No-ops with a NOTICE when job_cron_config is empty (the local state).';

revoke all on function public.invoke_cron_endpoint(text) from public;
revoke all on function public.invoke_cron_endpoint(text) from anon, authenticated;

-- The drain gets its OWN helper rather than a `job_name`-shaped parameter on the one above,
-- because three things differ and every one of them is a way to fail silently: the path is
-- /api/queue/drain (not /api/cron/{name}), the credential is INTERNAL_JOB_SECRET (not CRON_SECRET),
-- and the verb is POST (the drain mutates; a GET-only helper invites a cache or a crawler to
-- trigger it).
create or replace function public.invoke_queue_drain()
returns void
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
    config public.job_cron_config;
begin
    select * into config from public.job_cron_config limit 1;

    if not found then
        raise notice 'invoke_queue_drain: job_cron_config is empty; skipping. This is expected in local development, where npm run queue:worker drains the queue.';
        return;
    end if;

    if config.internal_job_secret is null then
        -- Named distinctly from the empty-table case: "the row exists but the drain half was never
        -- configured" is a DIFFERENT operator mistake from "nothing is configured", and an
        -- environment where alerts silently stop clearing within the minute is worth one clear line
        -- in the log rather than the same generic notice.
        raise notice 'invoke_queue_drain: job_cron_config.internal_job_secret is null; skipping. Set it to the deployment''s INTERNAL_JOB_SECRET to enable the every-minute drain.';
        return;
    end if;

    perform net.http_post(
        url := config.base_url || '/api/queue/drain',
        body := '{}'::jsonb,
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || config.internal_job_secret,
            'Content-Type', 'application/json'
        ),
        timeout_milliseconds := 5000
    );
end;
$$;

comment on function public.invoke_queue_drain() is
    'Calls POST /api/queue/drain on the configured origin with the INTERNAL_JOB_SECRET bearer '
    'header via pg_net (net.http_post). No-ops with a NOTICE when unconfigured (the local state).';

revoke all on function public.invoke_queue_drain() from public;
revoke all on function public.invoke_queue_drain() from anon, authenticated;

-- --------------------------------------------------------------------------------------------
-- The schedules
-- --------------------------------------------------------------------------------------------

-- `cron.schedule` UPSERTS by job name, so re-applying this migration re-points an existing schedule
-- rather than creating a duplicate — which matters because `supabase db push` may replay it and two
-- schedules with the same name would double-invoke both jobs.

-- Job 3. Every 15 minutes: the full per-tenant alert reconciliation (spec §9.5). This is also the
-- SAFETY NET for Job 4 — if a targeted re-evaluation message is lost, dead-lettered, or never
-- published because the queue was down, this sweep converges the same alert set within 15 minutes.
-- That is what makes the publish side fire-and-forget rather than transactional.
select cron.schedule('alert-evaluation', '*/15 * * * *', $cron$select public.invoke_cron_endpoint('alert-evaluation')$cron$);

-- Job 4's consumer. Every minute, because there is no resident worker on Vercel (Q-7): this
-- schedule IS the worker's heartbeat. One minute is the floor pg_cron offers and it sets the upper
-- bound on how long a completed workflow action's alert stays visible. The endpoint is idempotent
-- and time-budgeted (DEFAULT_TIME_BUDGET_MS well under the route's maxDuration), so an invocation
-- overlapping the previous one is safe: pgmq visibility timeouts prevent two drains from processing
-- the same message, and a drain that finds an empty queue returns immediately.
select cron.schedule('queue-drain', '* * * * *', $cron$select public.invoke_queue_drain()$cron$);
