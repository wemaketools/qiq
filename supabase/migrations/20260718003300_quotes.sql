-- 20260718003300_quotes.sql
--
-- Owner: T-005 (M-08, A-12, spec §11.3, N-04, AC-004/AC-005).
-- Source changelog: src/api/db/changelog/110-quotes/110-quotes.xml
--   changesets 110-quotes-table, 111-quote-versions-table, 112-quote-assignments-table,
--   113-quote-status-history-table.
--
-- The formal quotation. Per CLAUDE.md terminology every Quote belongs to exactly one Lead
-- (quotes.lead_id, always set), and a Lead may carry zero, one or many Quotes when the tenant
-- permits revisions/options/re-quotes. quote_versions then holds the priced revisions OF a quote.
--
-- ============================================================================================
-- THE TWO "CURRENT" MARKERS AND WHY ONLY ONE OF THEM GAINS A DATABASE GUARANTEE HERE.
-- ============================================================================================
-- There are two distinct one-of-N invariants in this file:
--   1. quote_versions.is_current — the current priced revision OF one quote.
--   2. quotes.is_current         — the current/primary quote OF one lead (FR-50, PRD 7.3).
-- Both matter for correctness, not just tidiness: every dashboard store joins
-- `quote.is_current AND version.is_current` to read the current quoted premium, so a duplicate
-- current row on either side DOUBLE-COUNTS premium in Executive, Pipeline, Broker and Loss
-- Analysis reporting simultaneously.
--
-- The .NET reference enforces NEITHER in the database — ReviseQuoteCommandHandler clears the prior
-- current version and inserts the new one in application code, so two concurrent Revise calls can
-- interleave and commit two current versions. That is the same class of gap the reference itself
-- closed for broker contacts in its F-043 hardening (uq_broker_contacts_primary), and this
-- migration closes it the same way for (1), which is named in T-005's scope:
--
--   uq_quote_versions_current — TARGET-ONLY documented strengthening, allow-listed in the parity
--   suite. Partial on is_current = true, so a quote may still have any number of superseded
--   versions while at most one is current. tenant_id (the partition key) is one of the indexed
--   columns, which is exactly what lets Postgres put a unique index on a partitioned parent and
--   propagate it to every existing and future partition.
--
-- (2) — quotes.is_current — is NOT guarded by this migration. It is outside T-005's stated scope,
-- and adding an unrequested second schema deviation without a task decision is not the Implementor's
-- call. IT REMAINS AN APPLICATION-LAYER-ONLY INVARIANT AND IS REPORTED AS AN OPEN GAP so it can be
-- scheduled deliberately. The index that would close it, if approved, is:
--   create unique index uq_quotes_current on quotes (tenant_id, lead_id) where is_current = true;
-- Do not add it silently — it needs the same allow-list entry and a backfill check against existing
-- data, since any tenant already holding two current quotes for one lead would fail the build.
--
-- ============================================================================================
-- REFERENCES, MONEY AND HISTORY.
-- ============================================================================================
-- lead_id, status_id, product_line_id, cover_type_id and lost_reason_id are by-convention
-- intra-tenant references (reference_items / leads), not physical FKs — a FK out of a
-- LIST-partitioned table would have to include the partition key, so the reference schema validates
-- in the application layer. Same shape as leads and brokers.
--
-- All money is numeric(18,2) (A-12): bound_premium, competitor_premium, quoted_premium. Never float.
--
-- quote_status_history.inputs is jsonb, and it is one of exactly two places in this schema where
-- that is allowed (its lead_status_history twin is the other). It is an APPEND-ONLY AUDIT PAYLOAD of
-- the dialog inputs an operation captured — never a queryable business field. Everything filterable
-- or reportable about the event is a typed column instead: operation, previous_status_id,
-- new_status_id, acted_by, acted_at. CLAUDE.md's "no jsonb for queryable core business fields" rule
-- is satisfied precisely because nothing queries inside `inputs`.
--
-- APPEND-ONLY IS AN APPLICATION DISCIPLINE, NOT A DATABASE TRIGGER. Verified against the live .NET
-- reference database: it has NO triggers and NO rules on either history table, so UPDATE and DELETE
-- are physically permitted there. Adding a guard trigger here would be a real behavioural divergence
-- from the reference (and would be invisible to the shape-based parity diff, which is worse), so it
-- is deliberately not added. The integration suite asserts this honestly — it proves both databases
-- agree rather than pretending a guard exists.
--
-- All four tables are partitioned LIST(tenant_id) per A-12, verified against the live reference
-- database. Picked up automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table quotes cascade` destroys quoted/bound premium history and orphans
-- attachments, assignments and alerts. Restore from backup.

create table quotes (
    tenant_id bigint not null,
    id bigint generated always as identity,
    -- Every quote belongs to exactly one lead. By-convention reference; see header.
    lead_id bigint not null,
    quote_ref text not null,
    status_id bigint not null,
    -- The lead's current/primary quote marker (FR-50). NOT DB-guarded; see header.
    is_current boolean not null default false,
    product_line_id bigint not null,
    cover_type_id bigint not null,

    prepared_date date not null,
    sent_date date,
    -- Drives the quote-expiry sweep (Job 1, §9.5) and the quote_expiring/quote_expired alerts.
    valid_until date,
    decision_date timestamptz,

    bound_premium numeric(18,2),

    -- Loss / withdrawal capture, mirroring the same block on leads.
    lost_reason_id bigint,
    competitor text,
    competitor_premium numeric(18,2),
    loss_comments text,
    withdrawal_note text,

    notes text,

    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,

    primary key (tenant_id, id),
    constraint uq_quotes_tenant_quote_ref unique (tenant_id, quote_ref)
) partition by list (tenant_id);

create table quotes_default partition of quotes default;

create index ix_quotes_tenant_lead on quotes (tenant_id, lead_id);

create table quote_versions (
    tenant_id bigint not null,
    id bigint generated always as identity,
    quote_id bigint not null,
    version_no integer not null,
    -- Money is always numeric(18,2) (A-12).
    quoted_premium numeric(18,2) not null,
    terms_notes text,
    revision_note text,
    is_current boolean not null default false,
    created_at timestamptz not null,
    created_by bigint,
    primary key (tenant_id, id),
    constraint uq_quote_versions_tenant_quote_version unique (tenant_id, quote_id, version_no)
) partition by list (tenant_id);

create table quote_versions_default partition of quote_versions default;

create index ix_quote_versions_tenant_quote on quote_versions (tenant_id, quote_id);

-- TARGET-ONLY STRENGTHENING (see header): at most one current version per quote. Partial, so any
-- number of superseded versions remain legal. Without this, two concurrent Revise calls can commit
-- two current versions and double-count quoted premium across every dashboard.
create unique index uq_quote_versions_current
    on quote_versions (tenant_id, quote_id)
    where is_current = true;

comment on index uq_quote_versions_current is
    'Enforces at most one current version per quote per tenant. Absent from the .NET reference, '
    'where the invariant lived only in ReviseQuoteCommandHandler and two concurrent revisions could '
    'commit two current rows — double-counting quoted premium in every dashboard that joins '
    'quote.is_current AND version.is_current. Documented target-only deviation (T-005).';

create table quote_assignments (
    tenant_id bigint not null,
    id bigint generated always as identity,
    quote_id bigint not null,
    -- The tenant's 'rm' or 'underwriter' SLOT (business_assignments), not a role directly.
    business_assignment_id bigint not null,
    user_id bigint not null,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id),
    -- One assignee per quote per slot.
    constraint uq_quote_assignments_tenant_quote_role unique (tenant_id, quote_id, business_assignment_id)
) partition by list (tenant_id);

create table quote_assignments_default partition of quote_assignments default;

create table quote_status_history (
    tenant_id bigint not null,
    id bigint generated always as identity,
    quote_id bigint not null,
    operation text not null,
    previous_status_id bigint,
    new_status_id bigint,
    acted_by bigint,
    acted_at timestamptz not null,
    -- Append-only audit payload of captured dialog inputs. NOT queried; see header.
    inputs jsonb,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table quote_status_history_default partition of quote_status_history default;

create index ix_quote_status_history_tenant_quote
    on quote_status_history (tenant_id, quote_id, acted_at);
