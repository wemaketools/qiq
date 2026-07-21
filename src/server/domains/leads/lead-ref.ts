/**
 * Lead reference generation (T-024, AC-043; V-056; spec §9.3, A-12, R-3).
 *
 * Port of `QuoteIQ.Domain/Settings/LeadReferenceGenerator.cs` (the pure formatting seam) and
 * `QuoteIQ.Infrastructure/Sequences/ReferenceSequenceService.cs` (the allocation SQL), plus
 * `CreateLeadCommandHandler.DerivePriority` (:343-346).
 *
 * THE TEMPLATE GRAMMAR IS NOT REIMPLEMENTED HERE
 * ==============================================
 * `formatLeadRef` delegates to `business-rules/reference-format.ts`, which is the SAME module the
 * settings endpoint validates `leadRefFormat` with (its header names this caller explicitly). A
 * second implementation would let the validator accept a template the generator cannot render, and
 * the resulting failure would surface at lead-creation time in a completely different feature from
 * the one that caused it.
 *
 * ALLOCATION IS THREE STATEMENTS AND EVERY ONE IS NECESSARY (ReferenceSequenceService.cs:29-37)
 * ============================================================================================
 *   1. `INSERT ... ON CONFLICT DO NOTHING` — guarantees the row EXISTS. `SELECT ... FOR UPDATE`
 *      cannot lock a row that does not exist yet, so without this the first two concurrent creates
 *      of a tenant/year both see no row and both allocate 1.
 *   2. `SELECT next_value ... FOR UPDATE` — takes the row lock a concurrent allocation must wait
 *      behind. This is the statement A-12/spec §9.3 specifies and the one the parallel-create test
 *      falsifies: drop `FOR UPDATE` and 20 parallel creates mint duplicate references.
 *   3. `UPDATE ... SET next_value` — persists the increment before COMMIT releases the lock.
 *
 * IT MUST RUN INSIDE THE CALLER'S TRANSACTION, AND THAT IS WHY IT TAKES AN EXECUTOR
 * ================================================================================
 * The row lock is held until COMMIT. Called on the pool instead of the creating transaction, each
 * statement would run on its own connection, the lock would be released immediately, and the
 * serialisation would be gone while every test that is not concurrent still passed. `createLead`
 * therefore passes its `trx`, and the signature offers no way to pass anything else usefully.
 *
 * R-3/pooler note: this is safe through a transaction-mode pooler precisely because all three
 * statements are in one transaction, which the pooler pins to one backend for its duration.
 */
import { sql } from 'kysely';

import { formatReference } from '../business-rules/reference-format.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { LEAD_PRIORITY_HIGH, LEAD_PRIORITY_NORMAL, type LeadPriority } from './schemas.js';

/** `reference_sequences.entity_type` for leads. Quotes (T-026) allocate `'quote'` from the same table. */
export const LEAD_SEQUENCE_ENTITY_TYPE = 'lead';

/** `LeadReferenceGenerator.Format` (:17-18). */
export function formatLeadRef(template: string, year: number, sequence: number): string {
  return formatReference(template, year, sequence);
}

/**
 * `CreateLeadCommandHandler.DerivePriority` (:343-346).
 *
 * Both null branches are load-bearing: a tenant with NO configured threshold must not get an
 * all-High pipeline, and a lead with no estimated premium cannot be judged against one. The
 * comparison is STRICTLY `>`, so a premium exactly equal to the threshold stays Normal.
 */
export function derivePriority(
  estimatedPremium: number | null | undefined,
  highValueThreshold: number | null | undefined,
): LeadPriority {
  if (estimatedPremium === null || estimatedPremium === undefined) return LEAD_PRIORITY_NORMAL;
  if (highValueThreshold === null || highValueThreshold === undefined) return LEAD_PRIORITY_NORMAL;
  return estimatedPremium > highValueThreshold ? LEAD_PRIORITY_HIGH : LEAD_PRIORITY_NORMAL;
}

/**
 * Allocates the next 1-based sequence value for a tenant/entity-type/year.
 *
 * MUST be called with a TRANSACTION executor — see this file's header. `reference_sequences` is
 * LIST-partitioned on `tenant_id`, and its natural key is the separate
 * `unique (tenant_id, entity_type, year)` constraint rather than the composite primary key, which
 * is what `ON CONFLICT` targets below.
 */
export async function allocateReferenceSequence(
  trx: DbExecutor,
  tenantId: TenantId,
  entityType: string,
  year: number,
): Promise<number> {
  // Step 1 — ensure the row exists without erroring when two transactions race to create it.
  await sql`
    insert into reference_sequences (tenant_id, entity_type, year, next_value)
    values (${tenantId}, ${entityType}, ${year}, 0)
    on conflict (tenant_id, entity_type, year) do nothing
  `.execute(trx);

  // Step 2 — take the row lock. Everything about concurrency safety lives in `for update`.
  const locked = await sql<{ next_value: string | number }>`
    select next_value
      from reference_sequences
     where tenant_id = ${tenantId}
       and entity_type = ${entityType}
       and year = ${year}
     for update
  `.execute(trx);

  const current = Number(locked.rows[0]?.next_value ?? 0);
  const allocated = current + 1;

  // Step 3 — persist the increment before COMMIT releases the lock.
  await sql`
    update reference_sequences
       set next_value = ${allocated}
     where tenant_id = ${tenantId}
       and entity_type = ${entityType}
       and year = ${year}
  `.execute(trx);

  return allocated;
}

/**
 * Allocates and renders one lead reference inside the caller's transaction.
 *
 * The YEAR is taken from the lead's creation moment (UTC), not from `dateReceived`: the reference
 * allocates with `DateTime.UtcNow.Year`, so back-dating a lead into last December does not reach
 * back into last year's sequence.
 */
export async function generateLeadRef(
  trx: DbExecutor,
  tenantId: TenantId,
  template: string,
  now: Date = new Date(),
): Promise<string> {
  const year = now.getUTCFullYear();
  const sequence = await allocateReferenceSequence(trx, tenantId, LEAD_SEQUENCE_ENTITY_TYPE, year);
  return formatLeadRef(template, year, sequence);
}
