/**
 * Quotes: the lead-subordinate quotation core, its version discipline and its workflow operations
 * (T-026; spec FR-38..FR-40, FR-44..FR-50, P-07 quote side, P-09).
 *
 * There is deliberately no delete export, because there is no delete route: a quote is withdrawn,
 * marked lost or expired through the workflow, never removed — its versions and history are the
 * audit trail the premium reporting surfaces depend on.
 */
export {
  QUOTE_EXPIRE_OPERATION,
  QUOTE_OPERATIONS,
  QUOTE_OPERATION_MATRIX,
  QUOTE_OPERATION_PERMISSIONS,
  QUOTE_STATUS_KEYS,
  availableQuoteOperations,
  isLegalToCreateQuote,
  isQuoteOperationLegal,
  legalQuoteOperations,
  resolveFixedQuoteTarget,
  type QuoteOperation,
  type QuoteOperationName,
} from './workflow/legality.js';
export {
  executeQuoteOperation,
  quoteOperationAuditAction,
  type QuoteWorkflowActor,
  type QuoteWorkflowDeps,
} from './workflow/operations.js';
export {
  QUOTE_CREATED_ACTION,
  QUOTE_UPDATED_ACTION,
  type QuotesActor,
  type QuotesDeps,
} from './service.js';
export {
  type QuoteDto,
  type QuoteHistoryEntryDto,
  type QuoteListItemDto,
  type QuoteVersionDto,
} from './schemas.js';
/** The two repository reads the T-032 quote-expiry sweep needs; no other job touches quote rows. */
export {
  listExpiredQuoteCandidates,
  listOtherOpenQuotes,
  type ExpiryCandidateRecord,
} from './repository.js';
/** The two attachment repository operations the T-049 orphaned-upload reaper needs. */
export {
  deletePendingAttachment,
  listOrphanedAttachmentCandidates,
  type OrphanedAttachmentCandidate,
} from './attachments.repository.js';
export { QUOTE_SEQUENCE_ENTITY_TYPE, formatQuoteRef, generateQuoteRef } from './quote-ref.js';
export { quoteRoutes } from './routes.js';
export { attachmentRoutes } from './attachments.routes.js';
export {
  ATTACHMENT_REMOVED_ACTION,
  ATTACHMENT_UPLOADED_ACTION,
  type AttachmentsActor,
  type AttachmentsDeps,
} from './attachments.service.js';
export type {
  AttachmentDownloadEnvelopeDto,
  AttachmentUploadEnvelopeDto,
  QuoteAttachmentDto,
} from './attachments.schemas.js';

import { getDb } from '../../lib/db/index.js';
import { createStorageAdapter } from '../../lib/storage/index.js';
import type { AppConfig } from '../../lib/config/index.js';
import type { QuotesDeps } from './service.js';
import type { LeadChangedListener } from '../leads/workflow/operations.js';
import type { AttachmentsDeps } from './attachments.service.js';

/**
 * Production wiring for the quote endpoints.
 *
 * Mirrors `defaultLeadsDeps()`. `getDb()` returns the process-wide pool and captures no request
 * state; the tenant and the caller's effective access are supplied per request by the route
 * handlers from the verified `TenantContext` and the per-request resolver, never from here.
 */
export function defaultQuotesDeps(onLeadChanged?: LeadChangedListener): QuotesDeps {
  // See `defaultLeadsDeps`: the seam is supplied by the composition root, not resolved here.
  return onLeadChanged === undefined ? { db: getDb() } : { db: getDb(), onLeadChanged };
}

/**
 * Production wiring for the attachment endpoints (T-027).
 *
 * Takes `config` — unlike `defaultQuotesDeps` — because the `StorageAdapter` binding is selected by
 * configuration (A-6/AC-058) and the Supabase binding needs the service-role client. The typed
 * config module stays the only reader of the environment (AC-010), and `createStorageAdapter`
 * refuses the in-memory fake outside a local environment, so a misconfigured deploy fails at
 * composition rather than silently accepting uploads it would lose.
 */
export function defaultAttachmentsDeps(config: AppConfig): AttachmentsDeps {
  return { db: getDb(), storage: createStorageAdapter(config) };
}
