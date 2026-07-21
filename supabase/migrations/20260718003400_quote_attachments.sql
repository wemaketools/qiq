-- 20260718003400_quote_attachments.sql
--
-- Owner: T-005 (M-08, A-6, A-12, spec §11.3/§16, AC-004/AC-005).
-- Source changelog: src/api/db/changelog/120-attachments/120-quote-attachments.xml
--   changeset 120-quote-attachments-table.
--
-- METADATA ONLY. The bytes are NOT here and must never be.
--
-- ============================================================================================
-- storage_key IS THE TENANT-PREFIXED SUPABASE STORAGE OBJECT KEY (A-6).
-- ============================================================================================
-- Attachment bytes live in a PRIVATE Supabase Storage bucket behind the StorageAdapter port; this
-- table holds only the metadata plus the key that locates the object. The key is tenant-prefixed,
-- which is what keeps one tenant's objects in a namespace another tenant's key can never address —
-- the storage-side half of the tenant isolation this schema enforces relationally.
--
-- There is deliberately NO bytea/blob column and none may be added. Postgres is not the blob store
-- (A-6), and a row here is worthless to an attacker holding only the database: the key names an
-- object in a private bucket that requires a separately-authorized signed URL to read. Access is
-- the signed-URL envelope flow (A-7): request → server authorizes and validates → signed URL →
-- direct-to-storage transfer → confirm. Never serve bytes through the API layer.
--
-- storage_key is NOT NULL because a row without one cannot name an object, so it could only ever be
-- a bug or a partially-written upload. content_type and size_bytes are likewise NOT NULL: both are
-- validated at upload against the tenant's max-attachment-MB setting and allowed types, and both are
-- shown in the UI before download. They are recorded as the SERVER observed them, not as the client
-- claimed — client-supplied values are hostile input (CLAUDE.md).
--
-- ============================================================================================
-- SOFT REMOVE ONLY (NFR-09). removed_at / removed_by IS THE ONLY DELETE PATH.
-- ============================================================================================
-- Business records are never hard-deleted, so a removed attachment stays attributable: who removed
-- it and when remain answerable, and a quote's document history is not silently rewritten. Callers
-- filter `removed_at is null` for the live set. Note the pair is nullable BY DESIGN — NULL means
-- "present" — so there is no default and no check tying the two columns together, exactly as in the
-- reference schema. Removing the storage object itself is a separate lifecycle concern; this row
-- survives it so the audit trail does.
--
-- Partitioned LIST(tenant_id) per A-12, verified against the live .NET reference database. Picked up
-- automatically by T-003's catalog-driven create_tenant_partitions.
--
-- Rollback/recovery: `drop table quote_attachments cascade` ORPHANS EVERY STORED OBJECT — the bytes
-- survive in the bucket but nothing records what they are, which quote they belong to, or that they
-- exist. That is unrecoverable by re-running this migration. Restore from backup.

create table quote_attachments (
    tenant_id bigint not null,
    id bigint generated always as identity,
    -- By-convention reference to a sibling quotes row in the same tenant partition.
    quote_id bigint not null,
    file_name text not null,
    -- Server-observed, not client-claimed.
    content_type text not null,
    size_bytes bigint not null,
    -- Tenant-prefixed object key in the private Supabase Storage bucket (A-6). Never the bytes.
    storage_key text not null,
    uploaded_at timestamptz not null,
    uploaded_by bigint,
    -- Soft-remove pair; NULL means present. The only delete path (NFR-09).
    removed_at timestamptz,
    removed_by bigint,
    primary key (tenant_id, id)
) partition by list (tenant_id);

create table quote_attachments_default partition of quote_attachments default;

create index ix_quote_attachments_tenant_quote on quote_attachments (tenant_id, quote_id);

comment on column quote_attachments.storage_key is
    'Tenant-prefixed object key in the private Supabase Storage bucket (A-6). Attachment BYTES live '
    'in Storage and are served only through the signed-URL envelope flow (A-7) — never add a bytea '
    'column to this table.';
