import { useMemo, useState } from 'react';
import type { SortState } from './SortableTh';

/** Per-field value accessor; string values compare case-insensitively, null/undefined sort last. */
export type SortAccessors<T, F extends string> = Record<F, (item: T) => string | number | boolean | null | undefined>;

function compareValues(a: string | number | boolean | null | undefined, b: string | number | boolean | null | undefined): number {
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Client-side sorting for grids whose full data set is already in memory (User Manager, Tenant
 * Manager, Brokers — the server returns the whole list). Provides the sane default ordering
 * (`initial`) and the standard toggle behavior: clicking a new column sorts it ascending, clicking
 * the active column flips direction. Pairs with `SortableTh` for the header UI. Null/undefined
 * values sort last in both directions.
 */
export function useClientSort<T, F extends string>(
  items: T[],
  accessors: SortAccessors<T, F>,
  // `NoInfer` keeps `initial` from contributing an inference candidate for `F`: without it a call
  // passing `{ field: 'name' }` collapses `F` to the literal `'name'`, and every other column key
  // (`status`, `email`, ...) is then rejected at the `SortableTh`/`toggle` call sites. `F` must come
  // from the accessors map alone, which is the authoritative set of sortable fields.
  initial: SortState<NoInfer<F>>,
) {
  const [sort, setSort] = useState<SortState<F>>(initial);

  const sorted = useMemo(() => {
    const accessor = accessors[sort.field];
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...items].sort((left, right) => {
      const a = accessor(left);
      const b = accessor(right);
      // Nulls stay last regardless of direction so "missing" never leads the grid.
      if (a == null || b == null) {
        return compareValues(a, b);
      }
      return compareValues(a, b) * factor;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- accessors are expected to be a stable module-level map.
  }, [items, sort]);

  function toggle(field: F): void {
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'asc' },
    );
  }

  return { sorted, sort, toggle };
}
