import KpiCard from '../../../components/dashboards/KpiCard';
import { kpiCardLabel } from '../../../components/dashboards/formatters';
import { formatKpiDelta, formatKpiValue } from '../overview/kpiFormat';
import type { KpiKind } from '../executiveApi';
import type { LossKpiDto } from '../lossApi';

interface LossKpiRowProps {
  kpis: LossKpiDto[];
  currencyCode: string;
  onDrill: (widgetKey: string) => void;
}

/** Per-KPI icon glyph (UI standards 3.3's tinted halo); the text label always carries the meaning. */
const KPI_ICONS: Record<string, string> = {
  lost_premium: '↓',
  quotes_lost: '✕',
  top_loss_reason: '⚠',
  avg_price_gap: '%',
  top_competitor: '≣',
};

const EM_DASH = '—';

/**
 * The Loss Analysis KPI row (spec FR-59, AC-058, PRD 16, T-036): exactly FIVE cards — Lost Premium
 * (currency, lower-is-better so a falling delta renders green), Quotes Lost (count, lower-is-better),
 * Top Loss Reason (text), Avg Price Gap (percent, lower-is-better), and Top Competitor (text). There is
 * deliberately NO Win-back Potential card (spec §2 / PRD 16.0 exclusion). Each card labels its
 * lead-vs-quote distinction (FR-54) and drills to its underlying rows on click (AC-058). Reuses the
 * shared `KpiCard` and the Executive dashboard's value/delta formatters.
 */
function LossKpiRow({ kpis, currencyCode, onDrill }: LossKpiRowProps) {
  return (
    <div
      data-testid="loss-kpi-row"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 'var(--qiq-space-3)',
      }}
    >
      {kpis.map((kpi) => {
        const value =
          kpi.kind === 'text'
            ? kpi.textValue ?? EM_DASH
            : formatKpiValue(kpi.kind as KpiKind, kpi.value, currencyCode);
        const delta = kpi.kind === 'text' ? null : formatKpiDelta(kpi.kind as KpiKind, kpi.delta, currencyCode);

        return (
          <KpiCard
            key={kpi.key}
            label={kpiCardLabel(kpi.label, kpi.leadOrQuote)}
            value={value}
            delta={delta}
            goodDirection={kpi.goodDirection}
            isFavorableDelta={kpi.isFavorableDelta}
            icon={KPI_ICONS[kpi.key]}
            onClick={() => onDrill(kpi.drillWidgetKey)}
          />
        );
      })}
    </div>
  );
}

export default LossKpiRow;
