-- 20260718003700_search_indexes.sql
--
-- Owner: T-005 (M-08, N-04, spec FR-53/A-14, AC-004).
-- Source changelog: src/api/db/changelog/160-search/160-search-indexes.xml
--   changesets 160-brokers-name-trigram-index, 161-leads-lead-ref-trigram-index,
--   162-leads-external-ref-trigram-index, 163-quotes-quote-ref-trigram-index.
--
-- The remaining trigram indexes backing the top-bar global type-ahead search (FR-53). It matches
-- leads by lead_ref or external_ref, quotes by quote_ref, parties by name and brokers by name;
-- parties.name is already covered by ix_parties_name_trgm in the parties migration, so this file
-- carries the other four.
--
-- Kept as a SEPARATE migration rather than folded into the owning table migrations, mirroring the
-- reference's own 160-search changelog: these indexes exist for one cross-cutting feature, not for
-- the tables' own access paths, so a future change to search indexing is a change to one file.
--
-- GIN + gin_trgm_ops accelerates both the prefix ILIKE and the similarity() predicates the search
-- store issues, so those queries stay index-backed instead of sequential-scanning every lead in a
-- tenant (N-04: indexes preserved for the tenant/date/status/broker access paths).
--
-- These are NOT unique indexes, so — unlike a unique index on a partitioned table — they do not need
-- to include the partition key. Postgres creates them on the LIST-partitioned parent and propagates
-- them to every existing partition and to every future <table>_p{tenant_id} partition created by
-- create_tenant_partitions(), with no further wiring. Tenant scoping of the SEARCH itself comes from
-- the query's own tenant_id predicate plus partition pruning, not from the index.
--
-- The `extensions.` qualifier on gin_trgm_ops is written explicitly because pg_trgm is installed
-- into the `extensions` schema per Supabase convention, and a migration must not depend on the
-- applying role's search_path. It does not affect parity: pg_indexes reports the opclass
-- unqualified on both sides, since Supabase keeps `extensions` on the default search_path. See the
-- parties migration header for the full rationale.
--
-- Rollback/recovery: dropping any of these degrades global search to sequential scans — a
-- performance regression against N-04, not a correctness or data-loss event. Re-running this
-- migration fully restores them; the indexes hold no data of their own.

create index ix_brokers_name_trgm on brokers using gin (name extensions.gin_trgm_ops);

create index ix_leads_lead_ref_trgm on leads using gin (lead_ref extensions.gin_trgm_ops);

create index ix_leads_external_ref_trgm on leads using gin (external_ref extensions.gin_trgm_ops);

create index ix_quotes_quote_ref_trgm on quotes using gin (quote_ref extensions.gin_trgm_ops);
