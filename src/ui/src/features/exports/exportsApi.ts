import { apiGetBlob, triggerBrowserDownload } from '../../api/client';
import type { ListLeadsParams } from '../leads/leadsApi';
import type { PartiesFilters } from '../parties/partiesFilters';

/**
 * Export backend contract (src/api/QuoteIQ.Api/Endpoints/ExportEndpoints.cs, spec FR-65, T-039):
 * `GET /exports/leads`, `GET /exports/parties`, and `GET /exports/dashboard` stream a CSV or xlsx file
 * (negotiated via `?format=csv|xlsx`) that reflects the same active filters the on-screen list/drill
 * uses. Downloads go through the shared API client's blob path (`apiGetBlob`) so bearer-token +
 * `X-Tenant-Id` injection stay in one place, then the browser's native save flow is triggered.
 */
export type ExportFormat = 'csv' | 'xlsx';

/** Builds the `/exports/leads` path carrying the active Leads-list filters + negotiated format. */
export function buildLeadsExportPath(params: ListLeadsParams, format: ExportFormat): string {
  const search = new URLSearchParams();
  if (params.statusIds && params.statusIds.length > 0) {
    search.set('status', params.statusIds.join(','));
  }
  if (params.ownerUserId != null) {
    search.set('ownerUserId', String(params.ownerUserId));
  }
  if (params.brokerId != null) {
    search.set('brokerId', String(params.brokerId));
  }
  if (params.productLineId != null) {
    search.set('productLineId', String(params.productLineId));
  }
  if (params.regionId != null) {
    search.set('regionId', String(params.regionId));
  }
  if (params.requestChannelId != null) {
    search.set('requestChannelId', String(params.requestChannelId));
  }
  if (params.dateReceivedFrom) {
    search.set('dateReceivedFrom', params.dateReceivedFrom);
  }
  if (params.dateReceivedTo) {
    search.set('dateReceivedTo', params.dateReceivedTo);
  }
  if (params.myLeads) {
    search.set('myLeads', 'true');
  }
  if (params.search) {
    search.set('search', params.search);
  }
  if (params.sort) {
    search.set('sort', params.sort);
  }
  search.set('format', format);
  return `/exports/leads?${search.toString()}`;
}

/** Builds the `/exports/parties` path carrying the active Parties-list filters + negotiated format. */
export function buildPartiesExportPath(filters: PartiesFilters, format: ExportFormat): string {
  const search = new URLSearchParams();
  if (filters.search) {
    search.set('search', filters.search);
  }
  if (filters.partyTypeId != null) {
    search.set('partyTypeId', String(filters.partyTypeId));
  }
  if (filters.segmentId != null) {
    search.set('segmentId', String(filters.segmentId));
  }
  if (filters.industryId != null) {
    search.set('industryId', String(filters.industryId));
  }
  if (filters.regionId != null) {
    search.set('regionId', String(filters.regionId));
  }
  if (filters.strategicOnly) {
    search.set('strategic', 'true');
  }
  search.set('format', format);
  return `/exports/parties?${search.toString()}`;
}

/** One dashboard filter query param set (mirrors `DashboardFilter`, spec FR-54). */
export interface DashboardExportFilter {
  from?: string | null;
  to?: string | null;
  productLineId?: number | null;
  brokerId?: number | null;
  rmUserId?: number | null;
  regionId?: number | null;
  teamOrRmId?: number | null;
  brokerTypeId?: number | null;
}

/** Maps the shared dashboard filter-bar state (`DashboardFiltersState`) onto the export filter query shape. */
export function dashboardFiltersToExportFilter(filters: {
  dateFrom: string | null;
  dateTo: string | null;
  productLineId: number | null;
  brokerId: number | null;
  rmUserId: number | null;
  regionId: number | null;
  teamOrRmId: number | null;
  brokerTypeId: number | null;
}): DashboardExportFilter {
  return {
    from: filters.dateFrom,
    to: filters.dateTo,
    productLineId: filters.productLineId,
    brokerId: filters.brokerId,
    rmUserId: filters.rmUserId,
    regionId: filters.regionId,
    teamOrRmId: filters.teamOrRmId,
    brokerTypeId: filters.brokerTypeId,
  };
}

/** Builds the `/exports/dashboard` path for a widget key + active dashboard filter + negotiated format. */
export function buildDashboardExportPath(widget: string, filter: DashboardExportFilter, format: ExportFormat): string {
  const search = new URLSearchParams({ widget });
  if (filter.from) {
    search.set('from', filter.from);
  }
  if (filter.to) {
    search.set('to', filter.to);
  }
  if (filter.productLineId != null) {
    search.set('productLineId', String(filter.productLineId));
  }
  if (filter.brokerId != null) {
    search.set('brokerId', String(filter.brokerId));
  }
  if (filter.rmUserId != null) {
    search.set('rmUserId', String(filter.rmUserId));
  }
  if (filter.regionId != null) {
    search.set('regionId', String(filter.regionId));
  }
  if (filter.teamOrRmId != null) {
    search.set('teamOrRmId', String(filter.teamOrRmId));
  }
  if (filter.brokerTypeId != null) {
    search.set('brokerTypeId', String(filter.brokerTypeId));
  }
  search.set('format', format);
  return `/exports/dashboard?${search.toString()}`;
}

/**
 * Downloads an export file at <paramref name="path"/> through the shared API client and hands it to the
 * browser's native save flow. The server supplies the descriptive `Content-Disposition` filename
 * (`{tenant}-{entity}-{yyyyMMdd}.{ext}`); <paramref name="fallbackFileName"/> is used only if the
 * header is absent.
 */
export async function downloadExport(path: string, fallbackFileName: string): Promise<void> {
  const file = await apiGetBlob(path);
  triggerBrowserDownload(file, fallbackFileName);
}
