import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CurrencyInput from '../CurrencyInput';

function Harness() {
  const [value, setValue] = useState<number | null>(null);
  return <CurrencyInput id="premium" name="premium" value={value} currencySymbol="BWP" onChange={setValue} />;
}

describe('CurrencyInput', () => {
  it('render_WhenValueProvided_ShouldShowCurrencySymbolPrefixAndThousandsSeparators', () => {
    // Arrange & Act
    render(<CurrencyInput id="premium" name="premium" value={1234567} currencySymbol="BWP" onChange={vi.fn()} />);

    // Assert
    const wrapper = screen.getByTestId('currency-input');
    expect(wrapper).toHaveTextContent('BWP');
    expect(screen.getByRole('textbox')).toHaveValue('1,234,567');
  });

  it('change_WhenUserTypesDigits_ShouldCallOnChangeWithParsedNumber', () => {
    // Arrange
    const onChange = vi.fn();
    render(<CurrencyInput id="premium" name="premium" value={null} currencySymbol="BWP" onChange={onChange} />);

    // Act
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '50000' } });

    // Assert
    expect(onChange).toHaveBeenCalledWith(50000);
  });

  it('change_WhenInputCleared_ShouldCallOnChangeWithNull', () => {
    // Arrange
    const onChange = vi.fn();
    render(<CurrencyInput id="premium" name="premium" value={500} currencySymbol="BWP" onChange={onChange} />);

    // Act
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });

    // Assert
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('blur_AfterTyping_ShouldReformatDisplayedValueWithSeparators', () => {
    // Arrange
    render(<Harness />);
    const input = screen.getByRole('textbox');

    // Act
    fireEvent.change(input, { target: { value: '1000000' } });
    fireEvent.blur(input);

    // Assert
    expect(input).toHaveValue('1,000,000');
  });
});
