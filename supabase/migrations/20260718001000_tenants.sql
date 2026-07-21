-- 20260718001000_tenants.sql
--
-- Owner: T-003 (M-08, A-12, spec §11 identity/tenancy model).
-- Source changelog: src/api/db/changelog/030-tenants/030-tenants-table.xml
--
-- The tenant registry that every tenant-scoped partition's tenant_id value refers to. It is
-- itself global/unpartitioned and is deliberately NOT registered with create_tenant_partitions.
--
-- Removal is a soft delete (status='removed'), never a hard delete (AC-027/N-09), so history and
-- reporting rows referencing a removed tenant's id stay resolvable.
--
-- Ordering: this is the first T-003 migration because later files and the partition function are
-- read most naturally with the tenant registry already in place. There is intentionally no FK
-- from tenant-scoped tables onto tenants(id): the Liquibase source has none (a partitioned child
-- would need the FK on every partition), and tenant existence is enforced in the tenant-creation
-- transaction (T-016) instead.
--
-- Rollback/recovery: `drop table tenants cascade` discards the entire tenant registry and would
-- orphan every tenant-scoped partition. There is no safe forward-recovery for that in a database
-- holding real data — recover by restoring from backup, not by re-running this migration.

create table tenants (
    id bigint generated always as identity primary key,
    name text not null,
    contact_name text,
    contact_email text,
    contact_phone text,
    status text not null default 'active',
    removed_at timestamptz,
    removed_by bigint,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint
);

alter table tenants add constraint ck_tenants_status check (status in ('active', 'removed'));

-- Database-level safety net behind the application's tenant-name uniqueness check (AC-028).
-- A *partial* unique index rather than a plain unique constraint: a removed tenant must not
-- permanently reserve its former name. lower(name) makes the check case-insensitive.
create unique index uq_tenants_active_name on tenants (lower(name)) where status = 'active';
