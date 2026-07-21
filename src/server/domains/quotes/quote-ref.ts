/**
 * Quote reference generation (T-026; spec §9.3, A-12, R-3).
 *
 * Port of `QuoteIQ.Infrastructure/Sequences/QuoteReferenceGenerator` — which is the SAME sequence
 * service the lead generator uses, differing only in its `entity_type` discriminator and in which
 * tenant-settings template it renders.
 *
 * NEITHER THE ALLOCATION NOR THE TEMPLATE GRAMMAR IS REIMPLEMENTED HERE
 * ====================================================================
 * `allocateReferenceSequence` (leads/lead-ref.ts) owns the three-statement `INSERT ... ON CONFLICT`
 * / `SELECT ... FOR UPDATE` / `UPDATE` allocation, and its header explains why every statement is
 * necessary. `formatReference` (business-rules/reference-format.ts) owns the `{YYYY}`/`{SEQ:n}`
 * grammar and is the same module the settings endpoint validates `quoteRefFormat` with.
 *
 * A second copy of either would be a real defect, not merely duplication: a second allocator would
 * be one refactor away from losing the `FOR UPDATE` row lock that makes concurrent creates
 * non-duplicating (and every non-concurrent test would still pass), and a second formatter would
 * let the settings validator accept a template the generator cannot render.
 *
 * `leads/lead-ref.ts` names this caller explicitly: "Quotes (T-026) allocate 'quote' from the same
 * table."
 *
 * MUST be called with a TRANSACTION executor — the row lock is held until COMMIT, so calling this
 * on the pool would release it immediately and silently un-serialise concurrent allocation.
 */
import { formatReference } from '../business-rules/reference-format.js';
import { allocateReferenceSequence } from '../leads/lead-ref.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';

/** `reference_sequences.entity_type` for quotes — the sibling of the leads module's `'lead'`. */
export const QUOTE_SEQUENCE_ENTITY_TYPE = 'quote';

/** `QuoteReferenceGenerator.Format` — the shared `{YYYY}`/`{SEQ:n}` grammar. */
export function formatQuoteRef(template: string, year: number, sequence: number): string {
  return formatReference(template, year, sequence);
}

/** Allocates and renders one quote reference inside the caller's transaction. */
export async function generateQuoteRef(
  trx: DbExecutor,
  tenantId: TenantId,
  template: string,
  now: Date = new Date(),
): Promise<string> {
  const year = now.getUTCFullYear();
  const sequence = await allocateReferenceSequence(trx, tenantId, QUOTE_SEQUENCE_ENTITY_TYPE, year);
  return formatQuoteRef(template, year, sequence);
}
