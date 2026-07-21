/**
 * Reporting categories a status chip can be colored by (UI Standards §4.1, spec AC-053, T-031
 * finalized): individual lead/quote statuses are tenant-configurable display names, but every status
 * maps to one of these fixed categories, so chip color survives renames. Consumed by leads (T-027,
 * `leadStatusCategory.ts`), quotes (T-029, `quoteStatusCategory.ts`), and admin list screens
 * (Tenant/User/Role/Group/Broker) for their own active/disabled semantics -- the palette below (open
 * info, quoted accent, won success, lost danger, expired neutral, withdrawn neutral-outlined) already
 * matched every one of those consumers going into this task, so it is unchanged here.
 */
export type ReportingCategory = 'open' | 'quoted' | 'won' | 'lost' | 'expired' | 'withdrawn';

interface StatusChipProps {
  label: string;
  category: ReportingCategory;
}

/**
 * Status chip: color is driven by reporting category, never by name; chip always carries text.
 * Palette lives in the shared `.qiq-chip--{category}` classes (theme/components.css, UI Standards
 * §4.1) so leads, quotes, and admin list screens all render the identical chip system.
 */
function StatusChip({ label, category }: StatusChipProps) {
  return (
    <span data-testid="status-chip" data-reporting-category={category} className={`qiq-chip qiq-chip--${category}`}>
      {label}
    </span>
  );
}

export default StatusChip;
