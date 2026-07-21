-- 20260718002100_default_reference_items.sql
--
-- Owner: T-004 (M-08, P-04, spec §11.2, AC-007).
-- Source changelog: src/api/db/changelog/040-reference/040-reference-tables.xml
--   changeset 041-default-reference-items-table.
--
-- The GLOBAL reference-data template that Internal users manage (P-04) and that every new tenant is
-- seeded from at creation time. It is deliberately UNPARTITIONED and carries no tenant_id: it is
-- one global list, not per-tenant data, so it must NOT be picked up by create_tenant_partitions
-- (which selects only tables LIST-partitioned on tenant_id — this table matches neither test).
-- Verified against the .NET reference database: relkind 'r' (ordinary table), no partitioning.
--
-- It mirrors reference_items column-for-column MINUS tenant_id, with one substitution:
-- default_product_line_key (a text name reference to a sibling template row) replaces
-- reference_items.product_line_id, because template rows have no tenant-specific numeric id for a
-- cover type to point at. Seeding (T-006) resolves the key to a real id as it materialises each
-- tenant's rows.
--
-- The two CHECKs are byte-identical in meaning to reference_items' so a template row can never be
-- copied into a tenant list and be rejected there. The unique key drops tenant_id for the same
-- reason the table does.
--
-- Rollback/recovery: `drop table default_reference_items cascade`. Safe in isolation — nothing
-- references this table physically; the only consumer is the tenant-seeding path, which would then
-- have no template to copy from. Re-running this migration plus re-seeding restores it.

create table default_reference_items (
    id bigint generated always as identity primary key,
    list_type text not null,
    name text not null,
    display_order integer not null default 0,
    is_active boolean not null default true,
    is_broker_channel boolean,
    -- Name reference to a sibling 'product_line' template row; resolved to a numeric
    -- reference_items.product_line_id during per-tenant seeding. See header.
    default_product_line_key text,
    reporting_category text,
    canonical_key text,
    is_terminal boolean not null default false,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    constraint uq_default_reference_items_list_name unique (list_type, name),
    constraint ck_default_reference_items_list_type check (list_type in (
        'request_channel', 'product_line', 'cover_type', 'party_segment', 'industry',
        'region', 'party_type', 'lead_status', 'quote_status', 'lost_reason', 'broker_type'
    )),
    constraint ck_default_reference_items_reporting_category check (reporting_category is null or reporting_category in (
        'open', 'quoted', 'won', 'lost', 'expired', 'withdrawn'
    ))
);
