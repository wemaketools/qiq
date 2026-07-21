-- 20260718000000_extensions.sql
--
-- Owner: T-002. Required Postgres extensions for the QuoteIQ background-job platform (Q-7, G-4).
--
-- Why a migration rather than config.toml: extensions declared here are applied by the SAME
-- path locally (`supabase db reset`) and in every hosted project (`supabase db push`), so a
-- deployed environment can never be missing an extension the code assumes. config.toml only
-- configures the local containers and would leave hosted projects to manual dashboard steps.
--
-- Ordering: this file carries the lowest migration timestamp in the repository on purpose.
-- Every later migration (T-003 onward) may assume these extensions already exist.
--
-- Rollback/recovery: dropping these extensions is destructive — `DROP EXTENSION pg_cron`
-- discards all scheduled jobs and `DROP EXTENSION pgmq` discards every queue and its
-- unconsumed messages. Recovery is to re-run this migration and re-apply the job schedules
-- owned by T-032/T-034, not to hand-edit the extension state.

-- Supabase convention: third-party extensions live in `extensions`, not `public`.
create schema if not exists extensions;

-- pg_cron: scheduled job triggers, replacing Hangfire recurring jobs (G-4).
-- Installs into its own fixed `cron` schema and only into the database named by the
-- cron.database_name server setting (`postgres` on both local and hosted Supabase).
create extension if not exists pg_cron;

-- pg_net: asynchronous outbound HTTP from Postgres, used by pg_cron schedules to invoke the
-- Vercel cron/drain endpoints in deployed environments (G-4).
create extension if not exists pg_net with schema extensions;

-- pgmq: durable message queues, replacing Hangfire background/enqueued jobs (G-4).
-- Installs into its own fixed `pgmq` schema.
create extension if not exists pgmq;
