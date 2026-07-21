/**
 * Currency/percent formatting for dashboard KPI cards, chart axes, and tables (spec NFR-08/A-3,
 * AC-074, PRD 22, T-031): compact notation ("BWP 128.6M") on cards/axes, full grouped amounts in
 * tables, always driven by the tenant's own currency code (`useTenantCurrency`), never a hardcoded
 * symbol.
 */

const EM_DASH = '—';

function compactSuffix(value: number): { divisor: number; suffix: string } {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return { divisor: 1_000_000_000, suffix: 'B' };
  }
  if (abs >= 1_000_000) {
    return { divisor: 1_000_000, suffix: 'M' };
  }
  if (abs >= 1_000) {
    return { divisor: 1_000, suffix: 'K' };
  }
  return { divisor: 1, suffix: '' };
}

/** Compact currency for KPI cards/chart axes (PRD 17.1's "BWP 128.6M" style). Renders an em dash for `null` (undefined/zero-denominator metric). */
export function formatCompactCurrency(amount: number | null, currencyCode: string): string {
  if (amount == null) {
    return EM_DASH;
  }
  const { divisor, suffix } = compactSuffix(amount);
  if (suffix === '') {
    return `${currencyCode} ${Math.round(amount).toLocaleString()}`;
  }
  const scaled = amount / divisor;
  return `${currencyCode} ${scaled.toFixed(1)}${suffix}`;
}

/** Full, grouped currency amount for tables/exports (spec AC-074: "full amounts in tables"). Renders an em dash for `null`. */
export function formatFullCurrency(amount: number | null, currencyCode: string): string {
  if (amount == null) {
    return EM_DASH;
  }
  return `${currencyCode} ${Math.round(amount).toLocaleString()}`;
}

/** Formats a 0..1 fraction (e.g. `MetricDefinitions`' rate formulas) as a one-decimal percent string. Renders an em dash for `null` (the formula's documented zero-denominator result). */
export function formatPercent(rate: number | null): string {
  if (rate == null) {
    return EM_DASH;
  }
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * KPI card label with its lead-vs-quote qualifier (spec FR-54: "lead vs quote metrics always labeled
 * distinctly"), appended only when the metric name doesn't already carry the distinction itself —
 * "Total Quotes (Quote)" and "Leads at Risk (Lead)" say nothing the bare name doesn't.
 */
export function kpiCardLabel(label: string, leadOrQuote: 'lead' | 'quote'): string {
  return /lead|quote/i.test(label) ? label : `${label} (${leadOrQuote === 'lead' ? 'Lead' : 'Quote'})`;
}
