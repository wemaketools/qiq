import { apiGet } from '../../api/client';
import type { DashboardFiltersState } from '../../app/slices/dashboardFiltersSlice';

/**
 * Loss Analysis dashboard backend contract (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`
 * `GET /api/v1/dashboards/loss-analysis`, `src/api/.../Features/Dashboards/LossAnalysis/*`, T-036,
 * spec FR-59/AC-058/PRD 16). Fetch-wrapper module matching the established convention
 * (`brokersApi.ts`/`rmApi.ts`) rather than RTK Query — this codebase has no RTK Query store.
 */

export type KpiGoodDirection = 'higherIsBetter' | 'lowerIsBetter';
/** Loss KPIs add a `text` kind for the categorical Top Loss Reason / Top Competitor cards (their value is a name, not a number). */
export type LossKpiKind = 'currency' | 'percent' | 'count' | 'text';
export type LeadOrQuote = 'lead' | 'quote';

/** Wire shape of `LossKpiDto`. There is deliberately NO Win-back Potential card (spec §2 / PRD 16.0 exclusion). */
export interface LossKpiDto {
  key: string;
  label: string;
  leadOrQuote: LeadOrQuote;
  kind: LossKpiKind;
  value: number | null;
  textValue: string | null;
  delta: number | null;
  goodDirection: KpiGoodDirection;
  isFavorableDelta: boolean | null;
  drillWidgetKey: string;
}

/** Wire shape of `LostPremiumByReasonRowDto` (a red horizontal bar: a lost reason and the premium lost under it). */
export interface LostPremiumByReasonRowDto {
  reasonName: string;
  amount: number;
  drillWidgetKey: string;
}

export interface LostPremiumByReasonDto {
  rows: LostPremiumByReasonRowDto[];
  drillWidgetKey: string;
}

/** Wire shape of `LossTrendPointDto` (one month of the six-month Lost Premium Trend). */
export interface LossTrendPointDto {
  monthLabel: string;
  amount: number;
}

export interface LossTrendDto {
  points: LossTrendPointDto[];
  drillWidgetKey: string;
}

/** Wire shape of `LostPremiumByProductLineRowDto` (an amber horizontal bar: a product line and the premium lost under it). */
export interface LostPremiumByProductLineRowDto {
  productLineName: string;
  amount: number;
  drillWidgetKey: string;
}

export interface LostPremiumByProductLineDto {
  rows: LostPremiumByProductLineRowDto[];
  drillWidgetKey: string;
}

/** Wire shape of `CompetitorAnalysisRowDto` (a competitor we lost business to: deals, premium lost, mean price gap). */
export interface CompetitorAnalysisRowDto {
  competitor: string;
  dealsLost: number;
  premiumLost: number;
  avgPriceGapPct: number | null;
  drillWidgetKey: string;
}

export interface CompetitorAnalysisDto {
  rows: CompetitorAnalysisRowDto[];
  drillWidgetKey: string;
}

/** Wire shape of `LossCommentaryItemDto` (a recent lost-business note: client + product line, comment, reason chip, premium). */
export interface LossCommentaryItemDto {
  leadId: number;
  client: string;
  productLineName: string;
  comment: string | null;
  lossReasonName: string;
  lossReasonTone: string;
  premium: number;
  drillWidgetKey: string;
}

export interface LossCommentaryDto {
  items: LossCommentaryItemDto[];
}

/** Wire shape of `LossAnalysisDto`. */
export interface LossAnalysisDto {
  currencyCode: string;
  kpis: LossKpiDto[];
  lostPremiumByReason: LostPremiumByReasonDto;
  lostPremiumTrend: LossTrendDto;
  lostPremiumByProductLine: LostPremiumByProductLineDto;
  competitorAnalysis: CompetitorAnalysisDto;
  lossCommentary: LossCommentaryDto;
}

function buildLossQuery(filters: DashboardFiltersState): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set('from', filters.dateFrom);
  if (filters.dateTo) params.set('to', filters.dateTo);
  if (filters.productLineId != null) params.set('productLineId', String(filters.productLineId));
  if (filters.brokerId != null) params.set('brokerId', String(filters.brokerId));
  if (filters.rmUserId != null) params.set('rmUserId', String(filters.rmUserId));
  if (filters.regionId != null) params.set('regionId', String(filters.regionId));
  return params.toString();
}

/** Fetches the Loss Analysis payload for the active dashboard filters (spec FR-59/AC-058). */
export function fetchLossAnalysis(filters: DashboardFiltersState): Promise<LossAnalysisDto> {
  const query = buildLossQuery(filters);
  return apiGet<LossAnalysisDto>(`/dashboards/loss-analysis${query ? `?${query}` : ''}`);
}
