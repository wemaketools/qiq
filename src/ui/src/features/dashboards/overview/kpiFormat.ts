import { formatCompactCurrency, formatPercent } from '../../../components/dashboards/formatters';
import type { KpiKind } from '../executiveApi';

const EM_DASH = '—';

/** Formats a KPI's primary value per its declared kind (spec FR-55/NFR-08): compact currency, percent, count, or days. */
export function formatKpiValue(kind: KpiKind, value: number | null, currencyCode: string): string {
  if (value == null) {
    return EM_DASH;
  }
  switch (kind) {
    case 'currency':
      return formatCompactCurrency(value, currencyCode);
    case 'percent':
      return formatPercent(value);
    case 'days':
      return `${value.toFixed(1)} days`;
    case 'count':
    default:
      return Math.round(value).toLocaleString();
  }
}

/** Formats a KPI's period-over-period delta string, or `null` when there is no prior-period value (spec FR-54). */
export function formatKpiDelta(kind: KpiKind, delta: number | null, currencyCode: string): string | null {
  if (delta == null) {
    return null;
  }
  const sign = delta < 0 ? '-' : '+';
  const abs = Math.abs(delta);
  switch (kind) {
    case 'currency':
      return `${sign}${formatCompactCurrency(abs, currencyCode)}`;
    case 'percent':
      return `${sign}${(abs * 100).toFixed(1)}pp`;
    case 'days':
      return `${sign}${abs.toFixed(1)}`;
    case 'count':
    default:
      return `${sign}${Math.round(abs).toLocaleString()}`;
  }
}
