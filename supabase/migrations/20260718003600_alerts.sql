-- 20260718003600_alerts.sql
--
-- Owner: T-005 (M-08, A-12, spec §9.4/§9.5, N-04, AC-004/AC-005/AC-008).
-- Source changelog: src/api/db/changelog/140-alerts/140-alerts.xml
--   changesets 140-alerts-table, 141-user-alert-views-table.
--
-- Materialized alert rows plus the per-user badge marker. Alerts are RECONCILED, not appended: the
-- alert-evaluation sweep (Job 3, §9.5) re-derives the full rule-match set every 15 minutes, creating
-- what is missing and resolving what has cleared.
--
-- ============================================================================================
-- uq_alerts_open_per_type_lead_quote IS WHAT MAKES JOB 3 IDEMPOTENT. THIS IS THE LOAD-BEARING
-- OBJECT IN THIS FILE.
-- ============================================================================================
-- Spec §9.5 states Job 3's reconciliation is "idempotent by construction ... no duplicate open alert
-- per type+lead+quote — DB uniqueness enforced". THIS INDEX IS THAT ENFORCEMENT. Without it the
-- guarantee is a comment: a retried, duplicated, or overlapping sweep — all of which the job model
-- explicitly tolerates, since pg_cron delivery is at-least-once and never exactly-once — would
-- insert a second identical open alert, and the Alerts Centre would show the same problem twice for
-- the same lead. T-033/T-034 build directly on this. It must not be weakened or renamed.
--
-- Three details make it work, and each is deliberate:
--
--   1. PARTIAL ON `resolved_at IS NULL`. The uniqueness applies to OPEN alerts only. This is what
--      lets the same (type, lead, quote) tuple legitimately recur: once an alert is resolved it
--      stops participating in the index, so when the condition re-triggers later a fresh open row
--      inserts cleanly. A non-partial unique would permanently forbid the second occurrence and
--      silently suppress real alerts forever after the first one was resolved. Any number of
--      resolved rows for the same tuple may coexist — that history is the point.
--
--   2. COALESCE(quote_id, 0). quote_id is NULL for lead-level alerts, and in SQL NULL never equals
--      NULL — so a plain unique index would treat every lead-level alert as distinct and enforce
--      nothing at all for exactly the alerts that have no quote. Folding NULL to 0 gives those rows
--      a single shared value so they collide as intended. (0 is safe as the sentinel because id is
--      a GENERATED ALWAYS AS IDENTITY column, which starts at 1 — no real quote can ever be 0.)
--      This is the difference between a constraint that works and one that looks right in the
--      catalog while admitting duplicates; assert it with a real violating INSERT, never by reading
--      pg_indexes.
--
--   3. tenant_id LEADS THE INDEX. It is the partition key, which a unique index on a partitioned
--      parent must include, and it also makes the uniqueness per-tenant rather than global —
--      two tenants may of course each have their own open alert of the same type.
--
-- ============================================================================================
-- THE TYPE CHECK IS DECLARED INLINE ON PURPOSE.
-- ============================================================================================
-- Written as an unnamed column-level CHECK so PostgreSQL auto-names it `alerts_type_check`, which is
-- exactly what the .NET reference database carries (verified live). Naming it `ck_alerts_type` in
-- our house style would read better but would produce a constraint-name mismatch in the parity
-- diff for no behavioural gain. Faithfulness wins here.
--
-- The eleven types are a closed set backing the Alerts Centre's grouping and the per-rule sweeps, so
-- an unrecognised type is rejected outright rather than creating a phantom category. `severity` is
-- deliberately UNCONSTRAINED text, matching the reference — do not add a check without a spec
-- decision, since the reference's severity values are assigned by rule configuration, not by a
-- fixed enumeration.
--
-- lead_id is NOT NULL: every alert hangs off a lead (quote-level alerts carry both). premium_at_risk
-- is numeric(18,2) money (A-12) and drives the value-weighted ordering in the Alerts Centre.
--
-- INDEXES (N-04): ix_alerts_tenant_lead serves the per-lead alert badge on lead detail;
-- ix_alerts_tenant_open_created is PARTIAL on the open set and ordered by created_at, which is the
-- Alerts Centre's actual query — it keeps that list from scanning resolved history that grows without
-- bound while the open set stays small.
--
-- ============================================================================================
-- user_alert_views: THE BADGE MARKER.
-- ============================================================================================
-- One row per user per tenant recording when they last opened the Alerts Centre; the unread badge
-- counts alerts created after last_opened_at. uq_user_alert_views_tenant_user is what makes
-- "exactly one row per user per tenant" true, and it is the conflict target the badge-reset upsert
-- relies on. The table still carries the standard synthetic id + composite (tenant_id, id) PK rather
-- than a natural (tenant_id, user_id) PK, because A-12 applies that shape to every tenant-scoped
-- table without exception — the natural key is expressed as the unique constraint instead.
--
-- Both tables are partitioned LIST(tenant_id) per A-12, verified against the live reference
-- database. Picked up automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table alerts cascade` is SELF-HEALING, uniquely in this schema — Job 3's
-- next sweep re-derives every open alert from the underlying rule inputs. What is NOT recovered is
-- the resolved history (when each alert cleared and why), which is gone for good. Restore from
-- backup if that history matters.

create table alerts (
    tenant_id bigint not null,
    id bigint generated always as identity,
    -- Unnamed inline check so Postgres auto-names it alerts_type_check, matching the reference.
    type text not null check (type in (
        'unassigned_lead', 'overdue_follow_up', 'stalled_lead', 'stalled_quote',
        'quote_expiring', 'quote_expired', 'sla_breach', 'high_value_stalled',
        'pending_pricing_approval', 'awaiting_underwriting', 'executive_escalation'
    )),
    -- Every alert hangs off a lead; quote-level alerts carry both.
    lead_id bigint not null,
    quote_id bigint,
    -- Unconstrained by design, matching the reference: severity comes from rule configuration.
    severity text not null,
    premium_at_risk numeric(18,2),
    created_at timestamptz not null,
    -- NULL = open. This is the predicate the uniqueness index below is scoped to.
    resolved_at timestamptz,
    resolved_reason text,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table alerts_default partition of alerts default;

-- At most one OPEN alert per (tenant, type, lead, quote). See header: this is the enforcement
-- behind spec §9.5's Job 3 idempotency guarantee. Partial so resolved rows never block a
-- recurrence; COALESCE so lead-level (quote_id IS NULL) alerts actually collide.
create unique index uq_alerts_open_per_type_lead_quote
    on alerts (tenant_id, type, lead_id, coalesce(quote_id, 0))
    where resolved_at is null;

create index ix_alerts_tenant_lead on alerts (tenant_id, lead_id);

-- Partial on the open set: the Alerts Centre never pages through resolved history.
create index ix_alerts_tenant_open_created on alerts (tenant_id, created_at) where resolved_at is null;

comment on index uq_alerts_open_per_type_lead_quote is
    'Enforces at most one OPEN alert per (tenant, type, lead, quote) — the DB uniqueness spec §9.5 '
    'names as the basis for Job 3 reconciliation idempotency under at-least-once cron delivery. '
    'Partial on resolved_at IS NULL so a resolved alert never blocks a recurrence; COALESCE(quote_id, 0) '
    'so lead-level alerts (quote_id IS NULL) collide instead of being all-distinct under NULL semantics.';

create table user_alert_views (
    tenant_id bigint not null,
    id bigint generated always as identity,
    user_id bigint not null,
    last_opened_at timestamptz not null,
    primary key (tenant_id, id),
    -- Exactly one row per user per tenant; the badge-reset upsert's conflict target.
    constraint uq_user_alert_views_tenant_user unique (tenant_id, user_id)
) partition by list (tenant_id);

create table user_alert_views_default partition of user_alert_views default;
