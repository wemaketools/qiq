-- 20260718003100_brokers.sql
--
-- Owner: T-005 (M-08, A-12, spec §11.3, N-04, AC-004/AC-005).
-- Source changelog: src/api/db/changelog/070-brokers/070-brokers.xml
--   changesets 070-brokers-table, 071-broker-contacts-table,
--   072-broker-contacts-primary-unique-index (the F-043 hardening).
--
-- Distribution partners and their contact people. leads.broker_id references a brokers row within
-- the same tenant partition; api_credentials.broker_id scopes an intake credential to one broker.
--
-- ============================================================================================
-- NO FOREIGN KEY IS ADDED TO api_credentials.broker_id BY THIS MIGRATION. THIS IS DELIBERATE.
-- ============================================================================================
-- T-005's task file carries a stale line about "adding FKs deferred from T-004, e.g.
-- api_credentials.broker_id". There is nothing deferred: T-004 established, and the 150 changelog
-- states outright, that the .NET reference schema has NO physical FK there — it is an intra-tenant
-- reference by convention, exactly like leads.broker_id below and reference_items.product_line_id.
-- Both tables are LIST-partitioned on tenant_id, so a real FK would have to include the partition
-- key and would not express the intended constraint anyway. Adding one now would be a silent
-- divergence from the reference schema that the parity suite would (correctly) flag. Broker validity
-- for a credential is enforced in the application layer at issue time.
--
-- DISABLING IS THE ONLY REMOVAL PATH (NFR-09, AC-075). Brokers are never hard-deleted, so historical
-- leads and quotes pointing at a retired broker stay resolvable and keep reporting correct; disabled
-- brokers are simply filtered out of active-broker pickers (FR-24, AC-023). ck_brokers_status makes
-- 'active'|'disabled' the only reachable states, so no caller can invent a third one.
--
-- broker_type_id is a by-convention reference to a tenant-scoped reference_items row (list_type
-- 'broker_type'), not a physical FK — same reasoning as above.
--
-- ============================================================================================
-- EXACTLY-ONE-PRIMARY-CONTACT IS A DATABASE GUARANTEE, NOT AN APPLICATION CONVENTION.
-- ============================================================================================
-- uq_broker_contacts_primary is the reference schema's own F-043 hardening, carried over verbatim.
-- Before it existed the invariant lived only in the command handlers, so two concurrent
-- AddContact(isPrimary=true) / SetPrimary requests against the same broker could interleave and
-- commit two primary contacts. The partial unique index makes that outcome unreachable: at most one
-- row per (tenant_id, broker_id) may have is_primary = true, and a second one raises 23505.
--
-- Note the index is partial (WHERE is_primary = true) rather than a plain unique constraint, which
-- is what allows ANY NUMBER of non-primary contacts per broker while admitting at most one primary.
-- A non-partial unique on (tenant_id, broker_id) would wrongly limit each broker to one contact
-- full stop. The partitioning works out because tenant_id — the partition key — is one of the
-- indexed columns, which is precisely the condition Postgres requires for a unique index on a
-- partitioned parent; it is then attached automatically to every existing and future partition.
--
-- broker_id references a sibling brokers row within the same tenant partition by convention (no
-- physical FK, same reason as everywhere else in this schema); the contact command handlers load
-- the parent broker through the tenant-scoped store before mutating its contacts.
--
-- Partitioned LIST(tenant_id) per A-12, both tables verified against the live .NET reference
-- database. Picked up automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table brokers cascade` leaves every lead/quote broker reference dangling
-- and destroys the contact rows with it. Restore from backup; re-running this migration only
-- recreates empty tables.

create table brokers (
    tenant_id bigint not null,
    id bigint generated always as identity,
    name text not null,
    -- By-convention reference to reference_items (list_type 'broker_type'); see header.
    broker_type_id bigint,
    branch text,
    status text not null default 'active',
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id),
    constraint uq_brokers_tenant_name unique (tenant_id, name),
    -- Disable, never delete: these two states are the whole lifecycle (NFR-09, AC-075).
    constraint ck_brokers_status check (status in ('active', 'disabled'))
) partition by list (tenant_id);

create table brokers_default partition of brokers default;

create table broker_contacts (
    tenant_id bigint not null,
    id bigint generated always as identity,
    -- By-convention reference to a sibling brokers row in the same tenant partition.
    broker_id bigint not null,
    name text not null,
    email text,
    phone text,
    is_primary boolean not null default false,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table broker_contacts_default partition of broker_contacts default;

create index ix_broker_contacts_tenant_broker on broker_contacts (tenant_id, broker_id);

-- At most ONE primary contact per broker per tenant. Partial, so unlimited non-primary contacts
-- remain legal. See header for why this is a DB constraint and not handler logic.
create unique index uq_broker_contacts_primary
    on broker_contacts (tenant_id, broker_id)
    where is_primary = true;

comment on index uq_broker_contacts_primary is
    'Enforces at most one primary contact per broker per tenant (FR-24, AC-023). Partial on '
    'is_primary = true so any number of non-primary contacts remain allowed. Replaces a '
    'handler-only invariant that two concurrent SetPrimary calls could violate.';
