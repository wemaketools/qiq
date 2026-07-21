-- 20260718002000_reference_items.sql
--
-- Owner: T-004 (M-08, P-04, spec §11.2, AC-007).
-- Source changelog: src/api/db/changelog/040-reference/040-reference-tables.xml
--   changeset 040-reference-items-table.
--
-- The tenant-scoped reference-data table behind every configurable list in P-04: request channels
-- (is_broker_channel), product lines, cover types (product_line_id -> a sibling product_line row),
-- segments, industries, regions, party types, lead/quote statuses, lost reasons and broker types,
-- all discriminated by list_type.
--
-- GUARDED STATUSES (P-04). Three columns carry the status guards, and only the parts that are
-- expressible as column constraints live here — the rest are service-level guards owned by the
-- reference-data domain task, exactly as the .NET original splits them:
--   * reporting_category — CHECK-restricted to open/quoted/won/lost/expired/withdrawn. Nullable
--     because non-status list types have no reporting category.
--   * canonical_key — the stable machine handle a status is resolved by (dashboards and workflow
--     code look up 'won'/'lost' rather than a tenant-renameable display name).
--   * is_terminal — flags a status that terminates the lifecycle. "Terminal statuses cannot be
--     disabled" is an UPDATE-time rule over another column, not a row-local invariant, so it stays
--     an application guard (as it is in .NET) rather than becoming a CHECK that would also reject
--     legitimately-seeded rows.
--
-- DISABLING IS THE ONLY REMOVAL PATH (NFR-09/AC-020/AC-075). is_active is the disable flag; rows are
-- never hard-deleted so a historical lead or quote pointing at a disabled value stays resolvable.
-- Nothing here cascades or deletes.
--
-- product_line_id references a sibling reference_items row (a cover type's parent product line)
-- WITHOUT a physical FK. That is the reference schema's deliberate intra-tenant reference shape —
-- a partitioned table cannot carry a self-FK that omits the partition key, and the same non-FK
-- convention is used by brokers.broker_type_id, business_assignments.role_id and leads.status_id.
-- Validation is the application layer's job.
--
-- ============================================================================================
-- DELIBERATE ADDITION: uq_reference_items_tenant_list_canonical_key (NOT in the .NET reference).
-- ============================================================================================
-- The .NET schema stores canonical_key with no uniqueness guarantee, relying entirely on seeding
-- discipline. But canonical_key's whole purpose is to be the unambiguous handle status resolution
-- keys on: two rows sharing ('won') inside one tenant's quote_status list makes "the won status"
-- undefined and silently corrupts every conversion metric that resolves by key. T-004's task file
-- calls for "canonical keys unique per tenant+list_type" and its test plan requires a duplicate to
-- be REJECTED, so the invariant is enforced in SQL here rather than left to convention.
--
-- Scope is exact: PostgreSQL treats NULLs as distinct in a unique constraint by default, so the
-- many rows in non-status lists that leave canonical_key NULL are entirely unaffected — only two
-- non-null identical keys within the same (tenant, list_type) collide. tenant_id leads the key
-- because a unique constraint on a LIST-partitioned table must contain the partition column.
--
-- This is a strengthening deviation from the reference schema, not a port of it. It is recorded on
-- the parity suite's allow-list as target-only, and that suite asserts it is absent from the
-- reference side, so the difference stays visible rather than silently drifting.
--
-- Rollback/recovery: `drop table reference_items cascade`. Dropping it takes the per-tenant
-- partitions with it and orphans every by-convention reference (leads.status_id, brokers
-- .broker_type_id, ...) since none is a physical FK — recover from backup, not by re-running.
-- Dropping only uq_reference_items_tenant_list_canonical_key is safe and reversible, and reverts
-- this table to the .NET reference shape.

create table reference_items (
    tenant_id bigint not null,
    id bigint generated always as identity,
    list_type text not null,
    name text not null,
    display_order integer not null default 0,
    is_active boolean not null default true,
    -- Only meaningful for list_type = 'request_channel'; nullable (not defaulted false) so
    -- "not a channel" and "channel that does not require a broker" stay distinguishable.
    is_broker_channel boolean,
    -- Only meaningful for list_type = 'cover_type': the parent product line. By-convention
    -- reference to a sibling row in the same tenant partition; see the header.
    product_line_id bigint,
    reporting_category text,
    canonical_key text,
    is_terminal boolean not null default false,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id),
    constraint uq_reference_items_tenant_list_name unique (tenant_id, list_type, name),
    -- See header: strengthening deviation from the .NET reference, parity-allow-listed.
    constraint uq_reference_items_tenant_list_canonical_key unique (tenant_id, list_type, canonical_key),
    constraint ck_reference_items_list_type check (list_type in (
        'request_channel', 'product_line', 'cover_type', 'party_segment', 'industry',
        'region', 'party_type', 'lead_status', 'quote_status', 'lost_reason', 'broker_type'
    )),
    constraint ck_reference_items_reporting_category check (reporting_category is null or reporting_category in (
        'open', 'quoted', 'won', 'lost', 'expired', 'withdrawn'
    ))
) partition by list (tenant_id);

-- DEFAULT partition safety net, per the spec §11 convention every partitioned table follows: a
-- write for a tenant whose dedicated partition does not exist yet lands here instead of erroring.
create table reference_items_default partition of reference_items default;
