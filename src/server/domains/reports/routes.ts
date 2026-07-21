/**
 * Report routes (T-040; AC-022, AC-083; V-027, V-106).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/ReportEndpoints.cs:29-33`, permission for permission:
 *
 *   GET /api/v1/reports            reports.view
 *   GET /api/v1/reports/{key}      reports.view  + the report's binding permission (in the service)
 *   GET /api/v1/reports/{key}/csv  reports.view  + the binding permission + the FR-65 export gates
 *
 * WHY THE PER-REPORT PERMISSION IS NOT ON `requirePermission`
 * ==========================================================
 * It depends on the `{key}` path segment, which the guard cannot see. So the group applies the BASE
 * `reports.view` and `authorizeReport` applies the additional one — 404 for a key that does not
 * exist, 403 for a real report the caller may not open.
 *
 * THERE IS NO `reports.export` GATE ON THE CSV, AND THAT IS MEASURED
 * =================================================================
 * `reports.export` exists in the permission catalog and `ReportEndpoints.cs:33` gates the CSV route
 * on `Reports.View`, not on it — exactly as the leads/parties export routes are gated on their own
 * `*.export` codes and the dashboard export on `leads.export`. Preserved as measured rather than
 * "corrected": adding a gate the reference does not have would 403 every existing Reports-screen
 * download button for callers who work today. FLAGGED for the orchestrator.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE. `/api/v1/reports` is not on `GLOBAL_ROUTE_PREFIXES`, so it
 * is classified tenant-scoped and the T-013 middleware demands a verified `X-Tenant-Id` before any
 * handler runs. `actorFrom` throws rather than defaulting: with RLS not adopted (Q-10) there is
 * nothing beneath the resulting predicates.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { parseExportFormat } from '../exports/routes.js';
import { parseDashboardFilter } from '../dashboards/executive.routes.js';
import type { ExportFile } from '../exports/service.js';
import {
  getReportCsv,
  getReportView,
  listReportCatalog,
  type ReportsActor,
  type ReportsDeps,
} from './service.js';

import type { Context } from 'hono';
import { z } from 'zod';

/**
 * The verified tenant, the acting user and the three SERVER-RESOLVED permission facts a report
 * needs: the per-report permission check, visibility breadth (`leads.view_all`), and the
 * cross-tenant export gate. All come from the same per-request resolver the route guard used, so the
 * guard and the queries cannot disagree about who this caller is.
 *
 * A missing tenant or resolver is a COMPOSITION fault and fails CLOSED with a 500 rather than
 * running an unscoped report. A report is a bulk read: the failure would not present as one obvious
 * foreign row but as a whole printable document of another tenant's book.
 */
async function actorFrom(c: Context<ApiEnv>): Promise<ReportsActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Report reached with no verified tenant context; refusing to run an unscoped report.',
    );
  }

  const resolveAccess = c.get('resolveAccess');
  if (resolveAccess === undefined) {
    throw new InternalError(
      'permissionResolution() middleware is not mounted; cannot evaluate report authorization.',
    );
  }

  const access = await resolveAccess(tenant.tenantId);
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    isCrossTenant: tenant.isCrossTenant,
    canViewAllLeads: access.canViewAll('leads'),
    canExportCrossTenant: access.has('global.cross_tenant_export'),
    has: (permission) => access.has(permission),
  };
}

/** `Results.File(...)` — bytes, negotiated content type, attachment disposition. */
function fileResponse(c: Context<ApiEnv>, file: ExportFile): Response {
  return c.body(file.content as unknown as ArrayBuffer, 200, {
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.fileName}"`,
    'Content-Length': String(file.content.byteLength),
  });
}

const formatQuery = z.object({ format: z.string().optional() });

export function reportRoutes(deps: ReportsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/reports', requirePermission('reports.view'), async (c) =>
    c.json(listReportCatalog(await actorFrom(c))),
  );

  routes.get('/reports/:key', requirePermission('reports.view'), async (c) =>
    c.json(
      await getReportView(deps, await actorFrom(c), c.req.param('key'), parseDashboardFilter(c)),
    ),
  );

  routes.get('/reports/:key/csv', requirePermission('reports.view'), async (c) => {
    // The SAME eight-parameter filter schema the print view parses, so a CSV cannot report a
    // different population than the view it is downloaded from (AC-083).
    const filter = parseDashboardFilter(c);
    const format = parseExportFormat(formatQuery.parse(c.req.query()).format);
    return fileResponse(
      c,
      await getReportCsv(deps, await actorFrom(c), c.req.param('key'), filter, format),
    );
  });

  return routes;
}
