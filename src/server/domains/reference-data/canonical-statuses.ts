/**
 * The guarded lead/quote status taxonomy (T-016, P-04, spec §11.2).
 *
 * Ported verbatim from
 * `src/api/QuoteIQ.Infrastructure/Provisioning/DefaultReferenceData.cs:156-202` (AddLeadStatuses /
 * AddQuoteStatuses) and cross-checked row-for-row against this repo's own seed
 * (`supabase/seed.sql`, the 93-row / 10-list template T-006 ships).
 *
 * WHY A CONSTANT AND NOT "WHATEVER THE TEMPLATE SAYS"
 * ==================================================
 * Dashboards and the workflow engine resolve statuses by `canonical_key`, never by the
 * tenant-renameable display name. If the live global template loses `won`, or relabels it into the
 * `lost` reporting category, every tenant seeded afterwards gets a workflow with no way to express
 * "won" — and the damage only becomes visible much later, in a conversion metric that quietly reads
 * zero. `TenantReferenceSeeder.EnsureCanonicalStatusesComplete` (:143-163) is the reference's answer
 * to that (recorded there as T-008 finding F-022), and it is checked at SEED time, inside the
 * tenant-creation transaction, so a bad template aborts the creation instead of producing a
 * half-usable tenant.
 */

export interface CanonicalStatus {
  readonly listType: 'lead_status' | 'quote_status';
  readonly canonicalKey: string;
  readonly reportingCategory: string;
  readonly isTerminal: boolean;
}

/** DefaultReferenceData.cs:159-171. */
const LEAD_STATUSES: readonly CanonicalStatus[] = [
  { listType: 'lead_status', canonicalKey: 'new', reportingCategory: 'open', isTerminal: false },
  { listType: 'lead_status', canonicalKey: 'assigned', reportingCategory: 'open', isTerminal: false },
  {
    listType: 'lead_status',
    canonicalKey: 'information_gathering',
    reportingCategory: 'open',
    isTerminal: false,
  },
  {
    listType: 'lead_status',
    canonicalKey: 'underwriting',
    reportingCategory: 'open',
    isTerminal: false,
  },
  { listType: 'lead_status', canonicalKey: 'pricing', reportingCategory: 'open', isTerminal: false },
  {
    listType: 'lead_status',
    canonicalKey: 'quote_sent',
    reportingCategory: 'quoted',
    isTerminal: false,
  },
  {
    listType: 'lead_status',
    canonicalKey: 'negotiation',
    reportingCategory: 'quoted',
    isTerminal: false,
  },
  { listType: 'lead_status', canonicalKey: 'closed_won', reportingCategory: 'won', isTerminal: true },
  {
    listType: 'lead_status',
    canonicalKey: 'closed_lost',
    reportingCategory: 'lost',
    isTerminal: true,
  },
  { listType: 'lead_status', canonicalKey: 'expired', reportingCategory: 'expired', isTerminal: true },
  {
    listType: 'lead_status',
    canonicalKey: 'withdrawn',
    reportingCategory: 'withdrawn',
    isTerminal: true,
  },
];

/** DefaultReferenceData.cs:185-193. */
const QUOTE_STATUSES: readonly CanonicalStatus[] = [
  { listType: 'quote_status', canonicalKey: 'draft', reportingCategory: 'open', isTerminal: false },
  { listType: 'quote_status', canonicalKey: 'sent', reportingCategory: 'quoted', isTerminal: false },
  {
    listType: 'quote_status',
    canonicalKey: 'revised',
    reportingCategory: 'quoted',
    isTerminal: false,
  },
  { listType: 'quote_status', canonicalKey: 'won', reportingCategory: 'won', isTerminal: true },
  { listType: 'quote_status', canonicalKey: 'lost', reportingCategory: 'lost', isTerminal: true },
  {
    listType: 'quote_status',
    canonicalKey: 'expired',
    reportingCategory: 'expired',
    isTerminal: true,
  },
  {
    listType: 'quote_status',
    canonicalKey: 'withdrawn',
    reportingCategory: 'withdrawn',
    isTerminal: true,
  },
];

export const REQUIRED_CANONICAL_STATUSES: readonly CanonicalStatus[] = [
  ...LEAD_STATUSES,
  ...QUOTE_STATUSES,
];

/** The list types the global template and every tenant's reference data are discriminated by. */
export const REFERENCE_LIST_TYPES = [
  'request_channel',
  'product_line',
  'cover_type',
  'party_segment',
  'industry',
  'region',
  'party_type',
  'lead_status',
  'quote_status',
  'lost_reason',
  'broker_type',
] as const;

export type ReferenceListType = (typeof REFERENCE_LIST_TYPES)[number];

/** `ReportingCategory.All` (checked by the same CHECK constraint on both reference tables). */
export const REPORTING_CATEGORIES = [
  'open',
  'quoted',
  'won',
  'lost',
  'expired',
  'withdrawn',
] as const;
