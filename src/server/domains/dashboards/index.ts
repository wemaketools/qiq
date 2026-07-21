/**
 * The dashboards domain's public surface (T-035).
 *
 * The metric definitions, the shared filter and the drill framework are consumed by T-036/T-037's
 * five dashboard endpoints and by T-039's exports. They import from HERE rather than reaching into
 * individual files, so the set of things a dashboard is allowed to depend on stays visible in one
 * place — in particular, that a formula comes from `metrics/` and never gets re-derived in a query.
 */
export * from './money.js';
export * from './metrics/index.js';
export * from './payload.js';
export * from './filters.js';
export * from './drill.service.js';
export * from './drill.queries.js';
export { dashboardRoutes } from './drill.routes.js';

// T-036: the Executive Overview and Pipeline & Conversion payload endpoints. Exported here for the
// same reason as the framework above — a dashboard's dependencies stay visible in one place.
export * from './composition.js';
export * from './snapshot.js';
export * from './executive.service.js';
export * from './pipeline.service.js';
export { executiveDashboardRoutes } from './executive.routes.js';
export { pipelineDashboardRoutes } from './pipeline.routes.js';

// T-037: the Broker Performance, RM Performance and Loss Analysis payload endpoints, plus the three
// pure rule modules two of them share (quadrant classification, watchlist action, insights) and the
// accountable-owner predicate that distinguishes the `rm` SLOT from any assignment (`owner.ts`).
export * from './quadrant.js';
export * from './suggested-action.js';
export * from './insights.js';
export * from './owner.js';
export * from './broker.service.js';
export * from './rm.service.js';
export * from './loss.service.js';
export { brokerPerformanceRoutes } from './broker.routes.js';
export { rmPerformanceRoutes } from './rm.routes.js';
export { lossAnalysisRoutes } from './loss.routes.js';

import { getDb } from '../../lib/db/index.js';
import { defaultDrillWidgetRegistry, type DashboardsDeps } from './drill.service.js';

/**
 * Production wiring for the dashboard endpoints.
 *
 * Mirrors `defaultQuotesDeps()`. `getDb()` returns the process-wide pool and captures no request
 * state; the tenant and the caller's resolved breadth come per request from the verified
 * `TenantContext` and the permission resolver, never from here — a dashboard that took its tenant
 * from composition would aggregate one tenant's numbers for every caller.
 *
 * `drillWidgets` is set EXPLICITLY to the default registry — which now carries the generic
 * `leads.filtered` key plus all 31 dashboard widget keys (T-050) — rather than left unset. The
 * registry is built once per composition, never per request: it holds pure closures over a scope
 * and captures no request state.
 */
export function defaultDashboardsDeps(): DashboardsDeps {
  return { db: getDb(), drillWidgets: defaultDrillWidgetRegistry() };
}
