import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PartiesFilterBar from '../PartiesFilterBar';
import { EMPTY_PARTIES_FILTERS } from '../partiesFilters';

describe('PartiesFilterBar', () => {
  it('type_WhenSearchTyped_ShouldCallOnChangeAfterDebounce', async () => {
    // Arrange
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(
      <PartiesFilterBar
        filters={EMPTY_PARTIES_FILTERS}
        onChange={onChange}
        onClear={vi.fn()}
        partyTypeOptions={[]}
        segmentOptions={[]}
        industryOptions={[]}
        regionOptions={[]}
      />,
    );

    // Act
    fireEvent.change(screen.getByTestId('parties-search-input'), { target: { value: 'Botswana Mining' } });
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);

    // Assert
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'Botswana Mining' }));
    vi.useRealTimers();
  });

  it('change_WhenPartyTypeSelected_ShouldCallOnChangeImmediately', () => {
    // Arrange
    const onChange = vi.fn();
    render(
      <PartiesFilterBar
        filters={EMPTY_PARTIES_FILTERS}
        onChange={onChange}
        onClear={vi.fn()}
        partyTypeOptions={[{ id: 10, name: 'Corporate' }]}
        segmentOptions={[]}
        industryOptions={[]}
        regionOptions={[]}
      />,
    );

    // Act
    fireEvent.change(screen.getByTestId('party-type-filter'), { target: { value: '10' } });

    // Assert
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ partyTypeId: 10 }));
  });

  it('render_WhenOptionSetIsNull_ShouldDisableThatControl', () => {
    // Arrange & Act
    render(
      <PartiesFilterBar
        filters={EMPTY_PARTIES_FILTERS}
        onChange={vi.fn()}
        onClear={vi.fn()}
        partyTypeOptions={null}
        segmentOptions={[]}
        industryOptions={[]}
        regionOptions={[]}
      />,
    );

    // Assert
    expect(screen.getByTestId('party-type-filter')).toBeDisabled();
  });

  it('click_WhenClearFiltersClicked_ShouldCallOnClear', () => {
    // Arrange
    const onClear = vi.fn();
    render(
      <PartiesFilterBar
        filters={EMPTY_PARTIES_FILTERS}
        onChange={vi.fn()}
        onClear={onClear}
        partyTypeOptions={[]}
        segmentOptions={[]}
        industryOptions={[]}
        regionOptions={[]}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('clear-filters-button'));

    // Assert
    expect(onClear).toHaveBeenCalled();
  });
});
