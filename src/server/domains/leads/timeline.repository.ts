/**
 * The lead activity timeline's aggregation query (T-029; AC-022, AC-060; V-027, V-076).
 *
 * Persistence half of the port of `GetLeadTimelineQueryHandler` — ONE query rather than the
 * reference's shape.
 *
 * WHY ONE UNION ALL AND NOT THE REFERENCE'S IN-MEMORY MERGE
 * ========================================================
 * The reference reads its four sources independently and merges them in C# (its own doc comment
 * argues this is fine "at seed volumes"), then resolves EVERY distinct status id and EVERY distinct
 * actor id with a separate `FindAsync` round trip, and reads each quote's history in a per-quote
 * loop. On a lead with a dozen entries that is upwards of thirty queries — the exact fan-out-per-
 * event pattern CLAUDE.md forbids (N-04), and the same N+1 `listQuotesForLead` was already
 * collapsed for on the Quotes card. The RESULT is identical: same four sources, same projection,
 * same total order. Only the number of round trips differs, so nothing observable is being changed.
 *
 * EVERY ALIAS CARRIES ITS OWN `tenant_id` PREDICATE
 * =================================================
 * RLS is not adopted (Q-10) and these are raw joins, so `forTenant` cannot help. The four union
 * branches, the `quotes` join that scopes quote history to THIS lead, and both `reference_items`
 * joins each carry `tenant_id` explicitly. `users` is the one deliberate exception: it is a global
 * table with no `tenant_id` column, and it is reached only through an actor id already read from a
 * tenant-predicated row.
 *
 * THE ORDER BY IS QUALIFIED, AND THAT IS LOAD-BEARING (T-048)
 * ==========================================================
 * `order by e.at desc, e.type_rank desc, e.source_id desc` names the CTE alias on every key.
 * Postgres resolves a BARE `order by <name>` to an OUTPUT-COLUMN alias in preference to the
 * underlying column, and this select list does carry same-named output columns — an unqualified
 * sort would be one refactor away from sorting a projected/cast value instead of the real one.
 *
 * `at` IS THE PRIMARY SORT, BUT IT NEVER BREAKS ITS OWN TIES
 * =========================================================
 * `acted_at`/`logged_at`/`created_at` are all APPLICATION wall clocks (`new Date()` in the
 * operation), so they tie at millisecond resolution and can step backwards across a clock
 * correction. The reference therefore breaks ties with a fixed per-type rank and then the
 * originating row's own database-assigned `id`, DESCENDING — never with a second timestamp. Both
 * levels are reproduced exactly, and both are pinned by same-timestamp tests rather than assumed
 * never to collide.
 */
import { sql } from 'kysely';

import type { DbExecutor, TenantId } from '../../lib/db/index.js';

/** The four sources, and the rank that breaks an exact timestamp tie between them (:98,:113,:133,:146). */
export const TIMELINE_TYPE_RANKS = {
  status: 3,
  quote_status: 2,
  follow_up: 1,
  note: 0,
} as const;

export type TimelineEntryType = keyof typeof TIMELINE_TYPE_RANKS;

/** One merged row, still unprojected: the raw facts each source contributes. */
export interface TimelineSourceRow {
  readonly type: TimelineEntryType;
  readonly at: string;
  readonly actorFirstName: string | null;
  readonly actorLastName: string | null;
  readonly operation: string | null;
  readonly previousStatusId: number | null;
  readonly newStatusId: number | null;
  readonly previousStatusName: string | null;
  readonly newStatusName: string | null;
  readonly body: string | null;
  readonly outcomeNote: string | null;
  readonly nextFollowUpDate: string | null;
  readonly quoteRef: string | null;
}

export interface TimelinePage {
  readonly rows: TimelineSourceRow[];
  readonly totalCount: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** `date` columns arrive as `Date` under node-postgres; the reference renders them `yyyy-MM-dd`. */
function toDateOnlyOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * One page of the merged timeline, plus the total over the WHOLE merge.
 *
 * `count(*) over ()` is evaluated before `limit`, so the count and the page come from one pass over
 * one predicate set by construction — a separate count query could disagree with the page it
 * describes if a write landed between them.
 */
export async function listLeadTimeline(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
  limit: number,
  offset: number,
): Promise<TimelinePage> {
  const result = await sql<{
    entry_type: string;
    at: Date | string;
    first_name: string | null;
    last_name: string | null;
    operation: string | null;
    previous_status_id: number | string | null;
    new_status_id: number | string | null;
    previous_status_name: string | null;
    new_status_name: string | null;
    body: string | null;
    outcome_note: string | null;
    next_follow_up_date: Date | string | null;
    quote_ref: string | null;
    total_count: number | string;
  }>`
    with entries as (
      select 'status'::text as entry_type,
             3 as type_rank,
             h.id as source_id,
             h.acted_at as at,
             h.acted_by as actor_id,
             h.operation as operation,
             h.previous_status_id as previous_status_id,
             h.new_status_id as new_status_id,
             null::text as body,
             null::text as outcome_note,
             null::date as next_follow_up_date,
             null::bigint as quote_id
        from lead_status_history h
       where h.tenant_id = ${tenantId} and h.lead_id = ${leadId}
      union all
      select 'quote_status', 2, qh.id, qh.acted_at, qh.acted_by, qh.operation,
             qh.previous_status_id, qh.new_status_id, null, null, null, qh.quote_id
        from quote_status_history qh
        join quotes q on q.id = qh.quote_id and q.tenant_id = ${tenantId}
       where qh.tenant_id = ${tenantId} and q.lead_id = ${leadId}
      union all
      select 'follow_up', 1, f.id, f.logged_at, f.logged_by, null,
             null, null, null, f.outcome_note, f.next_follow_up_date, null
        from follow_ups f
       where f.tenant_id = ${tenantId} and f.lead_id = ${leadId}
      union all
      select 'note', 0, n.id, n.created_at, n.created_by, null,
             null, null, n.body, null, null, null
        from lead_notes n
       where n.tenant_id = ${tenantId} and n.lead_id = ${leadId}
    )
    select e.entry_type, e.at, e.operation, e.body, e.outcome_note, e.next_follow_up_date,
           e.previous_status_id, e.new_status_id,
           ps.name as previous_status_name, ns.name as new_status_name,
           qr.quote_ref, u.first_name, u.last_name,
           count(*) over () as total_count
      from entries e
      left join quotes qr on qr.id = e.quote_id and qr.tenant_id = ${tenantId}
      left join reference_items ps on ps.id = e.previous_status_id and ps.tenant_id = ${tenantId}
      left join reference_items ns on ns.id = e.new_status_id and ns.tenant_id = ${tenantId}
      left join users u on u.id = e.actor_id
     order by e.at desc, e.type_rank desc, e.source_id desc
     limit ${limit} offset ${offset}
  `.execute(executor);

  return {
    rows: result.rows.map((row) => ({
      type: row.entry_type as TimelineEntryType,
      at: toIso(row.at),
      actorFirstName: row.first_name,
      actorLastName: row.last_name,
      operation: row.operation,
      previousStatusId: row.previous_status_id === null ? null : Number(row.previous_status_id),
      newStatusId: row.new_status_id === null ? null : Number(row.new_status_id),
      previousStatusName: row.previous_status_name,
      newStatusName: row.new_status_name,
      body: row.body,
      outcomeNote: row.outcome_note,
      nextFollowUpDate: toDateOnlyOrNull(row.next_follow_up_date),
      quoteRef: row.quote_ref,
    })),
    totalCount: result.rows.length === 0 ? 0 : Number(result.rows[0]?.total_count ?? 0),
  };
}

/**
 * The total when the requested page lies past the end.
 *
 * `count(*) over ()` rides on the returned rows, so an empty page carries no count with it. Rather
 * than let a page-5-of-2 request report `totalCount: 0` — which the SPA's "Load more" affordance
 * reads as "nothing here" — the count is re-read on exactly that path. It is a second query only
 * for a request that returned no rows, never on the common path.
 */
export async function countLeadTimeline(
  executor: DbExecutor,
  tenantId: TenantId,
  leadId: number,
): Promise<number> {
  const result = await sql<{ total_count: number | string }>`
    select (
      (select count(*) from lead_status_history h
        where h.tenant_id = ${tenantId} and h.lead_id = ${leadId})
      + (select count(*) from quote_status_history qh
           join quotes q on q.id = qh.quote_id and q.tenant_id = ${tenantId}
          where qh.tenant_id = ${tenantId} and q.lead_id = ${leadId})
      + (select count(*) from follow_ups f
          where f.tenant_id = ${tenantId} and f.lead_id = ${leadId})
      + (select count(*) from lead_notes n
          where n.tenant_id = ${tenantId} and n.lead_id = ${leadId})
    ) as total_count
  `.execute(executor);

  return Number(result.rows[0]?.total_count ?? 0);
}
