-- 20260718002200_tenant_settings.sql
--
-- Owner: T-004 (M-08, P-04, spec §11.2, AC-007).
-- Source changelogs:
--   src/api/db/changelog/050-settings/050-tenant-settings.xml  changeset 050-tenant-settings-table
--   src/api/db/changelog/130-jobs/130-jobs.xml                 changeset
--     130-jobs-tenant-settings-expire-lead-rule (adds expire_lead_when_last_quote_expires)
-- The two changesets are collapsed into one CREATE TABLE: a fresh Supabase database has no history
-- to replay, and an ALTER-after-CREATE in the same migration set would only reproduce the shape
-- this statement already declares. The final .NET schema is the target, not its edit history.
--
-- One row per tenant holds every tenant-configurable business rule in P-04: high-value threshold,
-- SLA targets, expiry/stall/aging/duplicate-check thresholds, lead & quote reference-format
-- templates, display currency, max attachment MB, the pricing-approval gate toggle, and
-- lead_inactivity_expiry_days.
--
-- EXACTLY ONE ROW PER TENANT is enforced by uq_tenant_settings_tenant_id, not merely by convention.
-- The settings row is created inside the same transaction as the tenant (tenant provisioning), so a
-- tenant never exists without settings, and this constraint means it can never acquire a second,
-- contradictory set either.
--
-- EVERY DEFAULT HERE IS LOAD-BEARING and mirrors the .NET TenantSettings property initializers 1:1
-- (spec FR-11). Provisioning inserts the row from application code, so if a column default drifted
-- from its C# initializer the two paths would silently produce different tenants depending on which
-- one created the row. Do not "tidy" these values — they are the compatibility contract, and the
-- parity suite compares column defaults against the reference database for exactly this reason.
--
-- Partitioned LIST(tenant_id) with a composite (tenant_id, id) PK, per spec §11 and verified
-- against the .NET reference database (relkind 'p', LIST strategy on tenant_id). It is therefore
-- picked up automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table tenant_settings cascade` removes every tenant's business rules and
-- all per-tenant partitions; nothing references it physically, but every tenant would fall back to
-- having no configured thresholds at all, which the application treats as a provisioning failure
-- rather than as defaults. Recover from backup.

create table tenant_settings (
    tenant_id bigint not null,
    id bigint generated always as identity,

    -- Display currency (P-04). Code and symbol are stored separately because the symbol is what
    -- the currency-prefixed premium inputs render.
    currency_code text not null default 'BWP',
    currency_symbol text not null default 'BWP',

    max_attachment_mb integer not null default 10,

    -- Nullable: a tenant that has not configured a high-value threshold has no high-value
    -- classification at all, which is distinct from a threshold of zero.
    high_value_threshold numeric(18,2),

    -- Alert / staleness thresholds consumed by the scheduled alert jobs.
    quote_expiry_alert_days integer not null default 7,
    follow_up_overdue_grace_days integer not null default 0,
    aging_amber_days integer not null default 8,
    aging_red_days integer not null default 15,
    unassigned_lead_hours integer not null default 24,
    stalled_lead_days integer not null default 7,
    stalled_quote_days integer not null default 7,
    duplicate_check_days integer not null default 30,

    -- Reference-format templates: {YYYY} = year, {SEQ:n} = zero-padded per-tenant/year sequence
    -- drawn transactionally from reference_sequences.
    lead_ref_format text not null default 'L-{YYYY}-{SEQ:4}',
    quote_ref_format text not null default 'Q-{YYYY}-{SEQ:4}',

    lead_inactivity_expiry_days integer not null default 60,

    -- SLA targets (P-04) driving the SLA/turnaround dashboards and breach alerts.
    pricing_approval_target_days integer not null default 3,
    sla_assignment_days integer not null default 1,
    sla_underwriting_days integer not null default 3,
    sla_received_to_sent_days integer not null default 5,

    -- Pricing-approval gate toggle (P-04): off by default, so enabling the gate is an explicit
    -- tenant decision rather than something a new tenant inherits.
    require_pricing_approval_for_high_value boolean not null default false,
    manual_external_ref_enabled boolean not null default false,

    -- Optional tenant rule: expire the lead when its last open quote expires. Default off.
    expire_lead_when_last_quote_expires boolean not null default false,

    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id),
    constraint uq_tenant_settings_tenant_id unique (tenant_id)
) partition by list (tenant_id);

create table tenant_settings_default partition of tenant_settings default;
