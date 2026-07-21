/**
 * Tenant-scoped persistence for the global type-ahead search (T-038, AC-022, AC-080; V-027, V-101).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Search/SearchStore.cs`. The match columns, the ranking and
 * the per-group limit are the reference's, verified against BOTH that file and the SPA consumer:
 *
 *   leads   : lead_ref ILIKE 'q%'  OR  external_ref ILIKE 'q%'  OR  party.name ILIKE '%q%'
 *             OR  similarity(party.name, q) >= 0.3            (SearchStore.cs:52-55)
 *             ORDER BY lead_ref ASC, id ASC                  (:64-65)
 *   quotes  : quote_ref ILIKE 'q%'                            (:75)
 *             ORDER BY quote_ref ASC, id ASC                  (:84-85)
 *   parties : name ILIKE '%q%'  OR  similarity(name, q) >= 0.3 (:95-96)
 *             ORDER BY name ASC, id ASC                        (:97)
 *   brokers : name ILIKE '%q%'  OR  similarity(name, q) >= 0.3 (:107-108)
 *             ORDER BY name ASC, id ASC                        (:109)
 *
 * MEASURED, NOT ASSUMED: quotes match ONLY on quote_ref (not on party name or lead ref); leads match
 * on lead_ref/external_ref by PREFIX but on party name by SUBSTRING; parties/brokers match on name by
 * substring OR trigram. The trigram half is the pg_trgm `similarity(...) >= 0.3` predicate (the
 * reference's `TrigramsSimilarity >= NameSimilarityThreshold`), NOT normalization — the same
 * predicate `PartyStore.ListAsync` uses (parties/repository.ts). It is backed by the GIN
 * gin_trgm_ops indexes from 20260718003700_search_indexes.sql (+ ix_parties_name_trgm), so no query
 * sequential-scans a tenant's book.
 *
 * BREADTH (Q-6/A-17/FR-12, SearchStore.cs:58-61,78-81): when the caller lacks `leads.view_all`, only
 * leads (and the quotes of those leads) carrying a `lead_assignments` row for the caller are
 * returned — the SAME `exists (... lead_assignments ...)` predicate `LeadStore.ListAsync` applies
 * (leads/repository.ts). Parties and brokers are tenant-wide lookups with NO breadth rule (A-14).
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NO DATABASE NET UNDERNEATH. Postgres RLS is not
 * adopted (spec Q-10). Each joined table alias carries its own `tenant_id = ${tenantId}` predicate,
 * written out one join at a time, exactly like `listLeadsForParty`. The ORDER BY columns are TABLE-
 * QUALIFIED (`l.lead_ref`, `pt.name`, ...) so Postgres sorts on the real column rather than a
 * same-named output alias — search ordering is user-visible and load-bearing.
 */
import { sql } from 'kysely';

import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import type {
  SearchBrokerDto,
  SearchLeadDto,
  SearchPartyDto,
  SearchQuoteDto,
} from './schemas.js';

/** `SearchStore.NameSimilarityThreshold` (SearchStore.cs:27) — pg_trgm's documented default. */
const NAME_SIMILARITY_THRESHOLD = 0.3;

/** `bigint` arrives as a string from node-postgres; ids are within the safe-integer range. */
function toId(value: number | string): number {
  return Number(value);
}

export interface GlobalSearchResult {
  readonly leads: SearchLeadDto[];
  readonly quotes: SearchQuoteDto[];
  readonly parties: SearchPartyDto[];
  readonly brokers: SearchBrokerDto[];
}

export interface SearchParams {
  readonly q: string;
  readonly limitPerType: number;
  readonly callerUserId: number;
  readonly callerHasLeadViewAll: boolean;
}

/**
 * Runs the four grouped queries for one tenant. Each group is independently capped at
 * `limitPerType`, so no query is unbounded; the four run sequentially rather than fanning out per
 * row (no N+1).
 */
export async function searchTenant(
  executor: DbExecutor,
  tenantId: TenantId,
  params: SearchParams,
): Promise<GlobalSearchResult> {
  const { q, limitPerType, callerUserId, callerHasLeadViewAll } = params;
  const prefix = `${q}%`;
  const substring = `%${q}%`;

  // The breadth clause (empty for a view_all holder). When present it is AND-joined, so it can only
  // ever narrow — a caller cannot widen visibility because the predicate only adds an EXISTS.
  const leadBreadth = callerHasLeadViewAll
    ? sql``
    : sql` and exists (
        select 1 from lead_assignments la
         where la.tenant_id = ${tenantId}
           and la.lead_id = l.id
           and la.user_id = ${callerUserId}
      )`;

  const leadRows = await sql<{
    id: string;
    ref: string;
    party_name: string;
    status: string;
  }>`
    select l.id::text        as id,
           l.lead_ref        as ref,
           p.name            as party_name,
           st.name           as status
      from leads l
      join parties p
        on p.tenant_id = ${tenantId} and p.id = l.party_id
      join reference_items st
        on st.tenant_id = ${tenantId} and st.id = l.status_id
     where l.tenant_id = ${tenantId}
       and (l.lead_ref ilike ${prefix}
            or (l.external_ref is not null and l.external_ref ilike ${prefix})
            or p.name ilike ${substring}
            or extensions.similarity(p.name, ${q}) >= ${NAME_SIMILARITY_THRESHOLD})
       ${leadBreadth}
     order by l.lead_ref asc, l.id asc
     limit ${limitPerType}
  `.execute(executor);

  const quoteRows = await sql<{
    id: string;
    ref: string;
    lead_id: string;
    lead_ref: string;
    party_name: string;
    status: string;
  }>`
    select qu.id::text       as id,
           qu.quote_ref      as ref,
           l.id::text        as lead_id,
           l.lead_ref        as lead_ref,
           p.name            as party_name,
           st.name           as status
      from quotes qu
      join leads l
        on l.tenant_id = ${tenantId} and l.id = qu.lead_id
      join parties p
        on p.tenant_id = ${tenantId} and p.id = l.party_id
      join reference_items st
        on st.tenant_id = ${tenantId} and st.id = qu.status_id
     where qu.tenant_id = ${tenantId}
       and qu.quote_ref ilike ${prefix}
       ${leadBreadth}
     order by qu.quote_ref asc, qu.id asc
     limit ${limitPerType}
  `.execute(executor);

  const partyRows = await sql<{
    id: string;
    name: string;
    type: string;
  }>`
    select pt.id::text       as id,
           pt.name           as name,
           ty.name           as type
      from parties pt
      join reference_items ty
        on ty.tenant_id = ${tenantId} and ty.id = pt.party_type_id
     where pt.tenant_id = ${tenantId}
       and (pt.name ilike ${substring}
            or extensions.similarity(pt.name, ${q}) >= ${NAME_SIMILARITY_THRESHOLD})
     order by pt.name asc, pt.id asc
     limit ${limitPerType}
  `.execute(executor);

  const brokerRows = await sql<{
    id: string;
    name: string;
    tier: string | null;
  }>`
    select b.id::text        as id,
           b.name            as name,
           ty.name           as tier
      from brokers b
      left join reference_items ty
        on ty.tenant_id = ${tenantId} and ty.id = b.broker_type_id
     where b.tenant_id = ${tenantId}
       and (b.name ilike ${substring}
            or extensions.similarity(b.name, ${q}) >= ${NAME_SIMILARITY_THRESHOLD})
     order by b.name asc, b.id asc
     limit ${limitPerType}
  `.execute(executor);

  return {
    leads: leadRows.rows.map((row) => ({
      id: toId(row.id),
      ref: row.ref,
      partyName: row.party_name,
      status: row.status,
    })),
    quotes: quoteRows.rows.map((row) => ({
      id: toId(row.id),
      ref: row.ref,
      leadId: toId(row.lead_id),
      leadRef: row.lead_ref,
      partyName: row.party_name,
      status: row.status,
    })),
    parties: partyRows.rows.map((row) => ({
      id: toId(row.id),
      name: row.name,
      type: row.type,
    })),
    brokers: brokerRows.rows.map((row) => ({
      id: toId(row.id),
      name: row.name,
      tier: row.tier,
    })),
  };
}
