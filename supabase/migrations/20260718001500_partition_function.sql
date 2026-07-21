-- 20260718001500_partition_function.sql
--
-- Owner: T-003 (A-12, spec §11, AC-005/AC-026).
-- Source changelog: src/api/db/changelog/functions/create_tenant_partitions.sql
--
-- Creates the per-tenant partitions for every tenant-scoped LIST-partitioned table. Tenant
-- creation (T-016) calls this INSIDE the same transaction that inserts the tenant row, so a
-- tenant and its partitions come into existence together, and a rolled-back tenant creation
-- leaves no orphan partitions behind (DDL is transactional in PostgreSQL).
--
-- ============================================================================================
-- DELIBERATE MECHANISM CHANGE: catalog-driven discovery instead of a hardcoded table array.
-- ============================================================================================
-- The Liquibase source hardcodes a 22-entry `partitioned_tables text[]` that each feature change
-- was required to extend by hand, relying on Liquibase's runOnChange to re-apply the definition
-- and on a .NET structural test (PartitioningConventionsTests) to catch anyone who forgot. That
-- registry is a workaround for a Liquibase constraint, not domain behaviour.
--
-- Plain-SQL Supabase migrations have no runOnChange, and T-003 cannot name tables that T-004 and
-- T-005 have not created yet. Rather than re-emitting a longer array in each later migration
-- (three chances to drift), this version derives the set from pg_partitioned_table: every table
-- in `public` partitioned BY LIST on exactly the single column `tenant_id`. That is precisely the
-- membership rule the hardcoded array and its structural test were enforcing, so the SEMANTICS
-- are preserved and strengthened — a new tenant-scoped table is covered the moment it is created,
-- and the registry can no longer fall out of sync with the schema.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS), so re-invoking for an existing tenant is a no-op. This
-- matters because tenant creation may be retried and because T-004/T-005 add partitioned tables
-- after tenants already exist — backfilling is just calling this again for each tenant.
--
-- SECURITY INVOKER (the default) is intentional: this creates tables, so it must run with the
-- caller's privileges rather than the definer's. search_path is pinned to the empty string so a
-- caller cannot shadow the catalog relations this function reads (pg_catalog remains implicitly
-- searched even with an empty path, and naming it explicitly would require a USAGE grant that
-- Supabase does not give every role). Table names come from the catalog and are quoted with %I,
-- so no identifier is ever interpolated from user input.
--
-- Rollback/recovery: `drop function create_tenant_partitions` does not touch existing partitions;
-- it only prevents new tenants from getting theirs (tenant creation would then fail loudly, and
-- writes would fall through to each table's DEFAULT partition — the safety net that exists for
-- exactly this case). Re-running this migration restores the function. To repair a tenant whose
-- partitions were dropped, call `select create_tenant_partitions(<tenant_id>)` — but note that
-- any rows already sitting in a DEFAULT partition for that tenant must be moved out first, since
-- PostgreSQL refuses to attach a partition whose range is already occupied by default-partition
-- rows.

create or replace function create_tenant_partitions(p_tenant_id bigint)
returns void
language plpgsql
set search_path = ''
as $function$
declare
    v_table text;
begin
    for v_table in
        select c.relname
          from pg_partitioned_table p
          join pg_class c on c.oid = p.partrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           -- 'l' = LIST strategy, partitioned on exactly one column...
           and p.partstrat = 'l'
           and p.partnatts = 1
           -- ...and that column is tenant_id.
           and (select a.attname
                  from pg_attribute a
                 where a.attrelid = c.oid
                   and a.attnum = p.partattrs[0]) = 'tenant_id'
         order by c.relname
    loop
        -- public. is explicit because search_path is empty: without it CREATE TABLE has no
        -- schema to create in.
        execute format(
            'create table if not exists public.%I partition of public.%I for values in (%L)',
            v_table || '_p' || p_tenant_id,
            v_table,
            p_tenant_id
        );
    end loop;
end;
$function$;

comment on function create_tenant_partitions(bigint) is
    'Creates the per-tenant partition on every public LIST(tenant_id)-partitioned table. Called '
    'inside the tenant-creation transaction (T-016); idempotent, so it is also the backfill path '
    'when a new partitioned table is added for existing tenants.';
