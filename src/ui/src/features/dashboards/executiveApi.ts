import { apiGet } from '../../api/client';
import type { DashboardFiltersState } from '../../app/slices/dashboardFiltersSlice';

/**
 * Executive Overview dashboard backend contract (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`
 * `GET /api/v1/dashboards/executive`, `src/api/.../Features/Dashboards/Executive/*`, T-032, spec FR-55).
 * Fetch-wrapper module, matching the established convention (`dashboardsApi.ts`/`leadsApi.ts`) rather
 * than RTK Query — this codebase has no RTK Query store configured.
 */

export type KpiGoodDirection = 'higherIsBetter' | 'lowerIsBetter';
export type KpiKind = 'currency' | 'percent' | 'count' | 'days';
export type LeadOrQuote = 'lead' | 'quote';

/** Wire shape of `ExecutiveKpiDto`. */
export interface ExecutiveKpiDto {
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

/** Wire shape of `ExecutivePipelineStageDto` (CURRENT open items per stage, not cumulative). */
export interface ExecutivePipelineStageDto {
  stageName: string;
  stageCanonicalKey: string | null;
  openCount: number;
  shareOfOpen: number;
  drillWidgetKey: string;
}

export interface ExecutiveAgingBucketDto {
  bucket: string;
  count: number;
  share: number;
}

export interface ExecutiveAgingDto {
  buckets: ExecutiveAgingBucketDto[];
  totalOpenQuotes: number;
  drillWidgetKey: string;
}

export interface ExecutiveTrendPointDto {
  label: string;
  wonPremium: number;
  lostPremium: number;
}

export interface ExecutiveTrendDto {
  weekly: ExecutiveTrendPointDto[];
  monthly: ExecutiveTrendPointDto[];
  drillWidgetKey: string;
}

export interface ExecutiveHighValueRowDto {
  leadId: number;
  leadRef: string;
  clientName: string;
  partyType: string;
  brokerName: string | null;
  productLineName: string;
  premium: number;
  stageName: string;
  stageReportingCategory: string;
  nextFollowUpDate: string | null;
  ownerName: string | null;
  riskFlag: boolean;
}

export interface ExecutiveAttentionRowDto {
  category: string;
  name: string;
  definition: string;
  tab: string | null;
  count: number;
}

/** Wire shape of `ExecutiveOverviewDto`. */
export interface ExecutiveOverviewDto {
  currencyCode: string;
  kpis: ExecutiveKpiDto[];
  pipelineByStage: ExecutivePipelineStageDto[];
  openQuotesAging: ExecutiveAgingDto;
  wonVsLostTrend: ExecutiveTrendDto;
  highValueOpportunities: ExecutiveHighValueRowDto[];
  requiresAttention: ExecutiveAttentionRowDto[];
}

function buildOverviewQuery(filters: DashboardFiltersState): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set('from', filters.dateFrom);
  if (filters.dateTo) params.set('to', filters.dateTo);
  if (filters.productLineId != null) params.set('productLineId', String(filters.productLineId));
  if (filters.brokerId != null) params.set('brokerId', String(filters.brokerId));
  if (filters.rmUserId != null) params.set('rmUserId', String(filters.rmUserId));
  if (filters.regionId != null) params.set('regionId', String(filters.regionId));
  return params.toString();
}

/** Fetches the Executive Overview payload for the active dashboard filters (spec FR-55/AC-054). */
export function fetchExecutiveOverview(filters: DashboardFiltersState): Promise<ExecutiveOverviewDto> {
  const query = buildOverviewQuery(filters);
  return apiGet<ExecutiveOverviewDto>(`/dashboards/executive${query ? `?${query}` : ''}`);
}
