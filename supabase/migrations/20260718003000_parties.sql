-- 20260718003000_parties.sql
--
-- Owner: T-005 (M-08, A-12, spec §11.3, N-04, AC-004/AC-005).
-- Source changelog: src/api/db/changelog/080-parties/080-parties.xml
--   changesets 080-pg-trgm-extension, 081-parties-table, 082-parties-name-trigram-index.
--
-- Clients/prospects. A party is the counterparty a Lead is raised for; leads.party_id references a
-- row here within the same tenant partition.
--
-- ============================================================================================
-- pg_trgm LIVES IN `extensions`, NOT `public` (deliberate deviation from the reference).
-- ============================================================================================
-- The .NET reference installs pg_trgm into `public` because plain Postgres defaults there. Supabase
-- convention — already established by T-002's extensions migration and by Supabase's own preinstalled
-- citext/pgcrypto/uuid-ossp — is that third-party extensions live in `extensions`, which Supabase
-- puts on the default search_path for every role. Installing into `public` would put operator
-- classes and functions in the same namespace as our business tables and diverge from every other
-- extension in this database.
--
-- PARITY IS UNAFFECTED — VERIFIED, NOT ASSUMED. pg_get_indexdef schema-qualifies an operator class
-- only when it is absent from the current session's search_path, which raised the question of
-- whether the trigram indexes would render as `extensions.gin_trgm_ops` here against plain
-- `gin_trgm_ops` in the reference. They do not: Supabase puts `extensions` on the default
-- search_path for its roles, so pg_indexes reports `gin_trgm_ops` unqualified on both sides and the
-- index diff stays empty with no normalization and no allow-list entries. Checked against the live
-- stack after applying this migration. The DDL below still writes `extensions.gin_trgm_ops`
-- explicitly, because migrations must not depend on the applying role's search_path.
--
-- ============================================================================================
-- WHY parties HAS NO UNIQUE NAME CONSTRAINT AND NO STATUS COLUMN.
-- ============================================================================================
-- Duplicate party names are PERMITTED (spec FR-28): the duplicate check is a non-blocking warning
-- surfaced at create time, not a rejection, so there is deliberately no analogue of
-- uq_brokers_tenant_name here. Constraining it would turn a soft warning into a hard failure and
-- break legitimate same-name entities in different regions/segments.
--
-- There is likewise no status/disable column: the MVP has no delete path for parties (PRD 12.9).
-- Parties are corrected via Edit only, so every party row a tenant creates stays permanently
-- resolvable and there is nothing to disable. Do not add a soft-delete pair here without a spec
-- decision — leads reference parties and an unresolvable party would orphan a lead's client name.
--
-- REFERENCE-DATA COLUMNS ARE BY-CONVENTION REFERENCES, NOT PHYSICAL FKs. party_type_id, segment_id,
-- industry_id and region_id each point at a tenant-scoped reference_items row (list_types
-- 'party_type', 'party_segment', 'industry', 'region'). Both tables are LIST-partitioned on
-- tenant_id and a FK out of a partitioned table would have to include the partition key, so the
-- reference schema uses the same non-FK intra-tenant shape used by brokers.broker_type_id and
-- reference_items.product_line_id. Validation lives in the application layer.
--
-- region_id is nullable ON PURPOSE and must stay that way: spec Q-9 states party region is NEVER
-- required, on either the standalone or the inline New/Edit Party form. This is the one place it
-- differs from leads.region_id, which IS required (the lead's own region is a reporting dimension).
--
-- Partitioned LIST(tenant_id) per A-12, verified against the live .NET reference database
-- (pg_partitioned_table reports partstrat 'l' on tenant_id). Picked up automatically by T-003's
-- catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table parties cascade` orphans every lead's client reference and is not
-- recoverable by re-running this migration (the rows are gone). Restore from backup.

-- Backs parties.name type-ahead search and the FR-28 duplicate-name similarity warning.
create extension if not exists pg_trgm with schema extensions;

create table parties (
    tenant_id bigint not null,
    id bigint generated always as identity,
    name text not null,
    -- By-convention references to tenant-scoped reference_items; see header for why no FK.
    party_type_id bigint not null,
    segment_id bigint,
    industry_id bigint,
    -- Nullable on purpose (Q-9): a party's region is never required.
    region_id bigint,
    is_strategic boolean not null default false,
    contact_name text,
    contact_email text,
    contact_phone text,
    -- Maintained on write (spec §11), not derived, so inactivity scans stay index-backed.
    last_activity_at timestamptz,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table parties_default partition of parties default;

-- Trigram GIN index for type-ahead and the duplicate-name warning. Not a unique index, so it does
-- NOT need to include the partition key; Postgres creates it on the parent and propagates it to
-- every existing partition and to every future parties_p{tenant_id} partition automatically.
create index ix_parties_name_trgm on parties using gin (name extensions.gin_trgm_ops);
