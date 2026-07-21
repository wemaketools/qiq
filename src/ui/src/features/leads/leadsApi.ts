import { apiGet, apiPost, apiPut } from '../../api/client';
import { fetchBusinessAssignments, fetchFullBusinessRules, type EligibleAssigneeApiDto } from '../settings/settingsApi';

/**
 * Leads list/bulk-reassign backend contract (src/api/QuoteIQ.Api/Endpoints/LeadEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Leads/{ListLeads,BulkReassign}/*, T-018, spec FR-43).
 * Fetch-wrapper module, matching the established convention (`tenantsApi.ts`/`usersApi.ts`/
 * `settingsApi.ts`) rather than RTK Query — this codebase has no RTK Query store configured
 * anywhere (`app/store.ts` is a plain `configureStore`), so introducing it for this task alone
 * would be a new, unapproved data-fetching framework (CLAUDE.md: "Do not introduce new frameworks
 * or tools without approval").
 */

/** Wire shape of `LeadAssigneeDto` (`src/api/.../Features/Leads/LeadDto.cs`). */
export interface LeadAssigneeDto {
  userId: number;
  firstName: string;
  lastName: string;
}

/** Wire shape of `LeadListItemDto` (`src/api/.../Features/Leads/LeadDto.cs`, spec FR-43). */
export interface LeadListItemDto {
  id: number;
  leadRef: string;
  partyId: number;
  partyName: string;
  brokerId: number | null;
  brokerName: string | null;
  productLineName: string;
  coverTypeName: string;
  /** Estimated premium until a quote exists, current quoted premium thereafter (server-resolved, spec FR-43). */
  premium: number | null;
  statusName: string;
  priority: string;
  dateReceived: string;
  ageDays: number;
  owner: LeadAssigneeDto | null;
  nextFollowUpDate: string | null;
  /** Escalated/SLA/Expiring/High value (spec FR-43); populated once T-019/T-021's alert evaluation lands — empty today. */
  flags: string[];
}

/** Wire shape of `LeadListDto` (`src/api/.../Features/Leads/LeadDto.cs`). */
export interface LeadListDto {
  items: LeadListItemDto[];
  totalCount: number;
  page: number;
  pageSize: number;
}

/**
 * Sortable Leads-list columns and the backend sort key each maps to (spec FR-43/PRD 12.4,
 * `LeadStore.ListAsync`, `src/api/.../QuoteIQ.Infrastructure/Leads/LeadStore.cs`). The backend takes
 * each key bare for ascending or `-`-prefixed for descending.
 *
 * Flags is the one grid column absent here: `LeadListItemDto.flags` is derived per row rather than
 * stored, so there is no column for the server to order by — its header stays a plain, non-sortable
 * `<th>` rather than getting an invented sort key.
 */
export const LEADS_SORT_KEYS = {
  leadRef: 'lead_ref',
  party: 'party',
  broker: 'broker',
  product: 'product',
  premium: 'premium',
  status: 'status',
  age: 'date_received',
  owner: 'owner',
  nextFollowUp: 'next_follow_up',
} as const;

export type LeadsSortField = keyof typeof LEADS_SORT_KEYS;
export type LeadsSortDirection = 'asc' | 'desc';

export interface LeadsSortState {
  field: LeadsSortField;
  direction: LeadsSortDirection;
}

/** PRD 12.4 / backend default: lowest Age first, i.e. newest-received first. */
export const DEFAULT_LEADS_SORT: LeadsSortState = { field: 'age', direction: 'asc' };

/**
 * Translates UI sort state into the backend's `sort` query value.
 *
 * Age is the one column whose direction flips on the way out: it counts *up* as `date_received`
 * recedes, so the ascending Age the user asked for (youngest lead first) is descending
 * `date_received` server-side. Every other column sorts in the direction it reads.
 */
export function buildLeadsSortParam(sort: LeadsSortState | null | undefined): string | undefined {
  if (!sort) {
    return undefined;
  }
  const key = LEADS_SORT_KEYS[sort.field];
  const descending = sort.field === 'age' ? sort.direction === 'asc' : sort.direction === 'desc';
  return descending ? `-${key}` : key;
}

export interface ListLeadsParams {
  statusIds?: number[];
  ownerUserId?: number | null;
  brokerId?: number | null;
  productLineId?: number | null;
  regionId?: number | null;
  requestChannelId?: number | null;
  dateReceivedFrom?: string | null;
  dateReceivedTo?: string | null;
  myLeads?: boolean;
  search?: string | null;
  sort?: string | null;
  page?: number;
  pageSize?: number;
}

export const LEADS_PAGE_SIZE = 25;

function buildListLeadsQuery(params: ListLeadsParams): string {
  const searchParams = new URLSearchParams();
  if (params.statusIds && params.statusIds.length > 0) {
    searchParams.set('status', params.statusIds.join(','));
  }
  if (params.ownerUserId != null) {
    searchParams.set('ownerUserId', String(params.ownerUserId));
  }
  if (params.brokerId != null) {
    searchParams.set('brokerId', String(params.brokerId));
  }
  if (params.productLineId != null) {
    searchParams.set('productLineId', String(params.productLineId));
  }
  if (params.regionId != null) {
    searchParams.set('regionId', String(params.regionId));
  }
  if (params.requestChannelId != null) {
    searchParams.set('requestChannelId', String(params.requestChannelId));
  }
  if (params.dateReceivedFrom) {
    searchParams.set('dateReceivedFrom', params.dateReceivedFrom);
  }
  if (params.dateReceivedTo) {
    searchParams.set('dateReceivedTo', params.dateReceivedTo);
  }
  if (params.myLeads) {
    searchParams.set('myLeads', 'true');
  }
  if (params.search) {
    searchParams.set('search', params.search);
  }
  if (params.sort) {
    searchParams.set('sort', params.sort);
  }
  searchParams.set('page', String(params.page ?? 1));
  searchParams.set('pageSize', String(params.pageSize ?? LEADS_PAGE_SIZE));
  return searchParams.toString();
}

export function listLeads(params: ListLeadsParams): Promise<LeadListDto> {
  return apiGet<LeadListDto>(`/leads?${buildListLeadsQuery(params)}`);
}

export interface BulkReassignPayload {
  leadIds: number[];
  newOwnerUserId: number;
  note: string;
}

/** Wire shape of `BulkReassignResultDto` (`src/api/.../Features/Leads/BulkReassign/BulkReassignCommand.cs`). */
export interface BulkReassignResultDto {
  reassignedCount: number;
}

export function bulkReassignLeads(payload: BulkReassignPayload): Promise<BulkReassignResultDto> {
  return apiPost<BulkReassignResultDto>('/leads/bulk-reassign', payload);
}

/** Wire shape of `EligibleAssigneeDto` (`src/api/.../Features/BusinessAssignments/EligibleAssigneeDto.cs`). */
export interface EligibleLeadOwnerDto {
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * Active tenant users eligible to hold the lead accountable-owner role (spec FR-43, PRD 10.4),
 * used by both the Leads list Owner filter and `BulkReassignDialog`'s owner picker.
 *
 * The gap T-027 flagged here was resolved on 2026-07-13 (T-044) with the option its report
 * recommended: `GET /settings/business-assignments` is now a membership-only read (matching the
 * already-ungated eligible-users lookup), so every leads user can resolve the accountable-owner
 * assignment id. The `null` degrade path is kept purely as transient-failure protection, so
 * callers hide/disable the owner picker instead of crashing the page.
 */
// ---------------------------------------------------------------------------
// Intake / edit (T-018 CreateLead/UpdateLead/GetLead, T-026 lead intake and edit UI, spec FR-29..FR-32)
// ---------------------------------------------------------------------------

/** Wire shape of `InlinePartyInput` (`CreateLeadCommand.InlineParty`, T-018): mirrors `PartyWritePayload`. */
export interface InlinePartyPayload {
  name: string;
  partyTypeId: number;
  segmentId: number | null;
  industryId: number | null;
  regionId: number | null;
  isStrategic: boolean;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface CreateLeadPayload {
  partyId: number | null;
  inlineParty: InlinePartyPayload | null;
  isExistingClient: boolean;
  dateReceived: string;
  requestChannelId: number;
  brokerId: number | null;
  ownerUserId: number;
  regionId: number;
  externalRef: string | null;
  productLineId: number;
  coverTypeId: number;
  sumInsured: number | null;
  estimatedPremium: number | null;
  policyTerm: string;
  policyTermOther: string | null;
  /** `null` lets the server derive from the tenant high-value threshold (spec FR-29); non-null is an explicit user override. */
  priority: string | null;
  intakeNotes: string | null;
  createAnyway: boolean;
}

/** `UpdateLeadCommand` never carries `partyId`/`ownerUserId` (spec FR-30/FR-32 — party reassignment
 * and owner changes are out of Edit's scope; owner changes go through the Assign workflow op). */
export interface UpdateLeadPayload {
  isExistingClient: boolean;
  dateReceived: string;
  requestChannelId: number;
  brokerId: number | null;
  regionId: number;
  externalRef: string | null;
  productLineId: number;
  coverTypeId: number;
  sumInsured: number | null;
  estimatedPremium: number | null;
  policyTerm: string;
  policyTermOther: string | null;
  priority: string;
}

export interface LeadNoteDto {
  id: number;
  body: string;
  createdAt: string;
}

/**
 * Wire shape of `LeadDto` (`src/api/.../Features/Leads/LeadDto.cs`, spec FR-29..FR-32/FR-44).
 *
 * Flagged gap (T-028 final report): `GetLeadQueryHandler` never projects the outcome fields that
 * exist on the `Lead` entity today (`DecisionDate`, `LostReasonId`, `Competitor`,
 * `CompetitorPremium`, `LossComments`) — nor a "who closed it" actor or a bound premium (the latter
 * is inherently T-020/T-029's quote-level field once quotes exist). `OutcomePanel` needs all of
 * these (spec FR-44/AC-043: "outcome status, decision date, bound premium (Won) or lost reason/
 * competitor/comments (Lost), who closed it"). Typed here as optional/always-`undefined`-until-
 * projected so `OutcomePanel` is forward-compatible the moment `LeadDto`/`GetLeadQueryHandler` add
 * them, rather than blocking this (pure-frontend, T-019/T-022-are-PASS) task on a backend change.
 * Recommended follow-up: extend `LeadDto` with `decisionDate`, `lostReasonName`, `competitor`,
 * `competitorPremium`, `lossComments`, `closedByName`, and (once T-029 lands) `boundPremium`.
 */
export interface LeadDetailDto {
  id: number;
  leadRef: string;
  externalRef: string | null;
  partyId: number;
  partyName: string;
  requestChannelId: number;
  brokerId: number | null;
  brokerName: string | null;
  regionId: number;
  productLineId: number;
  productLineName: string;
  coverTypeId: number;
  coverTypeName: string;
  sumInsured: number | null;
  estimatedPremium: number | null;
  policyTerm: string;
  policyTermOther: string | null;
  priority: string;
  isExistingClient: boolean;
  statusId: number;
  statusName: string;
  statusCanonicalKey: string | null;
  dateReceived: string;
  source: string;
  owner: LeadAssigneeDto | null;
  notes: LeadNoteDto[];
  availableOperations: string[];
  lastFollowUpDate: string | null;
  nextFollowUpDate: string | null;
  isNextFollowUpOverdue: boolean;
  /** Not yet projected server-side — see this interface's doc comment. */
  decisionDate?: string | null;
  lostReasonName?: string | null;
  competitor?: string | null;
  competitorPremium?: number | null;
  lossComments?: string | null;
  closedByName?: string | null;
  boundPremium?: number | null;
}

/** Wire shape of `LeadDuplicateMatchDto` (spec FR-31, T-018), one open/quoted duplicate-lead match. */
export interface LeadDuplicateMatchDto {
  leadId: number;
  leadRef: string;
  status: string;
  dateReceived: string;
}

/** Wire shape of `LeadWarningDto` — `Details` is the loosely-typed `object?` payload; callers narrow it per `code`. */
export interface LeadWarningDto {
  code: string;
  details: unknown;
}

export const DUPLICATE_LEAD_WARNING_CODE = 'DUPLICATE_LEAD';
export const DUPLICATE_PARTY_NAME_WARNING_CODE = 'DUPLICATE_PARTY_NAME';
export const DUPLICATE_EXTERNAL_REF_WARNING_CODE = 'DUPLICATE_EXTERNAL_REF';

/** Wire shape of `CreateLeadOutcomeDto` (spec FR-31, T-018): either the persisted lead plus
 * non-blocking warnings, or (when `requiresConfirmation` is true) a confirm-gated duplicate-lead
 * envelope with `lead: null` and nothing persisted yet. */
export interface CreateLeadOutcomeDto {
  lead: LeadDetailDto | null;
  warnings: LeadWarningDto[];
  requiresConfirmation: boolean;
}

/**
 * Creates a lead (`POST /leads`, spec FR-29..FR-32). The confirm-gated duplicate-lead response
 * (FR-31) comes back as a `CreateLeadOutcomeDto` body on HTTP 409 rather than a `ProblemDetails`
 * error — `extraOkStatuses: [409]` tells the shared client to resolve (not throw) for it, so callers
 * inspect `result.requiresConfirmation` themselves instead of catching an exception.
 */
export function createLead(payload: CreateLeadPayload): Promise<CreateLeadOutcomeDto> {
  return apiPost<CreateLeadOutcomeDto>('/leads', payload, [409]);
}

export function getLead(id: number): Promise<LeadDetailDto> {
  return apiGet<LeadDetailDto>(`/leads/${id}`);
}

export function updateLead(id: number, payload: UpdateLeadPayload): Promise<LeadDetailDto> {
  return apiPut<LeadDetailDto>(`/leads/${id}`, payload);
}

/**
 * The tenant's high-value threshold and manual-external-ref toggle for the intake form's derived
 * Priority hint (spec FR-29) and conditional External ref field. The gap T-026 flagged here was
 * resolved on 2026-07-13 (T-044): `GET /settings/business-rules` is now a membership-only read, so
 * every lead-creating role receives the real tenant rules. The `null` degrade path is kept purely
 * as transient-failure protection (callers hide the derived-priority hint / External ref field
 * instead of crashing the intake form).
 */
export async function getIntakeTenantRules(): Promise<{ highValueThreshold: number | null; manualExternalRefEnabled: boolean } | null> {
  try {
    const rules = await fetchFullBusinessRules();
    return { highValueThreshold: rules.highValueThreshold, manualExternalRefEnabled: rules.manualExternalRefEnabled };
  } catch {
    return null;
  }
}

export async function getEligibleLeadOwners(search?: string): Promise<EligibleLeadOwnerDto[] | null> {
  let ownerAssignmentId: number | null = null;
  try {
    const assignments = await fetchBusinessAssignments();
    ownerAssignmentId = assignments.rmRole?.assignmentId ?? null;
  } catch {
    return null;
  }

  if (ownerAssignmentId == null) {
    return [];
  }

  const searchParams = new URLSearchParams({ assignmentId: String(ownerAssignmentId) });
  if (search) {
    searchParams.set('search', search);
  }

  try {
    const eligible = await apiGet<EligibleAssigneeApiDto[]>(
      `/settings/business-assignments/eligible-users?${searchParams.toString()}`,
    );
    return eligible.map((dto) => ({ userId: dto.userId, firstName: dto.firstName, lastName: dto.lastName, email: dto.email }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lead Detail: timeline (T-022 GetLeadTimelineQuery) + workflow operations
// (T-019 LeadWorkflow/LeadOperationExecutor via POST /leads/{id}/operations/{op}, T-028)
// ---------------------------------------------------------------------------

/** Wire shape of `TimelineEntryDto` (`src/api/.../Features/Leads/GetTimeline/TimelineEntryDto.cs`, spec FR-44). */
export interface TimelineEntryDto {
  type: 'status' | 'quote_status' | 'follow_up' | 'note';
  at: string;
  actorName: string | null;
  title: string;
  detail: string | null;
  quoteRef: string | null;
}

/** Wire shape of `LeadTimelineDto` (`src/api/.../Features/Leads/GetTimeline/TimelineEntryDto.cs`, T-022). */
export interface LeadTimelineDto {
  items: TimelineEntryDto[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export function getLeadTimeline(leadId: number, page = 1): Promise<LeadTimelineDto> {
  return apiGet<LeadTimelineDto>(`/leads/${leadId}/timeline?page=${page}`);
}

/**
 * The twelve human-invocable lead workflow operation wire codes (`LeadOperationCodes.ToCodeValue`,
 * `src/api/.../QuoteIQ.Domain/Workflow/LeadOperation.cs`, T-019); `expire` (automatic-only, system
 * actor) is deliberately absent — `LeadDto.AvailableOperations` never surfaces it either.
 */
export const LEAD_OPERATION_CODES = {
  Assign: 'assign',
  StartInformationGathering: 'start-information-gathering',
  SendToUnderwriting: 'send-to-underwriting',
  StartPricing: 'start-pricing',
  RequestPricingApproval: 'request-pricing-approval',
  ApprovePricing: 'approve-pricing',
  RejectPricing: 'reject-pricing',
  LogFollowUp: 'log-follow-up',
  StartNegotiation: 'start-negotiation',
  MarkLost: 'mark-lost',
  Withdraw: 'withdraw',
  Reopen: 'reopen',
} as const;

export type LeadOperationCode = (typeof LEAD_OPERATION_CODES)[keyof typeof LEAD_OPERATION_CODES];

export interface LeadAssignmentPayload {
  businessAssignmentId: number;
  userId: number | null;
}

/** `POST /leads/{id}/operations/assign` (`AssignLeadCommand`/`AssignLeadRequest`, spec FR-34/FR-35). */
export function assignLead(leadId: number, assignments: LeadAssignmentPayload[], comment: string | null): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/assign`, { assignments, comment });
}

/** `POST /leads/{id}/operations/start-information-gathering` (`OptionalNoteRequest`). */
export function startLeadInformationGathering(leadId: number, note: string | null): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/start-information-gathering`, { note });
}

/** `POST /leads/{id}/operations/send-to-underwriting` (`SendToUnderwritingCommand`/`SendToUnderwritingRequest`). */
export function sendLeadToUnderwriting(leadId: number, underwritingOwnerUserId: number, note: string | null): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/send-to-underwriting`, { underwritingOwnerUserId, note });
}

/** `POST /leads/{id}/operations/start-pricing` (`OptionalNoteRequest`). */
export function startLeadPricing(leadId: number, note: string | null): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/start-pricing`, { note });
}

/** `POST /leads/{id}/operations/request-pricing-approval` (`RequestPricingApprovalCommand`/`RequestPricingApprovalRequest`). */
export function requestPricingApproval(
  leadId: number,
  approverUserId: number,
  proposedPremium: number | null,
  note: string | null,
): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/request-pricing-approval`, { approverUserId, proposedPremium, note });
}

/** `POST /leads/{id}/operations/approve-pricing` (`ApprovePricingCommand`/`OptionalNoteRequest`). */
export function approvePricing(leadId: number, note: string | null): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/approve-pricing`, { note });
}

/** `POST /leads/{id}/operations/reject-pricing` (`RejectPricingCommand`/`RejectPricingRequest` — reason required). */
export function rejectPricing(leadId: number, rejectionReason: string): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/reject-pricing`, { rejectionReason });
}

/** `POST /leads/{id}/operations/log-follow-up` (`LogFollowUpCommand`/`LogFollowUpRequest`, spec FR-51). */
export function logFollowUp(
  leadId: number,
  followUpDate: string | null,
  outcomeNote: string,
  nextFollowUpDate: string | null,
): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/log-follow-up`, { followUpDate, outcomeNote, nextFollowUpDate });
}

/** `POST /leads/{id}/operations/start-negotiation` (`OptionalNoteRequest`). */
export function startLeadNegotiation(leadId: number, note: string | null): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/start-negotiation`, { note });
}

/** `POST /leads/{id}/operations/mark-lost` (`MarkLeadLostCommand`/`MarkLeadLostRequest`, spec FR-36/FR-40). */
export function markLeadLost(
  leadId: number,
  lostReasonId: number,
  competitor: string | null,
  competitorPremium: number | null,
  lossComments: string | null,
): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/mark-lost`, {
    lostReasonId,
    competitor,
    competitorPremium,
    lossComments,
  });
}

/** `POST /leads/{id}/operations/withdraw` (`WithdrawLeadCommand`/`WithdrawLeadRequest` — note required). */
export function withdrawLead(leadId: number, withdrawalNote: string): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/withdraw`, { withdrawalNote });
}

/** `POST /leads/{id}/operations/reopen` (`ReopenLeadCommand`/`ReopenLeadRequest` — reason required, A-13's "last open status"). */
export function reopenLead(leadId: number, reopenReason: string): Promise<LeadDetailDto> {
  return apiPost<LeadDetailDto>(`/leads/${leadId}/operations/reopen`, { reopenReason });
}

/**
 * Active tenant users eligible for a configured assignment slot
 * (`GET /settings/business-assignments/eligible-users?assignmentId=`, T-011; two-slot amendment).
 * Used by `AssignDialog` (RM/Underwriter pickers), `SendToUnderwritingDialog` (the Underwriting
 * slot), and `QuoteAssignDialog`. Intentionally not permission-gated server-side (same rationale
 * as `getEligibleLeadOwners`), so no `| null` degrade-to-unavailable branch is needed here.
 */
export function getEligibleAssignees(assignmentId: number, search?: string): Promise<EligibleAssigneeApiDto[]> {
  const searchParams = new URLSearchParams({ assignmentId: String(assignmentId) });
  if (search) {
    searchParams.set('search', search);
  }
  return apiGet<EligibleAssigneeApiDto[]>(`/settings/business-assignments/eligible-users?${searchParams.toString()}`);
}

/** Active tenant users holding `pricing.approve` (`GET /settings/business-assignments/eligible-approvers`, T-011), for `RequestPricingApprovalDialog`'s approver picker. */
export function getEligibleApprovers(search?: string): Promise<EligibleAssigneeApiDto[]> {
  const searchParams = new URLSearchParams();
  if (search) {
    searchParams.set('search', search);
  }
  const qs = searchParams.toString();
  return apiGet<EligibleAssigneeApiDto[]>(`/settings/business-assignments/eligible-approvers${qs ? `?${qs}` : ''}`);
}
