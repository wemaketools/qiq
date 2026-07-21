import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FilterBar from '../FilterBar';
import type { DashboardFiltersState } from '../../../app/slices/dashboardFiltersSlice';

const EMPTY_FILTERS: DashboardFiltersState = {
  dateFrom: null,
  dateTo: null,
  productLineId: null,
  brokerId: null,
  rmUserId: null,
  regionId: null,
  teamOrRmId: null,
  brokerTypeId: null,
};

describe('FilterBar', () => {
  it('render_ByDefault_ShouldShowAllDropdownsAsAll', () => {
    // Arrange & Act
    render(
      <FilterBar
        filters={EMPTY_FILTERS}
        onChange={vi.fn()}
        onClear={vi.fn()}
        productLineOptions={[{ id: 1, name: 'Motor' }]}
        brokerOptions={[{ id: 2, name: 'Acme Brokers' }]}
        rmOptions={[{ id: 3, name: 'Jane RM' }]}
        regionOptions={[{ id: 4, name: 'Gaborone' }]}
      />,
    );

    // Assert
    expect(screen.getByTestId('filter-product-line')).toHaveValue('');
    expect(screen.getByTestId('filter-broker')).toHaveValue('');
    expect(screen.getByTestId('filter-rm')).toHaveValue('');
    expect(screen.getByTestId('filter-region')).toHaveValue('');
  });

  it('change_WhenProductLineSelected_ShouldCallOnChangeWithUpdatedFilters', () => {
    // Arrange
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={EMPTY_FILTERS}
        onChange={onChange}
        onClear={vi.fn()}
        productLineOptions={[{ id: 1, name: 'Motor' }]}
        brokerOptions={[]}
        rmOptions={[]}
        regionOptions={[]}
      />,
    );

    // Act
    fireEvent.change(screen.getByTestId('filter-product-line'), { target: { value: '1' } });

    // Assert
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, productLineId: 1 });
  });

  it('click_WhenClearFiltersClicked_ShouldCallOnClear', () => {
    // Arrange
    const onClear = vi.fn();
    render(
      <FilterBar
        filters={{ ...EMPTY_FILTERS, productLineId: 1 }}
        onChange={vi.fn()}
        onClear={onClear}
        productLineOptions={[{ id: 1, name: 'Motor' }]}
        brokerOptions={[]}
        rmOptions={[]}
        regionOptions={[]}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('clear-filters-button'));

    // Assert
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('click_WhenDateRangePreset_ShouldSetFromAndToViaOnChange', () => {
    // Arrange
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={EMPTY_FILTERS}
        onChange={onChange}
        onClear={vi.fn()}
        productLineOptions={[]}
        brokerOptions={[]}
        rmOptions={[]}
        regionOptions={[]}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('date-preset-this-month'));

    // Assert
    const callArg = onChange.mock.calls[0]![0] as DashboardFiltersState;
    expect(callArg.dateFrom).not.toBeNull();
    expect(callArg.dateTo).not.toBeNull();
  });

  it('render_WhenVariantIsRmPerformance_ShouldSwapRmAndBrokerLabels', () => {
    // Arrange & Act
    render(
      <FilterBar
        filters={EMPTY_FILTERS}
        onChange={vi.fn()}
        onClear={vi.fn()}
        productLineOptions={[]}
        brokerOptions={[]}
        rmOptions={[]}
        regionOptions={[]}
        variant="rmPerformance"
      />,
    );

    // Assert
    expect(screen.getByLabelText('RM/Team')).toBeInTheDocument();
    expect(screen.getByLabelText('Broker Type')).toBeInTheDocument();
  });

  it('render_WhenVariantIsDefault_ShouldShowPlainRmAndBrokerLabels', () => {
    // Arrange & Act
    render(
      <FilterBar
        filters={EMPTY_FILTERS}
        onChange={vi.fn()}
        onClear={vi.fn()}
        productLineOptions={[]}
        brokerOptions={[]}
        rmOptions={[]}
        regionOptions={[]}
      />,
    );

    // Assert
    expect(screen.getByLabelText('RM')).toBeInTheDocument();
    expect(screen.getByLabelText('Broker')).toBeInTheDocument();
  });
});
