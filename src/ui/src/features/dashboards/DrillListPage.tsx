import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectDashboardFilters } from '../../app/slices/dashboardFiltersSlice';
import { useTenantCurrency } from '../../components/shell/useTenantCurrency';
import type { NormalizedError } from '../../api/client';
import { DEFAULT_AGING_AMBER_DAYS, DEFAULT_AGING_RED_DAYS } from '../leads/agingThresholds';
import type { LeadListItemDto } from '../leads/leadsApi';
import LeadsTable from '../leads/LeadsTable';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { fetchDrill } from './dashboardsApi';

const PAGE_SIZE = 25;

/** Human titles per drill widget key (one entry per key the backend `DrillWidgetRegistry` registers). */
const DRILL_TITLES: Record<string, string> = {
  'leads.filtered': 'Leads',
  'exec.leads': 'All leads',
  'exec.quotes': 'Quoted leads',
  'exec.open_pipeline': 'Open pipeline',
  'exec.won': 'Won leads',
  'exec.lost': 'Lost leads',
  'exec.high_value': 'High-value opportunities',
  'exec.at_risk': 'At-risk leads',
  'pipeline.leads': 'Pipeline leads',
  'pipeline.new_leads': 'New leads this month',
  'pipeline.open_pipeline': 'Open pipeline',
  'pipeline.quoted': 'Quoted leads',
  'pipeline.won': 'Won leads',
  'pipeline.lost': 'Lost leads',
  'pipeline.at_risk': 'At-risk pipeline',
  'pipeline.overdue_quotes': 'Overdue quotes',
  'broker.leads': 'Broker-introduced leads',
  'broker.quotes': 'Broker quoted leads',
  'broker.won': 'Won via brokers',
  'broker.lost': 'Lost via brokers',
  'broker.overdue': 'Broker overdue follow-ups',
  'rm.leads': 'RM leads',
  'rm.quotes': 'RM quoted leads',
  'rm.won': 'RM won leads',
  'rm.lost': 'RM lost leads',
  'rm.overdue': 'RM overdue follow-ups',
  'loss.count_by_reason': 'Lost leads by reason',
  'loss.trend_by_reason': 'Lost leads (trend)',
  'loss.by_cover_type': 'Losses by cover type',
  'loss.by_broker': 'Losses by broker',
  'loss.by_rm': 'Losses by RM',
  'loss.price_gap': 'Losses with a price gap',
};

/** Fallback for a key not in the map: "pipeline.new_leads" -> "New leads". */
function humanizeWidgetKey(widgetKey: string): string {
  const tail = widgetKey.split('.').pop() ?? widgetKey;
  const words = tail.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Generic dashboard drill-through screen (spec FR-54/AC-053, T-031): route
 * `/dashboards/drill/:widgetKey`, reached via `useDrill().navigateToDrill`. Renders the widget's
 * underlying rows through the exact same shared `LeadsTable` the Leads list itself uses (whose rows
 * navigate to Lead Detail — quote-scoped widgets also resolve to the owning leads, and the lead page
 * shows its quotes), filtered by the currently active `dashboardFiltersSlice` state (persisted across
 * dashboard routes, A-16) — this page does not carry its own separate filter state.
 */
function DrillListPage() {
  const { widgetKey } = useParams<{ widgetKey: string }>();
  const filters = useAppSelector(selectDashboardFilters);
  const currencyCode = useTenantCurrency();

  const [items, setItems] = useState<LeadListItemDto[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!widgetKey) {
      return;
    }
    setLoading(true);
    setError(null);
    fetchDrill(widgetKey, filters, page, PAGE_SIZE)
      .then((result) => {
        setItems(result.items);
        setTotalCount(result.totalCount);
      })
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load drill results.'))
      .finally(() => setLoading(false));
  }, [widgetKey, filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [widgetKey]);

  const title = (widgetKey && DRILL_TITLES[widgetKey]) ?? humanizeWidgetKey(widgetKey ?? '');
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, totalCount);

  return (
    <div data-testid="drill-list" className="qiq-page">
      <div>
        <h2 style={{ fontSize: '20px' }} data-testid="drill-title">
          {title}
        </h2>
        <p className="qiq-card-sub" style={{ margin: '2px 0 0' }}>
          Drill-through from the dashboard — the active dashboard filters apply. Click a row to open the lead.
        </p>
      </div>

      {loading && <SkeletonTable />}
      {!loading && error && <ErrorBanner message={error} onRetry={load} />}
      {!loading && !error && totalCount === 0 && <EmptyState message="No records match the current filters." />}
      {!loading && !error && totalCount > 0 && (
        <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
          <LeadsTable leads={items} currencyCode={currencyCode} agingAmberDays={DEFAULT_AGING_AMBER_DAYS} agingRedDays={DEFAULT_AGING_RED_DAYS} />
          <div
            data-testid="drill-pagination"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 'var(--qiq-space-3) var(--qiq-space-4)',
              borderTop: '1px solid var(--qiq-border-subtle)',
              fontSize: '12px',
              color: 'var(--qiq-text-secondary)',
            }}
          >
            <span data-testid="drill-page-summary">
              {pageStart}-{pageEnd} of {totalCount}
            </span>
            <div style={{ display: 'flex', gap: 'var(--qiq-space-2)' }}>
              <button type="button" className="qiq-btn qiq-btn--sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                Previous
              </button>
              <button type="button" className="qiq-btn qiq-btn--sm" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DrillListPage;
