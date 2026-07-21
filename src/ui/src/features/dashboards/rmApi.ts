import { apiGet } from '../../api/client';
import type { DashboardFiltersState } from '../../app/slices/dashboardFiltersSlice';
import type { BrokerMatrixDto } from './brokersApi';

/**
 * RM Performance dashboard backend contract (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`
 * `GET /api/v1/dashboards/rm-performance`, `src/api/.../Features/Dashboards/RmPerformance/*`, T-035,
 * spec FR-58/PRD 15.2/15.4). Fetch-wrapper module matching the established convention
 * (`brokersApi.ts`/`pipelineApi.ts`) rather than RTK Query — this codebase has no RTK Query store.
 */

export type KpiGoodDirection = 'higherIsBetter' | 'lowerIsBetter';
export type KpiKind = 'currency' | 'percent' | 'count' | 'days';
export type LeadOrQuote = 'lead' | 'quote';

/** Wire shape of `RmKpiDto` (same contract as the Broker/Executive/Pipeline KPI card). */
export interface RmKpiDto {
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

/** Wire shape of `TopRmDto` (a Top-RMs ranking bar, ranked by won premium). */
export interface TopRmDto {
  rmUserId: number;
  rmName: string;
  quoteVolume: number;
  wonPremium: number;
  conversionRate: number | null;
  drillWidgetKey: string;
}

/** Wire shape of `TopBrokerRankDto` (a Top-Brokers ranking bar on the RM dashboard, ranked by won premium). */
export interface TopBrokerRankDto {
  brokerId: number;
  brokerName: string;
  quoteVolume: number;
  wonPremium: number;
  conversionRate: number | null;
  drillWidgetKey: string;
}

/** Wire shape of `TurnaroundRmRowDto` (one RM's average turnaround + whether it exceeds the SLA target). */
export interface TurnaroundRmRowDto {
  rmUserId: number;
  rmName: string;
  avgTurnaroundDays: number | null;
  beyondTarget: boolean;
  drillWidgetKey: string;
}

/** Wire shape of `TurnaroundByRmDto` (per-RM turnaround bars + the dashed SLA target marker). */
export interface TurnaroundByRmDto {
  rows: TurnaroundRmRowDto[];
  slaTargetDays: number;
  drillWidgetKey: string;
}

/** Wire shape of `SuggestedActionDto` (the color-coded watchlist action chip: label + `qiq-chip--{tone}` suffix). */
export interface SuggestedActionDto {
  label: string;
  tone: string;
}

/** Wire shape of `WatchlistRowDto` (a Performance Watchlist row with its suggested action). */
export interface WatchlistRowDto {
  rmUserId: number;
  name: string;
  quoteVolume: number;
  wonPremium: number;
  conversionRate: number | null;
  avgTurnaroundDays: number | null;
  overdueFollowUps: number;
  suggestedAction: SuggestedActionDto;
  drillWidgetKey: string;
}

/** Wire shape of `LeadershipInsightDto` (a generated one-liner: icon glyph + headline + narrative). */
export interface LeadershipInsightDto {
  type: string;
  icon: string;
  headline: string;
  narrative: string;
}

/** Wire shape of `RmPerformanceDto`. The Broker Matrix reuses the shared `BrokerMatrixDto` so the RM page renders it with the same `BrokerMatrixScatter` + `quadrantPalette` single source. */
export interface RmPerformanceDto {
  currencyCode: string;
  kpis: RmKpiDto[];
  topRms: TopRmDto[];
  topBrokers: TopBrokerRankDto[];
  brokerMatrix: BrokerMatrixDto;
  turnaroundByRm: TurnaroundByRmDto;
  watchlist: WatchlistRowDto[];
  insights: LeadershipInsightDto[];
}

function buildRmQuery(filters: DashboardFiltersState): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set('from', filters.dateFrom);
  if (filters.dateTo) params.set('to', filters.dateTo);
  if (filters.productLineId != null) params.set('productLineId', String(filters.productLineId));
  if (filters.regionId != null) params.set('regionId', String(filters.regionId));
  // RM-variant fields: the "RM/Team" and "Broker Type" selects (honored by the rm-performance endpoint).
  if (filters.teamOrRmId != null) params.set('teamOrRmId', String(filters.teamOrRmId));
  if (filters.brokerTypeId != null) params.set('brokerTypeId', String(filters.brokerTypeId));
  // A broker-matrix-point drill narrows to a single broker via the shared brokerId dimension.
  if (filters.brokerId != null) params.set('brokerId', String(filters.brokerId));
  return params.toString();
}

/** Fetches the RM Performance payload for the active dashboard filters (spec FR-58/AC-057). */
export function fetchRmPerformance(filters: DashboardFiltersState): Promise<RmPerformanceDto> {
  const query = buildRmQuery(filters);
  return apiGet<RmPerformanceDto>(`/dashboards/rm-performance${query ? `?${query}` : ''}`);
}
