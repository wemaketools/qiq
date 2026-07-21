/**
 * Alerts Center application logic (T-033; AC-022, AC-070; V-027, V-087).
 *
 * Port of `GetAlertSummaryQueryHandler`, `ListAlertsQueryHandler`, `GetBadgeQueryHandler` and
 * `ResetBadgeCommandHandler`.
 *
 * EVERY FUNCTION TAKES THE VERIFIED TENANT AS AN ARGUMENT
 * ======================================================
 * There is no ambient tenant anywhere in this codebase; the routes read the tenant the T-013
 * middleware verified and pass it in. With RLS not adopted (Q-10) the predicate the repository
 * applies from this argument is the only thing separating one tenant's alerts from another's.
 */
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { ALERT_CATEGORIES, typesForTab, ALERT_TABS, DEFAULT_ALERT_TAB, isAlertTab } from './definitions.js';
import {
  countAlertsNewSinceLastVisit,
  countOpenAlertsByType,
  getAlertRollup,
  listAlerts,
  markAlertsVisited,
  type AlertListRow,
} from './repository.js';
import {
  DEFAULT_ALERTS_PAGE,
  DEFAULT_ALERTS_PAGE_SIZE,
  MAX_ALERTS_PAGE_SIZE,
  type AlertBadgeDto,
  type AlertListDto,
  type AlertListItemDto,
  type AlertSummaryDto,
  type ListAlertsQuery,
} from './schemas.js';

export interface AlertsDeps {
  readonly db: DbExecutor;
}

export interface AlertsActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly correlationId?: string;
}

/** The wire contract is a JSON number; the value was exact up to this line. */
function toWireAmount(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toListItem(row: AlertListRow): AlertListItemDto {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    createdAt: row.createdAt.toISOString(),
    leadId: row.leadId,
    leadRef: row.leadRef,
    quoteId: row.quoteId,
    quoteRef: row.quoteRef,
    clientName: row.clientName,
    productLineName: row.productLineName,
    brokerName: row.brokerName,
    premiumAtRisk: toWireAmount(row.premiumAtRisk),
    stage: row.stage,
    priority: row.priority,
    ownerUserId: row.ownerUserId,
    // `AlertListItemDto.FromRow`: null when there is no owner, "First Last" otherwise.
    ownerName: row.ownerUserId === null ? null : `${row.ownerFirstName ?? ''} ${row.ownerLastName ?? ''}`.trim(),
  };
}

/**
 * `GET /alerts/summary` — the five category cards plus the premium-at-risk rollup.
 *
 * Card counts are SUMS OVER THE CARD'S TYPES, computed from one grouped query rather than five
 * counting queries, so the cards are guaranteed to be a partition of the same instant's data. A
 * type with no open alerts contributes 0 and the card still renders — the SPA lays out five cards
 * unconditionally.
 */
export async function getAlertSummary(
  deps: AlertsDeps,
  actor: AlertsActor,
): Promise<AlertSummaryDto> {
  const counts = new Map(
    (await countOpenAlertsByType(deps.db, actor.tenantId)).map((row) => [row.type, row.count]),
  );

  const categories = ALERT_CATEGORIES.map((category) => ({
    category: category.key,
    name: category.name,
    definition: category.definition,
    tab: category.tab,
    count: category.types.reduce((total, type) => total + (counts.get(type) ?? 0), 0),
  }));

  const rollup = await getAlertRollup(deps.db, actor.tenantId);

  return {
    categories,
    rollup: { premiumAtRisk: Number(rollup.premiumAtRisk), quoteCount: rollup.quoteCount },
  };
}

/**
 * `GET /alerts` — the escalation queue, paged and filtered.
 *
 * `tabCounts` covers ALL five tabs on every response, not just the active one, because the SPA
 * renders the counts on the inactive tab headers. They come from the same per-type counts the cards
 * use, so a tab header can never disagree with the card above it.
 */
export async function listAlertsForTenant(
  deps: AlertsDeps,
  query: ListAlertsQuery,
  actor: AlertsActor,
): Promise<AlertListDto> {
  const tab = query.tab !== undefined && isAlertTab(query.tab) ? query.tab : DEFAULT_ALERT_TAB;
  const page = Math.max(1, query.page ?? DEFAULT_ALERTS_PAGE);
  const pageSize = Math.min(
    MAX_ALERTS_PAGE_SIZE,
    Math.max(1, query.pageSize ?? DEFAULT_ALERTS_PAGE_SIZE),
  );

  const types = typesForTab(tab);

  const { items, totalCount } = await listAlerts(deps.db, actor.tenantId, {
    types,
    ownerUserId: query.ownerUserId ?? null,
    productLineId: query.productLineId ?? null,
    coverTypeId: query.coverTypeId ?? null,
    regionId: query.regionId ?? null,
    priority: query.priority ?? null,
    page,
    pageSize,
  });

  const counts = new Map(
    (await countOpenAlertsByType(deps.db, actor.tenantId)).map((row) => [row.type, row.count]),
  );

  const tabCounts: Record<string, number> = {};
  for (const candidate of ALERT_TABS) {
    const tabTypes = typesForTab(candidate);
    tabCounts[candidate] =
      tabTypes === null
        ? [...counts.values()].reduce((total, count) => total + count, 0)
        : tabTypes.reduce((total, type) => total + (counts.get(type) ?? 0), 0);
  }

  return { items: items.map(toListItem), totalCount, page, pageSize, tabCounts };
}

/** `GET /alerts/badge` — new since THIS user's last visit to THIS tenant's Alerts Center. */
export async function getAlertBadge(
  deps: AlertsDeps,
  actor: AlertsActor,
): Promise<AlertBadgeDto> {
  return { count: await countAlertsNewSinceLastVisit(deps.db, actor.tenantId, actor.userId) };
}

/**
 * `POST /alerts/badge/reset` — records that this user has now seen the Alerts Center.
 *
 * Per user AND per tenant: the marker row is keyed on both, so resetting in tenant A leaves the
 * same user's tenant-B badge alone, and one user's visit never clears a colleague's badge.
 * Idempotent — calling it twice just moves the timestamp forward.
 */
export async function resetAlertBadge(
  deps: AlertsDeps,
  actor: AlertsActor,
  now: Date = new Date(),
): Promise<void> {
  await markAlertsVisited(deps.db, actor.tenantId, actor.userId, now);
}
