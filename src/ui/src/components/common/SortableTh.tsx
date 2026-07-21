export interface SortState<F extends string = string> {
  field: F;
  direction: 'asc' | 'desc';
}

interface SortableThProps<F extends string> {
  field: F;
  label: string;
  sort: SortState<F> | null | undefined;
  onSort: (field: F) => void;
  align?: 'left' | 'right';
}

/**
 * Stacked pair, drawn only on columns that are sortable-but-not-currently-sorted: the affordance that
 * tells the user the header is clickable at all, without competing with the active column's single
 * arrow (it is drawn in a lighter grey via `.qiq-sort-arrow`).
 */
const STACKED_UP = 'M4 1L7.5 5H0.5Z';
const STACKED_DOWN = 'M4 11L0.5 7H7.5Z';

/** Single, vertically centered arrow marking the one column the grid is currently sorted by. */
const ACTIVE_UP = 'M4 3.5L7.5 8.5H0.5Z';
const ACTIVE_DOWN = 'M4 8.5L0.5 3.5H7.5Z';

/** `null` direction = sortable but not the active column. */
function SortArrows({ direction }: { direction: SortState['direction'] | null }) {
  return (
    <svg className="qiq-sort-arrow" viewBox="0 0 8 12" width="8" height="12" aria-hidden="true" focusable="false">
      {direction === null ? (
        <>
          <path d={STACKED_UP} />
          <path d={STACKED_DOWN} />
        </>
      ) : (
        <path d={direction === 'asc' ? ACTIVE_UP : ACTIVE_DOWN} />
      )}
    </svg>
  );
}

/**
 * The one sortable column header for every grid (UI Standards §15): a `<th>` whose label is a button
 * styled to look exactly like a plain header (`.qiq-th-sort`), with the active column carrying
 * `aria-sort` and a single direction arrow, and every other sortable column carrying the greyed
 * stacked pair. Consumers own the sort state — server-driven grids (Leads, Parties) pass their API
 * sort state; in-memory grids use `useClientSort`.
 *
 * Because the arrows are the sortable-affordance, this renders only for columns that really are
 * sortable: a column with no sort key stays a plain `<th>` (see `LeadsTable`'s Flags column).
 */
function SortableTh<F extends string>({ field, label, sort, onSort, align }: SortableThProps<F>) {
  const active = sort != null && sort.field === field;
  return (
    <th
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="qiq-th-sort" data-testid={`sort-header-${field}`} onClick={() => onSort(field)}>
        {label}
        <span
          className="qiq-sort-arrow-slot"
          data-testid={`sort-indicator-${field}`}
          data-direction={active ? sort.direction : 'none'}
        >
          <SortArrows direction={active ? sort.direction : null} />
        </span>
      </button>
    </th>
  );
}

export default SortableTh;
