-- 20260718002300_business_assignments.sql
--
-- Owner: T-004 (M-08, P-04, spec §11.2, AC-007).
-- Source changelogs:
--   src/api/db/changelog/060-assignments/060-business-assignments.xml  changeset
--     060-business-assignments-table (original free-form shape)
--   src/api/db/changelog/170-assignment-slots/170-assignment-slots.xml changeset
--     170-business-assignment-slots (the 2026-07-15 restructure into fixed slots)
--
-- ============================================================================================
-- THE FINAL (POST-170) SHAPE IS CREATED DIRECTLY. The migration history is NOT replayed.
-- ============================================================================================
-- Changeset 060 created a free-form table (applies_to 'lead'|'quote', is_accountable_owner,
-- display_order, unique on (tenant_id, role_id, applies_to)); changeset 170 then dropped all three
-- columns and both constraints, backfilled a `slot` column, and DELETEd every row that did not map
-- onto a slot. Replaying that against a brand-new Supabase database would create three columns and
-- two constraints purely to destroy them one statement later, and would run a data migration over
-- zero rows. What matters is the resulting shape, so this migration declares it once.
--
-- The columns 170 deleted are gone on purpose and must not be reintroduced:
--   * applies_to / is_accountable_owner — superseded by the slot itself. The "rm" slot IS the
--     accountable-owner concept; the "underwriter" slot IS what send-to-underwriting targets.
--   * display_order — meaningless for a fixed two-element set.
--
-- Two fixed slots, one role each per tenant (P-04, spec FR-23/FR-35/FR-36), enforced structurally:
--   * ck_business_assignments_slot restricts slot to exactly 'rm' | 'underwriter', so no third
--     slot can ever be invented by a buggy caller.
--   * uq_business_assignments_tenant_slot admits at most ONE row per (tenant, slot), which is what
--     makes "one role each" a database guarantee rather than an application convention.
-- Together these replace the /underwrit/i role-name heuristic the .NET
-- SendToUnderwritingCommandHandler used to infer the underwriting role — the slot is now explicit.
--
-- role_id references the roles table BY CONVENTION, not with a physical FK. roles is global-capable
-- (unpartitioned, nullable tenant_id) while this table is LIST-partitioned, and the same non-FK
-- shape is already used by user_roles/group_roles against roles. Validation lives in the
-- application layer, matching the .NET reference exactly.
--
-- Downstream lead_assignments/quote_assignments (T-005) reference business_assignments.id, so a
-- slot's configured role can change without touching live assignee rows.
--
-- Partitioned LIST(tenant_id) per spec §11, verified against the .NET reference database; picked up
-- automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table business_assignments cascade` unconfigures both slots for every
-- tenant and (once T-005 lands) cascades into the assignee tables that reference it. Recover from
-- backup. There is no partial rollback to the pre-170 free-form shape — that shape is retired.

create table business_assignments (
    tenant_id bigint not null,
    id bigint generated always as identity,
    -- By-convention reference to roles(id); see header for why this is not a physical FK.
    role_id bigint not null,
    slot text not null,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id),
    -- At most one row per (tenant, slot): this is the "one role per slot" guarantee.
    constraint uq_business_assignments_tenant_slot unique (tenant_id, slot),
    constraint ck_business_assignments_slot check (slot in ('rm', 'underwriter'))
) partition by list (tenant_id);

create table business_assignments_default partition of business_assignments default;
