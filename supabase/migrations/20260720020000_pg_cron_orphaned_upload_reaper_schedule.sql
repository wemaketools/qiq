-- 20260720020000_pg_cron_orphaned_upload_reaper_schedule.sql
--
-- Owner: T-049. The pg_cron schedule for the orphaned-upload reaper (M-13, M-14, AC-024, V-031,
-- spec §9.5 Job 5).
--
--   orphaned-upload-reaper   '30 * * * *'  -> GET /api/cron/orphaned-upload-reaper
--
-- This migration adds ONLY a schedule row. It reuses, unchanged, the `job_cron_config` table and the
-- `invoke_cron_endpoint(text)` helper defined by 20260720000000_pg_cron_expiry_schedules.sql and
-- corrected by 20260720010000_pg_cron_alert_and_drain_schedules.sql. Read the first of those two
-- migrations' headers for the full mechanism: the single-row config table populated OUT OF BAND per
-- environment, the "no URL and no secret is committed" rule, and the empty-config-is-a-NOTICE local
-- behaviour. NONE of that is reinvented here, and this file commits neither a URL nor a secret.
--
-- ALL SCHEDULES ARE UTC, matching the other two pg_cron migrations and docs/background-jobs.md.
--
-- WHY :30 AND WHY HOURLY
-- ======================
-- The half-hour offset keeps the reaper off the same minute as the :00 quote-expiry and :10
-- lead-inactivity sweeps and the every-15-minute alert sweep — not for correctness (the reaper
-- touches only `quote_attachments`, a table no other job reads or writes) but so a busy minute on
-- pg_net is not made busier for no reason. Hourly is ample: a pending row is invisible to every read
-- path the moment it is created, and the upload-URL TTL it must exceed is two hours, so the worst
-- case is an abandoned object living roughly three hours before reclamation, which no requirement
-- constrains further.
--
-- `cron.schedule` UPSERTS by job name, so re-applying this migration re-points the existing schedule
-- rather than creating a duplicate — the same property the sibling schedule migrations rely on.
select cron.schedule(
    'orphaned-upload-reaper',
    '30 * * * *',
    $cron$select public.invoke_cron_endpoint('orphaned-upload-reaper')$cron$
);
