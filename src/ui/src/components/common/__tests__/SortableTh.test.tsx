import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SortableTh, { type SortState } from '../SortableTh';

type Field = 'name' | 'count';

function renderHeader(sort: SortState<Field> | null, onSort = vi.fn()) {
  const result = render(
    <table>
      <thead>
        <tr>
          <SortableTh field="name" label="Party name" sort={sort} onSort={onSort} />
        </tr>
      </thead>
    </table>,
  );
  return { ...result, onSort };
}

/** Each arrow is one `<path>`, so the count distinguishes the stacked pair from a single arrow. */
function arrowCount(container: HTMLElement): number {
  return container.querySelectorAll('.qiq-sort-arrow path').length;
}

describe('SortableTh', () => {
  it('render_WhenColumnIsSortableButNotActive_ShouldShowStackedPairAndNoAriaSort', () => {
    // Arrange + Act: another column is the active one.
    const { container } = renderHeader({ field: 'count', direction: 'asc' });

    // Assert: the greyed up/down pair is what advertises the column as sortable at all.
    expect(arrowCount(container)).toBe(2);
    expect(screen.getByTestId('sort-indicator-name')).toHaveAttribute('data-direction', 'none');
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('render_WhenColumnIsSortedAscending_ShouldShowSingleArrowAndAscendingAriaSort', () => {
    // Arrange + Act
    const { container } = renderHeader({ field: 'name', direction: 'asc' });

    // Assert
    expect(arrowCount(container)).toBe(1);
    expect(screen.getByTestId('sort-indicator-name')).toHaveAttribute('data-direction', 'asc');
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('render_WhenColumnIsSortedDescending_ShouldShowSingleArrowAndDescendingAriaSort', () => {
    // Arrange + Act
    const { container } = renderHeader({ field: 'name', direction: 'desc' });

    // Assert
    expect(arrowCount(container)).toBe(1);
    expect(screen.getByTestId('sort-indicator-name')).toHaveAttribute('data-direction', 'desc');
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
  });

  it('render_WhenGridHasNoSortState_ShouldStillAdvertiseTheColumnAsSortable', () => {
    // Arrange + Act
    const { container } = renderHeader(null);

    // Assert
    expect(arrowCount(container)).toBe(2);
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('click_WhenHeaderClicked_ShouldInvokeOnSortWithItsField', () => {
    // Arrange
    const { onSort } = renderHeader({ field: 'count', direction: 'asc' });

    // Act
    fireEvent.click(screen.getByTestId('sort-header-name'));

    // Assert
    expect(onSort).toHaveBeenCalledExactlyOnceWith('name');
  });
});
