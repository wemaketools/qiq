/**
 * Alerts Center wire contract and query validation (T-033; AC-070).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Alerts/AlertDtos.cs`. The DTO interfaces below are
 * field-for-field with the SPA's `src/ui/src/features/alerts/alertsApi.ts`, which is the contract
 * being preserved (spec A-3): the Alerts Center renders these shapes today and is not in scope for
 * change, so an added or renamed field here is a break, not an improvement.
 *
 * PREMIUM CROSSES FROM STRING TO NUMBER HERE, AND ONLY HERE
 * ========================================================
 * `premium_at_risk` is `numeric(18,2)` and stays a string through the rules and the SQL totals so
 * no business decision or sum passes through an IEEE-754 double. The .NET DTO declared `decimal?`
 * and System.Text.Json emitted a JSON NUMBER, and the SPA declares `number | null` — so the wire
 * contract is a number and the widening has to happen somewhere. It happens at this boundary, in
 * one place, AFTER every comparison and every total is already exact.
 */
import { z } from 'zod';

import { ALERT_TABS, DEFAULT_ALERT_TAB } from './definitions.js';

/** `AlertCategoryCardDto`. `tab` is null for the Stalled card. */
export interface AlertCategoryCardDto {
  readonly category: string;
  readonly name: string;
  readonly definition: string;
  readonly tab: string | null;
  readonly count: number;
}

/** `AlertRollupDto` — the Escalation Queue header. */
export interface AlertRollupDto {
  readonly premiumAtRisk: number;
  readonly quoteCount: number;
}

/** `AlertSummaryDto` — `GET /alerts/summary`. */
export interface AlertSummaryDto {
  readonly categories: readonly AlertCategoryCardDto[];
  readonly rollup: AlertRollupDto;
}

/** `AlertListItemDto` — one queue row. */
export interface AlertListItemDto {
  readonly id: number;
  readonly type: string;
  readonly severity: string;
  readonly createdAt: string;
  readonly leadId: number;
  readonly leadRef: string;
  readonly quoteId: number | null;
  readonly quoteRef: string | null;
  readonly clientName: string;
  readonly productLineName: string;
  readonly brokerName: string | null;
  readonly premiumAtRisk: number | null;
  readonly stage: string;
  readonly priority: string;
  readonly ownerUserId: number | null;
  readonly ownerName: string | null;
}

/** `AlertListDto` — `GET /alerts`. */
export interface AlertListDto {
  readonly items: readonly AlertListItemDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly tabCounts: Readonly<Record<string, number>>;
}

/** `AlertBadgeDto` — `GET /alerts/badge`. */
export interface AlertBadgeDto {
  readonly count: number;
}

/** Every field name the queue row carries — asserted against the SPA's interface. */
export const ALERT_LIST_ITEM_FIELDS = [
  'id',
  'type',
  'severity',
  'createdAt',
  'leadId',
  'leadRef',
  'quoteId',
  'quoteRef',
  'clientName',
  'productLineName',
  'brokerName',
  'premiumAtRisk',
  'stage',
  'priority',
  'ownerUserId',
  'ownerName',
] as const;

/** `AlertEndpoints.ListAlertsAsync`'s defaults (`page ?? 1, pageSize ?? 25`). */
export const DEFAULT_ALERTS_PAGE = 1;
export const DEFAULT_ALERTS_PAGE_SIZE = 25;
/**
 * A ceiling the reference does not have. `pageSize` reaches SQL as a LIMIT, so an unbounded value
 * lets any authenticated caller ask for the whole alerts table in one request.
 */
export const MAX_ALERTS_PAGE_SIZE = 200;

const optionalIdParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine((value) => value > 0)
  .optional();

/**
 * `GET /api/v1/alerts` query string.
 *
 * An UNRECOGNIZED `tab` falls back to "all" rather than 422 — matching the reference, which maps
 * anything outside its four named tabs to "every type" (`TypesForTab`'s `_ => null`). The SPA
 * deep-links `?tab=` straight from a URL, so a stale bookmark degrades to the full queue instead of
 * an error page.
 */
export const listAlertsQuerySchema = z.object({
  tab: z
    .string()
    .transform((value) =>
      (ALERT_TABS as readonly string[]).includes(value) ? value : DEFAULT_ALERT_TAB,
    )
    .optional(),
  ownerUserId: optionalIdParam,
  productLineId: optionalIdParam,
  coverTypeId: optionalIdParam,
  regionId: optionalIdParam,
  priority: z.string().min(1).max(50).optional(),
  page: z.string().regex(/^\d+$/).transform(Number).optional(),
  pageSize: z.string().regex(/^\d+$/).transform(Number).optional(),
});

export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;
