import { apiDelete, apiGet, apiPost, apiPut, navigateToSignedUrl, putFileToSignedUrl } from '../../api/client';

/**
 * Quotes/attachments backend contract (`src/api/QuoteIQ.Api/Endpoints/{QuoteEndpoints,AttachmentEndpoints}.cs`,
 * `src/api/QuoteIQ.Application/Features/Quotes/*`, T-020/T-021, spec FR-38..FR-40/FR-45..FR-50).
 * Fetch-wrapper module, matching the established convention (`leadsApi.ts`/`settingsApi.ts`) rather
 * than RTK Query.
 *
 * DEVIATION FLAGGED (T-029 brief said "quotesApi RTK Query module"): this codebase has no RTK Query
 * store configured anywhere (`app/store.ts` is a plain `configureStore` with hand-rolled slices) —
 * every existing feature (leadsApi, settingsApi, tenantsApi, usersApi) uses this same fetch-wrapper
 * pattern instead, exactly as `leadsApi.ts`'s own header comment and `settingsApi.ts`'s own header
 * comment already documented for their own tasks' identical briefs. Introducing RTK Query for this
 * task alone would be a new, unapproved data-fetching framework mid-codebase (CLAUDE.md: "Do not
 * introduce new frameworks or tools without approval"), so this module matches the established
 * convention rather than the brief's wording. The attachment upload/download now follow the A-7
 * signed-URL envelope (T-027/T-028): the request-upload/confirm/download-envelope calls go through
 * the shared `api/client.ts` layer (so bearer-token attachment, `X-Tenant-Id` injection, and 401
 * handling stay in one place), while the raw byte transfer goes DIRECTLY to storage via
 * `putFileToSignedUrl` (bypassing `/api/v1` and the Vercel body cap, with no app token attached).
 */

// ---------------------------------------------------------------------------
// Quote CRUD (T-020: POST/GET /leads/{id}/quotes, GET/PUT /quotes/{id})
// ---------------------------------------------------------------------------

/** Wire shape of `QuoteVersionDto` (`src/api/.../Features/Quotes/QuoteDto.cs`, spec FR-46/FR-49/FR-50). */
export interface QuoteVersionDto {
  id: number;
  versionNo: number;
  quotedPremium: number;
  termsNotes: string | null;
  revisionNote: string | null;
  isCurrent: boolean;
  createdAt: string;
}

/** Wire shape of `QuoteHistoryEntryDto` (`src/api/.../Features/Quotes/QuoteDto.cs`, spec FR-38).
 *
 * Flagged gap (mirrors T-028's LeadDto outcome-projection gap, F-001): this DTO carries only the
 * numeric `newStatusId`/`previousStatusId`/`actedBy`, never a resolved status *name* or actor
 * *name*. `QuoteDetailPanel`'s status-history list therefore resolves status ids against the
 * `quote_status` reference list (already fetched for other purposes on Lead Detail) and falls back
 * to `"User #{id}"` for the actor — there is no endpoint exposed to an ordinary Quotes user that
 * resolves an arbitrary user id to a display name (`GET /users/{id}` is a Users-admin-gated route).
 * Recommended follow-up: project `newStatusName`/`previousStatusName`/`actedByName` directly on this
 * DTO (mirrors `QuoteListItemDto.StatusName`already doing the same server-side resolution).
 */
export interface QuoteHistoryEntryDto {
  operation: string;
  previousStatusId: number | null;
  newStatusId: number | null;
  actedBy: number | null;
  actedAt: string;
}

/** Wire shape of the full `QuoteDto` (`src/api/.../Features/Quotes/QuoteDto.cs`, spec FR-38/FR-45..FR-50). */
export interface QuoteDetailDto {
  id: number;
  quoteRef: string;
  leadId: number;
  statusId: number;
  statusName: string;
  statusCanonicalKey: string | null;
  isCurrent: boolean;
  productLineId: number;
  productLineName: string;
  coverTypeId: number;
  coverTypeName: string;
  preparedDate: string;
  sentDate: string | null;
  validUntil: string | null;
  decisionDate: string | null;
  boundPremium: number | null;
  lostReasonId: number | null;
  competitor: string | null;
  competitorPremium: number | null;
  lossComments: string | null;
  withdrawalNote: string | null;
  notes: string | null;
  versions: QuoteVersionDto[];
  history: QuoteHistoryEntryDto[];
  availableOperations: string[];
}

/** Wire shape of `QuoteListItemDto` (`src/api/.../Features/Quotes/QuoteDto.cs`, spec FR-44).
 *
 * Flagged gap: FR-44/this task's brief list "Version" among the Quotes-card columns, but this list
 * projection (unlike the full `QuoteDetailDto`) carries no version number or count — only the
 * *current* version's premium (`currentQuotedPremium`). There is no cheap way to show a per-row
 * version number without an N+1 `GET /quotes/{id}` fetch per collapsed row (which would defeat the
 * point of a lightweight list endpoint). `QuotesCard`'s Version column therefore shows the version
 * number only once a row is expanded (`QuoteDetailDto.versions`, via the current version's
 * `versionNo`) and renders "—" while collapsed. Recommended follow-up: project a `currentVersionNo`
 * (or `versionCount`) field on `QuoteListItemDto`.
 */
export interface QuoteListItemDto {
  id: number;
  quoteRef: string;
  statusName: string;
  statusCanonicalKey: string | null;
  isCurrent: boolean;
  productLineName: string;
  currentQuotedPremium: number;
  preparedDate: string;
  sentDate: string | null;
  validUntil: string | null;
}

export function listQuotesForLead(leadId: number): Promise<QuoteListItemDto[]> {
  return apiGet<QuoteListItemDto[]>(`/leads/${leadId}/quotes`);
}

export function getQuote(id: number): Promise<QuoteDetailDto> {
  return apiGet<QuoteDetailDto>(`/quotes/${id}`);
}

/** `POST /leads/{id}/quotes` (`CreateQuoteCommand`/`CreateQuoteRequest`, spec FR-46). */
export interface CreateQuotePayload {
  productLineId: number | null;
  coverTypeId: number | null;
  quotedPremium: number;
  preparedDate: string | null;
  validUntil: string | null;
  notes: string | null;
}

export function createQuote(leadId: number, payload: CreateQuotePayload): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/leads/${leadId}/quotes`, payload);
}

/** `PUT /quotes/{id}` (`UpdateDraftQuoteCommand`/`UpdateDraftQuoteRequest` — Draft-only direct edit, spec FR-49). */
export interface UpdateDraftQuotePayload {
  productLineId: number;
  coverTypeId: number;
  quotedPremium: number;
  preparedDate: string;
  validUntil: string | null;
  notes: string | null;
}

export function updateDraftQuote(id: number, payload: UpdateDraftQuotePayload): Promise<QuoteDetailDto> {
  return apiPut<QuoteDetailDto>(`/quotes/${id}`, payload);
}

// ---------------------------------------------------------------------------
// Quote workflow operations (T-020: POST /quotes/{id}/operations/{op}, POST /quotes/{id}/set-current)
// ---------------------------------------------------------------------------

/** The seven quote workflow operation wire codes (`QuoteOperationCodes.ToCodeValue`, `src/api/.../QuoteIQ.Domain/Workflow/QuoteOperation.cs`, T-020); `expire_automatic` (system-actor-only) is deliberately absent — `QuoteDto.AvailableOperations` never surfaces it either. */
export const QUOTE_OPERATION_CODES = {
  Assign: 'assign',
  Send: 'send',
  Revise: 'revise',
  MarkWon: 'mark-won',
  MarkLost: 'mark-lost',
  Withdraw: 'withdraw',
  SetCurrent: 'set-current',
} as const;

export type QuoteOperationCode = (typeof QUOTE_OPERATION_CODES)[keyof typeof QUOTE_OPERATION_CODES];

export interface QuoteAssignmentPayload {
  businessAssignmentId: number;
  userId: number | null;
}

/** `POST /quotes/{id}/operations/assign` (`AssignQuoteCommand`/`AssignQuoteRequest`, spec FR-35/FR-38). */
export function assignQuote(quoteId: number, assignments: QuoteAssignmentPayload[], comment: string | null): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/quotes/${quoteId}/operations/assign`, { assignments, comment });
}

/** `POST /quotes/{id}/operations/send` (`SendQuoteCommand`/`SendQuoteRequest` — valid-until and next follow-up both required, spec FR-46). */
export function sendQuote(quoteId: number, sentDate: string | null, validUntil: string, nextFollowUpDate: string): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/quotes/${quoteId}/operations/send`, { sentDate, validUntil, nextFollowUpDate });
}

/** `POST /quotes/{id}/operations/revise` (`ReviseQuoteCommand`/`ReviseQuoteRequest` — new version, spec FR-49/FR-50). */
export function reviseQuote(
  quoteId: number,
  newQuotedPremium: number | null,
  termsNotes: string | null,
  revisionNote: string,
): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/quotes/${quoteId}/operations/revise`, { newQuotedPremium, termsNotes, revisionNote });
}

/** `POST /quotes/{id}/operations/mark-won` (`MarkQuoteWonCommand`/`MarkQuoteWonRequest` — the ONLY path to Closed Won, spec FR-39). */
export function markQuoteWon(quoteId: number, boundPremium: number | null, decisionDate: string | null): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/quotes/${quoteId}/operations/mark-won`, { boundPremium, decisionDate });
}

/** `POST /quotes/{id}/operations/mark-lost` (`MarkQuoteLostCommand`/`MarkQuoteLostRequest`, spec FR-38/FR-40). */
export function markQuoteLost(
  quoteId: number,
  lostReasonId: number,
  competitor: string | null,
  competitorPremium: number | null,
  lossComments: string | null,
  alsoCloseLead: boolean | null,
): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/quotes/${quoteId}/operations/mark-lost`, {
    lostReasonId,
    competitor,
    competitorPremium,
    lossComments,
    alsoCloseLead,
  });
}

/** `POST /quotes/{id}/operations/withdraw` (`WithdrawQuoteCommand`/`WithdrawQuoteRequest` — note required, lead never changed, spec FR-38/FR-40). */
export function withdrawQuote(quoteId: number, withdrawalNote: string): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/quotes/${quoteId}/operations/withdraw`, { withdrawalNote });
}

/** `POST /quotes/{id}/set-current` (`SetCurrentQuoteCommand`, PRD 7.3 multi-option marker; no request body). */
export function setCurrentQuote(quoteId: number): Promise<QuoteDetailDto> {
  return apiPost<QuoteDetailDto>(`/quotes/${quoteId}/set-current`);
}

// ---------------------------------------------------------------------------
// Attachments (T-021: POST /quotes/{id}/attachments, GET/DELETE /attachments/{id})
// ---------------------------------------------------------------------------

/** Wire shape of `QuoteAttachmentDto` (`src/api/.../Features/Quotes/Attachments/QuoteAttachmentDto.cs`, spec FR-48). */
export interface QuoteAttachmentDto {
  id: number;
  quoteId: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: number | null;
}

/** Allow-listed extensions (`FileSignatureValidator`'s `AllowedExtensionsByContentType` keys, `src/api/.../Features/Quotes/Attachments/FileSignatureValidator.cs`, spec FR-48) for the file-input's `accept` attribute and inline client-side pre-check. The server remains authoritative (extension + declared content type + magic-number bytes, AC-077) — this is UX-only, never trusted alone. */
export const ALLOWED_ATTACHMENT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.pdf', '.doc', '.docx'] as const;

/** Extension -> declared content type this client sends on upload, mirroring `FileSignatureValidator`'s allow-list exactly (spec FR-48). */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Lower-cased, leading-dot extension of a file name (matches `Path.GetExtension(...).ToLowerInvariant()`'s server-side normalization). */
export function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex === -1 ? '' : fileName.slice(dotIndex).toLowerCase();
}

/** True when `fileName`'s extension is one of the five allow-listed types (client-side UX pre-check only; the server re-validates extension + content type + magic-number bytes authoritatively). */
export function isAllowedAttachmentFile(fileName: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPE_BY_EXTENSION, fileExtension(fileName));
}

// --- Signed-URL envelope wire DTOs (A-7/M-25, T-027 `attachments.schemas.ts`) ----------------

/** Body of `POST /quotes/{id}/attachments` — the request-upload envelope (T-027 `requestAttachmentUploadSchema`). */
export interface RequestAttachmentUploadPayload {
  fileName: string;
  /** Declared type used for the cheap pre-signing check; the server re-observes it at confirm. */
  contentType: string;
  /** A client hint; the persisted `sizeBytes` is what the server observes at confirm. */
  declaredSizeBytes: number;
}

/** Response of the request-upload envelope (T-027 `AttachmentUploadEnvelopeDto`); `202 Accepted`. */
export interface AttachmentUploadEnvelopeDto {
  attachmentId: number;
  quoteId: number;
  fileName: string;
  contentType: string;
  /** Fully-qualified signed URL to PUT the bytes to; the token is embedded (T-027 `supabase-adapter`). */
  uploadUrl: string;
  uploadToken: string;
  expiresInSeconds: number;
}

/** Response of `GET /attachments/{id}` (T-027 `AttachmentDownloadEnvelopeDto`) — a short-lived signed URL with attachment disposition. */
export interface AttachmentDownloadEnvelopeDto {
  attachmentId: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  downloadUrl: string;
  expiresInSeconds: number;
}

/** `POST /quotes/{id}/attachments` — authorize + validate (type/size) and mint a signed upload URL (T-027). */
export function requestAttachmentUpload(
  quoteId: number,
  payload: RequestAttachmentUploadPayload,
): Promise<AttachmentUploadEnvelopeDto> {
  return apiPost<AttachmentUploadEnvelopeDto>(`/quotes/${quoteId}/attachments`, payload);
}

/** `POST /attachments/{id}/confirm` — the server verifies the object (size + magic number, R-8) and records it (T-027); `201`. */
export function confirmAttachmentUpload(attachmentId: number): Promise<QuoteAttachmentDto> {
  return apiPost<QuoteAttachmentDto>(`/attachments/${attachmentId}/confirm`);
}

/** `GET /attachments/{id}` — a short-lived signed download URL (T-027). */
export function getAttachmentDownloadEnvelope(attachmentId: number): Promise<AttachmentDownloadEnvelopeDto> {
  return apiGet<AttachmentDownloadEnvelopeDto>(`/attachments/${attachmentId}`);
}

/**
 * Uploads a quote attachment over the A-7 signed-URL envelope (T-027/T-028): request-upload ->
 * direct PUT of the bytes to the returned signed URL (bypassing the Vercel body cap) -> confirm.
 *
 * The declared content type sent on request-upload — and stamped onto the bytes PUT to storage — is
 * derived from the file's extension (mirroring `FileSignatureValidator`'s allow-list) rather than
 * trusting `File.type` verbatim, since browsers do not always populate `File.type` for every
 * allow-listed extension (notably `.doc`). The server's own magic-number check at confirm is
 * authoritative regardless, and rejects (`ATTACHMENT_SIGNATURE_MISMATCH`, 422) after deleting the
 * object — which is why this rejection must propagate to the caller rather than be swallowed.
 */
export async function uploadAttachment(
  quoteId: number,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<QuoteAttachmentDto> {
  const extension = fileExtension(file.name);
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension] ?? file.type;

  const envelope = await requestAttachmentUpload(quoteId, {
    fileName: file.name,
    contentType,
    declaredSizeBytes: file.size,
  });

  const typedFile = contentType !== file.type ? new File([file], file.name, { type: contentType }) : file;
  // Straight to the URL the SERVER signed — never a hardcoded host, never with the app token.
  await putFileToSignedUrl(envelope.uploadUrl, typedFile, onProgress);

  return confirmAttachmentUpload(envelope.attachmentId);
}

/**
 * Downloads a quote attachment (T-027/T-028): fetch the signed download envelope, then follow the
 * URL, which carries `Content-Disposition: attachment`. An error (e.g. an expired/removed
 * attachment) rejects before any navigation happens.
 */
export async function downloadAttachment(attachmentId: number): Promise<void> {
  const envelope = await getAttachmentDownloadEnvelope(attachmentId);
  navigateToSignedUrl(envelope.downloadUrl);
}

/** `DELETE /attachments/{id}` (soft-delete, T-021/T-027 — unchanged by the envelope migration). */
export function removeAttachment(id: number): Promise<void> {
  return apiDelete<void>(`/attachments/${id}`);
}
