-- 20260718003500_lead_workflow.sql
--
-- Owner: T-005 (M-08, A-12, spec §11.3, N-04, AC-004/AC-005).
-- Source changelog: src/api/db/changelog/100-lead-workflow/100-lead-workflow.xml
--   changesets 100-lead-status-history-table, 101-pricing-approvals-table, 102-follow-ups-table.
--
-- The three tables that record what HAPPENED to a lead, as opposed to its current state on the
-- leads row: the status-transition audit trail, the pricing-approval workflow, and logged follow-ups.
--
-- ============================================================================================
-- lead_status_history.inputs IS jsonb, AND THAT IS ONE OF EXACTLY TWO SANCTIONED EXCEPTIONS.
-- ============================================================================================
-- CLAUDE.md forbids jsonb for queryable core business fields. This column (and its
-- quote_status_history twin) is the sanctioned exception because it is an APPEND-ONLY AUDIT PAYLOAD
-- of the dialog inputs an operation captured — nothing queries inside it, filters on it, groups by
-- it, or reports from it. Every fact that IS filterable or reportable about the event is a typed
-- column: operation, previous_status_id, new_status_id, acted_by, acted_at. If a future requirement
-- needs to query something currently buried in `inputs`, the answer is to promote it to its own
-- typed column, not to add a jsonb path index.
--
-- APPEND-ONLY IS AN APPLICATION DISCIPLINE HERE, NOT A DATABASE TRIGGER — and that is a verified
-- fact about the reference, not an assumption. The live .NET reference database has NO triggers and
-- NO rules on lead_status_history or quote_status_history, so UPDATE and DELETE are physically
-- permitted there. Adding a guard trigger in the target would be a genuine behavioural divergence,
-- and a shape-based schema diff would not even show it. So it is deliberately NOT added, and the
-- integration suite asserts the true state of both databases rather than a comforting fiction. If
-- append-only should become a DB guarantee, that is a spec decision applying to both history tables
-- together.
--
-- previous_status_id and new_status_id are both NULLABLE because not every recorded operation is a
-- transition — a captured note or an assignment change has no status delta. Do not tighten these.
--
-- ============================================================================================
-- pricing_approvals: THE WORKFLOW LOG. leads.pricing_approval_state IS THE DENORMALIZED ANSWER.
-- ============================================================================================
-- One row per approval REQUEST, with its own state machine (ck_pricing_approvals_state:
-- pending → approved | rejected). The lead's own pricing_approval_state column mirrors the current
-- outcome so list/dashboard queries do not need a correlated subquery per lead; the two are kept
-- consistent by the workflow handlers. The 'pending' state feeds the pending_pricing_approval alert.
--
-- requested_by, requested_at and approver_id are NOT NULL: a request with no requester or no
-- nominated approver is not a request. The decided_* trio is nullable because it is only written
-- when the decision lands. rejection_reason and decision_note are separate columns on purpose —
-- the reference keeps them distinct and both are surfaced differently in the UI.
--
-- ============================================================================================
-- follow_ups: THE LOG. leads.last_follow_up_date / next_follow_up_date / follow_up_count ARE THE
-- DENORMALIZED ROLL-UP.
-- ============================================================================================
-- Each row is one logged follow-up with its outcome and optionally the next scheduled date. The
-- overdue-follow-up alert rule and the SLA/aging dashboards read the denormalized columns on leads
-- (maintained on write) rather than aggregating this table per lead, which is what keeps those
-- sweeps index-backed at seed-and-beyond volumes (N-04). outcome_note is NOT NULL: a follow-up with
-- no recorded outcome is not a follow-up.
--
-- INDEXES (N-04). All three carry a (tenant_id, <parent>_id, <time>) composite. That column order is
-- the access path, not decoration: every read is tenant-scoped first, drills to one lead, and then
-- wants the rows in chronological order — so the same index serves the lookup AND supplies the sort,
-- with no separate sort step and no cross-tenant scan.
--
-- All three tables are partitioned LIST(tenant_id) per A-12, verified against the live reference
-- database. Picked up automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table lead_status_history cascade` destroys the audit trail of every
-- lead transition — unrecoverable by re-running this migration, and audit records are exactly what
-- cannot be reconstructed. Restore from backup.

create table lead_status_history (
    tenant_id bigint not null,
    id bigint generated always as identity,
    lead_id bigint not null,
    operation text not null,
    -- Both nullable: not every recorded operation is a status transition.
    previous_status_id bigint,
    new_status_id bigint,
    acted_by bigint,
    acted_at timestamptz not null,
    -- Append-only audit payload of captured dialog inputs. NOT queried; see header.
    inputs jsonb,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table lead_status_history_default partition of lead_status_history default;

create index ix_lead_status_history_tenant_lead
    on lead_status_history (tenant_id, lead_id, acted_at);

create table pricing_approvals (
    tenant_id bigint not null,
    id bigint generated always as identity,
    lead_id bigint not null,
    requested_by bigint not null,
    requested_at timestamptz not null,
    approver_id bigint not null,
    proposed_premium numeric(18,2),
    request_note text,
    state text not null,
    -- Written only when the decision lands.
    decided_by bigint,
    decided_at timestamptz,
    decision_note text,
    rejection_reason text,
    primary key (tenant_id, id),
    constraint ck_pricing_approvals_state check (state in ('pending', 'approved', 'rejected'))
) partition by list (tenant_id);

create table pricing_approvals_default partition of pricing_approvals default;

create index ix_pricing_approvals_tenant_lead
    on pricing_approvals (tenant_id, lead_id, requested_at);

create table follow_ups (
    tenant_id bigint not null,
    id bigint generated always as identity,
    lead_id bigint not null,
    follow_up_date date not null,
    -- NOT NULL: a follow-up with no recorded outcome is not a follow-up.
    outcome_note text not null,
    next_follow_up_date date,
    logged_by bigint,
    logged_at timestamptz not null,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table follow_ups_default partition of follow_ups default;

create index ix_follow_ups_tenant_lead on follow_ups (tenant_id, lead_id, logged_at);
