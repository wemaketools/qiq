import type { ReportingCategory } from '../../components/common/StatusChip';

/**
 * Derives the Leads list Status chip's `ReportingCategory` from `LeadListItemDto.statusName` (spec
 * FR-43, StatusChip's own contract: "chip color is driven by reporting category, never by name, so
 * it survives renames").
 *
 * Flagged gap: `LeadListItemDto` (`src/api/.../Features/Leads/LeadDto.cs`, T-018) carries only
 * `StatusName` — unlike the single-lead `LeadDto`, it does not project `StatusCanonicalKey` or a
 * reporting-category field, so the list screen has no server-authoritative category to key off.
 * This function is a best-effort, name-based stopgap (matching seeded/default status *display*
 * names, not the tenant-renamable-safe canonical key) so the list still renders differentiated chip
 * colors; it will misclassify a tenant that renames a status away from these defaults. Recommended
 * follow-up: add a `StatusReportingCategory` field to `LeadListItemDto`/`ListLeadsQueryHandler`
 * (mirrors the field `LeadDto` already has) and delete this function in favor of it.
 */
export function deriveLeadReportingCategory(statusName: string): ReportingCategory {
  const normalized = statusName.trim().toLowerCase();

  if (normalized === 'won' || normalized.includes('won')) {
    return 'won';
  }
  if (normalized === 'lost' || normalized.includes('lost')) {
    return 'lost';
  }
  if (normalized.includes('expired')) {
    return 'expired';
  }
  if (normalized.includes('withdrawn')) {
    return 'withdrawn';
  }
  if (normalized.includes('quote')) {
    return 'quoted';
  }
  return 'open';
}
