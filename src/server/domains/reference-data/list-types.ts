/**
 * The tenant-configurable list-type registry (T-019, AC-035; P-04, spec §12 Settings).
 *
 * Port of `src/api/QuoteIQ.Domain/ReferenceData/ReferenceListType.cs` +
 * `ReferenceListTypes.TryParse`, plus the per-type rules the .NET code expressed inline as
 * `command.ListType == ReferenceListType.CoverType` style comparisons scattered across
 * CreateItemCommandHandler / UpdateItemCommandHandler / their validators.
 *
 * WHY THE RULES LIVE HERE AND NOT IN THE HANDLERS
 * ==============================================
 * The reference asked "is this a cover type?" in five places (CreateItemValidator.cs:20,
 * CreateItemCommandHandler.cs:46,72, UpdateItemCommandHandler.cs:76,93) and "is this a status?" in
 * six. Each of those is a separate opportunity to forget one — and forgetting the WRITE-side one
 * while keeping the VALIDATE-side one produces a row that passed validation and then silently
 * dropped the field. Naming the three rules once makes every call site the same expression, and
 * makes them unit-testable without a database (test_plan.unit).
 *
 * The list-type STRINGS themselves are not redefined here: `REFERENCE_LIST_TYPES` in
 * canonical-statuses.ts is the single source shared with the global template (T-016) and matches
 * `ck_reference_items_list_type` in 20260718002000_reference_items.sql.
 */
import { REFERENCE_LIST_TYPES, type ReferenceListType } from './canonical-statuses.js';

export { REFERENCE_LIST_TYPES, type ReferenceListType };

const KNOWN: ReadonlySet<string> = new Set<string>(REFERENCE_LIST_TYPES);

/**
 * `ReferenceListTypes.TryParse` (:53-61): the snake_case route/DB value, or null.
 *
 * Ordinal comparison, exactly as the reference's `StringComparer.Ordinal` dictionary — `REGION` is
 * NOT a region. The route answers 400 for null, so a case-insensitive match here would silently
 * widen a documented contract.
 */
export function parseReferenceListType(value: string | undefined): ReferenceListType | null {
  if (value === undefined) return null;
  return KNOWN.has(value) ? (value as ReferenceListType) : null;
}

/**
 * `ReportingCategory.All` restated as the status-list membership test. Lead and quote statuses are
 * the only guarded lists: only they carry `reporting_category`, `canonical_key` and `is_terminal`.
 */
export function isStatusListType(listType: ReferenceListType): boolean {
  return listType === 'lead_status' || listType === 'quote_status';
}

/** Only request channels carry the broker flag (CreateItemCommandHandler.cs:71). */
export function carriesBrokerChannelFlag(listType: ReferenceListType): boolean {
  return listType === 'request_channel';
}

/** Only cover types depend on a parent product line (CreateItemCommandHandler.cs:46,72). */
export function requiresProductLine(listType: ReferenceListType): boolean {
  return listType === 'cover_type';
}

/**
 * `ReportingCategory.IntermediateAllowed` (ReportingCategory.cs:20).
 *
 * A tenant may only ADD (or retarget) a status into an OPEN or QUOTED category. The four terminal
 * categories — won/lost/expired/withdrawn — are reachable only through the canonical statuses the
 * tenant-creation seed installs, because a tenant-invented "won" would give conversion metrics two
 * different rows meaning the same thing (spec FR-20).
 */
export const INTERMEDIATE_REPORTING_CATEGORIES = ['open', 'quoted'] as const;

export function isIntermediateReportingCategory(category: string | null): boolean {
  return category !== null && (INTERMEDIATE_REPORTING_CATEGORIES as readonly string[]).includes(category);
}
