import KpiCard from '../../../components/dashboards/KpiCard';
import { kpiCardLabel } from '../../../components/dashboards/formatters';
import type { PipelineKpiDto } from '../pipelineApi';
import { formatKpiDelta, formatKpiValue } from '../overview/kpiFormat';

interface PipelineKpiRowProps {
  kpis: PipelineKpiDto[];
  currencyCode: string;
  onDrill: (widgetKey: string) => void;
}

/** Per-KPI icon glyph (UI standards 3.3's tinted halo); the text label always carries the meaning. */
const KPI_ICONS: Record<string, string> = {
  new_leads_this_month: '≣',
  open_pipeline_value: '$',
  quote_to_proposal_rate: '%',
  proposal_to_win_rate: '★',
  average_quote_age: '⏱',
  sla_breaches: '!',
  quotes_issued_this_month: '≣',
  lead_to_quote_rate: '%',
  average_lead_age: '⏱',
};

/**
 * The Pipeline & Conversion KPI row (spec FR-56, T-033): nine cards, each labeled with its
 * lead-vs-quote distinction (FR-54), rendering a prior-period delta colored by the server-declared
 * good direction and drilling to its underlying rows on click (AC-055). Reuses the shared `KpiCard`
 * and the Executive dashboard's value/delta formatters so both dashboards render identically.
 */
function PipelineKpiRow({ kpis, currencyCode, onDrill }: PipelineKpiRowProps) {
  return (
    <div
      data-testid="pipeline-kpi-row"
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

export default PipelineKpiRow;
