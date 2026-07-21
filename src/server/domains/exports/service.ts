/**
 * The export service: authorisation, metadata, the row projections and the audit write
 * (T-039; AC-022, AC-024, AC-081, AC-082, AC-084; V-027, V-031, V-103, V-104, V-108).
 *
 * Port of `QuoteIQ.Application/Features/Exports/*` — `ExportService`, `ExportLimits`,
 * `ExportErrors`, and the three query handlers (Leads, Parties, Drill).
 *
 * FILTER PARITY IS BY CONSTRUCTION, NOT BY AGREEMENT (P-12)
 * ========================================================
 * Each export below builds the SAME filter object its list endpoint builds and calls the SAME
 * repository function (`listLeads`, `listParties`, and for the dashboard export the SAME drill
 * widget registry the on-screen chevron uses). No predicate is restated here. That matters more for
 * an export than for a list: an export is a BULK read, so a breadth or tenant mistake here leaks
 * the whole table in one file rather than 25 rows at a time. Reusing the query is what makes
 * "a caller cannot see more through an export than through the list" true structurally, instead of
 * true only while two implementations happen to agree.
 *
 * BREADTH IS SERVER-RESOLVED (AC-076(c), human ruling, ledger entry 13)
 * ====================================================================
 * `leads.view_all` narrows the export exactly as it narrows the Leads list and the drill: the flag
 * is read from the caller's resolved effective access, never from the wire. The human's ruling that
 * aggregates narrow by `leads.view_all` makes this load-bearing — if the export ignored breadth it
 * would become precisely the way around that ruling, and the most convenient one, since it hands
 * the caller every row at once.
 */
import { writeAudit } from '../audit/writer.js';
import type { JsonValue } from '../audit/types.js';
import { AppError, ForbiddenError, InternalError } from '../../lib/errors/index.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { findTenant } from '../tenants/repository.js';
import { findSettings } from '../business-rules/repository.js';
import { listItems } from '../reference-data/repository.js';
import { listLeads } from '../leads/repository.js';
import { parseLeadSort } from '../leads/service.js';
import type { ListLeadsQuery, LeadListItemDto } from '../leads/schemas.js';
import { listParties } from '../parties/repository.js';
import { parsePartySort } from '../parties/service.js';
import type { ListPartiesQuery } from '../parties/schemas.js';
import type { DashboardFilter } from '../dashboards/filters.js';
import {
  defaultDrillWidgetRegistry,
  UNKNOWN_WIDGET_CODE,
  type DrillWidgetRegistry,
} from '../dashboards/drill.service.js';
import { NotFoundError } from '../../lib/errors/index.js';
import { CSV_CONTENT_TYPE, CSV_FILE_EXTENSION, writeCsv } from './csv.js';
import { XLSX_CONTENT_TYPE, XLSX_FILE_EXTENSION, writeXlsx } from './excel.js';
import {
  formatUniversalTime,
  type ExportCell,
  type ExportColumn,
  type ExportDocument,
  type ExportFormat,
  type ExportMetadata,
} from './document.js';

/**
 * THE DOCUMENTED SYNCHRONOUS EXPORT LIMIT (Q-18, R-1).
 *
 * Exports are generated synchronously and returned in the response body, so they are bounded by
 * Vercel's ~4.5 MB response cap. A leads row renders to roughly 150-200 bytes of CSV once a party
 * name, broker name, product line, cover type, status, owner name and three dates are in it, so
 * 4.5 MB is somewhere around 23,000-30,000 rows. 20,000 is the documented cap: comfortably inside
 * the ceiling with room for unusually long tenant reference-data labels, and far above any
 * seed-scale tenant (spec FR-67).
 *
 * DELIBERATE, RECORDED DIVERGENCE FROM THE REFERENCE. `ExportLimits.MaxRows` was 100,000 and was
 * used as the PAGE SIZE of the underlying query, with no check afterwards — so the reference
 * silently returned a TRUNCATED file for a larger result set, and .NET was streaming the response
 * rather than buffering it under a 4.5 MB cap. Both halves of that are wrong here: AC-082 requires
 * an over-limit request to fail with a documented error "rather than a truncated file", and 100,000
 * rows would blow the response cap long before reaching it. So the cap is lower AND enforced.
 *
 * ENFORCEMENT: the query runs with `pageSize = MAX_EXPORT_ROWS`, and its `totalCount` (computed by
 * the same query over the same predicate) is compared against the cap BEFORE anything is rendered.
 * A caller over the cap gets a 400 carrying `EXPORT_TOO_LARGE` and no file at all. Memory stays
 * bounded by exactly the documented limit, and no partial file can ever be mistaken for a complete
 * one. The scale path (queue-generated export stored to Storage + signed URL) is noted by Q-18 and
 * deliberately not built.
 */
export const MAX_EXPORT_ROWS = 20_000;

export const EXPORT_TOO_LARGE_CODE = 'EXPORT_TOO_LARGE';

/** `ExportErrors.CrossTenantExportForbiddenCode` (:9). */
export const CROSS_TENANT_EXPORT_FORBIDDEN_CODE = 'CROSS_TENANT_EXPORT_FORBIDDEN';

/**
 * `ExportService.ExportAuditAction` (:23) — kept as the reference's bare `export` rather than
 * renamed to this port's dotted convention, because the ENTITY TYPE beside it (`lead`, `party`,
 * `dashboard`) already carries the domain and because it is the string the reference's own audit
 * consumers grep for. Flagged in the task file as the one non-dotted action in the port.
 */
export const EXPORT_ACTION = 'export';

export interface ExportsDeps {
  readonly db: DbExecutor;
  /** Overridable for tests, exactly as `DashboardsDeps.drillWidgets` is. */
  readonly drillWidgets?: DrillWidgetRegistry;
  /**
   * The row cap, defaulting to `MAX_EXPORT_ROWS`. A TEST SEAM, and the only honest one available:
   * the over-limit path is a `must` acceptance criterion (AC-082) and seeding 20,001 leads to reach
   * it is not a test anyone would keep running, so the alternative to this seam is asserting the
   * limit at the unit level and shipping the ENDPOINT's enforcement untested. Production
   * composition roots never set it, which `auth-wiring.test.ts` pins by asserting they pass
   * `defaultExportsDeps()`.
   */
  readonly maxRows?: number;
}

/**
 * The caller facts an export needs, all resolved SERVER-SIDE by the route from the verified tenant
 * context and the per-request permission resolver. Nothing here is readable from the wire.
 */
export interface ExportActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  /** True when tenant access came from `global.view_any_tenant` rather than from membership. */
  readonly isCrossTenant: boolean;
  /** `leads.view_all` — visibility BREADTH, applied inside the shared queries. */
  readonly canViewAllLeads: boolean;
  /** `global.cross_tenant_export` — the Internal-only gate below. */
  readonly canExportCrossTenant: boolean;
}

/** A rendered export, ready for the route to stream back. */
export interface ExportFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export function exportTooLargeError(totalCount: number, maxRows: number): AppError {
  return new AppError(
    400,
    `This export would contain ${String(totalCount)} rows, which exceeds the synchronous export ` +
      `limit of ${String(maxRows)} rows. Narrow the filters and try again.`,
    { code: EXPORT_TOO_LARGE_CODE },
  );
}

/** The effective cap for this request: the deps override if present, else the documented limit. */
function rowCap(deps: ExportsDeps): number {
  return deps.maxRows ?? MAX_EXPORT_ROWS;
}

/**
 * `ExportService.AuthorizeAsync` (:70-84) — THE CROSS-TENANT EXPORT GATE (AC-084, V-108).
 *
 * The entity's own export permission (`leads.export`, `parties.export`) is enforced at the route by
 * `requirePermission`. This is the SEPARATE, narrower gate: when the request runs under a
 * cross-tenant context — an Internal user who reached this tenant through
 * `global.view_any_tenant` rather than through membership — bulk-extracting its records
 * additionally requires `global.cross_tenant_export`. Reading a tenant you oversee and walking out
 * with a file of its book are not the same act, and the reference separates them for that reason.
 *
 * It cannot live in `requirePermission`, because whether the request IS cross-tenant is only known
 * after the tenant middleware has resolved membership.
 */
export function assertExportAuthorized(actor: ExportActor): void {
  if (actor.isCrossTenant && !actor.canExportCrossTenant) {
    throw new ForbiddenError(
      'Cross-tenant export requires the global.cross_tenant_export permission.',
      { code: CROSS_TENANT_EXPORT_FORBIDDEN_CODE },
    );
  }
}

/**
 * `ExportService.BuildMetadataAsync` (:87-101): tenant name + tenant display currency.
 *
 * EXPORTED for T-040. The reports domain builds its FR-65 header block from this exact function —
 * the reference did the same (`GetReportViewQuery.cs:47`, `GetReportCsvQuery.cs:80`) — so a printed
 * report's header and an export file's header are one definition, not two that agree today.
 */
export async function buildMetadata(
  deps: ExportsDeps,
  actor: ExportActor,
  dataPeriod: string,
  filtersEcho: readonly string[],
  now: Date,
): Promise<ExportMetadata> {
  const [tenant, settings] = await Promise.all([
    findTenant(deps.db, actor.tenantId),
    findSettings(deps.db, actor.tenantId),
  ]);

  if (settings === undefined) {
    // A tenant with no settings row is a provisioning failure. Falling back to a hard-coded
    // currency would label every amount in a financial export with a currency nobody chose, which
    // is worse than failing: the file would look authoritative and be wrong.
    throw new InternalError(
      `Tenant ${String(actor.tenantId)} has no tenant_settings row; refusing to label an export with an unknown currency.`,
    );
  }

  return {
    tenantName: tenant?.name ?? 'tenant',
    generatedAt: now,
    dataPeriod,
    currency: settings.currencyCode,
    lastRefreshed: formatUniversalTime(now),
    filtersEcho,
  };
}

/** `ExportService.Slugify` (:129-148): lowercase, non-alphanumeric runs collapsed to one hyphen. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug === '' ? 'tenant' : slug;
}

/** `{tenant}-{entity}-{yyyyMMdd}.{ext}` (`ExportService.BuildFileName`, :126). */
function buildFileName(
  tenantName: string,
  entitySlug: string,
  generatedAt: Date,
  extension: string,
): string {
  const stamp = generatedAt.toISOString().slice(0, 10).replaceAll('-', '');
  return `${slugify(tenantName)}-${entitySlug}-${stamp}.${extension}`;
}

/**
 * `ExportService.RenderAndAuditAsync` (:107-124): render, audit, return.
 *
 * THE AUDIT ROW IS WRITTEN FOR EVERY EXPORT, not only cross-tenant ones (AC-024/V-031), and it
 * records the scope the file covers: the format, the row count, the caller, the tenant, and the
 * exact filter summary. That is what makes "who took what out of this tenant, and when" answerable
 * after the fact — the property AC-084 asks for specifically, and the reason an export is treated
 * as a privileged operation rather than as just another read.
 *
 * EXPORTED for T-040, and this is the load-bearing reuse of that task. A report CSV goes through
 * THIS function, so it gets the same `writeCsv` — and therefore the ONE formula-injection guard
 * (`document.ts`) that is already pinned from both directions by mutation — the same CRLF line
 * endings, the same metadata header block, the same filename convention and the same audit row. A
 * second guard written for reports is how one of the two drifts, and the drifting one is always the
 * copy nobody is testing.
 */
export async function renderAndAudit(
  deps: ExportsDeps,
  actor: ExportActor,
  document: ExportDocument,
  format: ExportFormat,
  entitySlug: string,
  auditEntityType: string,
  filterSummary: JsonValue,
): Promise<ExportFile> {
  const content = format === 'xlsx' ? await writeXlsx(document) : writeCsv(document);
  const contentType = format === 'xlsx' ? XLSX_CONTENT_TYPE : CSV_CONTENT_TYPE;
  const extension = format === 'xlsx' ? XLSX_FILE_EXTENSION : CSV_FILE_EXTENSION;

  await writeAudit(deps.db, {
    entityType: auditEntityType,
    entityId: entitySlug,
    action: EXPORT_ACTION,
    actorUserId: actor.userId,
    tenantId: Number(actor.tenantId),
    after: {
      format: extension,
      rowCount: document.rows.length,
      crossTenant: actor.isCrossTenant,
      filters: filterSummary,
    },
  });

  return {
    fileName: buildFileName(document.metadata.tenantName, entitySlug, document.metadata.generatedAt, extension),
    contentType,
    content,
  };
}

/** `DescribePeriod` (ExportLeadsQueryHandler.cs:158-168), shared by all three exports. */
function describePeriod(from: string | undefined, to: string | undefined): string {
  if (from === undefined && to === undefined) return 'All time';
  return `${from ?? '…'} to ${to ?? '…'}`;
}

function ownerName(row: LeadListItemDto): string | null {
  return row.owner === null ? null : `${row.owner.firstName} ${row.owner.lastName}`;
}

// ---------------------------------------------------------------------------------------------
// Leads list export.
// ---------------------------------------------------------------------------------------------

/** `ExportLeadsQueryHandler.Columns` (:88-102), caption for caption and in order (A-3). */
const LEAD_COLUMNS: readonly ExportColumn[] = [
  { header: 'Lead ref', type: 'text' },
  { header: 'Party', type: 'text' },
  { header: 'Broker', type: 'text' },
  { header: 'Product line', type: 'text' },
  { header: 'Cover type', type: 'text' },
  { header: 'Premium', type: 'number' },
  { header: 'Status', type: 'text' },
  { header: 'Priority', type: 'text' },
  { header: 'Date received', type: 'date' },
  { header: 'Age (days)', type: 'number' },
  { header: 'Owner', type: 'text' },
  { header: 'Next follow-up', type: 'date' },
];

function leadRow(row: LeadListItemDto): readonly ExportCell[] {
  return [
    row.leadRef,
    row.partyName,
    row.brokerName,
    row.productLineName,
    row.coverTypeName,
    row.premium,
    row.statusName,
    row.priority,
    row.dateReceived,
    row.ageDays,
    ownerName(row),
    row.nextFollowUpDate,
  ];
}

/** `ExportLeadsQueryHandler.BuildFiltersEcho` (:121-156). */
function leadFiltersEcho(query: ListLeadsQuery): readonly string[] {
  const echo: string[] = [];
  if (query.status !== undefined && query.status.length > 0) {
    echo.push(`Status ids: ${query.status.join(', ')}`);
  }
  if (query.ownerUserId !== undefined) echo.push(`Owner id: ${String(query.ownerUserId)}`);
  if (query.brokerId !== undefined) echo.push(`Broker id: ${String(query.brokerId)}`);
  if (query.productLineId !== undefined) echo.push(`Product line id: ${String(query.productLineId)}`);
  if (query.regionId !== undefined) echo.push(`Region id: ${String(query.regionId)}`);
  if (query.requestChannelId !== undefined) echo.push(`Channel id: ${String(query.requestChannelId)}`);
  if (query.myLeads === true) echo.push('My leads only');
  if (query.search !== undefined && query.search.trim() !== '') echo.push(`Search: ${query.search}`);
  return echo.length === 0 ? ['None'] : echo;
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function exportLeads(
  deps: ExportsDeps,
  query: ListLeadsQuery,
  actor: ExportActor,
  format: ExportFormat,
  now: Date = new Date(),
): Promise<ExportFile> {
  assertExportAuthorized(actor);
  const maxRows = rowCap(deps);

  // The SAME filter shape `listLeadsForTenant` builds, against the SAME repository function —
  // paging replaced by the export cap, breadth resolved server-side (see the file header).
  const { items, totalCount } = await listLeads(
    deps.db,
    actor.tenantId,
    {
      statusIds: query.status,
      ownerUserId: query.ownerUserId,
      brokerId: query.brokerId,
      productLineId: query.productLineId,
      regionId: query.regionId,
      requestChannelId: query.requestChannelId,
      dateReceivedFrom: query.dateReceivedFrom,
      dateReceivedTo: query.dateReceivedTo,
      myLeadsOnly: query.myLeads ?? false,
      callerUserId: actor.userId,
      callerHasViewAll: actor.canViewAllLeads,
      search: query.search,
      sort: parseLeadSort(query.sort),
      page: 1,
      pageSize: maxRows,
    },
    todayUtc(now),
  );

  if (totalCount > maxRows) throw exportTooLargeError(totalCount, maxRows);

  const metadata = await buildMetadata(
    deps,
    actor,
    describePeriod(query.dateReceivedFrom, query.dateReceivedTo),
    leadFiltersEcho(query),
    now,
  );

  const document: ExportDocument = {
    title: 'Leads export',
    metadata,
    columns: LEAD_COLUMNS,
    rows: items.map(leadRow),
  };

  return await renderAndAudit(deps, actor, document, format, 'leads', 'lead', {
    statusIds: query.status ?? null,
    ownerUserId: query.ownerUserId ?? null,
    brokerId: query.brokerId ?? null,
    productLineId: query.productLineId ?? null,
    regionId: query.regionId ?? null,
    requestChannelId: query.requestChannelId ?? null,
    dateReceivedFrom: query.dateReceivedFrom ?? null,
    dateReceivedTo: query.dateReceivedTo ?? null,
    myLeadsOnly: query.myLeads ?? false,
    search: query.search ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// Parties list export.
// ---------------------------------------------------------------------------------------------

/** `ExportPartiesQueryHandler.Columns` (:106-117). */
const PARTY_COLUMNS: readonly ExportColumn[] = [
  { header: 'Name', type: 'text' },
  { header: 'Type', type: 'text' },
  { header: 'Segment', type: 'text' },
  { header: 'Industry', type: 'text' },
  { header: 'Region', type: 'text' },
  { header: 'Strategic', type: 'text' },
  { header: 'Open leads', type: 'number' },
  { header: 'Total leads', type: 'number' },
  { header: 'Last activity', type: 'date' },
];

/** `ExportPartiesQueryHandler.BuildFiltersEcho` (:129-165). */
function partyFiltersEcho(query: ListPartiesQuery): readonly string[] {
  const echo: string[] = [];
  if (query.search !== undefined && query.search.trim() !== '') echo.push(`Search: ${query.search}`);
  if (query.partyTypeId !== undefined) echo.push(`Type id: ${String(query.partyTypeId)}`);
  if (query.segmentId !== undefined) echo.push(`Segment id: ${String(query.segmentId)}`);
  if (query.industryId !== undefined) echo.push(`Industry id: ${String(query.industryId)}`);
  if (query.regionId !== undefined) echo.push(`Region id: ${String(query.regionId)}`);
  if (query.strategic !== undefined) echo.push(`Strategic: ${query.strategic ? 'Yes' : 'No'}`);
  return echo.length === 0 ? ['None'] : echo;
}

/**
 * `NameMapAsync` (:119-123): id -> display name for one reference list, DISABLED INCLUDED.
 *
 * `includeDisabled: true` is not incidental. A disabled reference value must remain displayable for
 * the historical records that still carry it (CLAUDE.md); dropping it would silently blank the
 * Segment column of every older party instead of showing the value it actually has.
 */
async function nameMap(
  deps: ExportsDeps,
  tenantId: TenantId,
  listType: string,
): Promise<ReadonlyMap<number, string>> {
  const items = await listItems(deps.db, tenantId, listType, true);
  return new Map(items.map((item) => [item.id, item.name]));
}

export async function exportParties(
  deps: ExportsDeps,
  query: ListPartiesQuery,
  actor: ExportActor,
  format: ExportFormat,
  now: Date = new Date(),
): Promise<ExportFile> {
  assertExportAuthorized(actor);
  const maxRows = rowCap(deps);

  const { items, totalCount } = await listParties(deps.db, actor.tenantId, {
    search: query.search,
    partyTypeId: query.partyTypeId,
    segmentId: query.segmentId,
    industryId: query.industryId,
    regionId: query.regionId,
    strategic: query.strategic,
    sort: parsePartySort(query.sort),
    page: 1,
    pageSize: maxRows,
  });

  if (totalCount > maxRows) throw exportTooLargeError(totalCount, maxRows);

  // Four lookups, each ONE query over a small tenant-scoped list, resolved before the row loop.
  // Resolving a name per party would be the N+1 this file's header warns about, and an export is
  // where it bites hardest because it runs over the whole filtered set rather than one page.
  const [partyTypes, segments, industries, regions] = await Promise.all([
    nameMap(deps, actor.tenantId, 'party_type'),
    nameMap(deps, actor.tenantId, 'party_segment'),
    nameMap(deps, actor.tenantId, 'industry'),
    nameMap(deps, actor.tenantId, 'region'),
  ]);

  const lookup = (map: ReadonlyMap<number, string>, id: number | null): string | null =>
    id === null ? null : (map.get(id) ?? null);

  const metadata = await buildMetadata(deps, actor, 'All time', partyFiltersEcho(query), now);

  const document: ExportDocument = {
    title: 'Parties export',
    metadata,
    columns: PARTY_COLUMNS,
    rows: items.map((party) => [
      party.name,
      lookup(partyTypes, party.partyTypeId),
      lookup(segments, party.segmentId),
      lookup(industries, party.industryId),
      lookup(regions, party.regionId),
      party.isStrategic ? 'Yes' : 'No',
      party.openLeadsCount,
      party.totalLeadsCount,
      party.lastActivityAt === null ? null : party.lastActivityAt.slice(0, 10),
    ]),
  };

  return await renderAndAudit(deps, actor, document, format, 'parties', 'party', {
    search: query.search ?? null,
    partyTypeId: query.partyTypeId ?? null,
    segmentId: query.segmentId ?? null,
    industryId: query.industryId ?? null,
    regionId: query.regionId ?? null,
    strategic: query.strategic ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// Dashboard (drill) export.
// ---------------------------------------------------------------------------------------------

/** `ExportDrillQueryHandler.Columns` (:87-100) — the lead columns WITHOUT `Next follow-up`. */
const DRILL_COLUMNS: readonly ExportColumn[] = LEAD_COLUMNS.slice(0, 11);

/** `ExportDrillQueryHandler.BuildFiltersEcho` (:106-131). */
function drillFiltersEcho(widget: string, filter: DashboardFilter): readonly string[] {
  const echo: string[] = [`Widget: ${widget}`];
  if (filter.productLineId !== undefined) echo.push(`Product line id: ${String(filter.productLineId)}`);
  if (filter.brokerId !== undefined) echo.push(`Broker id: ${String(filter.brokerId)}`);
  if (filter.rmUserId !== undefined) echo.push(`RM id: ${String(filter.rmUserId)}`);
  if (filter.regionId !== undefined) echo.push(`Region id: ${String(filter.regionId)}`);
  return echo;
}

export interface DashboardExportRequest {
  readonly widget: string;
  readonly filter: DashboardFilter;
}

export async function exportDashboard(
  deps: ExportsDeps,
  request: DashboardExportRequest,
  actor: ExportActor,
  format: ExportFormat,
  now: Date = new Date(),
): Promise<ExportFile> {
  // THE SAME REGISTRY THE ON-SCREEN DRILL RESOLVES AGAINST (T-035/T-050). A private widget map here
  // would be a second population per widget key, and the two would diverge the first time either
  // side changed — which is exactly the failure the drill layer already suffered once.
  const registry = deps.drillWidgets ?? defaultDrillWidgetRegistry();
  const rowQuery = registry.get(request.widget);
  if (rowQuery === undefined) {
    throw new NotFoundError(`Unknown drill widget '${request.widget}'.`, {
      code: UNKNOWN_WIDGET_CODE,
    });
  }

  assertExportAuthorized(actor);
  const maxRows = rowCap(deps);

  const { items, totalCount } = await rowQuery({
    db: deps.db,
    tenantId: actor.tenantId,
    filter: request.filter,
    caller: { callerUserId: actor.userId, callerHasViewAll: actor.canViewAllLeads },
    page: 1,
    pageSize: maxRows,
    today: todayUtc(now),
  });

  if (totalCount > maxRows) throw exportTooLargeError(totalCount, maxRows);

  const metadata = await buildMetadata(
    deps,
    actor,
    describePeriod(request.filter.from, request.filter.to),
    drillFiltersEcho(request.widget, request.filter),
    now,
  );

  const document: ExportDocument = {
    title: `Dashboard export (${request.widget})`,
    metadata,
    columns: DRILL_COLUMNS,
    rows: items.map((row) => leadRow(row).slice(0, 11)),
  };

  return await renderAndAudit(
    deps,
    actor,
    document,
    format,
    request.widget.replaceAll('.', '-'),
    'dashboard',
    {
      widgetKey: request.widget,
      from: request.filter.from ?? null,
      to: request.filter.to ?? null,
      productLineId: request.filter.productLineId ?? null,
      brokerId: request.filter.brokerId ?? null,
      rmUserId: request.filter.rmUserId ?? null,
      regionId: request.filter.regionId ?? null,
    },
  );
}
