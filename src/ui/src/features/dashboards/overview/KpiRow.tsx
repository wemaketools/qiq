import KpiCard from '../../../components/dashboards/KpiCard';
import { kpiCardLabel } from '../../../components/dashboards/formatters';
import type { ExecutiveKpiDto } from '../executiveApi';
import { formatKpiDelta, formatKpiValue } from './kpiFormat';

interface KpiRowProps {
  kpis: ExecutiveKpiDto[];
  currencyCode: string;
  onDrill: (widgetKey: string) => void;
}

/** Per-KPI icon glyph (UI standards 3.3's tinted halo); text label always carries the meaning, the glyph is decorative. */
const KPI_ICONS: Record<string, string> = {
  total_quotes: '≣',
  open_pipeline_premium: '$',
  won_premium: '★',
  conversion_rate: '%',
  average_turnaround: '⏱',
  quotes_at_risk: '!',
  total_leads: '≣',
  lead_to_quote_rate: '%',
  leads_at_risk: '!',
};

/**
 * The Overview KPI row (spec FR-55, T-032): nine cards wrapping across the row, each labeled with its
 * lead-vs-quote distinction (FR-54), rendering a prior-period delta colored by the server-declared good
 * direction, and drilling through to its underlying rows on click (AC-054).
 */
function KpiRow({ kpis, currencyCode, onDrill }: KpiRowProps) {
  return (
    <div
      data-testid="kpi-row"
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

export default KpiRow;
