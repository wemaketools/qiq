import KpiCard from '../../../components/dashboards/KpiCard';
import { kpiCardLabel } from '../../../components/dashboards/formatters';
import type { BrokerKpiDto } from '../brokersApi';
import { formatKpiDelta, formatKpiValue } from '../overview/kpiFormat';

interface BrokerKpiRowProps {
  kpis: BrokerKpiDto[];
  currencyCode: string;
  onDrill: (widgetKey: string) => void;
}

/** Per-KPI icon glyph (UI standards 3.3's tinted halo); the text label always carries the meaning. */
const KPI_ICONS: Record<string, string> = {
  active_brokers: '⚑',
  broker_quotes: '≣',
  broker_conversion: '%',
  won_via_brokers: '$',
  avg_turnaround: '⏱',
  overdue_follow_ups: '!',
};

/**
 * The Broker Performance KPI row (spec FR-57, PRD 15.1, T-034): six cards — Active Brokers, Broker
 * Quotes, Broker Conversion, Won via Brokers, Avg Turnaround (down = good), Overdue Follow-ups — each
 * labeled with its lead-vs-quote distinction (FR-54) and drilling to its underlying rows on click
 * (AC-056). Reuses the shared `KpiCard` and the Executive dashboard's value/delta formatters so every
 * dashboard renders KPIs identically.
 */
function BrokerKpiRow({ kpis, currencyCode, onDrill }: BrokerKpiRowProps) {
  return (
    <div
      data-testid="broker-kpi-row"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 'var(--qiq-space-3)',
      }}
    >
      {kpis.map((kpi) => (
        <KpiCard
          key={kpi.key}
          label={kpiCardLabel(kpi.label, kpi.leadOrQuote)}
          value={formatKpiValue(kpi.kind, kpi.value, currencyCode)}
          delta={formatKpiDelta(kpi.kind, kpi.delta, currencyCode)}
          goodDirection={kpi.goodDirection}
          isFavorableDelta={kpi.isFavorableDelta}
          icon={KPI_ICONS[kpi.key]}
          onClick={() => onDrill(kpi.drillWidgetKey)}
        />
      ))}
    </div>
  );
}

export default BrokerKpiRow;
