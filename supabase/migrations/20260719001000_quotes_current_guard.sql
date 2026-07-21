-- 20260719001000_quotes_current_guard.sql
--
-- Owner: T-026 (scope amendment 2026-07-19, per the T-005 evaluator ruling).
--
-- Closes the SECOND of the two "current" invariants that 20260718003300_quotes.sql identified and
-- deliberately left open. That migration's header states the gap and even writes out the index that
-- would close it, with an explicit instruction not to add it silently:
--
--   (2) — quotes.is_current — is NOT guarded by this migration. [...] IT REMAINS AN
--   APPLICATION-LAYER-ONLY INVARIANT AND IS REPORTED AS AN OPEN GAP so it can be scheduled
--   deliberately. The index that would close it, if approved, is:
--     create unique index uq_quotes_current on quotes (tenant_id, lead_id) where is_current = true;
--   Do not add it silently — it needs the same allow-list entry and a backfill check against
--   existing data [...]
--
-- It is now scheduled: T-026 owns every code path that writes quotes.is_current (create's
-- first-quote default and the Set current operation), so the guard belongs with the code it
-- constrains. This index was a documented target-only strengthening over the .NET reference (which
-- enforced the one-current invariant only in application code); the schema-parity suite that tracked
-- that deviation was retired at cutover (T-044). The index is now guarded by db:validate against
-- supabase/schema.expected.sql.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 20260718003300_quotes.sql
-- ==================================================================
-- That migration has already been applied, and the db:validate snapshot enforces that applied
-- migrations are never rewritten. Editing it in place would be invisible to anyone who had already
-- migrated and would fail the snapshot check for everyone else.
--
-- WHAT THIS BUYS, CONCRETELY
-- ==========================
-- Every dashboard store joins `quote.is_current AND version.is_current` to read the current quoted
-- premium. Without this index, two concurrent Set current calls on one lead — or a Set current
-- racing the first-quote default in create — can each read "no other current quote", each promote
-- their own, and both commit. The lead then has two current quotes and its premium is DOUBLE
-- COUNTED in Executive, Pipeline, Broker and Loss Analysis reporting simultaneously. Application
-- code cannot close that window on its own; only a unique index can.
--
-- Partial on is_current = true, so a lead may still carry any number of non-current quotes.
-- tenant_id (the partition key) is one of the indexed columns, which is what lets Postgres put a
-- unique index on a LIST-partitioned parent and propagate it to every existing and future
-- partition.
--
-- BACKFILL CAVEAT (honoured, and a no-op locally)
-- ==============================================
-- The quotes migration header requires a backfill check: any environment already holding two
-- current quotes for one lead would fail to create this index. Per A-1 there is no production data
-- and local environments are rebuilt from clean resets, so this is a no-op here. For any deployed
-- environment created before this migration lands, demote the duplicates first, e.g.:
--
--   update quotes q set is_current = false
--    where q.is_current
--      and q.id <> (select max(q2.id) from quotes q2
--                    where q2.tenant_id = q.tenant_id and q2.lead_id = q.lead_id and q2.is_current);
--
-- Rollback: `drop index uq_quotes_current;` — the invariant reverts to application-layer only.

create unique index uq_quotes_current
    on quotes (tenant_id, lead_id)
    where is_current = true;

comment on index uq_quotes_current is
    'Enforces at most one current quote per lead per tenant (FR-50, PRD 7.3). Absent from the .NET '
    'reference, where the invariant lived only in SetCurrentQuoteCommandHandler/CreateQuoteCommandHandler '
    'and two concurrent promotions could commit two current rows — double-counting quoted premium in '
    'every dashboard that joins quote.is_current AND version.is_current. Documented target-only '
    'deviation (T-026, per the T-005 evaluator ruling).';
