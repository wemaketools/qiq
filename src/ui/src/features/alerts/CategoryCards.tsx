import Icon, { type IconName } from '../../components/common/Icon';
import type { AlertCategoryCardDto } from './alertsApi';

interface CategoryCardsProps {
  categories: AlertCategoryCardDto[];
  /** The currently-active queue tab; the matching card renders as selected. */
  activeTab: string;
  /** Activates the card's queue tab. Cards whose `tab` is null (Stalled) are not selectable. */
  onSelectTab: (tab: string) => void;
}

/** Category key → design-system icon (best available match to the prototype's per-card glyphs). */
const CATEGORY_ICONS: Record<string, IconName> = {
  escalated: 'warning',
  stalled: 'alerts',
  overdue: 'calendar',
  expiring: 'calendar',
  sla: 'warning',
};

/**
 * The five Alerts-center category summary cards (spec FR-62, PRD 18.2): Escalated, Stalled, Overdue,
 * Expiring, SLA Breaches. Each shows its name, its tenant-threshold-derived definition text (rendered
 * from the backend `definition`, which composes tenant thresholds), and its open count. Clicking a
 * card activates the matching queue tab; the Stalled card has no dedicated queue tab server-side and
 * is intentionally not selectable.
 */
function CategoryCards({ categories, activeTab, onSelectTab }: CategoryCardsProps) {
  return (
    <div
      data-testid="alert-category-cards"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${categories.length}, 1fr)`,
        gap: 'var(--qiq-space-4)',
        marginBottom: 'var(--qiq-space-4)',
      }}
    >
      {categories.map((category) => {
        const selectable = category.tab != null;
        const isActive = selectable && category.tab === activeTab;
        return (
          <button
            key={category.category}
            type="button"
            data-testid="alert-category-card"
            data-category={category.category}
            data-active={isActive ? 'true' : 'false'}
            className="qiq-card"
            aria-pressed={selectable ? isActive : undefined}
            disabled={!selectable}
            onClick={() => {
              if (category.tab != null) {
                onSelectTab(category.tab);
              }
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--qiq-space-2)',
              alignItems: 'flex-start',
              textAlign: 'left',
              cursor: selectable ? 'pointer' : 'default',
              outline: isActive ? '2px solid var(--qiq-accent)' : undefined,
            }}
          >
            <span style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="qiq-kpi-halo" aria-hidden="true">
                <Icon name={CATEGORY_ICONS[category.category] ?? 'alerts'} size={18} />
              </span>
              <span className="qiq-kpi-value" data-testid="alert-category-count">
                {category.count}
              </span>
            </span>
            <span className="qiq-kpi-label" data-testid="alert-category-name">
              {category.name}
            </span>
            <span className="qiq-card-sub" data-testid="alert-category-definition">
              {category.definition}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default CategoryCards;
