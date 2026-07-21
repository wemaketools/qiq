/**
 * The reports service: authorization, the catalog, the print-ready view and the report CSV
 * (T-040; AC-022, AC-083; V-027, V-106; spec FR-64/FR-65).
 *
 * Port of `ListReportsQuery`, `ReportAuthorizer`, `GetReportViewQuery` and `GetReportCsvQuery`.
 *
 * THE REPORT CSV IS AN EXPORT, NOT A SECOND FILE WRITER
 * ====================================================
 * `getReportCsv` builds an `ExportDocument` from the composition's primary table and hands it to
 * T-039's `renderAndAudit`. That means a report CSV inherits, without restating any of it:
 *
 *   - the ONE formula-injection guard (`document.ts` — every text cell, every header, every
 *     metadata value; NOT number/date cells, deliberately, so `-500.00` stays money);
 *   - RFC-4180 CRLF line endings;
 *   - the FR-65 metadata header block;
 *   - `{tenant}-{entity}-{yyyyMMdd}.csv` filenames;
 *   - the audit row naming the actor, the tenant, the row count and the exact filters.
 *
 * Re-implementing any of that here is how the report copy and the export copy drift apart, and the
 * one that drifts is always the one with no test pointing at it.
 *
 * NO SCHEDULING EXISTS IN THIS FILE OR ANY OTHER (Q-14/A-13, spec FR-64 "No scheduling")
 * =====================================================================================
 * Reports are on demand only. There is no schedule table, no cron entry and no distribution list.
 */
import { ForbiddenError, NotFoundError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { DashboardFilter } from '../dashboards/filters.js';
import type { ExportColumn, ExportDocument, ExportFormat } from '../exports/document.js';
import {
  assertExportAuthorized,
  buildMetadata,
  renderAndAudit,
  type ExportActor,
  type ExportFile,
} from '../exports/service.js';
import type { PermissionCode } from '../rbac/permission-catalog.js';
import { REPORT_CATALOG, findReport, reportsVisibleTo, type ReportDescriptor } from './catalog.js';
import { composeReport, type ReportActor, type ReportsComposerDeps } from './composer.js';
import {
  describeReportFilters,
  describeReportPeriod,
  type ReportCatalogDto,
  type ReportColumnDto,
  type ReportViewDto,
} from './contracts.js';

/** `ReportErrors.UnknownReportCode` / `ReportForbiddenCode` (:8-9). */
export const REPORT_UNKNOWN_CODE = 'REPORT_UNKNOWN';
export const REPORT_FORBIDDEN_CODE = 'REPORT_FORBIDDEN';

/**
 * An alias rather than an extending interface: the reports service needs exactly what the composer
 * needs (`{ db }`) and nothing more. An empty extending interface would claim a distinction that
 * does not exist and invite one to be added without a reason.
 */
export type ReportsDeps = ReportsComposerDeps;

/**
 * Everything a report needs to know about its caller, ALL resolved server-side by the route from the
 * verified tenant context and the per-request permission resolver. Nothing here is readable from the
 * wire — a caller who could assert their own `canViewAllLeads` would widen every report by asking.
 */
export interface ReportsActor extends ReportActor {
  /** True when tenant access came from `global.view_any_tenant` rather than from membership. */
  readonly isCrossTenant: boolean;
  /** `global.cross_tenant_export` — the FR-65 gate on the internal report's CSV. */
  readonly canExportCrossTenant: boolean;
  /** The caller's resolved permission check, the SAME one the route guard used. */
  readonly has: (permission: PermissionCode) => boolean;
}

function exportActorFrom(actor: ReportsActor): ExportActor {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId satisfies TenantId,
    isCrossTenant: actor.isCrossTenant,
    canViewAllLeads: actor.canViewAllLeads,
    canExportCrossTenant: actor.canExportCrossTenant,
  };
}

/**
 * `ListReportsQueryHandler` (:31-41) — the caller-visible catalog.
 *
 * The permission CODE never goes on the wire: the card carries display data only. A client that
 * learned which permission gates a report it cannot open has been told something about the
 * authorization model for no benefit to the UI.
 */
export function listReportCatalog(actor: ReportsActor): ReportCatalogDto {
  return {
    reports: reportsVisibleTo(actor.has).map((report) => ({
      key: report.key,
      name: report.name,
      description: report.description,
      icon: report.icon,
      audience: report.audience,
    })),
  };
}

/**
 * `ReportAuthorizer.AuthorizeAsync` (:31-47) — resolve the key, then enforce its binding permission.
 *
 * UNKNOWN vs FORBIDDEN are different answers on purpose: a key that is not in the catalog is a 404
 * ("there is no such report"), while a real report the caller may not open is a 403. Collapsing them
 * would be defensible as enumeration-hardening, but the catalog is public to any `reports.view`
 * holder anyway, and the reference distinguishes them.
 *
 * The base `reports.view` gate lives at the route; this is the ADDITIONAL per-report permission,
 * which `requirePermission` cannot apply because it depends on the `{key}` path segment.
 */
export function authorizeReport(actor: ReportsActor, key: string): ReportDescriptor {
  const descriptor = findReport(key);
  if (descriptor === undefined) {
    throw new NotFoundError(`Unknown report '${key}'.`, { code: REPORT_UNKNOWN_CODE });
  }

  if (descriptor.permission !== null && !actor.has(descriptor.permission)) {
    throw new ForbiddenError(
      `You do not have permission to open the '${key}' report.`,
      { code: REPORT_FORBIDDEN_CODE },
    );
  }

  return descriptor;
}

/**
 * `GetReportViewQueryHandler` (:33-56) — the print-ready payload.
 *
 * The header block comes from the SHARED export metadata builder, so the print view and the CSV of
 * the same report under the same filter carry byte-identical tenant/period/currency lines.
 */
export async function getReportView(
  deps: ReportsDeps,
  actor: ReportsActor,
  key: string,
  filter: DashboardFilter,
  now: Date = new Date(),
): Promise<ReportViewDto> {
  const descriptor = authorizeReport(actor, key);

  const content = await composeReport(deps, actor, key, filter, now);

  const dataPeriod = describeReportPeriod(filter);
  const filtersEcho = describeReportFilters(filter);
  const metadata = await buildMetadata(deps, exportActorFrom(actor), dataPeriod, filtersEcho, now);

  return {
    key: descriptor.key,
    name: descriptor.name,
    header: {
      tenantName: metadata.tenantName,
      reportDate: metadata.generatedAt.toISOString(),
      dataPeriod: metadata.dataPeriod,
      currency: metadata.currency,
      lastRefreshed: metadata.lastRefreshed,
      filtersEcho: metadata.filtersEcho,
    },
    sections: content.sections,
  };
}

/** `ToExportColumn` (GetReportCsvQuery.cs:97-104) — the report column types ARE the export ones. */
function toExportColumn(column: ReportColumnDto): ExportColumn {
  return { header: column.header, type: column.type };
}

/**
 * `GetReportCsvQueryHandler` (:36-95) — the report's primary table as a CSV/XLSX download.
 *
 * TWO GATES, NOT ONE, FOR THE CROSS-TENANT REPORT (spec FR-65, AC-084):
 *   1. `global.cross_tenant_reporting` to OPEN it at all (the descriptor's binding permission), and
 *   2. `global.cross_tenant_export` to walk out with a FILE of it.
 * Reading a set of tenants you oversee and extracting them to a spreadsheet are different acts, and
 * the reference separates them deliberately. `assertExportAuthorized` then applies the third,
 * orthogonal gate: a request running under a cross-tenant TENANT CONTEXT needs the export grant too.
 */
export async function getReportCsv(
  deps: ReportsDeps,
  actor: ReportsActor,
  key: string,
  filter: DashboardFilter,
  format: ExportFormat,
  now: Date = new Date(),
): Promise<ExportFile> {
  const descriptor = authorizeReport(actor, key);

  if (descriptor.isCrossTenant && !actor.canExportCrossTenant) {
    throw new ForbiddenError(
      'Cross-tenant export requires the global.cross_tenant_export permission.',
      { code: 'CROSS_TENANT_EXPORT_FORBIDDEN' },
    );
  }

  assertExportAuthorized(exportActorFrom(actor));

  const content = await composeReport(deps, actor, key, filter, now);
  const primaryTable = content.primaryTable;
  if (primaryTable === null) {
    // Unreachable for every catalogued report — each composition sets one — and asserted as such by
    // rendering all ten CSVs in `reports.test.ts`. Kept because the reference has the same guard and
    // because a future report that forgot its primary table must fail loudly, not emit an empty file.
    throw new NotFoundError(`Report '${key}' has no exportable table.`, {
      code: REPORT_UNKNOWN_CODE,
    });
  }

  const dataPeriod = describeReportPeriod(filter);
  const filtersEcho = describeReportFilters(filter);
  const metadata = await buildMetadata(deps, exportActorFrom(actor), dataPeriod, filtersEcho, now);

  const document: ExportDocument = {
    title: `${descriptor.name} — ${primaryTable.title}`,
    metadata,
    columns: primaryTable.columns.map(toExportColumn),
    rows: primaryTable.rows,
  };

  return await renderAndAudit(
    deps,
    exportActorFrom(actor),
    document,
    format,
    descriptor.key,
    'report',
    { report: descriptor.key, dataPeriod, filters: [...filtersEcho] },
  );
}

export { REPORT_CATALOG };
