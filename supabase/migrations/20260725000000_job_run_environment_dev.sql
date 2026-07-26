-- 20260725000000_job_run_environment_dev.sql
--
-- Owner: CI/CD schema delivery (N-08, follows 20260719000000_job_run.sql).
--
-- Adds 'dev' to the environments `job_run.environment` will accept.
--
-- WHY
-- ===
-- The `dev` branch deploys to a hosted project (qiq-dev) that had no name in `appEnvValues`, so
-- its job runs were about to be stamped 'staging' — the nearest existing value. That defeats the
-- entire purpose of the column, which 20260719000000 introduced precisely so that a restored dump
-- could not let one environment's job run be read as another's. An environment stamp that lies is
-- worse than no stamp: it is evidence pointing the wrong way during an incident.
--
-- 'staging' is deliberately KEPT. No pre-production tier exists today, but removing a value from
-- this constraint would orphan any historical row already carrying it, and the constraint is
-- validated against existing rows on creation.
--
-- WIDENING ONLY, so this is safe on a populated table: every value that satisfied the old
-- constraint satisfies the new one. Postgres still scans the table to validate, which is
-- acceptable here — `job_run` is observability history, and the table comment records that it can
-- be truncated without business consequence.
--
-- Rollback: re-create the constraint without 'dev'. That will FAIL if any qiq-dev job run has been
-- recorded by then, which is the correct behaviour — deleting real execution history to narrow a
-- label is not a rollback anyone should get for free.

alter table job_run drop constraint ck_job_run_environment;

alter table job_run add constraint ck_job_run_environment
    check (environment in ('local', 'dev', 'preview', 'staging', 'production'));
