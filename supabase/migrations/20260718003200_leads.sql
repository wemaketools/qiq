-- 20260718003200_leads.sql
--
-- Owner: T-005 (M-08, A-12, spec §11.3, N-04, AC-004/AC-005).
-- Source changelog: src/api/db/changelog/090-leads/090-leads.xml
--   changesets 090-leads-table, 091-lead-assignments-table, 092-lead-notes-table.
--   Changeset 093-reference-sequences-table is NOT here — T-003 already created that table
--   (20260718001400_reference_sequences.sql); recreating it would fail on a clean apply.
--
-- The Lead is the central business entity (CLAUDE.md terminology: a Lead is the intake record /
-- sales opportunity, and it exists BEFORE any Quote). Every column spec §11.3 lists is created
-- here, including lifecycle columns no intake path writes at create time — T-019's workflow
-- operations are what mutate status_id, the loss/withdrawal capture block, the pricing-approval
-- state and the follow-up counters. Creating them all now means the workflow tasks add behaviour,
-- not schema.
--
-- ============================================================================================
-- REFERENCE-DATA COLUMNS ARE BY-CONVENTION REFERENCES, NOT PHYSICAL FKs.
-- ============================================================================================
-- request_channel_id, region_id, product_line_id, cover_type_id, status_id and lost_reason_id each
-- point at a tenant-scoped reference_items row (list_types 'request_channel', 'region',
-- 'product_line', 'cover_type', 'lead_status', 'lost_reason'). party_id points at parties and
-- broker_id at brokers — both within the same tenant partition. None of these is a physical FK, for
-- the reason that recurs throughout this schema: a FK out of a LIST-partitioned table must include
-- the partition key, so the reference schema validates in the application layer instead. Mirroring
-- that is both faithful and parity-preserving.
--
-- region_id IS NOT NULL here, unlike parties.region_id which is nullable. That asymmetry is
-- deliberate and specified (Q-9): the LEAD's own region is a required reporting dimension (PRD 9.3)
-- and drives regional dashboards, whereas the party's region is optional and merely supplies a
-- default when set. Do not "harmonise" these two columns.
--
-- ============================================================================================
-- THE CHECK CONSTRAINTS ARE REPORTING GUARANTEES, NOT INPUT VALIDATION.
-- ============================================================================================
-- policy_term, priority, source and pricing_approval_state are closed enumerations backing
-- dashboard dimensions and business rules, so they are constrained in the database rather than
-- trusted from the caller. CLAUDE.md forbids free text for core report dimensions; a stray value
-- would silently create a phantom bucket in every report that groups by them.
--   * ck_leads_source ('browser' | 'api') is what distinguishes a UI-entered lead from one ingested
--     through POST /intake/leads. intake_credential_id records WHICH api_credentials row ingested
--     it (by convention, no FK), which is what makes an API-sourced lead attributable to a broker
--     integration even after that credential is disabled.
--   * policy_term_other carries the free-text term only when policy_term = 'other'. That pairing is
--     enforced in the application layer, matching the reference — there is no DB check for it.
--
-- last_activity_at is MAINTAINED ON WRITE, not derived (spec §11). The inactivity-expiry sweep
-- (Job 2, §9.5) and the stalled-lead alert rules scan on it, so computing it from history at read
-- time would make those sweeps unindexable.
--
-- lead_assignments is SLOT-BASED. business_assignment_id references a business_assignments row
-- (T-004) — that is, the tenant's 'rm' or 'underwriter' SLOT — rather than a role directly, so a
-- slot's configured role can change without rewriting live assignee rows.
-- uq_lead_assignments_tenant_lead_role admits at most one assignee per lead per slot, which is what
-- makes "the RM of this lead" a single unambiguous answer.
--
-- lead_notes is append-oriented free text with created_at/created_by only — no updated_* pair,
-- because a note is a point-in-time record rather than a mutable field. This mirrors the reference
-- exactly; do not add update columns.
--
-- All three tables are partitioned LIST(tenant_id) per A-12, verified against the live .NET
-- reference database. Picked up automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table leads cascade` destroys the core business record and orphans
-- quotes, follow-ups, alerts and history. Restore from backup.

create table leads (
    tenant_id bigint not null,
    id bigint generated always as identity,
    -- By-convention references within the same tenant partition; see header for why no FKs.
    party_id bigint not null,
    lead_ref text not null,
    -- Caller-supplied reference from an upstream system; nullable and not unique.
    external_ref text,
    date_received date not null,
    request_channel_id bigint not null,
    broker_id bigint,
    -- NOT NULL unlike parties.region_id: the lead's region is a required reporting dimension (Q-9).
    region_id bigint not null,
    product_line_id bigint not null,
    cover_type_id bigint not null,

    sum_insured numeric(18,2),
    estimated_premium numeric(18,2),

    policy_term text not null,
    -- Free-text term, used only when policy_term = 'other'; pairing enforced in the app layer.
    policy_term_other text,
    priority text not null default 'normal',
    is_existing_client boolean not null default false,

    status_id bigint not null,
    pricing_approval_state text not null default 'none',

    date_assigned timestamptz,
    decision_date timestamptz,

    -- Loss / withdrawal capture. Written by the workflow operations (T-019), not at intake.
    lost_reason_id bigint,
    lost_before_quote boolean,
    competitor text,
    competitor_premium numeric(18,2),
    loss_comments text,
    withdrawal_note text,

    -- Maintained on write, not derived: the inactivity sweep and stalled-lead rules scan on it.
    last_activity_at timestamptz,
    last_follow_up_date date,
    next_follow_up_date date,
    follow_up_count integer not null default 0,

    -- 'browser' vs 'api' intake; intake_credential_id attributes an API lead to its credential.
    source text not null,
    intake_credential_id bigint,

    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,

    primary key (tenant_id, id),
    constraint uq_leads_tenant_lead_ref unique (tenant_id, lead_ref),
    -- Closed enumerations backing report dimensions and business rules; see header.
    constraint ck_leads_policy_term check (policy_term in ('m6', 'm12', 'm24', 'm36', 'other')),
    constraint ck_leads_priority check (priority in ('normal', 'high')),
    constraint ck_leads_source check (source in ('browser', 'api')),
    constraint ck_leads_pricing_approval_state
        check (pricing_approval_state in ('none', 'pending', 'approved', 'rejected'))
) partition by list (tenant_id);

create table leads_default partition of leads default;

create table lead_assignments (
    tenant_id bigint not null,
    id bigint generated always as identity,
    lead_id bigint not null,
    -- The tenant's 'rm' or 'underwriter' SLOT (business_assignments), not a role directly.
    business_assignment_id bigint not null,
    user_id bigint not null,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id),
    -- One assignee per lead per slot.
    constraint uq_lead_assignments_tenant_lead_role unique (tenant_id, lead_id, business_assignment_id)
) partition by list (tenant_id);

create table lead_assignments_default partition of lead_assignments default;

create table lead_notes (
    tenant_id bigint not null,
    id bigint generated always as identity,
    lead_id bigint not null,
    body text not null,
    -- No updated_at/updated_by pair on purpose: a note is a point-in-time record.
    created_at timestamptz not null,
    created_by bigint,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table lead_notes_default partition of lead_notes default;
