/**
 * The drill-through service and widget registry (T-035; AC-076; V-095; spec FR-54, AC-053).
 *
 * Port of `GetDrillQueryHandler.cs`, `DrillWidgetRegistry.cs`, `IDrillRowQuery.cs`,
 * `LeadFilterDrillRowQuery.cs` and `DrillResultDto.cs`.
 *
 * WHAT A DRILL IS FOR, AND WHY IT IS ONE ENDPOINT
 * ==============================================
 * Every dashboard cell is a number over a population. The drill answers "which records ARE that
 * number" — so its whole correctness condition (AC-076) is that the rows it returns are exactly
 * the population the aggregate counted, under the same filters and the same visibility breadth.
 * That is why there is one endpoint with a widget REGISTRY rather than a drill route per
 * dashboard: the shared filter parsing, the breadth resolution and the row projection happen once,
 * and a new widget contributes only its own population query.
 *
 * BREADTH IS RESOLVED SERVER-SIDE, NEVER READ FROM THE WIRE
 * ========================================================
 * `GetDrillQueryHandler.cs:52-56` resolves the caller's effective permissions itself and derives
 * `callerHasViewAll` from them, exactly as the leads list does. A client cannot widen its own
 * visibility by asking. Without this, the drill would be a trivial bypass of the Leads list's
 * breadth rule: same rows, different URL.
 */
import { NotFoundError } from '../../lib/errors/index.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { listLeads } from '../leads/repository.js';
import type { LeadListItemDto } from '../leads/schemas.js';
import { leadListFilterFrom, type DashboardFilter } from './filters.js';
import { dashboardDrillQueries } from './drill.queries.js';

/** `GetDrillQueryHandler.UnknownWidgetCode` (:12) — surfaced as a 404, not a 400. */
export const UNKNOWN_WIDGET_CODE = 'UNKNOWN_WIDGET';

/** Default paging (`DashboardEndpoints.cs:120`: `page ?? 1, pageSize ?? 25`). */
export const DEFAULT_DRILL_PAGE = 1;
export const DEFAULT_DRILL_PAGE_SIZE = 25;

/** The caller-derived breadth facts (`DrillCallerContext.cs`). */
export interface DrillCaller {
  readonly callerUserId: number;
  readonly callerHasViewAll: boolean;
}

/**
 * `DrillResultDto` (:7) — note `totalCount`, matching every other list envelope in this port.
 * Rows reuse `LeadListItemDto` verbatim so the SPA's shared Leads table renders a drill unchanged.
 */
export interface DrillResultDto {
  readonly widgetKey: string;
  readonly items: readonly LeadListItemDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/** One widget's population query (`IDrillRowQuery`). */
export type DrillRowQuery = (context: {
  readonly db: DbExecutor;
  readonly tenantId: TenantId;
  readonly filter: DashboardFilter;
  readonly caller: DrillCaller;
  readonly page: number;
  readonly pageSize: number;
  readonly today: string;
}) => Promise<{ items: LeadListItemDto[]; totalCount: number }>;

/**
 * The framework's one generic widget (`DrillWidgetRegistry.LeadsFilteredWidgetKey`): every lead
 * matching the active dashboard filter. The five dashboards' own 31 scoped keys are registered
 * alongside it by `defaultDrillWidgetRegistry` below (T-050).
 */
export const LEADS_FILTERED_WIDGET_KEY = 'leads.filtered';

/**
 * `LeadFilterDrillRowQuery` (:31-47): projects the dashboard filter onto the Leads list query.
 *
 * Reusing `listLeads` rather than writing a second lead query is the load-bearing choice here. It
 * is what makes "a caller cannot see more through a drill than through the Leads list itself" true
 * by CONSTRUCTION rather than by two implementations of the same breadth rule agreeing — and a
 * second implementation is exactly how they would stop agreeing.
 */
const leadsFilteredQuery: DrillRowQuery = async ({
  db,
  tenantId,
  filter,
  caller,
  page,
  pageSize,
  today,
}) => listLeads(db, tenantId, leadListFilterFrom(filter, caller, page, pageSize), today);

/** Widget key -> population query. Mutable only at composition time, never per request. */
export type DrillWidgetRegistry = ReadonlyMap<string, DrillRowQuery>;

/**
 * The generic widget PLUS every dashboard widget key (`DrillWidgetRegistry.cs:24-64`).
 *
 * This is the DEFAULT, not an opt-in override, and that is the point. It was previously a one-entry
 * map with a comment saying the dashboard tasks would override it; none did, so every drill chevron
 * in the product answered 404 while a test asserting "an unregistered key 404s" passed trivially and
 * documented the defect as correct behaviour. Registering here means a composition that forgets to
 * pass `drillWidgets` still gets a working product rather than a silently broken one.
 */
export function defaultDrillWidgetRegistry(): DrillWidgetRegistry {
  const widgets = dashboardDrillQueries();
  widgets.set(LEADS_FILTERED_WIDGET_KEY, leadsFilteredQuery);
  return widgets;
}

export interface DashboardsDeps {
  readonly db: DbExecutor;
  /** Overridable so T-036/T-037 can register their widgets without editing this module. */
  readonly drillWidgets?: DrillWidgetRegistry;
}

export interface DrillActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly canViewAllLeads: boolean;
}

export interface DrillRequest {
  readonly widget: string;
  readonly filter: DashboardFilter;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

/** `DateOnly.FromDateTime(DateTime.UtcNow)` — UTC, date only, matching the reference's ageing. */
function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Executes a drill (`GetDrillQueryHandler.Handle`).
 *
 * An unknown widget key is a 404 carrying `UNKNOWN_WIDGET` (`DashboardEndpoints.cs:129-133`),
 * NOT a 400: the reference maps that one error code specially and every other dashboard error to
 * 400, and the code is what its own tests assert on.
 */
export async function runDrill(
  deps: DashboardsDeps,
  request: DrillRequest,
  actor: DrillActor,
  now: Date = new Date(),
): Promise<DrillResultDto> {
  const registry = deps.drillWidgets ?? defaultDrillWidgetRegistry();
  const rowQuery = registry.get(request.widget);
  if (rowQuery === undefined) {
    throw new NotFoundError(`Unknown drill widget '${request.widget}'.`, {
      code: UNKNOWN_WIDGET_CODE,
    });
  }

  const page = request.page ?? DEFAULT_DRILL_PAGE;
  const pageSize = request.pageSize ?? DEFAULT_DRILL_PAGE_SIZE;

  const { items, totalCount } = await rowQuery({
    db: deps.db,
    tenantId: actor.tenantId,
    filter: request.filter,
    // Breadth comes from the SERVER-RESOLVED effective permission set, never from the request.
    caller: { callerUserId: actor.userId, callerHasViewAll: actor.canViewAllLeads },
    page,
    pageSize,
    today: todayUtc(now),
  });

  return { widgetKey: request.widget, items, totalCount, page, pageSize };
}
