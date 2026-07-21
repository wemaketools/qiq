/**
 * The alerts domain's public surface (T-033).
 *
 * Consumers import from HERE rather than reaching into individual files, so what a feature is
 * allowed to depend on stays visible in one place. Two consumers are already known:
 *
 *   T-034 — wires the cron schedule and the post-workflow-action re-evaluation, and needs
 *           `reconcileTenantAlerts` / `evaluateForLead`.
 *   T-036 — the executive dashboard's escalation panel, which must consume THIS rule module rather
 *           than re-deriving "escalated" in a dashboard query. Two implementations of the
 *           escalation predicate would disagree the first time a threshold changed.
 */
export {
  ALERT_RULES,
  ALERT_SEVERITIES,
  ALERT_TYPES,
  evaluateAllRules,
  ruleFor,
  type AlertCandidate,
  type AlertEvaluationContext,
  type AlertRule,
  type AlertSeverity,
  type AlertThresholds,
  type AlertType,
  type LeadAlertSnapshot,
  type QuoteAlertSnapshot,
} from './rules/index.js';
export {
  ALERT_CATEGORIES,
  ALERT_TABS,
  DEFAULT_ALERT_TAB,
  isAlertTab,
  typesForTab,
  type AlertCategoryDefinition,
  type AlertTab,
} from './definitions.js';
export {
  RULE_CLEARED_REASON,
  buildEvaluationContext,
  countAlertsNewSinceLastVisit,
  countOpenAlertsByType,
  getAlertRollup,
  listOpenAlerts,
  loadAlertThresholds,
  markAlertsVisited,
  type AlertListFilter,
  type AlertListRow,
  type AlertRollup,
  type OpenAlertRow,
} from './repository.js';
export {
  evaluateForLead,
  reconcileTenantAlerts,
  type ReconcileOptions,
  type ReconcileResult,
} from './evaluate.js';
export { alertRoutes } from './routes.js';
export {
  getAlertBadge,
  getAlertSummary,
  listAlertsForTenant,
  resetAlertBadge,
  type AlertsActor,
  type AlertsDeps,
} from './service.js';
export {
  ALERT_LIST_ITEM_FIELDS,
  DEFAULT_ALERTS_PAGE,
  DEFAULT_ALERTS_PAGE_SIZE,
  MAX_ALERTS_PAGE_SIZE,
  listAlertsQuerySchema,
  type AlertBadgeDto,
  type AlertCategoryCardDto,
  type AlertListDto,
  type AlertListItemDto,
  type AlertRollupDto,
  type AlertSummaryDto,
  type ListAlertsQuery,
} from './schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { AlertsDeps } from './service.js';

/**
 * Production wiring for the alerts endpoints.
 *
 * Mirrors `defaultBusinessRulesDeps()`. `getDb()` returns the process-wide pool and captures no
 * request state; the tenant is supplied per request by the route handlers from the verified
 * `TenantContext`, never from here.
 */
export function defaultAlertsDeps(): AlertsDeps {
  return { db: getDb() };
}
