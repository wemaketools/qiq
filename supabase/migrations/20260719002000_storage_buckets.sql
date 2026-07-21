-- 20260719002000_storage_buckets.sql
--
-- Owner: T-027 (A-6, A-7, Q-6, Q-22, spec §16, AC-056, AC-058).
--
-- Provisions the PRIVATE attachment bucket that `SupabaseStorageAdapter` writes through.
--
-- ============================================================================================
-- WHY A MIGRATION RATHER THAN config.toml's [storage.buckets.*]
-- ============================================================================================
-- `config.toml` buckets are a LOCAL-ONLY convenience: the Supabase CLI creates them on
-- `supabase start`/`db reset` and they do not exist in a hosted project. The bucket is not a dev
-- affordance — it is production infrastructure that the attachment endpoints fail without — so it is
-- provisioned the same way every other schema object is, and one `supabase db push` brings a hosted
-- environment to the same state as a local reset. Idempotent, so re-running is safe.
--
-- ============================================================================================
-- public = false, AND NO RLS POLICY IS CREATED. BOTH HALVES MATTER.
-- ============================================================================================
-- `public = false` stops unauthenticated URL-guessing against the object path. The absence of any
-- policy on `storage.objects` is what stops an AUTHENTICATED caller holding the anon key from
-- reading the bucket with their own Supabase client: `storage.objects` has RLS enabled by default in
-- Supabase, so with zero policies both `anon` and `authenticated` are denied everything. Adding a
-- permissive policy here would silently hand every signed-in user of the project every tenant's
-- attachments, because Storage has no tenant concept — tenant separation lives entirely in the
-- key prefix (`t{tenantId}/...`) and in the server-side authorization that precedes signing.
--
-- The only two ways to reach an object are therefore (1) the service-role client inside
-- `SupabaseStorageAdapter`, and (2) a short-lived signed URL that adapter minted after the domain
-- layer authorized the caller. `attachments.test.ts` asserts the anon key cannot read the bucket.
--
-- ============================================================================================
-- STORAGE-LEVEL MIME AND SIZE BACKSTOPS ARE DEFENCE IN DEPTH, NOT THE PRIMARY CHECK
-- ============================================================================================
-- The authoritative checks are server-side in `attachments.service.ts` (allow-list + extension
-- before signing; server-observed size + magic number at confirm). These bucket-level limits catch
-- the case those cannot: a caller who holds a validly-issued signed upload URL and then uploads
-- something other than what they declared. Storage rejects the write outright.
--
-- allowed_mime_types is exactly the five types of spec FR-48 (PNG/JPEG/PDF/DOC/DOCX). Keep it in
-- sync with `ALLOWED_ATTACHMENT_CONTENT_TYPES` in src/server/domains/quotes/attachment-content.ts;
-- attachments.test.ts asserts the two agree, so a drift fails a test rather than silently
-- rejecting valid uploads at the storage layer.
--
-- file_size_limit is 25 MiB: a coarse ceiling above the 10 MB default per-tenant cap (Q-22),
-- chosen to match the reference's own documented ceiling (`AttachmentEndpoints.cs`
-- MaxSupportedTenantCapMb = 20 MB plus its 25% multipart headroom). `max_attachment_mb` has no
-- enforced upper bound in the business-rules validator, so A TENANT CAP ABOVE 25 MB WOULD BE
-- SILENTLY UNUSABLE — uploads would pass the server's per-tenant check and then be refused by
-- Storage. Raise this limit in lockstep if such a cap is ever permitted. Flagged, not assumed away.
--
-- Rollback: `delete from storage.buckets where id = 'quote-attachments'` FAILS while objects exist
-- (and orphans metadata rows if forced). Empty the bucket first; the `quote_attachments` rows that
-- name those objects are separate and survive.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'quote-attachments',
    'quote-attachments',
    false,
    26214400,
    array[
        'image/png',
        'image/jpeg',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
)
on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
