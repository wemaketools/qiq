-- 20260719000100_pgmq_queues.sql
--
-- Owner: T-031 (M-16, Q-7, spec §9.5, AC-064).
-- Source: src/api/.../IAlertReevaluationQueue + AlertReevaluationQueue (Hangfire `Enqueue`,
--   fire-and-forget, called by the lead/quote workflow executors).
--
-- Hangfire's in-process enqueue becomes a durable pgmq queue. pgmq supplies the four semantics the
-- old implementation got from Hangfire, and this file is where the queue that carries them is
-- created:
--
--   enqueue                 pgmq.send(queue, jsonb)
--   read w/ visibility      pgmq.read(queue, vt_seconds, qty)   -- also increments read_ct
--   ack                     pgmq.delete(queue, msg_id)
--   dead-letter             pgmq.archive(queue, msg_id)         -- moves to pgmq.a_<queue>
--
-- `pgmq.create` builds pgmq.q_alert_reevaluation (the queue) and pgmq.a_alert_reevaluation (the
-- archive / dead-letter). Both live in the `pgmq` schema, so they do NOT appear in
-- supabase/schema.expected.sql — that snapshot dumps `public` only. The integration tests in
-- src/server/tests/integration/pgmq-queue.test.ts are what prove this migration ran.
--
-- Rollback/recovery: `select pgmq.drop_queue('alert_reevaluation')` DISCARDS every unconsumed
-- message. Recovery is to re-run this migration; the lost work self-heals on the next
-- alert-evaluation sweep (spec §9.5 names that sweep as the safety net for exactly this case),
-- so there is no need to reconstruct individual messages.

-- pgmq.create is internally CREATE TABLE IF NOT EXISTS and is safe to re-run (verified against
-- pgmq 1.5.1 on the local stack), which is what `npm run db:validate`'s repeated-reset pass
-- requires of every migration in this repository.
select pgmq.create('alert_reevaluation');

-- Targeted alert re-evaluation fired by the lead/quote workflow executors (spec §9.5 Job 4).
comment on table pgmq.q_alert_reevaluation is
    'QuoteIQ: targeted alert re-evaluation messages (spec §9.5 Job 4). Producers: lead/quote workflow executors. Consumers: /api/queue/drain (deployed) and `npm run queue:worker` (local).';
comment on table pgmq.a_alert_reevaluation is
    'QuoteIQ: dead-letter archive for alert_reevaluation. A message lands here after max_attempts (default 5) failed deliveries; inspect with `npm run jobs:status`.';

-- The server connects with the Supabase service role in deployed environments and as `postgres`
-- locally. `postgres` owns these objects already; service_role must be granted explicitly or the
-- drain endpoint fails at runtime with a permission error that no local test would ever surface.
-- Guarded on role existence so the migration also applies to a plain Postgres database.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant usage on schema pgmq to service_role;
        grant select, insert, update, delete on pgmq.q_alert_reevaluation to service_role;
        grant select, insert, update, delete on pgmq.a_alert_reevaluation to service_role;
        grant execute on all functions in schema pgmq to service_role;
    end if;
end
$$;
