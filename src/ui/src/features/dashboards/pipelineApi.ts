import { apiGet } from '../../api/client';
import type { DashboardFiltersState } from '../../app/slices/dashboardFiltersSlice';

/**
 * Pipeline & Conversion dashboard backend contract (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`
 * `GET /api/v1/dashboards/pipeline`, `src/api/.../Features/Dashboards/Pipeline/*`, T-033, spec FR-56).
 * Fetch-wrapper module matching the established convention (`executiveApi.ts`/`dashboardsApi.ts`)
 * rather than RTK Query — this codebase has no RTK Query store configured.
 */

export type KpiGoodDirection = 'higherIsBetter' | 'lowerIsBetter';
export type KpiKind = 'currency' | 'percent' | 'count' | 'days';
export type LeadOrQuote = 'lead' | 'quote';

/** Wire shape of `PipelineKpiDto` (same contract as the Executive Overview KPI card). */
export interface PipelineKpiDto {
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

/** Wire shape of `FunnelStageDto` (cumulative reached-stage counts; `isLost` marks the terminal red bar). */
export interface FunnelStageDto {
  stageName: string;
  stageCanonicalKey: string | null;
  reachedCount: number;
  conversionFromTop: number;
  isLost: boolean;
  drillWidgetKey: string;
}

export interface ProductLineStackSegmentDto {
  productLineName: string;
  value: number;
}

export interface ProductLineStackColumnDto {
  monthLabel: string;
  segments: ProductLineStackSegmentDto[];
  monthlyTotal: number;
}

export interface PipelineByProductLineDto {
  productLines: string[];
  columns: ProductLineStackColumnDto[];
  drillWidgetKey: string;
}

export interface PipelineDonutSliceDto {
  label: string;
  count: number;
  share: number;
}

export interface PipelineDonutDto {
  slices: PipelineDonutSliceDto[];
  drillWidgetKey: string;
}

export interface AgingHeatmapStageDto {
  stageName: string;
  stageCanonicalKey: string | null;
}

export interface AgingHeatmapCellDto {
  stageName: string;
  bucket: string;
  count: number;
  grade: 'normal' | 'amber' | 'red';
  drillWidgetKey: string;
}

export interface AgingByStageDto {
  stages: AgingHeatmapStageDto[];
  buckets: string[];
  cells: AgingHeatmapCellDto[];
  drillWidgetKey: string;
}

export interface AtRiskRowDto {
  leadId: number;
  leadRef: string;
  clientName: string;
  brokerName: string | null;
  premium: number;
  stageName: string;
  stageReportingCategory: string;
  ageDays: number;
  ownerName: string | null;
  riskReason: string;
  suggestedAction: string;
  tenantName: string | null;
  drillWidgetKey: string;
}

export interface ImmediateActionDto {
  category: string;
  name: string;
  count: number;
  tab: string | null;
  drillWidgetKey: string;
}

/** Wire shape of `PipelineDashboardDto`. */
export interface PipelineDashboardDto {
  currencyCode: string;
  kpis: PipelineKpiDto[];
  stageConversionFunnel: FunnelStageDto[];
  pipelineByProductLine: PipelineByProductLineDto;
  quoteVolumeBySource: PipelineDonutDto;
  leadVolumeByChannel: PipelineDonutDto;
  agingByStage: AgingByStageDto;
  atRiskPipeline: AtRiskRowDto[];
  immediateActions: ImmediateActionDto[];
}

function buildPipelineQuery(filters: DashboardFiltersState): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set('from', filters.dateFrom);
  if (filters.dateTo) params.set('to', filters.dateTo);
  if (filters.productLineId != null) params.set('productLineId', String(filters.productLineId));
  if (filters.brokerId != null) params.set('brokerId', String(filters.brokerId));
  if (filters.rmUserId != null) params.set('rmUserId', String(filters.rmUserId));
  if (filters.regionId != null) params.set('regionId', String(filters.regionId));
  return params.toString();
}

/** Fetches the Pipeline & Conversion payload for the active dashboard filters (spec FR-56/AC-055). */
export function fetchPipelineDashboard(filters: DashboardFiltersState): Promise<PipelineDashboardDto> {
  const query = buildPipelineQuery(filters);
  return apiGet<PipelineDashboardDto>(`/dashboards/pipeline${query ? `?${query}` : ''}`);
}
