import { apiGet, apiPost } from '../../api/client';

/**
 * Alerts Center backend contract (src/api/QuoteIQ.Api/Endpoints/AlertEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Alerts/*, T-024, spec FR-62/FR-63). Fetch-wrapper module
 * matching the established convention (`leadsApi.ts`/`settingsApi.ts`) rather than RTK Query — this
 * codebase configures no RTK Query store (CLAUDE.md: "Do not introduce new frameworks without
 * approval"). Every route is tenant-scoped via the shared client's `X-Tenant-Id` injection and gated
 * server-side by `alerts.view`.
 */

/** Wire shape of `AlertCategoryCardDto` (`Features/Alerts/AlertDtos.cs`). `tab` is null for cards with no queue tab (Stalled). */
export interface AlertCategoryCardDto {
  category: string;
  name: string;
  definition: string;
  tab: string | null;
  count: number;
}

/** Wire shape of `AlertRollupDto` — the Escalation Queue header rollup (spec FR-62). */
export interface AlertRollupDto {
  premiumAtRisk: number;
  quoteCount: number;
}

/** Wire shape of `AlertSummaryDto` (`GET /alerts/summary`). */
export interface AlertSummaryDto {
  categories: AlertCategoryCardDto[];
  rollup: AlertRollupDto;
}

/** Wire shape of `AlertListItemDto` (`Features/Alerts/AlertDtos.cs`, spec FR-62's queue row). */
export interface AlertListItemDto {
  id: number;
  type: string;
  severity: string;
  createdAt: string;
  leadId: number;
  leadRef: string;
  quoteId: number | null;
  quoteRef: string | null;
  clientName: string;
  productLineName: string;
  brokerName: string | null;
  premiumAtRisk: number | null;
  stage: string;
  priority: string;
  ownerUserId: number | null;
  ownerName: string | null;
}

/** Wire shape of `AlertListDto` (`GET /alerts`), including the per-tab counts (spec FR-62). */
export interface AlertListDto {
  items: AlertListItemDto[];
  totalCount: number;
  page: number;
  pageSize: number;
  tabCounts: Record<string, number>;
}

/** Wire shape of `AlertBadgeDto` (`GET /alerts/badge`, spec FR-63). */
export interface AlertBadgeDto {
  count: number;
}

export const ALERTS_PAGE_SIZE = 25;

/**
 * The five queue tabs (mirrors `AlertDefinitions.Tabs`, T-024). Kept in one place so the tab strip,
 * the `?tab=` deep-link, and the category-card → tab mapping all agree.
 */
export const ALERT_TABS = ['all', 'escalated', 'overdue', 'expiring', 'sla'] as const;
export type AlertTab = (typeof ALERT_TABS)[number];

export const ALERT_TAB_LABELS: Record<AlertTab, string> = {
  all: 'All',
  escalated: 'Escalated',
  overdue: 'Overdue',
  expiring: 'Expiring',
  sla: 'SLA',
};

export function isAlertTab(value: string | null | undefined): value is AlertTab {
  return value != null && (ALERT_TABS as readonly string[]).includes(value);
}

/**
 * Category key → queue tab (mirrors `AlertDefinitions.Categories`' `Tab`, T-024). The Stalled
 * category has no dedicated tab server-side, so it maps to null (clicking it activates no tab). Used
 * by the `?category=` deep-link (dashboards/reports pre-filter into the Alerts center by category).
 */
const CATEGORY_TO_TAB: Record<string, AlertTab | null> = {
  escalated: 'escalated',
  stalled: null,
  overdue: 'overdue',
  expiring: 'expiring',
  sla: 'sla',
};

export function tabForCategory(category: string | null | undefined): AlertTab | null {
  if (category == null) {
    return null;
  }
  return CATEGORY_TO_TAB[category] ?? null;
}

/**
 * The contextual per-row action an alert type maps to (spec FR-62, PRD 18.2): the queue turns each
 * alert into the one workflow operation that clears/downgrades it. Alert-type string values mirror
 * `src/api/.../QuoteIQ.Domain/Alerts/AlertType.cs`. Types with no direct workflow action return
 * `null` — the row is still clickable through to Lead Detail.
 */
export type AlertActionKind = 'assign' | 'follow-up' | 'executive-review';

export function actionForAlertType(type: string): AlertActionKind | null {
  switch (type) {
    case 'unassigned_lead':
      return 'assign';
    case 'overdue_follow_up':
      return 'follow-up';
    case 'executive_escalation':
    case 'high_value_stalled':
      return 'executive-review';
    default:
      return null;
  }
}

export const ALERT_ACTION_LABELS: Record<AlertActionKind, string> = {
  assign: 'Assign & acknowledge',
  'follow-up': 'Follow up',
  'executive-review': 'Executive review',
};

/**
 * Short human labels for the FLAGS-column chips (spec FR-62's queue). Keys mirror
 * `AlertType.cs`; an unknown type falls back to its own code so a newly-added backend type never
 * renders blank.
 */
const ALERT_TYPE_LABELS: Record<string, string> = {
  unassigned_lead: 'Unassigned',
  overdue_follow_up: 'Follow-Up Due',
  stalled_lead: 'Stalled',
  stalled_quote: 'Stalled',
  quote_expiring: 'Expiring',
  quote_expired: 'Expired',
  sla_breach: 'SLA Breach',
  high_value_stalled: 'Escalated',
  pending_pricing_approval: 'Approval Pending',
  awaiting_underwriting: 'Awaiting UW',
  executive_escalation: 'Escalated',
};

export function labelForAlertType(type: string): string {
  return ALERT_TYPE_LABELS[type] ?? type;
}

export function getAlertSummary(): Promise<AlertSummaryDto> {
  return apiGet<AlertSummaryDto>('/alerts/summary');
}

export interface ListAlertsParams {
  tab?: string;
  ownerUserId?: number | null;
  productLineId?: number | null;
  coverTypeId?: number | null;
  regionId?: number | null;
  priority?: string | null;
  page?: number;
  pageSize?: number;
}

function buildListAlertsQuery(params: ListAlertsParams): string {
  const searchParams = new URLSearchParams();
  if (params.tab && params.tab !== 'all') {
    searchParams.set('tab', params.tab);
  }
  if (params.ownerUserId != null) {
    searchParams.set('ownerUserId', String(params.ownerUserId));
  }
  if (params.productLineId != null) {
    searchParams.set('productLineId', String(params.productLineId));
  }
  if (params.coverTypeId != null) {
    searchParams.set('coverTypeId', String(params.coverTypeId));
  }
  if (params.regionId != null) {
    searchParams.set('regionId', String(params.regionId));
  }
  if (params.priority) {
    searchParams.set('priority', params.priority);
  }
  searchParams.set('page', String(params.page ?? 1));
  searchParams.set('pageSize', String(params.pageSize ?? ALERTS_PAGE_SIZE));
  return searchParams.toString();
}

export function listAlerts(params: ListAlertsParams): Promise<AlertListDto> {
  return apiGet<AlertListDto>(`/alerts?${buildListAlertsQuery(params)}`);
}

export function getAlertBadge(): Promise<AlertBadgeDto> {
  return apiGet<AlertBadgeDto>('/alerts/badge');
}

/**
 * Marks the Alerts center as visited for the current user (`POST /alerts/badge/reset`). The reset is
 * server-persisted per user (T-024 upserts a per-user `last_opened_at`), so the badge stays zero for
 * that user across reloads while other users still see their own new-since-last-visit count (AC-062).
 */
export function resetAlertBadge(): Promise<void> {
  return apiPost<void>('/alerts/badge/reset');
}
