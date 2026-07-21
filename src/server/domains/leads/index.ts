/**
 * Leads: the tenant-scoped intake/list/detail/edit/bulk-reassign core (T-024; spec FR-29..FR-32,
 * FR-43, P-06, P-08).
 *
 * There is deliberately no delete export, because there is no delete route: a lead is withdrawn or
 * marked lost through the workflow operations (T-025), never removed — its history is the audit
 * trail the reporting surfaces depend on.
 */
export {
  DUPLICATE_EXTERNAL_REF_WARNING,
  DUPLICATE_LEAD_WARNING,
  DUPLICATE_PARTY_NAME_WARNING,
  LEAD_POLICY_TERMS,
  LEAD_PRIORITIES,
  LEAD_SORT_FIELDS,
  LEAD_SOURCES,
  NEW_STATUS_CANONICAL_KEY,
  type BulkReassignResultDto,
  type CreateLeadOutcomeDto,
  type LeadAssigneeDto,
  type LeadDto,
  type LeadDuplicateMatchDto,
  type LeadListDto,
  type LeadListItemDto,
  type LeadNoteDto,
  type LeadSortField,
  type LeadWarningDto,
  type UpdateLeadOutcomeDto,
} from './schemas.js';
/** The workflow surface the T-032 lead-inactivity sweep and the quote-expiry cascade drive. */
export {
  LEAD_EXPIRE_OPERATION,
  type LeadOperationName,
} from './workflow/legality.js';
export {
  executeLeadOperation,
  type LeadChangeEvent,
  type LeadChangedListener,
  type LeadWorkflowActor,
  type LeadWorkflowDeps,
} from './workflow/operations.js';
export { listInactivityExpiredLeadCandidates } from './repository.js';
export { derivePriority, formatLeadRef, generateLeadRef } from './lead-ref.js';
export { leadRoutes } from './routes.js';
export { leadTimelineRoutes } from './timeline.routes.js';
export {
  TIMELINE_PAGE_SIZE,
  getLeadTimeline,
  operationTitle,
  type LeadTimelineDto,
  type TimelineEntryDto,
} from './timeline.service.js';
export {
  LEAD_CREATED_ACTION,
  LEAD_REASSIGNED_ACTION,
  LEAD_UPDATED_ACTION,
  parseLeadSort,
  type LeadsActor,
  type LeadsDeps,
} from './service.js';

import { getDb } from '../../lib/db/index.js';
import type { LeadsDeps } from './service.js';
import type { LeadChangedListener } from './workflow/operations.js';

/**
 * Production wiring for the leads endpoints.
 *
 * Mirrors `defaultPartiesDeps()`. `getDb()` returns the process-wide pool and captures no request
 * state; the tenant and the caller's effective access are supplied per request by the route
 * handlers from the verified `TenantContext` and the per-request resolver, never from here.
 */
export function defaultLeadsDeps(onLeadChanged?: LeadChangedListener): LeadsDeps {
  // The seam is a PARAMETER rather than something this factory resolves itself, because building it
  // means building a queue transport — infrastructure this domain must not reach for. The
  // composition roots own that decision; see `defaultAlertReevaluationSeam`.
  return onLeadChanged === undefined ? { db: getDb() } : { db: getDb(), onLeadChanged };
}
