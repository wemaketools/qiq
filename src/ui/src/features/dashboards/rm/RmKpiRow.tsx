import KpiCard from '../../../components/dashboards/KpiCard';
import { kpiCardLabel } from '../../../components/dashboards/formatters';
import type { RmKpiDto } from '../rmApi';
import { formatKpiDelta, formatKpiValue } from '../overview/kpiFormat';

interface RmKpiRowProps {
  kpis: RmKpiDto[];
  currencyCode: string;
  onDrill: (widgetKey: string) => void;
}

/** Per-KPI icon glyph (UI standards 3.3's tinted halo); the text label always carries the meaning. */
const KPI_ICONS: Record<string, string> = {
  active_rms: '⚑',
  active_brokers: '≣',
  won_premium_ytd: '$',
  rm_conversion_rate: '%',
  broker_conversion_rate: '%',
  follow_up_compliance: '☑',
};

/**
 * The RM Performance KPI row (spec FR-58, PRD 15.2, T-035): six cards — Active RMs, Active Brokers, Won
 * Premium YTD, RM Conversion Rate, Broker Conversion Rate, Follow-up Compliance — each labeled with its
 * lead-vs-quote distinction (FR-54) and drilling to its underlying rows on click (AC-057). Reuses the
 * shared `KpiCard` and the Executive dashboard's value/delta formatters so every dashboard renders KPIs
 * identically.
 */
function RmKpiRow({ kpis, currencyCode, onDrill }: RmKpiRowProps) {
  return (
    <div
      data-testid="rm-kpi-row"
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

export default RmKpiRow;
