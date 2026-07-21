-- 20260719002100_quote_attachments_confirmed_at.sql
--
-- Owner: T-027 (A-7, Q-22, spec §16, AC-057).
--
-- Adds the PENDING/CONFIRMED distinction the signed-URL envelope flow requires.
--
-- ============================================================================================
-- WHY THIS COLUMN EXISTS: THE REFERENCE HAD NO PENDING STATE BECAUSE IT HAD NO ENVELOPE
-- ============================================================================================
-- The .NET upload was ONE request: bytes streamed through the API, were validated, were written to
-- object storage, and the metadata row was inserted inside that same transaction. A row therefore
-- always described an object that already existed, and a "half-uploaded" row was — as the T-005
-- migration comment says — necessarily a bug.
--
-- Under A-7 the transfer is deliberately split in two: the server issues a signed URL, the CLIENT
-- transfers the bytes directly to Storage, and a second call confirms. The row must be inserted at
-- step one, because the attachment id is a component of the object key
-- (`t{tenantId}/quotes/{quoteId}/{attachmentId}_{name}`) and the key must be known before the URL
-- can be signed. So between step one and confirm there is a legitimate, expected state the
-- reference schema could not express: a metadata row whose object does not exist yet.
--
-- Without this column that state would be INDISTINGUISHABLE from a confirmed attachment. Every
-- read path would list attachments that cannot be downloaded, and an upload that was merely
-- requested — by a caller who then uploaded nothing at all — would be reported to the user as a
-- successfully attached file. `confirmed_at is null` is what makes the pending state explicit and
-- filterable instead of a silent lie.
--
-- ============================================================================================
-- NULLABLE, NO DEFAULT, AND EXISTING ROWS ARE BACKFILLED AS CONFIRMED
-- ============================================================================================
-- NULL means "requested, not yet confirmed" — the same nullable-means-something convention as the
-- adjacent `removed_at` pair, where NULL means "present". There is deliberately no default: a
-- default of `now()` would make every newly-inserted (i.e. pending) row instantly look confirmed,
-- which is the exact failure this column exists to prevent.
--
-- The backfill sets `confirmed_at = uploaded_at` for every pre-existing row. Those rows were
-- written under the .NET single-request flow, so their objects genuinely do exist and they must not
-- vanish from the UI the moment the read paths start filtering on this column. (In practice this
-- table is empty in every current environment; the backfill is written so the migration is correct
-- against a database restored from the reference system, not merely against a fresh one.)
--
-- The read paths filter `confirmed_at is not null and removed_at is null` for the live set. The
-- partial index serves exactly that predicate for the per-quote list.
--
-- Rollback: `alter table quote_attachments drop column confirmed_at` loses the pending/confirmed
-- distinction; any pending rows still present would then appear as real attachments.

alter table quote_attachments
    add column confirmed_at timestamptz;

comment on column quote_attachments.confirmed_at is
    'NULL until the A-7 signed-URL upload is confirmed server-side (object verified: exists, within '
    'the tenant size cap, magic number agrees with the declared content type). Rows with a NULL '
    'confirmed_at are pending uploads and must never appear in a read path or be downloadable.';

-- Pre-existing rows come from the .NET single-request upload, where the object always existed.
update quote_attachments
   set confirmed_at = uploaded_at
 where confirmed_at is null;

-- Serves the per-quote live-set list (`tenant_id, quote_id` where confirmed and not removed).
create index ix_quote_attachments_tenant_quote_live
    on quote_attachments (tenant_id, quote_id)
 where confirmed_at is not null and removed_at is null;
