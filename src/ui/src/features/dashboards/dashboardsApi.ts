import { apiGet } from '../../api/client';
import type { DashboardFiltersState } from '../../app/slices/dashboardFiltersSlice';
import type { LeadListItemDto } from '../leads/leadsApi';

/**
 * Dashboard drill-through backend contract (`src/api/QuoteIQ.Api/Endpoints/DashboardEndpoints.cs`,
 * `src/api/.../Features/Dashboards/Drill/*`, T-031, spec FR-54). Fetch-wrapper module, matching the
 * established convention (`leadsApi.ts`/`tenantsApi.ts`) rather than RTK Query -- this codebase has
 * no RTK Query store configured (`app/store.ts` is a plain `configureStore`).
 */

/**
 * Wire shape of `DrillResultDto` (`src/api/.../Features/Dashboards/Drill/DrillResultDto.cs`): rows
 * are the exact same `LeadListItemDto` shape the Leads list uses (spec FR-54: "rows reuse the shared
 * Leads table"), so `DrillListPage` can render them through the unmodified `LeadsTable` component.
 */
export interface DrillResultDto {
  widgetKey: string;
  items: LeadListItemDto[];
  totalCount: number;
  page: number;
  pageSize: number;
}

function buildDrillQuery(widgetKey: string, filters: DashboardFiltersState, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  params.set('widget', widgetKey);
  if (filters.dateFrom) params.set('from', filters.dateFrom);
  if (filters.dateTo) params.set('to', filters.dateTo);
  if (filters.productLineId != null) params.set('productLineId', String(filters.productLineId));
  if (filters.brokerId != null) params.set('brokerId', String(filters.brokerId));
  if (filters.rmUserId != null) params.set('rmUserId', String(filters.rmUserId));
  if (filters.regionId != null) params.set('regionId', String(filters.regionId));
  if (page !== 1) params.set('page', String(page));
  if (pageSize !== 25) params.set('pageSize', String(pageSize));
  return params.toString();
}

/** Drills a dashboard widget through to its underlying rows (spec FR-54/AC-053: "every KPI/chart/row drills to underlying items"). */
export function fetchDrill(
  widgetKey: string,
  filters: DashboardFiltersState,
  page = 1,
  pageSize = 25,
): Promise<DrillResultDto> {
  return apiGet<DrillResultDto>(`/dashboards/drill?${buildDrillQuery(widgetKey, filters, page, pageSize)}`);
}
