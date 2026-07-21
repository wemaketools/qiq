/**
 * The Alerts Center category cards and queue tabs (T-033; AC-070).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Alerts/AlertDefinitions.cs`, isolated in exactly one
 * module so the card/tab composition can be changed in a single place — and pinned against the
 * SPA's own copies in `src/ui/src/features/alerts/alertsApi.ts` (`ALERT_TABS`, `CATEGORY_TO_TAB`),
 * which must agree or a deep-link from a dashboard opens the wrong tab.
 *
 * FIVE CARDS, FOUR NON-"ALL" TABS — MEASURED, NOT AN OVERSIGHT
 * ===========================================================
 * The Stalled card has NO queue tab: its `tab` is null and clicking it activates nothing. The
 * reference records this explicitly (PRD 18.2 names five summary cards but only four tabs), and the
 * SPA already encodes the same null. Inventing a fifth tab here would look tidier and would diverge
 * from both.
 *
 * NOT EVERY ALERT TYPE BELONGS TO A CARD. `stalled_lead`/`stalled_quote` reach the queue only via
 * the "all" tab. That is why the card counts do NOT sum to the "all" tab count, and why the tab
 * counts are derived from the per-type counts rather than from each other.
 */
import type { AlertType } from './rules/index.js';

export const ALERT_TABS = ['all', 'escalated', 'overdue', 'expiring', 'sla'] as const;
export type AlertTab = (typeof ALERT_TABS)[number];

export const DEFAULT_ALERT_TAB: AlertTab = 'all';

export function isAlertTab(value: string): value is AlertTab {
  return (ALERT_TABS as readonly string[]).includes(value);
}

/** Tab -> its constituent alert types. `null` (the "all" tab) means every type. */
export function typesForTab(tab: AlertTab): readonly AlertType[] | null {
  switch (tab) {
    case 'escalated':
      return ['executive_escalation', 'high_value_stalled'];
    case 'overdue':
      return ['overdue_follow_up'];
    case 'expiring':
      return ['quote_expiring', 'quote_expired'];
    case 'sla':
      return ['sla_breach', 'awaiting_underwriting', 'pending_pricing_approval'];
    case 'all':
    default:
      return null;
  }
}

export interface AlertCategoryDefinition {
  readonly key: string;
  readonly name: string;
  readonly definition: string;
  readonly types: readonly AlertType[];
  readonly tab: AlertTab | null;
}

/** The five category summary cards, in display order (`AlertDefinitions.Categories`). */
export const ALERT_CATEGORIES: readonly AlertCategoryDefinition[] = [
  {
    key: 'escalated',
    name: 'Escalated',
    definition: 'High-value & stalled',
    types: ['executive_escalation', 'high_value_stalled'],
    tab: 'escalated',
  },
  {
    key: 'stalled',
    name: 'Stalled',
    definition: 'No activity 7+ days',
    types: ['stalled_lead', 'stalled_quote'],
    tab: null,
  },
  {
    key: 'overdue',
    name: 'Overdue',
    definition: 'Follow-up overdue',
    types: ['overdue_follow_up'],
    tab: 'overdue',
  },
  {
    key: 'expiring',
    name: 'Expiring',
    definition: 'Within threshold / expired',
    types: ['quote_expiring', 'quote_expired'],
    tab: 'expiring',
  },
  {
    key: 'sla',
    name: 'SLA Breaches',
    definition: 'Underwriting/assignment beyond SLA',
    types: ['sla_breach', 'awaiting_underwriting', 'pending_pricing_approval'],
    tab: 'sla',
  },
];
