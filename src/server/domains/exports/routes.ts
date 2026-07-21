/**
 * Export routes (T-039; AC-022, AC-081, AC-082, AC-084; V-103, V-104, V-108).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/ExportEndpoints.cs:33-37`, permission for permission:
 *
 *   GET /api/v1/exports/leads      leads.export
 *   GET /api/v1/exports/parties    parties.export
 *   GET /api/v1/exports/dashboard  leads.export
 *
 * WHY THE DASHBOARD EXPORT IS GATED ON `leads.export` AND NOT A DASHBOARD PERMISSION
 * =================================================================================
 * Measured (ExportEndpoints.cs:24-30). Its rows ARE lead records — the same rows the on-screen
 * drill returns — so it must require exactly what exporting the Leads list requires. A dashboard
 * permission here would make the dashboard export a way to extract leads without `leads.export`.
 *
 * THERE IS NO `/exports/quotes`, DELIBERATELY. Quotes are lead-subordinate with no top-level list
 * (spec FR-45), so the reference exposes no tenant-wide quote export; quote detail behind a
 * dashboard summary comes out through `/exports/dashboard`. `quotes.export` exists in the catalog
 * and gates nothing here, exactly as in the reference.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE. `/api/v1/exports` is not on `GLOBAL_ROUTE_PREFIXES`, so
 * it is classified tenant-scoped and the T-013 middleware demands a verified `X-Tenant-Id` before
 * any handler runs. `actorFrom` throws rather than defaulting — with RLS not adopted (Q-10) there
 * is nothing beneath the resulting predicates, and an unscoped BULK read is the worst possible
 * shape for that mistake to take.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError, ValidationError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { dashboardFilterSchema } from '../dashboards/filters.js';
import { listLeadsQuerySchema } from '../leads/schemas.js';
import { listPartiesQuerySchema } from '../parties/schemas.js';
import type { ExportFormat } from './document.js';
import {
  exportDashboard,
  exportLeads,
  exportParties,
  type ExportActor,
  type ExportFile,
  type ExportsDeps,
} from './service.js';

import type { Context } from 'hono';
import { z } from 'zod';

/**
 * `ParseFormat` (ExportEndpoints.cs:88-92): `xlsx` or `excel` selects Excel; ANYTHING else,
 * including an omitted or misspelled value, falls back to CSV rather than erroring. Preserved as
 * measured — a stale bookmark still downloads a usable file.
 */
export function parseExportFormat(format: string | undefined): ExportFormat {
  const normalized = format?.toLowerCase();
  return normalized === 'xlsx' || normalized === 'excel' ? 'xlsx' : 'csv';
}

/**
 * The verified tenant, the acting user, and the two SERVER-RESOLVED permission facts an export
 * needs: visibility breadth (`leads.view_all`) and the cross-tenant export gate
 * (`global.cross_tenant_export`). Both are read from the same per-request resolver the route guard
 * used, so the guard and the query cannot disagree about who this caller is.
 *
 * A missing tenant or resolver is a composition fault and fails CLOSED with a 500 rather than
 * running an unscoped or unfiltered bulk extract.
 */
async function actorFrom(c: Context<ApiEnv>): Promise<ExportActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Export reached with no verified tenant context; refusing to run an unscoped bulk read.',
    );
  }

  const resolveAccess = c.get('resolveAccess');
  if (resolveAccess === undefined) {
    throw new InternalError(
      'permissionResolution() middleware is not mounted; cannot evaluate export authorization.',
    );
  }

  const access = await resolveAccess(tenant.tenantId);
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    isCrossTenant: tenant.isCrossTenant,
    canViewAllLeads: access.canViewAll('leads'),
    canExportCrossTenant: access.has('global.cross_tenant_export'),
  };
}

/**
 * `Results.File(...)` — the bytes, the negotiated content type, and an attachment disposition so
 * the browser downloads rather than renders. The filename is quoted because it can contain spaces
 * once a tenant name is slugified into it.
 */
function fileResponse(c: Context<ApiEnv>, file: ExportFile): Response {
  return c.body(file.content as unknown as ArrayBuffer, 200, {
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.fileName}"`,
    'Content-Length': String(file.content.byteLength),
  });
}

const formatQuery = z.object({ format: z.string().optional() });

export function exportRoutes(deps: ExportsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/exports/leads', requirePermission('leads.export'), async (c) => {
    // THE SAME SCHEMA the Leads list parses its filters with, so the export cannot drift from the
    // list it claims to mirror (P-12). `page`/`pageSize` are accepted and IGNORED: an export is the
    // whole filtered set by definition, bounded by MAX_EXPORT_ROWS rather than by the caller.
    const parsed = listLeadsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new ValidationError(toFieldErrors(parsed.error), { status: 400 });
    }

    const format = parseExportFormat(formatQuery.parse(c.req.query()).format);
    return fileResponse(c, await exportLeads(deps, parsed.data, await actorFrom(c), format));
  });

  routes.get('/exports/parties', requirePermission('parties.export'), async (c) => {
    const parsed = listPartiesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new ValidationError(toFieldErrors(parsed.error), { status: 400 });
    }

    const format = parseExportFormat(formatQuery.parse(c.req.query()).format);
    return fileResponse(c, await exportParties(deps, parsed.data, await actorFrom(c), format));
  });

  routes.get('/exports/dashboard', requirePermission('leads.export'), async (c) => {
    // `widget` is REQUIRED (:75-81): a missing one is 400 "you asked wrong", while a well-formed
    // but unregistered key is the 404 the service raises — "there is no such chart".
    const parsed = dashboardFilterSchema
      .extend({
        widget: z
          .string({ message: "EXPORT_WIDGET_REQUIRED|The 'widget' query parameter is required." })
          .trim()
          .min(1, { message: "EXPORT_WIDGET_REQUIRED|The 'widget' query parameter is required." }),
      })
      .safeParse(c.req.query());
    if (!parsed.success) {
      throw new ValidationError(toFieldErrors(parsed.error), {
        status: 400,
        code: 'DASHBOARD_FILTER_INVALID',
      });
    }

    const { widget, ...filter } = parsed.data;
    const format = parseExportFormat(formatQuery.parse(c.req.query()).format);
    return fileResponse(
      c,
      await exportDashboard(deps, { widget, filter }, await actorFrom(c), format),
    );
  });

  return routes;
}
