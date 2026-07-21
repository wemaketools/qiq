-- 20260718001400_reference_sequences.sql
--
-- Owner: T-003 (M-08, A-12, P-06/AC-043).
-- Source changelog: src/api/db/changelog/090-leads/090-leads.xml, changeset
--   093-reference-sequences-table.
--
-- Per-tenant/per-year counter rows backing tenant-formatted lead reference allocation. Lead
-- creation takes `select ... for update` on the matching row inside the creation transaction, so
-- concurrent creations in one tenant produce unique sequential references under the transaction
-- pooler (AC-043).
--
-- Ported here in T-003 rather than with leads (T-005) because it is a tenancy/sequence primitive
-- with no dependency on the lead schema, and because the partition function immediately following
-- needs a second partitioned table to prove it generalises.
--
-- Convention note: this carries a synthetic bigint identity id and a composite (tenant_id, id) PK
-- even though its natural key is (tenant_id, entity_type, year). That follows the spec §11 / A-12
-- rule applied uniformly to every NOT NULL tenant_id table; the natural key is preserved as a
-- separate tenant-inclusive unique constraint. A stale comment in the source changelog (090-leads
-- line 29) still claims this table is excluded from the partitioned set — that comment predates
-- changeset 093 and is contradicted by the changeset itself and by the reference DB, where the
-- table IS partitioned and IS listed in create_tenant_partitions.sql. The changeset wins.
--
-- Rollback/recovery: dropping this table loses the high-water mark for every tenant's reference
-- series. Re-creating it empty would restart numbering at zero and collide with existing lead
-- references (which are unique per tenant), so recovery is to restore from backup, or to rebuild
-- each row from `max(sequence portion of lead_ref)` per tenant/year before resuming allocation.

create table reference_sequences (
    tenant_id bigint not null,
    id bigint generated always as identity,
    entity_type text not null,
    year integer not null,
    next_value bigint not null default 0,
    primary key (tenant_id, id),
    constraint uq_reference_sequences_tenant_entity_year unique (tenant_id, entity_type, year)
) partition by list (tenant_id);

create table reference_sequences_default partition of reference_sequences default;
