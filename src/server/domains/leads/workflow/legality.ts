/**
 * The pure lead legality matrix (T-025; AC-047, V-060).
 *
 * Port of `QuoteIQ.Domain/Workflow/LeadWorkflow.cs`, `LeadStatusKeys.cs`, `LeadOperation.cs` and
 * `LeadOperationPermissions.cs`, collapsed into one module because in TypeScript the C# split
 * between an enum, its wire-code dictionary and the matrix keyed by that enum buys nothing: the
 * wire code IS the identity here, so `LeadOperationCodes.ToCodeValue`/`TryParse` disappear and a
 * whole class of enum-to-code drift disappears with them.
 *
 * NO I/O OF ANY KIND LIVES HERE, DELIBERATELY
 * ===========================================
 * Every function takes plain values (a status's canonical key and/or reporting category) and
 * returns a plain value, so `lead-legality-matrix.test.ts` exercises the entire operation x status
 * space with zero fixtures and zero database. The two rules that genuinely cannot be pure — Reopen's
 * history-derived target and the per-caller permission filter — are deliberately NOT smuggled in
 * behind a callback; they live in `operations.ts` and `availableLeadOperations` respectively.
 *
 * THE FLAGGED AMBIGUITIES ARE PORTED AS THE REFERENCE RESOLVED THEM
 * ================================================================
 * `LeadWorkflow.cs:46-76` records two deliberate readings of PRD 10.4 that this port keeps verbatim
 * rather than re-litigating:
 *
 *   1. "Any open status" means reporting category `open` OR `quoted` — every non-terminal status,
 *      not merely the literal `open` category. Mark lost, Withdraw, Log follow-up and Assign must
 *      stay legal from Quote Sent/Negotiation or PRD 7.3's "lost before quote" vs "lost after quote"
 *      reporting split becomes unrepresentable.
 *   2. A tenant-added custom status (no canonical key) inherits its category's operations — which
 *      means exactly those four category-wide operations. The narrowly scoped operations (the
 *      three `start-` operations, send-to-underwriting, and the pricing trio) are tied to
 *      individually named canonical statuses, so a brand-new custom status is NOT assumed to
 *      occupy the same lifecycle position.
 */
import type { PermissionCode } from '../../rbac/permission-catalog.js';

/** The eleven guarded canonical lead-status keys (`LeadStatusKeys.cs:12-22`). Rename-safe: a tenant may rename a guarded status's display name, never its canonical key. */
export const LEAD_STATUS_KEYS = {
  new: 'new',
  assigned: 'assigned',
  informationGathering: 'information_gathering',
  underwriting: 'underwriting',
  pricing: 'pricing',
  quoteSent: 'quote_sent',
  negotiation: 'negotiation',
  closedWon: 'closed_won',
  closedLost: 'closed_lost',
  expired: 'expired',
  withdrawn: 'withdrawn',
} as const;

/** Every reporting category a status may declare (`ReportingCategory.cs:10-15`). */
export const LEAD_REPORTING_CATEGORIES = [
  'open',
  'quoted',
  'won',
  'lost',
  'expired',
  'withdrawn',
] as const;

export type LeadReportingCategory = (typeof LEAD_REPORTING_CATEGORIES)[number];

/**
 * The automatic, inactivity-based PRD 10.4 "Expire" row (`LeadOperation.cs:30`, T-032).
 *
 * It runs through the same executor as every human operation — never bypassing legality, history or
 * audit — but is invoked only by the expiry job under the system actor. It has NO HTTP route and is
 * deliberately excluded from `LEAD_OPERATIONS`, so it can never surface in a 409's legal-operation
 * hint or in a lead's `availableOperations`.
 */
export const LEAD_EXPIRE_OPERATION = 'expire_automatic';

/**
 * The twelve human-invocable operations, in the reference's enum order (`LeadOperation.cs:18-29`).
 *
 * Order is load-bearing, not incidental: `GetLegalOperations` projects `Enum.GetValues<LeadOperation>()`
 * in declaration order, so the hint array and `availableOperations` are ordered lists the SPA and the
 * tests compare element-wise.
 */
export const LEAD_OPERATIONS = [
  'assign',
  'start-information-gathering',
  'send-to-underwriting',
  'start-pricing',
  'request-pricing-approval',
  'approve-pricing',
  'reject-pricing',
  'log-follow-up',
  'start-negotiation',
  'mark-lost',
  'withdraw',
  'reopen',
] as const;

export type LeadOperation = (typeof LEAD_OPERATIONS)[number];

/** Every matrix key: the human operations plus the system-only expiry. */
export type LeadOperationName = LeadOperation | typeof LEAD_EXPIRE_OPERATION;

/** How an operation's target status is resolved once it is found legal (`LeadOperationTargetMode`). */
export type LeadOperationTargetMode =
  /** Sub-state-only operations: the lead's status column is untouched. */
  | 'unchanged'
  /** A single fixed canonical status regardless of where the lead came from. */
  | 'fixed'
  /** Assign's PRD 10.4 special case: New -> Assigned on first assignment, otherwise unchanged. */
  | 'assigned-on-first-assignment'
  /** Reopen's A-13 target: the last open status, resolved from history at execution time. */
  | 'last-open-from-history';

/** One row of the legality matrix (`LeadOperationRule`). */
export interface LeadOperationRule {
  readonly allowedFromCanonicalKeys: readonly string[];
  readonly allowedFromCategories: readonly string[];
  readonly targetMode: LeadOperationTargetMode;
  readonly fixedTargetCanonicalKey?: string;
}

/** "Any open status" — every non-terminal category. See the header's flagged reading (1). */
const ANY_OPEN_OR_QUOTED = ['open', 'quoted'] as const;

/** The matrix (`LeadWorkflow.Matrix`, :82-172). */
export const LEAD_OPERATION_MATRIX: Readonly<Record<LeadOperationName, LeadOperationRule>> = {
  // "Assign / Reassign | New, or any open status (reassign)".
  assign: {
    allowedFromCanonicalKeys: [LEAD_STATUS_KEYS.new],
    allowedFromCategories: ANY_OPEN_OR_QUOTED,
    targetMode: 'assigned-on-first-assignment',
  },

  // "Start information gathering | Assigned, Underwriting, Pricing".
  'start-information-gathering': {
    allowedFromCanonicalKeys: [
      LEAD_STATUS_KEYS.assigned,
      LEAD_STATUS_KEYS.underwriting,
      LEAD_STATUS_KEYS.pricing,
    ],
    allowedFromCategories: [],
    targetMode: 'fixed',
    fixedTargetCanonicalKey: LEAD_STATUS_KEYS.informationGathering,
  },

  // "Send to underwriting | Assigned, Information Gathering".
  'send-to-underwriting': {
    allowedFromCanonicalKeys: [LEAD_STATUS_KEYS.assigned, LEAD_STATUS_KEYS.informationGathering],
    allowedFromCategories: [],
    targetMode: 'fixed',
    fixedTargetCanonicalKey: LEAD_STATUS_KEYS.underwriting,
  },

  // "Start pricing | Assigned, Information Gathering, Underwriting".
  'start-pricing': {
    allowedFromCanonicalKeys: [
      LEAD_STATUS_KEYS.assigned,
      LEAD_STATUS_KEYS.informationGathering,
      LEAD_STATUS_KEYS.underwriting,
    ],
    allowedFromCategories: [],
    targetMode: 'fixed',
    fixedTargetCanonicalKey: LEAD_STATUS_KEYS.pricing,
  },

  // The pricing-approval sub-workflow: legal from Pricing, and the lead's STATUS never moves —
  // only `pricing_approval_state` does. That is why all three are `unchanged`.
  'request-pricing-approval': {
    allowedFromCanonicalKeys: [LEAD_STATUS_KEYS.pricing],
    allowedFromCategories: [],
    targetMode: 'unchanged',
  },
  'approve-pricing': {
    allowedFromCanonicalKeys: [LEAD_STATUS_KEYS.pricing],
    allowedFromCategories: [],
    targetMode: 'unchanged',
  },
  'reject-pricing': {
    allowedFromCanonicalKeys: [LEAD_STATUS_KEYS.pricing],
    allowedFromCategories: [],
    targetMode: 'unchanged',
  },

  // "Log follow-up | Quote Sent, Negotiation (any open status permitted)".
  'log-follow-up': {
    allowedFromCanonicalKeys: [],
    allowedFromCategories: ANY_OPEN_OR_QUOTED,
    targetMode: 'unchanged',
  },

  // "Start negotiation | Quote Sent".
  'start-negotiation': {
    allowedFromCanonicalKeys: [LEAD_STATUS_KEYS.quoteSent],
    allowedFromCategories: [],
    targetMode: 'fixed',
    fixedTargetCanonicalKey: LEAD_STATUS_KEYS.negotiation,
  },

  // "Mark lost | Any open status".
  'mark-lost': {
    allowedFromCanonicalKeys: [],
    allowedFromCategories: ANY_OPEN_OR_QUOTED,
    targetMode: 'fixed',
    fixedTargetCanonicalKey: LEAD_STATUS_KEYS.closedLost,
  },

  // "Withdraw | Any open status".
  withdraw: {
    allowedFromCanonicalKeys: [],
    allowedFromCategories: ANY_OPEN_OR_QUOTED,
    targetMode: 'fixed',
    fixedTargetCanonicalKey: LEAD_STATUS_KEYS.withdrawn,
  },

  // "Reopen | Closed Lost, Expired, Withdrawn; permission-bound". Closed Won is deliberately absent:
  // FR-39 makes Closed Won reachable only via the quote-level Mark won, never undone by a lead op.
  reopen: {
    allowedFromCanonicalKeys: [
      LEAD_STATUS_KEYS.closedLost,
      LEAD_STATUS_KEYS.expired,
      LEAD_STATUS_KEYS.withdrawn,
    ],
    allowedFromCategories: [],
    targetMode: 'last-open-from-history',
  },

  // "Expire | Any open status (automatic, inactivity-based)" — category-wide like Mark lost, but
  // never human-invocable; see LEAD_EXPIRE_OPERATION.
  [LEAD_EXPIRE_OPERATION]: {
    allowedFromCanonicalKeys: [],
    allowedFromCategories: ANY_OPEN_OR_QUOTED,
    targetMode: 'fixed',
    fixedTargetCanonicalKey: LEAD_STATUS_KEYS.expired,
  },
};

/** True if `operation` may be invoked from a status carrying this canonical key / reporting category (`IsLegal`, :179-189). */
export function isLeadOperationLegal(
  operation: LeadOperationName,
  currentCanonicalKey: string | null,
  currentReportingCategory: string | null,
): boolean {
  const rule = LEAD_OPERATION_MATRIX[operation];
  if (rule === undefined) return false;

  if (currentCanonicalKey !== null && rule.allowedFromCanonicalKeys.includes(currentCanonicalKey)) {
    return true;
  }

  return (
    currentReportingCategory !== null &&
    rule.allowedFromCategories.includes(currentReportingCategory)
  );
}

/**
 * Every human-invocable operation legal from the given status (`GetLegalOperations`, :199-202) —
 * the 409 hint and the raw input to `availableOperations`.
 *
 * The automatic expiry is excluded here rather than at the call sites, so no future caller can
 * accidentally surface it: the exclusion is a property of this function, and the unit suite sweeps
 * every status to prove it.
 */
export function legalLeadOperations(
  currentCanonicalKey: string | null,
  currentReportingCategory: string | null,
): LeadOperation[] {
  return LEAD_OPERATIONS.filter((operation) =>
    isLeadOperationLegal(operation, currentCanonicalKey, currentReportingCategory),
  );
}

/**
 * The operation's target canonical key, for every mode except Reopen's (`ResolveFixedTarget`,
 * :210-224). Null means the status is unchanged.
 *
 * Reopen THROWS rather than returning null: null is a meaningful answer here ("stay put"), so
 * returning it for an operation that must move the lead somewhere would silently leave a reopened
 * lead sitting in its terminal status.
 */
export function resolveFixedLeadTarget(
  operation: LeadOperationName,
  currentCanonicalKey: string | null,
): string | null {
  const rule = LEAD_OPERATION_MATRIX[operation];

  switch (rule.targetMode) {
    case 'unchanged':
      return null;
    case 'fixed':
      return rule.fixedTargetCanonicalKey ?? null;
    case 'assigned-on-first-assignment':
      return currentCanonicalKey === LEAD_STATUS_KEYS.new ? LEAD_STATUS_KEYS.assigned : null;
    case 'last-open-from-history':
      throw new Error(
        `resolveFixedLeadTarget cannot resolve '${operation}'; its target requires status history.`,
      );
  }
}

/**
 * The per-operation permission map (`LeadOperationPermissions.Map`).
 *
 * The five ordinary status-transition operations share `leads.update` — the same "you may operate
 * on this lead" permission the edit endpoint is gated behind — because PRD 10.4 names no distinct
 * permission for them. Assign, the close pair, the pricing trio and Reopen each carry their own
 * named permission because PRD 10.4 explicitly calls those out as permission-bound.
 *
 * Typed as `PermissionCode`, not `string`: a typo here would otherwise silently grant an operation
 * to everyone (no user holds a permission that does not exist, so `has()` would always answer
 * false and the operation would vanish from every `availableOperations` instead of failing loudly).
 */
export const LEAD_OPERATION_PERMISSIONS: Readonly<Record<LeadOperation, PermissionCode>> = {
  assign: 'leads.assign',
  'start-information-gathering': 'leads.update',
  'send-to-underwriting': 'leads.update',
  'start-pricing': 'leads.update',
  'request-pricing-approval': 'pricing.request',
  'approve-pricing': 'pricing.approve',
  'reject-pricing': 'pricing.reject',
  'log-follow-up': 'leads.update',
  'start-negotiation': 'leads.update',
  'mark-lost': 'leads.close',
  withdraw: 'leads.close',
  reopen: 'leads.reopen',
};

/**
 * `LeadDto.ComputeAvailableOperations` (:61-66): the legality matrix intersected with the caller's
 * effective permissions, so operations that are illegal for this lead AND operations this caller may
 * not perform are both HIDDEN from the UI rather than rendered-then-disabled.
 *
 * This is a UI affordance, never an authorization decision — `executeLeadOperation` re-checks both
 * legality and permission server-side, and the integration suite proves an operation absent from
 * this list still fails 409/403 when called directly.
 */
export function availableLeadOperations(
  currentCanonicalKey: string | null,
  currentReportingCategory: string | null,
  hasPermission: (permission: PermissionCode) => boolean,
): LeadOperation[] {
  return legalLeadOperations(currentCanonicalKey, currentReportingCategory).filter((operation) =>
    hasPermission(LEAD_OPERATION_PERMISSIONS[operation]),
  );
}
