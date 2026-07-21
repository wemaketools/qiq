import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LeadsFilterBar from '../LeadsFilterBar';
import { EMPTY_LEADS_FILTERS } from '../leadsFilters';

describe('LeadsFilterBar', () => {
  it('type_WhenSearchTyped_ShouldCallOnChangeAfterDebounce', async () => {
    // Arrange
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(
      <LeadsFilterBar
        filters={EMPTY_LEADS_FILTERS}
        onChange={onChange}
        onClear={vi.fn()}
        statusOptions={[]}
        ownerOptions={[]}
        brokerOptions={[]}
        productLineOptions={[]}
        regionOptions={[]}
        channelOptions={[]}
        myLeadsForced={false}
      />,
    );

    // Act
    fireEvent.change(screen.getByTestId('leads-search-input'), { target: { value: 'LEAD-0042' } });
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);

    // Assert
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'LEAD-0042' }));
    vi.useRealTimers();
  });

  it('render_WhenOptionSetIsNull_ShouldDisableThatControl', () => {
    // Arrange & Act
    render(
      <LeadsFilterBar
        filters={EMPTY_LEADS_FILTERS}
        onChange={vi.fn()}
        onClear={vi.fn()}
        statusOptions={null}
        ownerOptions={[]}
        brokerOptions={[]}
        productLineOptions={[]}
        regionOptions={[]}
        channelOptions={[]}
        myLeadsForced={false}
      />,
    );

    // Assert
    expect(screen.getByTestId('status-filter')).toBeDisabled();
  });

  it('render_WhenMyLeadsForced_ShouldCheckAndDisableToggle', () => {
    // Arrange & Act
    render(
      <LeadsFilterBar
        filters={EMPTY_LEADS_FILTERS}
        onChange={vi.fn()}
        onClear={vi.fn()}
        statusOptions={[]}
        ownerOptions={[]}
        brokerOptions={[]}
        productLineOptions={[]}
        regionOptions={[]}
        channelOptions={[]}
        myLeadsForced
      />,
    );

    // Assert
    const toggle = screen.getByTestId('my-leads-toggle');
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
  });

  it('click_WhenClearFiltersClicked_ShouldCallOnClear', () => {
    // Arrange
    const onClear = vi.fn();
    render(
      <LeadsFilterBar
        filters={EMPTY_LEADS_FILTERS}
        onChange={vi.fn()}
        onClear={onClear}
        statusOptions={[]}
        ownerOptions={[]}
        brokerOptions={[]}
        productLineOptions={[]}
        regionOptions={[]}
        channelOptions={[]}
        myLeadsForced={false}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('clear-filters-button'));

    // Assert
    expect(onClear).toHaveBeenCalled();
  });
});
