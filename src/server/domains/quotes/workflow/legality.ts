/**
 * The pure quote legality matrix (T-026; AC-050, AC-053, AC-054; V-064).
 *
 * Port of `QuoteIQ.Domain/Workflow/QuoteWorkflow.cs`, `QuoteStatusKeys.cs`, `QuoteOperation.cs` and
 * `QuoteOperationPermissions.cs`, collapsed into one module for the same reason the lead side is:
 * the wire code IS the operation's identity in TypeScript, so `QuoteOperationCodes.ToCodeValue`/
 * `TryParse` disappear and a whole class of enum-to-code drift disappears with them.
 *
 * NO I/O OF ANY KIND LIVES HERE, DELIBERATELY
 * ===========================================
 * Every function takes plain values and returns a plain value, so `quote-legality-matrix.test.ts`
 * exercises the entire operation x status space with zero fixtures and zero database.
 *
 * THE QUOTE MATRIX IS KEYED BY CANONICAL KEY ALONE — MEASURED, AND IT DIFFERS FROM THE LEAD MATRIX
 * ================================================================================================
 * `LeadWorkflow.IsLegal` takes a canonical key AND a reporting category, so a tenant-added lead
 * status inherits its category's operations. `QuoteWorkflow.IsLegal` (:111-122) takes ONLY the
 * canonical key: every rule is a canonical-key list and there is no category fallback at all. The
 * consequence is real and is asserted in the unit suite — a tenant-added custom QUOTE status
 * inherits NOTHING and offers no operations. That asymmetry is the reference's, not an oversight
 * here, and it is preserved rather than "tidied" into symmetry with the lead side.
 *
 * THE FLAGGED CONFLICT IS PORTED AS THE REFERENCE RESOLVED IT
 * ==========================================================
 * `QuoteWorkflow.cs:40-49` records that the prose brief said "send: draft/revised" while V-046's
 * legal-button list for a Revised quote said "Send-not-present" — two authoritative sources in
 * genuine disagreement. The reference followed V-046 (Send legal from Draft only), reasoning that
 * FR-49's "Sent changes only via Revise" means once a quote has been sent at all, the only outbound
 * edit path is Revise. That resolution is ported verbatim rather than re-litigated.
 */
import type { PermissionCode } from '../../rbac/permission-catalog.js';

/** The seven guarded canonical quote-status keys (`QuoteStatusKeys.cs:12-18`). */
export const QUOTE_STATUS_KEYS = {
  draft: 'draft',
  sent: 'sent',
  revised: 'revised',
  won: 'won',
  lost: 'lost',
  expired: 'expired',
  withdrawn: 'withdrawn',
} as const;

/**
 * The automatic, past-valid-until PRD 10.4 quote "Expire" row (`QuoteOperation.cs:32`, T-032).
 *
 * It runs through the same executor as every human operation — never bypassing legality, history or
 * audit — but is invoked only by the expiry job under the system actor. It has NO HTTP route and is
 * deliberately excluded from `QUOTE_OPERATIONS`, so it can never surface in a 409's legal-operation
 * hint or in a quote's `availableOperations`.
 */
export const QUOTE_EXPIRE_OPERATION = 'expire_automatic';

/**
 * The seven human-invocable operations, in the reference's enum order (`QuoteOperation.cs:15-22`,
 * minus `Create`).
 *
 * Order is load-bearing, not incidental: `GetLegalOperations` projects the matrix in declaration
 * order, so the 409 hint and `availableOperations` are ordered lists the SPA and the tests compare
 * element-wise.
 *
 * `create` is deliberately absent: its legality is evaluated against the LEAD's reporting category
 * (there is no quote yet), which is `isLegalToCreateQuote` below rather than a matrix row.
 */
export const QUOTE_OPERATIONS = [
  'assign',
  'send',
  'revise',
  'mark-won',
  'mark-lost',
  'withdraw',
  'set-current',
] as const;

export type QuoteOperation = (typeof QUOTE_OPERATIONS)[number];

/** Every matrix key: the human operations plus the system-only expiry. */
export type QuoteOperationName = QuoteOperation | typeof QUOTE_EXPIRE_OPERATION;

/** How an operation's target status is resolved once it is found legal (`QuoteOperationTargetMode`). */
export type QuoteOperationTargetMode =
  /** The quote's status column is untouched (Assign/Reassign and Set current). */
  | 'unchanged'
  /** The quote moves to a single fixed canonical status regardless of where it came from. */
  | 'fixed';

/** One row of the legality matrix (`QuoteOperationRule`). */
export interface QuoteOperationRule {
  readonly allowedFromCanonicalKeys: readonly string[];
  readonly targetMode: QuoteOperationTargetMode;
  readonly fixedTargetCanonicalKey?: string;
}

const DRAFT_SENT_REVISED = [
  QUOTE_STATUS_KEYS.draft,
  QUOTE_STATUS_KEYS.sent,
  QUOTE_STATUS_KEYS.revised,
] as const;

const SENT_REVISED = [QUOTE_STATUS_KEYS.sent, QUOTE_STATUS_KEYS.revised] as const;

/** The matrix (`QuoteWorkflow.Matrix`, :73-104). */
export const QUOTE_OPERATION_MATRIX: Readonly<Record<QuoteOperationName, QuoteOperationRule>> = {
  // "Assign / Reassign | Draft, Sent, Revised" — never changes the quote's own status.
  assign: { allowedFromCanonicalKeys: DRAFT_SENT_REVISED, targetMode: 'unchanged' },

  // "Send | Draft" — see this file's header on the flagged V-046 resolution.
  send: {
    allowedFromCanonicalKeys: [QUOTE_STATUS_KEYS.draft],
    targetMode: 'fixed',
    fixedTargetCanonicalKey: QUOTE_STATUS_KEYS.sent,
  },

  // "Revise | Sent" — a Revised quote cannot be revised a second time in this model.
  revise: {
    allowedFromCanonicalKeys: [QUOTE_STATUS_KEYS.sent],
    targetMode: 'fixed',
    fixedTargetCanonicalKey: QUOTE_STATUS_KEYS.revised,
  },

  // "Mark won | Sent, Revised" — FR-39's ONLY path to a lead's Closed Won.
  'mark-won': {
    allowedFromCanonicalKeys: SENT_REVISED,
    targetMode: 'fixed',
    fixedTargetCanonicalKey: QUOTE_STATUS_KEYS.won,
  },

  // "Mark lost | Sent, Revised".
  'mark-lost': {
    allowedFromCanonicalKeys: SENT_REVISED,
    targetMode: 'fixed',
    fixedTargetCanonicalKey: QUOTE_STATUS_KEYS.lost,
  },

  // "Withdraw | Draft, Sent, Revised".
  withdraw: {
    allowedFromCanonicalKeys: DRAFT_SENT_REVISED,
    targetMode: 'fixed',
    fixedTargetCanonicalKey: QUOTE_STATUS_KEYS.withdrawn,
  },

  // "Set current | Draft, Sent, Revised" (PRD 7.3, V-049) — never changes the quote's own status.
  'set-current': { allowedFromCanonicalKeys: DRAFT_SENT_REVISED, targetMode: 'unchanged' },

  // "Expire | Sent, Revised (automatic, past valid-until)" — never human-invocable.
  [QUOTE_EXPIRE_OPERATION]: {
    allowedFromCanonicalKeys: SENT_REVISED,
    targetMode: 'fixed',
    fixedTargetCanonicalKey: QUOTE_STATUS_KEYS.expired,
  },
};

/**
 * True if `operation` may be invoked while a quote's status carries this canonical key
 * (`IsLegal`, :111-122).
 *
 * A null key (a tenant-added status) is ALWAYS illegal — see this file's header.
 */
export function isQuoteOperationLegal(
  operation: QuoteOperationName,
  currentCanonicalKey: string | null,
): boolean {
  const rule = QUOTE_OPERATION_MATRIX[operation];
  if (rule === undefined) return false;

  return (
    currentCanonicalKey !== null && rule.allowedFromCanonicalKeys.includes(currentCanonicalKey)
  );
}

/**
 * Every human-invocable operation legal from the given quote status (`GetLegalOperations`, :132-133)
 * — the 409 hint and the raw input to `availableOperations`.
 *
 * The automatic expiry is excluded HERE rather than at the call sites, so no future caller can
 * accidentally surface it; the unit suite sweeps every status to prove it.
 */
export function legalQuoteOperations(currentCanonicalKey: string | null): QuoteOperation[] {
  return QUOTE_OPERATIONS.filter((operation) =>
    isQuoteOperationLegal(operation, currentCanonicalKey),
  );
}

/**
 * The operation's target canonical key (`ResolveFixedTarget`, :139-148). Null means unchanged.
 *
 * Unlike the lead side there is no history-derived mode, so this is total: every quote operation's
 * target is a property of the operation alone.
 */
export function resolveFixedQuoteTarget(operation: QuoteOperationName): string | null {
  const rule = QUOTE_OPERATION_MATRIX[operation];

  switch (rule.targetMode) {
    case 'unchanged':
      return null;
    case 'fixed':
      return rule.fixedTargetCanonicalKey ?? null;
  }
}

/**
 * The per-operation permission map (`QuoteOperationPermissions.Map`, :22-31).
 *
 * Typed as `PermissionCode`, not `string`: a typo here would otherwise silently make an operation
 * unreachable for everyone (no user holds a permission that does not exist, so `has()` would always
 * answer false) instead of failing loudly at compile time.
 *
 * `create` is intentionally absent — its permission (`quotes.create`) is checked at the route, not
 * by the executor, because Create never operates on an existing quote's status.
 */
export const QUOTE_OPERATION_PERMISSIONS: Readonly<Record<QuoteOperation, PermissionCode>> = {
  assign: 'quotes.assign',
  send: 'quotes.mark_sent',
  revise: 'quotes.revise',
  'mark-won': 'quotes.close_won',
  'mark-lost': 'quotes.close_lost',
  withdraw: 'quotes.withdraw',
  'set-current': 'quotes.set_current',
};

/**
 * `QuoteDto.ComputeAvailableOperations` (:58-62): the legality matrix intersected with the caller's
 * effective permissions, so operations illegal for this quote AND operations this caller may not
 * perform are both HIDDEN rather than rendered-then-disabled.
 *
 * A UI affordance, never an authorization decision — `executeQuoteOperation` re-checks both
 * legality and permission server-side, and the integration suite proves an operation absent from
 * this list still fails 409/403 when called directly.
 */
export function availableQuoteOperations(
  currentCanonicalKey: string | null,
  hasPermission: (permission: PermissionCode) => boolean,
): QuoteOperation[] {
  return legalQuoteOperations(currentCanonicalKey).filter((operation) =>
    hasPermission(QUOTE_OPERATION_PERMISSIONS[operation]),
  );
}

/**
 * Create quote's own legality rule (`IsLegalToCreateQuote`, :155-156), evaluated against the LEAD's
 * reporting category: legal while the lead is Open or Quoted, illegal once the lead itself is
 * Won/Lost/Expired/Withdrawn.
 *
 * "Quoted" is included deliberately, not incidentally: PRD 7.3's multi-option quoting explicitly
 * allows creating an additional quote after the lead has already reached Quote Sent.
 */
export function isLegalToCreateQuote(leadReportingCategory: string | null): boolean {
  return leadReportingCategory === 'open' || leadReportingCategory === 'quoted';
}
