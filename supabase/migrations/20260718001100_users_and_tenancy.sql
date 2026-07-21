-- 20260718001100_users_and_tenancy.sql
--
-- Owner: T-003 (M-08, A-12, spec §11).
-- Source changelog: src/api/db/changelog/020-rbac/020-rbac-tables.xml
--   changesets 020-citext-extension, 021-users-table, 022-user-tenants-table.
--
-- ============================================================================================
-- DECISION: users.auth_user_id is a HARD foreign key onto auth.users(id).
-- ============================================================================================
-- The task delegated this call explicitly, so it is recorded here rather than left implicit.
--
-- What was decided: `auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE
-- RESTRICT`, replacing the legacy `keycloak_id text NOT NULL UNIQUE`.
--
-- Why a real FK rather than a validated bare uuid:
--   * It was verified to create and enforce on the local stack — the migration role (postgres)
--     holds REFERENCES on auth.users both locally and on hosted Supabase, and referencing
--     auth.users is Supabase's own documented pattern for linking application rows to identities.
--   * AC-006/V-007 require that "for each FK carried from the Liquibase source, a violating
--     INSERT raises the expected constraint error". A bare uuid + unique index cannot satisfy
--     that for the identity link; it would silently accept an auth_user_id for an identity that
--     does not exist, which is exactly the half-provisioned user AC-031 forbids.
--   * auth_user_id is the ONLY external identity link in the schema (A-12: every app entity keeps
--     a bigint PK), so this is one constraint, not a pattern that spreads across the model.
--
-- Why ON DELETE RESTRICT, not CASCADE:
--   Deleting a Supabase Auth identity must never delete the app user row. QuoteIQ deactivates
--   users and never deletes them (AC-029), and the app user id is referenced by audit and history
--   rows. RESTRICT converts an accidental auth-side delete into a loud error instead of silent
--   data loss.
--
-- Known hosted-Supabase risk, accepted:
--   A FK into the auth schema couples public-schema restores to auth-schema restore ordering and
--   can block an auth-schema operation that deletes identities. pg_dump/pg_restore order the
--   schemas by dependency, and identity deletion being blocked is the intended behaviour above.
--   DOCUMENTED FALLBACK if a hosted environment ever rejects this: drop only the FK
--   (`alter table users drop constraint users_auth_user_id_fkey`), keep NOT NULL + the unique
--   index, and move the existence check into the Auth Admin provisioning path (T-017) plus a
--   reconciliation job. No other column or index changes.
--
-- Rollback/recovery: dropping `users` cascades to every RBAC assignment table. Recover from
-- backup. Dropping only the auth FK (the fallback above) is safe and reversible.

-- citext backs users.email: the login identifier must compare and be unique case-insensitively.
-- Supabase convention places third-party extensions in `extensions`, not `public`, so the column
-- type is schema-qualified rather than relying on search_path.
create extension if not exists citext with schema extensions;

create table users (
    id bigint generated always as identity primary key,
    auth_user_id uuid not null references auth.users (id) on delete restrict,
    first_name text not null,
    last_name text not null,
    email extensions.citext not null,
    is_active boolean not null default true,
    last_tenant_id bigint,
    theme_preference text,
    created_at timestamptz not null,
    created_by bigint,
    updated_at timestamptz not null,
    updated_by bigint,
    -- Declared as UNIQUE CONSTRAINTS rather than bare unique indexes to match the reference
    -- schema exactly: the .NET model declares both as constraints, so they appear in
    -- pg_constraint and are addressable by name from application error handling.
    -- uq_users_auth_user_id replaces the legacy uq_users_keycloak_id one-for-one.
    constraint uq_users_auth_user_id unique (auth_user_id),
    constraint uq_users_email unique (email)
);

-- user_tenants is the one tenant-scoped table in the identity/RBAC set: a membership row is
-- meaningless without a tenant, so tenant_id is NOT NULL and the table follows the ordinary
-- spec §11 / A-12 convention — LIST-partitioned on tenant_id, composite (tenant_id, id) PK,
-- tenant-inclusive unique — unlike roles/groups/grants, which are nullable-tenant (global-capable)
-- and therefore stay unpartitioned.
--
-- The DEFAULT partition is the safety net required alongside every partitioned table: a write for
-- a tenant whose dedicated partition does not exist yet lands there instead of erroring.
create table user_tenants (
    tenant_id bigint not null,
    id bigint generated always as identity,
    user_id bigint not null references users (id),
    created_at timestamptz not null,
    created_by bigint,
    primary key (tenant_id, id),
    constraint uq_user_tenants_user_tenant unique (user_id, tenant_id)
) partition by list (tenant_id);

create table user_tenants_default partition of user_tenants default;
