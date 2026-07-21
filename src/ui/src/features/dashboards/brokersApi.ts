import { apiGet } from '../../api/client';
import type { DashboardFiltersState } from '../../app/slices/dashboardFiltersSlice';
import type { MatrixQuadrant } from './quadrantPalette';

/**
 * Broker Performance dashboard backend contract (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`
 * `GET /api/v1/dashboards/broker-performance`, `src/api/.../Features/Dashboards/BrokerPerformance/*`,
 * T-034, spec FR-57/PRD 15.1). Fetch-wrapper module matching the established convention
 * (`pipelineApi.ts`/`executiveApi.ts`) rather than RTK Query — this codebase has no RTK Query store.
 */

export type KpiGoodDirection = 'higherIsBetter' | 'lowerIsBetter';
export type KpiKind = 'currency' | 'percent' | 'count' | 'days';
export type LeadOrQuote = 'lead' | 'quote';

/** Wire shape of `BrokerKpiDto` (same contract as the Executive/Pipeline KPI card). */
export interface BrokerKpiDto {
  key: string;
  label: string;
  leadOrQuote: LeadOrQuote;
  kind: KpiKind;
  value: number | null;
  delta: number | null;
  goodDirection: KpiGoodDirection;
  isFavorableDelta: boolean | null;
  drillWidgetKey: string;
}

/** Wire shape of `TopBrokerDto` (a Top-Brokers ranking bar). */
export interface TopBrokerDto {
  brokerId: number;
  brokerName: string;
  quoteVolume: number;
  conversionRate: number | null;
  drillWidgetKey: string;
}

/** Wire shape of `BrokerMatrixPointDto` (x = volume, y = conversion, bubble = won premium, server-classified quadrant). */
export interface BrokerMatrixPointDto {
  brokerId: number;
  brokerName: string;
  quoteVolume: number;
  conversionRate: number | null;
  wonPremium: number;
  quadrant: MatrixQuadrant;
  drillWidgetKey: string;
}

/** Wire shape of `BrokerMatrixDto` (points + median-or-configured axis splits the frontend shades from). */
export interface BrokerMatrixDto {
  points: BrokerMatrixPointDto[];
  volumeSplit: number;
  conversionSplit: number;
  drillWidgetKey: string;
}

/** Wire shape of `BrokerTableRowDto` (full ranked broker table row with loss patterns). */
export interface BrokerTableRowDto {
  brokerId: number;
  brokerName: string;
  primaryContactName: string | null;
  tierName: string | null;
  branch: string | null;
  quoteVolume: number;
  conversionRate: number | null;
  wonPremium: number;
  avgTurnaroundDays: number | null;
  overdueFollowUps: number;
  topLossReason: string | null;
  drillWidgetKey: string;
}

/** Wire shape of `BrokerPerformanceDto`. */
export interface BrokerPerformanceDto {
  currencyCode: string;
  kpis: BrokerKpiDto[];
  topBrokers: TopBrokerDto[];
  matrix: BrokerMatrixDto;
  table: BrokerTableRowDto[];
}

function buildBrokerQuery(filters: DashboardFiltersState): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set('from', filters.dateFrom);
  if (filters.dateTo) params.set('to', filters.dateTo);
  if (filters.productLineId != null) params.set('productLineId', String(filters.productLineId));
  if (filters.brokerId != null) params.set('brokerId', String(filters.brokerId));
  if (filters.rmUserId != null) params.set('rmUserId', String(filters.rmUserId));
  if (filters.regionId != null) params.set('regionId', String(filters.regionId));
  return params.toString();
}

/** Fetches the Broker Performance payload for the active dashboard filters (spec FR-57/AC-056). */
export function fetchBrokerPerformance(filters: DashboardFiltersState): Promise<BrokerPerformanceDto> {
  const query = buildBrokerQuery(filters);
  return apiGet<BrokerPerformanceDto>(`/dashboards/broker-performance${query ? `?${query}` : ''}`);
}
