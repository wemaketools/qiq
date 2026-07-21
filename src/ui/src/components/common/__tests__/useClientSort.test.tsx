import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useClientSort, type SortAccessors } from '../useClientSort';

interface Row {
  name: string;
  branch: string | null;
  count: number;
}

const ROWS: Row[] = [
  { name: 'delta', branch: 'South', count: 3 },
  { name: 'Alpha', branch: null, count: 10 },
  { name: 'charlie', branch: 'North', count: 1 },
];

const ACCESSORS: SortAccessors<Row, 'name' | 'branch' | 'count'> = {
  name: (row) => row.name,
  branch: (row) => row.branch,
  count: (row) => row.count,
};

describe('useClientSort', () => {
  it('sorted_WhenInitialSortProvided_ShouldOrderCaseInsensitively', () => {
    // Arrange + Act
    const { result } = renderHook(() => useClientSort(ROWS, ACCESSORS, { field: 'name', direction: 'asc' }));

    // Assert
    expect(result.current.sorted.map((row) => row.name)).toEqual(['Alpha', 'charlie', 'delta']);
  });

  it('toggle_WhenActiveFieldToggled_ShouldFlipDirection', () => {
    // Arrange
    const { result } = renderHook(() => useClientSort(ROWS, ACCESSORS, { field: 'name', direction: 'asc' }));

    // Act
    act(() => result.current.toggle('name'));

    // Assert
    expect(result.current.sorted.map((row) => row.name)).toEqual(['delta', 'charlie', 'Alpha']);
  });

  it('toggle_WhenDifferentFieldToggled_ShouldSortItAscending', () => {
    // Arrange
    const { result } = renderHook(() => useClientSort(ROWS, ACCESSORS, { field: 'name', direction: 'desc' }));

    // Act
    act(() => result.current.toggle('count'));

    // Assert
    expect(result.current.sort).toEqual({ field: 'count', direction: 'asc' });
    expect(result.current.sorted.map((row) => row.count)).toEqual([1, 3, 10]);
  });

  it('sorted_WhenValuesAreNull_ShouldKeepNullsLastInBothDirections', () => {
    // Arrange
    const { result } = renderHook(() => useClientSort(ROWS, ACCESSORS, { field: 'branch', direction: 'asc' }));

    // Assert ascending: nulls last
    expect(result.current.sorted.map((row) => row.branch)).toEqual(['North', 'South', null]);

    // Act: flip to descending
    act(() => result.current.toggle('branch'));

    // Assert descending: nulls still last
    expect(result.current.sorted.map((row) => row.branch)).toEqual(['South', 'North', null]);
  });
});
