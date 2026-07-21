import { apiDelete, apiGet, apiPost, apiPut } from '../../api/client';

/**
 * Fetch-wrapper API module for the four Settings backends (T-008/T-010/T-011/T-012), following the
 * same `apiGet`/`apiPost`/`apiPut` convention as `api/me.ts`/`api/businessRules.ts` and
 * `features/userManager/*Api.ts`.
 *
 * Deviation flagged (task brief said "settingsApi RTK Query module"): this codebase has no RTK
 * Query store configured anywhere (`app/store.ts` is a plain `configureStore` with hand-rolled
 * slices) — every existing feature (tenantManager, userManager) uses this same fetch-wrapper
 * pattern instead. Introducing RTK Query for this task alone would be a new, unapproved data-
 * fetching framework mid-codebase (CLAUDE.md: "Do not introduce new frameworks or tools without
 * approval"), so this module matches the established convention rather than the brief's wording.
 */

// ---------------------------------------------------------------------------
// Reference data (T-008: GET/POST/PUT /settings/reference-data/{listType}, .../reorder, .../disable)
// ---------------------------------------------------------------------------

/** The eleven tenant-configurable reference lists (spec §11.2, FR-19), in backend enum declaration order. */
export const REFERENCE_LIST_TYPES = [
  'request_channel',
  'product_line',
  'cover_type',
  'party_segment',
  'industry',
  'region',
  'party_type',
  'lead_status',
  'quote_status',
  'lost_reason',
  'broker_type',
] as const;

export type ReferenceListType = (typeof REFERENCE_LIST_TYPES)[number];

export const REFERENCE_LIST_TYPE_LABELS: Record<ReferenceListType, string> = {
  request_channel: 'Request channels',
  product_line: 'Product lines',
  cover_type: 'Cover types',
  party_segment: 'Party segments',
  industry: 'Industry',
  region: 'Region',
  party_type: 'Party types',
  lead_status: 'Lead statuses',
  quote_status: 'Quote statuses',
  lost_reason: 'Lost reasons',
  broker_type: 'Broker types',
};

/** Wire shape of `ReferenceItemDto` (src/api/.../ReferenceData/ReferenceItemDto.cs). */
export interface ReferenceItemDto {
  id: number;
  listType: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
  isBrokerChannel: boolean | null;
  productLineId: number | null;
  reportingCategory: string | null;
  canonicalKey: string | null;
  isTerminal: boolean;
}

export interface ReferenceItemWritePayload {
  name: string;
  isBrokerChannel?: boolean | null;
  productLineId?: number | null;
  reportingCategory?: string | null;
}

export function listReferenceItems(listType: ReferenceListType, includeDisabled = false): Promise<ReferenceItemDto[]> {
  return apiGet<ReferenceItemDto[]>(`/settings/reference-data/${listType}?includeDisabled=${includeDisabled}`);
}

export function createReferenceItem(listType: ReferenceListType, payload: ReferenceItemWritePayload): Promise<ReferenceItemDto> {
  return apiPost<ReferenceItemDto>(`/settings/reference-data/${listType}`, payload);
}

export function updateReferenceItem(
  listType: ReferenceListType,
  id: number,
  payload: ReferenceItemWritePayload,
): Promise<ReferenceItemDto> {
  return apiPut<ReferenceItemDto>(`/settings/reference-data/${listType}/${id}`, payload);
}

export function disableReferenceItem(listType: ReferenceListType, id: number): Promise<void> {
  return apiPost<void>(`/settings/reference-data/${listType}/${id}/disable`);
}

export function reorderReferenceItems(listType: ReferenceListType, orderedIds: number[]): Promise<void> {
  return apiPost<void>(`/settings/reference-data/${listType}/reorder`, { orderedIds });
}

// ---------------------------------------------------------------------------
// Business rules (T-010: GET/PUT /settings/business-rules)
// ---------------------------------------------------------------------------

/** Full wire shape of `BusinessRulesDto` (src/api/.../BusinessRules/BusinessRulesDto.cs, FR-11). */
export interface FullBusinessRulesDto {
  currencyCode: string;
  currencySymbol: string;
  maxAttachmentMb: number;
  highValueThreshold: number | null;
  quoteExpiryAlertDays: number;
  followUpOverdueGraceDays: number;
  agingAmberDays: number;
  agingRedDays: number;
  unassignedLeadHours: number;
  stalledLeadDays: number;
  stalledQuoteDays: number;
  duplicateCheckDays: number;
  leadRefFormat: string;
  quoteRefFormat: string;
  leadInactivityExpiryDays: number;
  pricingApprovalTargetDays: number;
  slaAssignmentDays: number;
  slaUnderwritingDays: number;
  slaReceivedToSentDays: number;
  requirePricingApprovalForHighValue: boolean;
  manualExternalRefEnabled: boolean;
}

export function fetchFullBusinessRules(): Promise<FullBusinessRulesDto> {
  return apiGet<FullBusinessRulesDto>('/settings/business-rules');
}

export function updateBusinessRules(payload: FullBusinessRulesDto): Promise<FullBusinessRulesDto> {
  return apiPut<FullBusinessRulesDto>('/settings/business-rules', payload);
}

// ---------------------------------------------------------------------------
// Business assignments (T-011; two-slot amendment 2026-07-15:
// GET/PUT /settings/business-assignments — one role per slot: RM + Underwriting)
// ---------------------------------------------------------------------------

/** Wire shape of `BusinessAssignmentEntryDto` (src/api/.../BusinessAssignments/BusinessAssignmentsDto.cs). */
export interface BusinessAssignmentEntryDto {
  assignmentId: number;
  roleId: number;
  roleName: string;
}

/** The tenant's two assignment slots; either may be unconfigured (`null`). RM = lead accountable owner; Underwriting = Send-to-underwriting / quote assignment. */
export interface BusinessAssignmentsDto {
  rmRole: BusinessAssignmentEntryDto | null;
  underwritingRole: BusinessAssignmentEntryDto | null;
}

export interface BusinessAssignmentsWritePayload {
  rmRoleId: number | null;
  underwritingRoleId: number | null;
}

export function fetchBusinessAssignments(): Promise<BusinessAssignmentsDto> {
  return apiGet<BusinessAssignmentsDto>('/settings/business-assignments');
}

/**
 * Wire shape of `EligibleAssigneeDto` (`src/api/.../Features/BusinessAssignments/EligibleAssigneeDto.cs`),
 * returned by the (intentionally not permission-gated) `GET .../eligible-users` and
 * `GET .../eligible-approvers` picker endpoints. Exported for `features/leads/leadsApi.ts`'s
 * `getEligibleLeadOwners`.
 */
export interface EligibleAssigneeApiDto {
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
}

export function updateBusinessAssignments(payload: BusinessAssignmentsWritePayload): Promise<BusinessAssignmentsDto> {
  return apiPut<BusinessAssignmentsDto>('/settings/business-assignments', payload);
}

// ---------------------------------------------------------------------------
// Brokers (T-012: /api/v1/brokers CRUD + disable + contacts)
// ---------------------------------------------------------------------------

/** Wire shape of `BrokerSummaryDto` (src/api/.../Brokers/BrokerDto.cs). */
export interface BrokerSummaryDto {
  id: number;
  name: string;
  brokerTypeId: number | null;
  branch: string | null;
  status: 'active' | 'disabled';
}

export interface BrokerContactDto {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

export interface BrokerDetailDto {
  id: number;
  name: string;
  brokerTypeId: number | null;
  branch: string | null;
  status: 'active' | 'disabled';
  contacts: BrokerContactDto[];
}

export interface BrokerListDto {
  items: BrokerSummaryDto[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface BrokerWritePayload {
  name: string;
  brokerTypeId?: number | null;
  branch?: string | null;
}

export function listBrokers(): Promise<BrokerListDto> {
  // Settings screen wants every broker (active and disabled) with a status column, so no `status`
  // filter is passed; `pageSize` is set generously since the Settings tab does not paginate.
  return apiGet<BrokerListDto>('/brokers?page=1&pageSize=200');
}

export function getBroker(id: number): Promise<BrokerDetailDto> {
  return apiGet<BrokerDetailDto>(`/brokers/${id}`);
}

export function createBroker(payload: BrokerWritePayload): Promise<BrokerDetailDto> {
  return apiPost<BrokerDetailDto>('/brokers', payload);
}

export function updateBroker(id: number, payload: BrokerWritePayload): Promise<BrokerDetailDto> {
  return apiPut<BrokerDetailDto>(`/brokers/${id}`, payload);
}

export function disableBroker(id: number): Promise<void> {
  return apiPost<void>(`/brokers/${id}/disable`);
}

export interface BrokerContactWritePayload {
  name: string;
  email?: string | null;
  phone?: string | null;
}

export function addBrokerContact(
  brokerId: number,
  payload: BrokerContactWritePayload & { isPrimary?: boolean },
): Promise<BrokerContactDto> {
  return apiPost<BrokerContactDto>(`/brokers/${brokerId}/contacts`, payload);
}

export function updateBrokerContact(
  brokerId: number,
  contactId: number,
  payload: BrokerContactWritePayload,
): Promise<BrokerContactDto> {
  return apiPut<BrokerContactDto>(`/brokers/${brokerId}/contacts/${contactId}`, payload);
}

export function removeBrokerContact(brokerId: number, contactId: number): Promise<void> {
  return apiDelete<void>(`/brokers/${brokerId}/contacts/${contactId}`);
}

export function setPrimaryBrokerContact(brokerId: number, contactId: number): Promise<BrokerContactDto> {
  return apiPost<BrokerContactDto>(`/brokers/${brokerId}/contacts/${contactId}/set-primary`);
}

// ---------------------------------------------------------------------------
// API access credentials (T-030: /api/v1/settings/api-credentials)
// ---------------------------------------------------------------------------

/** Wire shape of `ApiCredentialDto` (src/api/.../ApiAccess/ApiAccessDtos.cs). Never carries a secret. */
export interface ApiCredentialDto {
  id: number;
  brokerId: number | null;
  clientId: string;
  status: 'active' | 'disabled';
  createdAt: string;
  lastRotatedAt: string | null;
  disabledAt: string | null;
}

export interface ApiCredentialListDto {
  credentials: ApiCredentialDto[];
}

/**
 * A credential plus its secret, returned exactly once at provision/regenerate/reveal
 * (spec FR-25, AC-024). The secret must be shown once and never re-fetched from storage — it exists
 * only in this in-memory response, so callers surface it immediately and drop it.
 */
export interface CredentialSecretDto {
  credential: ApiCredentialDto;
  clientId: string;
  secret: string;
}

export function listApiCredentials(brokerId?: number): Promise<ApiCredentialListDto> {
  const query = brokerId != null ? `?brokerId=${brokerId}` : '';
  return apiGet<ApiCredentialListDto>(`/settings/api-credentials${query}`);
}

export function provisionTenantApiCredential(): Promise<CredentialSecretDto> {
  return apiPost<CredentialSecretDto>('/settings/api-credentials');
}

export function provisionBrokerApiCredential(brokerId: number): Promise<CredentialSecretDto> {
  return apiPost<CredentialSecretDto>(`/settings/api-credentials/broker/${brokerId}`);
}

export function revealApiCredentialSecret(id: number): Promise<CredentialSecretDto> {
  return apiPost<CredentialSecretDto>(`/settings/api-credentials/${id}/reveal`);
}

export function regenerateApiCredentialSecret(id: number): Promise<CredentialSecretDto> {
  return apiPost<CredentialSecretDto>(`/settings/api-credentials/${id}/regenerate`);
}

export function disableApiCredential(id: number): Promise<ApiCredentialDto> {
  return apiPost<ApiCredentialDto>(`/settings/api-credentials/${id}/disable`);
}
