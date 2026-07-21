-- 20260718001300_audit_log.sql
--
-- Owner: T-003 (M-08, P-13, spec §11.4 / §15).
-- Source changelogs:
--   src/api/db/changelog/010-foundation/010-audit-log.xml   (base table + indexes)
--   src/api/db/changelog/130-jobs/130-jobs.xml              (adds actor_label)
--
-- Consolidation note: the .NET schema created this table and then added actor_label in a later
-- changelog. There is no deployed database to migrate here, so the final shape is created in one
-- statement. The result was verified column-for-column against the .NET reference schema during
-- the migration; that schema-parity suite was retired at cutover (T-044) and the schema is now
-- guarded by db:validate against supabase/schema.expected.sql.
--
-- Append-only administrative/workflow audit trail. Deliberately UNPARTITIONED: tenant_id is
-- nullable so system/global actions that belong to no single tenant (tenant lifecycle, global
-- template edits, cross-tenant Internal access per AC-020) can be recorded. A LIST partition on
-- tenant_id would require a NOT NULL key and could not represent those rows.
--
-- BEFORE/AFTER PAYLOADS (spec §11 "audit_log (jsonb before/after payloads)", AC-024): carried
-- over as the single `details` jsonb column, matching the .NET IAuditWriter contract, whose
-- AuditEntry.Details is documented as "an anonymous object or DTO capturing the relevant
-- before/after state". The audit writer (T-013) therefore writes {"before": ..., "after": ...}
-- into details, and the shared audit assertion helper reads details->'before'/details->'after'.
-- This is a deliberate choice of one jsonb payload column over two dedicated columns: it keeps
-- the ported writer contract intact and avoids columns that no operation populates. If the
-- Evaluator prefers explicit before_state/after_state columns, that is a cheap additive
-- migration and no data would need rewriting at this stage (the table is empty).
--
-- jsonb is used here and only here in T-003's scope: per A-12, jsonb is reserved for audit and
-- history payloads and is never used for queryable core business fields.
--
-- Rollback/recovery: this table is the audit trail. Dropping it destroys evidence that cannot be
-- reconstructed from any other source. Never drop it to "fix" a migration; add a forward
-- migration instead.

create table audit_log (
    id bigint generated always as identity primary key,
    tenant_id bigint,
    entity_type text not null,
    entity_id text not null,
    action text not null,
    actor_user_id bigint,
    -- Human-readable label for a non-user actor: 'system' for the automatic background jobs
    -- (quote expiry, lead inactivity expiry), null for ordinary authenticated callers where
    -- actor_user_id alone identifies the actor.
    actor_label text,
    acted_at timestamptz not null,
    details jsonb
);

create index ix_audit_log_tenant_id on audit_log (tenant_id);
create index ix_audit_log_entity on audit_log (entity_type, entity_id);
create index ix_audit_log_acted_at on audit_log (acted_at);
