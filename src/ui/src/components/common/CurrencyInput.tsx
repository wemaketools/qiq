import { useEffect, useState } from 'react';

export interface CurrencyInputProps {
  id: string;
  name: string;
  /** `null` = empty/not entered. */
  value: number | null;
  /** Tenant display-currency symbol (spec A-3, AC-074/AC-028), e.g. from `useTenantCurrencySymbol()`. */
  currencySymbol: string;
  onChange: (value: number | null) => void;
  onBlur?: () => void;
  disabled?: boolean;
  required?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}

function formatThousands(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '';
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (cleaned.length === 0) {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Tenant-currency-aware numeric input (spec FR-29, AC-028: "currency inputs with tenant symbol"),
 * used for `estimatedPremium`/`sumInsured` on the lead intake/edit form. Displays the tenant's
 * currency symbol as a fixed prefix and formats the value with thousand separators; the underlying
 * value passed to `onChange` is always a plain `number | null`, never a formatted string, so callers
 * never have to re-parse it.
 */
function CurrencyInput({
  id,
  name,
  value,
  currencySymbol,
  onChange,
  onBlur,
  disabled,
  required,
  ariaInvalid,
  ariaDescribedBy,
}: CurrencyInputProps) {
  const [text, setText] = useState(() => formatThousands(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setText(formatThousands(value));
    }
  }, [value, focused]);

  return (
    <div data-testid="currency-input" style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
      <span aria-hidden="true" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--qiq-text-secondary)' }}>
        {currencySymbol}
      </span>
      <input
        id={id}
        name={name}
        type="text"
        inputMode="decimal"
        style={{ flex: 1, minWidth: 0 }}
        disabled={disabled}
        required={required}
        value={text}
        aria-invalid={ariaInvalid ? true : undefined}
        aria-describedby={ariaDescribedBy}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseAmount(event.target.value));
        }}
        onBlur={() => {
          setFocused(false);
          setText(formatThousands(value));
          onBlur?.();
        }}
      />
    </div>
  );
}

export default CurrencyInput;
