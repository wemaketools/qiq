-- 20260720000000_pg_cron_expiry_schedules.sql
--
-- Owner: T-032. The pg_cron schedules for the two expiry sweeps (M-13, M-14, AC-068, V-085,
-- spec §9.5 Jobs 1-2).
--
--   quote-expiry             '0 * * * *'   -> GET /api/cron/quote-expiry
--   lead-inactivity-expiry   '10 * * * *'  -> GET /api/cron/lead-inactivity-expiry
--
-- T-034 adds the alert-evaluation ('*/15 * * * *') and queue-drain (every minute) entries using the
-- same `job_cron_config` row and the same `invoke_cron_endpoint` helper defined here.
--
-- ALL SCHEDULES ARE UTC. pg_cron interprets its expressions in the `cron.timezone` setting, which
-- Supabase leaves at UTC; the schedules are stated as UTC in docs/background-jobs.md and the two
-- must agree. The ten-minute offset between the two sweeps is deliberate and not cosmetic: the
-- quote sweep STAMPS `last_activity_at` on every lead whose quote it expires, so running them on the
-- same minute would have the inactivity sweep reading a column the other job is still writing.
--
-- ============================================================================================
-- NO URL AND NO SECRET IS COMMITTED HERE
-- ============================================================================================
-- The schedules must call a DEPLOYED origin with the CRON_SECRET in an Authorization header.
-- Neither value may live in a migration: the origin differs per environment (local, preview,
-- staging, production) and the secret must never enter version control.
--
-- The chosen mechanism is a single-row configuration table, `public.job_cron_config`, populated
-- OUT OF BAND per environment (`npm run db:cron:configure`, or the Supabase SQL editor for hosted
-- projects) and never by a migration or by the committed seed. This was chosen over the two
-- alternatives deliberately:
--
--   * `ALTER DATABASE ... SET app.settings.*` — not visible to pg_cron's own background workers on
--     Supabase without a reconnect, and invisible to `\d`, so a misconfigured environment gives no
--     diagnosable signal.
--   * Supabase Vault — Q-23 defers database-resident secrets; adopting it here would pre-empt that
--     decision for the whole product on the strength of one job schedule.
--
-- The table is deliberately NOT tenant-scoped: it is infrastructure configuration, not tenant data.
-- It is locked down to the service role and revoked from anon/authenticated below, because it holds
-- a bearer secret.
--
-- WHEN THE TABLE IS EMPTY THE SCHEDULES ARE NO-OPS THAT SAY SO.
-- Local development does not use this path at all — pg_net runs inside the Supabase container and
-- cannot reach a dev server on the host (Q-7), so locally the sweeps are driven by
-- `npm run cron:run -- <job>`. A migration that failed without a configured URL would therefore
-- break every clean local setup. Instead the helper raises a NOTICE and returns, which is
-- observable in the Postgres log without turning an expected local state into an error.

-- --------------------------------------------------------------------------------------------
-- Configuration
-- --------------------------------------------------------------------------------------------

create table if not exists public.job_cron_config (
    -- A one-row table: the CHECK is what makes it one row rather than a convention nobody enforces.
    id boolean primary key default true constraint job_cron_config_single_row check (id),
    -- Origin only, no trailing slash: 'https://quoteiq.example.com'.
    base_url text not null,
    -- The value of the CRON_SECRET environment variable the endpoints authenticate against.
    cron_secret text not null,
    updated_at timestamptz not null default now()
);

comment on table public.job_cron_config is
    'Single-row infrastructure config for the pg_cron -> pg_net job schedules (T-032). Holds a '
    'bearer secret: service-role only. Populated per environment out of band, NEVER by a migration '
    'or by the committed seed, and never present in local development (see Q-7).';

-- It holds a secret. No API role may read it, and PostgREST must not expose it.
revoke all on table public.job_cron_config from public;
revoke all on table public.job_cron_config from anon, authenticated;

-- --------------------------------------------------------------------------------------------
-- The invocation helper
-- --------------------------------------------------------------------------------------------

-- One function for every schedule, so the header shape, the timeout and the missing-config
-- behaviour are defined ONCE. Three schedules each building their own net.http_get call is three
-- places for the Authorization header to be spelled wrong, and a job that authenticates wrongly
-- fails silently at 03:00 with a 401 nobody is watching.
create or replace function public.invoke_cron_endpoint(job_name text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    config public.job_cron_config;
begin
    select * into config from public.job_cron_config limit 1;

    if not found then
        -- The expected state locally. Not an error: see this file's header.
        raise notice 'invoke_cron_endpoint(%): job_cron_config is empty; skipping. This is expected in local development, where npm run cron:run drives the sweeps.', job_name;
        return;
    end if;

    -- Fire-and-forget: pg_net queues the request and returns immediately, so a slow or unreachable
    -- endpoint can never block the cron worker or hold a transaction open. The endpoint's own
    -- job_run row is the durable record of what happened — this call's response is not inspected,
    -- and deliberately so, because there is nothing useful pg_cron could do with a failure that the
    -- next state-guarded tick will not already fix.
    perform extensions.http_get(
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
    'pg_net. No-ops with a NOTICE when job_cron_config is empty (the local state).';

revoke all on function public.invoke_cron_endpoint(text) from public;
revoke all on function public.invoke_cron_endpoint(text) from anon, authenticated;

-- --------------------------------------------------------------------------------------------
-- The schedules
-- --------------------------------------------------------------------------------------------

-- `cron.schedule` UPSERTS by job name, so re-applying this migration re-points an existing schedule
-- rather than creating a duplicate — which matters because `supabase db push` may replay it and two
-- schedules with the same name would double-invoke every sweep.
select cron.schedule('quote-expiry', '0 * * * *', $cron$select public.invoke_cron_endpoint('quote-expiry')$cron$);
select cron.schedule('lead-inactivity-expiry', '10 * * * *', $cron$select public.invoke_cron_endpoint('lead-inactivity-expiry')$cron$);
