/**
 * The lead activity timeline (T-029; AC-022, AC-060; V-027, V-076).
 *
 * Port of `GetLeadTimelineQueryHandler` + `TimelineEntryDto`/`LeadTimelineDto`
 * (`src/api/QuoteIQ.Application/Features/Leads/GetTimeline/`).
 *
 * FOUR SOURCES — MEASURED, AND NARROWER THAN THE TASK FILE AND AC-060 DESCRIBE
 * ===========================================================================
 * The reference aggregates EXACTLY four: `lead_status_history`, the lead's quotes' own
 * `quote_status_history`, `follow_ups` and `lead_notes` (handler :55-65, and its own doc comment
 * says "its four tenant-scoped sources"). The task file additionally lists pricing approvals,
 * assignment changes and attachment events; AC-060/V-076 name "attachment events" as a fifth
 * source. THE REFERENCE IMPLEMENTS NONE OF THOSE — there is no attachment, pricing-approval or
 * assignment branch anywhere in the handler, `TimelineEntryDto` declares exactly four type
 * discriminators (`status`, `quote_status`, `follow_up`, `note`), and the already-shipped SPA panel
 * renders exactly those four (`TimelinePanel.tsx`) and types them as a closed union
 * (`leadsApi.ts:409`). Adding a fifth type would break the SPA's exhaustive `TYPE_LABELS` map.
 *
 * The reference is authoritative, so four is what ships. Recorded as a contradiction in the task
 * file rather than silently resolved.
 *
 * "INTAKE NOTES APPEAR AS THE FIRST ACTIVITY" MEANS OLDEST, HENCE LAST ON THE PAGE
 * ===============================================================================
 * The list is NEWEST FIRST (spec FR-44). The intake note is written at creation with the same `now`
 * as the lead itself, and creation writes no status-history row, so it is the lead's earliest entry
 * and therefore the LAST item of the last page. AC-060's "first activity" is chronological, not
 * positional; the test asserts the position that follows from it.
 *
 * PAGED, NOT FULL, AND THE PAGE SIZE IS FIXED
 * ===========================================
 * `LeadTimelineDto.PageSizeValue = 50`, page is 1-based and floors at 1 (:156), and the envelope is
 * `{ items, totalCount, page, pageSize }` — NOT a bare array. Verified against the SPA, which reads
 * `totalCount` to decide whether to render "Load more" and pages with `?page=`.
 *
 * NOT BREADTH-FILTERED, MATCHING LEAD DETAIL
 * ==========================================
 * The handler resolves the lead with the plain `_leadStore.FindAsync` (:49) — the same call
 * `GetLeadQueryHandler` uses — with no `leads.view_all` consideration anywhere. Visibility breadth
 * is a LIST-query filter in this codebase (human-ruled); a caller who can read a lead's detail can
 * read its timeline. Tenant scope is a different thing entirely and IS enforced, in the query.
 */
import { leadNotFoundError } from './errors.js';
import { findLead } from './repository.js';
import {
  countLeadTimeline,
  listLeadTimeline,
  type TimelineSourceRow,
} from './timeline.repository.js';
import type { LeadsActor, LeadsDeps } from './service.js';

/** `TimelineEntryDto` (`TimelineEntryDto.cs:9-21`). `quoteRef` is set on quote entries and nowhere else. */
export interface TimelineEntryDto {
  readonly type: 'status' | 'quote_status' | 'follow_up' | 'note';
  readonly at: string;
  readonly actorName: string | null;
  readonly title: string;
  readonly detail: string | null;
  readonly quoteRef: string | null;
}

/** `LeadTimelineDto` (`TimelineEntryDto.cs:24-27`). */
export interface LeadTimelineDto {
  readonly items: TimelineEntryDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/** `LeadTimelineDto.PageSizeValue` — fixed, not client-supplied. */
export const TIMELINE_PAGE_SIZE = 50;

/**
 * `OperationTitle` (:214-216): a kebab-case wire code to a Title Case label.
 *
 * Only the FIRST character of each hyphen-separated word is upper-cased and the remainder is left
 * untouched, so `log-follow-up` renders `Log Follow Up`. Empty segments are dropped
 * (`RemoveEmptyEntries`), which is what keeps a stray double hyphen from producing a blank word.
 */
export function operationTitle(operationCode: string): string {
  return operationCode
    .split('-')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * `StatusTransitionDetail` (:200-211).
 *
 * No detail at all unless BOTH ids are present AND different — a row that records no transition
 * (the follow-up/pricing operations, which stamp history without moving status) shows only its
 * title. An id that no longer resolves renders `Unknown` rather than disappearing, so a deleted
 * reference item cannot make a transition look like a non-transition.
 */
function statusTransitionDetail(row: TimelineSourceRow): string | null {
  if (
    row.previousStatusId === null ||
    row.newStatusId === null ||
    row.previousStatusId === row.newStatusId
  ) {
    return null;
  }

  return `${row.previousStatusName ?? 'Unknown'} → ${row.newStatusName ?? 'Unknown'}`;
}

/** `$"{user.FirstName} {user.LastName}".Trim()`, or null when the row records no acting user. */
function actorName(row: TimelineSourceRow): string | null {
  if (row.actorFirstName === null && row.actorLastName === null) return null;
  const name = `${row.actorFirstName ?? ''} ${row.actorLastName ?? ''}`.trim();
  return name === '' ? null : name;
}

/** The follow-up detail (:119-123): the outcome note, then the next date if one was set. */
function followUpDetail(row: TimelineSourceRow): string {
  const parts = [row.outcomeNote ?? ''];
  if (row.nextFollowUpDate !== null) parts.push(`Next follow-up: ${row.nextFollowUpDate}`);
  return parts.join(' — ');
}

function projectEntry(row: TimelineSourceRow): TimelineEntryDto {
  switch (row.type) {
    case 'status':
      return {
        type: 'status',
        at: row.at,
        actorName: actorName(row),
        title: operationTitle(row.operation ?? ''),
        detail: statusTransitionDetail(row),
        quoteRef: null,
      };
    case 'quote_status':
      return {
        type: 'quote_status',
        at: row.at,
        actorName: actorName(row),
        title: operationTitle(row.operation ?? ''),
        detail: statusTransitionDetail(row),
        // The ONLY entry type that carries one (`TimelineEntryDto.cs:5-7`).
        quoteRef: row.quoteRef,
      };
    case 'follow_up':
      return {
        type: 'follow_up',
        at: row.at,
        actorName: actorName(row),
        title: 'Follow-up logged',
        detail: followUpDetail(row),
        quoteRef: null,
      };
    case 'note':
      return {
        type: 'note',
        at: row.at,
        actorName: actorName(row),
        title: 'Note added',
        detail: row.body,
        quoteRef: null,
      };
  }
}

/**
 * `GetLeadTimelineQueryHandler.Handle`.
 *
 * The lead is resolved FIRST and a foreign-tenant or missing id answers the same 404 (:49-53, N-01)
 * — the aggregation never runs for a lead the caller cannot reach, so a nonexistent lead and
 * another tenant's lead are indistinguishable from outside.
 */
export async function getLeadTimeline(
  deps: LeadsDeps,
  leadId: number,
  page: number,
  actor: LeadsActor,
): Promise<LeadTimelineDto> {
  const { tenantId } = actor;

  const lead = await findLead(deps.db, tenantId, leadId);
  if (lead === undefined) throw leadNotFoundError(leadId);

  const effectivePage = page < 1 ? 1 : page;
  const offset = (effectivePage - 1) * TIMELINE_PAGE_SIZE;

  const { rows, totalCount } = await listLeadTimeline(
    deps.db,
    tenantId,
    leadId,
    TIMELINE_PAGE_SIZE,
    offset,
  );

  return {
    items: rows.map(projectEntry),
    // An empty page carries no windowed count with it; see `countLeadTimeline`.
    totalCount: rows.length === 0 ? await countLeadTimeline(deps.db, tenantId, leadId) : totalCount,
    page: effectivePage,
    pageSize: TIMELINE_PAGE_SIZE,
  };
}
