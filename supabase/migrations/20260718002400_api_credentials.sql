-- 20260718002400_api_credentials.sql
--
-- Owner: T-004 (M-08, P-04, spec §12.6/§13/§16, Q-19, Q-23, AC-007).
-- Source changelog: src/api/db/changelog/150-api-credentials/150-api-credentials.xml
--   changeset 150-api-credentials-table — CONVERTED BY SEMANTICS, NOT COLUMN-FOR-COLUMN. See below.
--
-- Credentials for server-to-server lead intake (POST /intake/leads), tenant- and broker-scoped.
--
-- ============================================================================================
-- APPROVED RESHAPE (Q-19): Keycloak client-credentials -> first-party hashed API keys.
-- ============================================================================================
-- The .NET row recorded a `keycloak_client_id` binding the credential to a Keycloak confidential
-- client; the secret lived in Keycloak and was re-served through a live call to its client-secret
-- endpoint. Keycloak is gone (A-4: Supabase Auth), and Supabase Auth deliberately does not provide
-- external machine-to-machine credentials, so Q-19 approves QuoteIQ issuing its own keys. The
-- BEHAVIOUR carried over intact — per-credential tenant/broker scoping, reveal-once issuance,
-- regenerate, disable, audit, and an unspoofable broker on intake — while the storage changes:
--   keycloak_client_id  ->  key_id + key_hash + key_salt (+ name, last_used_at)
--
-- ============================================================================================
-- SECURITY: THIS TABLE STORES NO PLAINTEXT KEY AND NO RETRIEVABLE SECRET. EVER.
-- ============================================================================================
-- There is deliberately NO column capable of holding a usable key, and none may be added:
--   * key_id — the PUBLIC lookup handle carried in the presented key's prefix. Not a secret; it
--     exists so verification is a single indexed point lookup instead of a scan that hashes every
--     candidate row. Safe to display in admin UI, logs and audit rows.
--   * key_hash — a salted, peppered one-way hash of the secret half of the key. NOT NULL: a row
--     with no hash could never authenticate anything, so it can only be a bug or a tampering
--     attempt, and the database refuses it outright.
--   * key_salt — the per-credential random salt. NOT NULL for the same reason. Stored per row so
--     two credentials that happen to share a secret do not share a hash, defeating precomputation
--     and cross-row correlation.
-- The PEPPER — the application-wide secret mixed in alongside the salt — is NOT in this table and
-- is NOT in this database. It lives in env configuration (a Vercel Sensitive Environment Variable,
-- A-5/Q-5) read only through the typed server-side config module. That separation is the point: a
-- full dump of this database is not sufficient to verify, let alone forge, a single key.
--
-- VERIFY-ONLY, NEVER RETRIEVE. The stored form supports exactly one operation — recomputing the
-- hash of a PRESENTED key (salt from the row, pepper from config) and comparing. The original key
-- is displayed once at issue/regenerate and is thereafter unrecoverable by anyone, including
-- Internal users and anyone holding the database. "Reveal" is therefore regenerate-and-show-once,
-- not read-back; the .NET live-call-to-Keycloak reveal path has no successor and must not grow one.
-- Comparison must be constant-time in the application layer.
--
-- NOT A VAULT SECRET (Q-19/Q-23). These are credentials we VERIFY on inbound calls, not secrets we
-- hold on someone's behalf and later decrypt. They are categorically distinct from the retrievable
-- tenant-scoped secrets designated for Supabase Vault, and Q-23 resolves that NO Vault objects are
-- created in this migration at all — no vault schema usage, no secrets table, nothing. This
-- migration touches only the public schema.
--
-- ============================================================================================
-- BROKER SCOPE AND THE DELIBERATELY ABSENT broker_id FOREIGN KEY.
-- ============================================================================================
-- broker_id is NULL for a tenant-scoped credential and set for a broker-scoped one, which the
-- intake endpoint treats as the UNSPOOFABLE broker: broker_id is taken from this row, and a payload
-- naming a different broker is rejected (422 BROKER_NOT_ALLOWED). It is never read from the request.
--
-- DECISION — no physical FK to brokers, so there is no cross-task ordering problem: the brokers
-- table arrives in T-005, AFTER this migration, but that ordering is irrelevant because the .NET
-- reference schema deliberately does NOT declare this FK either (150's own changelog comment:
-- "referencing a sibling brokers row within the same tenant partition by convention, not a physical
-- FK, the same non-FK intra-tenant reference shape as leads.broker_id"). Both tables are
-- LIST-partitioned on tenant_id and a FK from a partitioned table would have to include the
-- partition key, so the reference schema uses the same by-convention intra-tenant reference used by
-- reference_items.product_line_id and business_assignments.role_id. Mirroring that is both faithful
-- and parity-preserving. T-005 must NOT add this FK retroactively; broker validity is enforced in
-- the application layer at credential issue time. Nothing here is left dangling or deferred.
--
-- UNIQUENESS AND LOOKUP. key_id is globally unique by construction (generated with sufficient
-- entropy at issue time), but a LIST-partitioned parent cannot carry a unique index omitting the
-- partition key, so the ENFORCED constraint is (tenant_id, key_id) — exactly the compromise the
-- .NET schema made for keycloak_client_id. The plain ix_api_credentials_key_id index supports what
-- intake actually does: a cross-partition lookup of the presented key's key_id, before any tenant
-- is known (the credential is what determines the tenant).
--
-- DISABLING IS THE ONLY REMOVAL PATH (NFR-09/AC-075). Credentials are never hard-deleted, so leads
-- ingested through a retired credential stay attributable. A disabled credential fails verification
-- at intake regardless of whether the presented key is otherwise correct.
--
-- Rollback/recovery: `drop table api_credentials cascade` revokes all intake access tenant-wide and
-- is UNRECOVERABLE by re-running this migration — the hashes cannot be reconstructed, so every
-- credential must be reissued and every integrating consumer reconfigured. Restore from backup
-- instead. Note that a restore is sufficient on its own only while the pepper is unchanged: rotating
-- the pepper invalidates every stored hash and also forces a full reissue.

create table api_credentials (
    tenant_id bigint not null,
    id bigint generated always as identity,
    -- NULL = tenant-scoped credential; set = broker-scoped. By-convention reference to
    -- brokers(id) within the same tenant partition; see header for why there is no FK.
    broker_id bigint,

    -- Public lookup handle (the presented key's prefix). Not a secret.
    key_id text not null,
    -- Salted + peppered one-way hash of the secret half. The pepper is in env config, never here.
    key_hash text not null,
    -- Per-credential random salt. Not a secret on its own; useless without the pepper.
    key_salt text not null,

    -- Human-readable label shown in the admin UI ("Acme broker portal").
    name text not null,

    status text not null default 'active',

    created_at timestamptz not null,
    created_by bigint,
    -- Rotation metadata: last_rotated_at is set on regenerate, disabled_at on disable.
    last_rotated_at timestamptz,
    disabled_at timestamptz,
    -- Usage metadata for the admin UI and for spotting dormant credentials. Written on successful
    -- verification only; never part of an authorization decision.
    last_used_at timestamptz,

    primary key (tenant_id, id),
    constraint uq_api_credentials_key_id unique (tenant_id, key_id),
    constraint ck_api_credentials_status check (status in ('active', 'disabled'))
) partition by list (tenant_id);

create table api_credentials_default partition of api_credentials default;

-- Cross-partition lookup path for intake: the presented key_id resolves the credential (and hence
-- the tenant) before any tenant context exists.
create index ix_api_credentials_key_id on api_credentials (key_id);

comment on column api_credentials.key_hash is
    'Salted + peppered one-way hash of the API key secret. Verify-only: the plaintext key is shown '
    'once at issue/regenerate and is never recoverable. The pepper lives in env config, not in the '
    'database. Never add a column that can hold a usable key (Q-19, spec §16).';
