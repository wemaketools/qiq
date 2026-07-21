import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../components/common/Icon';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import SkeletonTable from '../../components/common/SkeletonTable';
import type { NormalizedError } from '../../api/client';
import { downloadReportCsv, fetchReportCatalog, toIconName, type ReportDescriptor } from './reportsApi';

/**
 * Reports screen (spec FR-64, AC-063, PRD 19, T-040): an intro line plus a grid of the caller's permitted
 * report cards, each offering "Open report" (a print-ready view) and "CSV". There is deliberately NO
 * scheduling/cadence UI — reporting is on-demand only (FR-64). Built entirely on the T-043 design-system
 * layer (`.qiq-*` classes + `Icon`).
 */
function ReportsPage() {
  const navigate = useNavigate();
  const [reports, setReports] = useState<ReportDescriptor[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchReportCatalog()
      .then((catalog) => setReports(catalog.reports))
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load reports.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCsv = useCallback((key: string) => {
    setDownloadingKey(key);
    downloadReportCsv(key).finally(() => setDownloadingKey(null));
  }, []);

  return (
    <div className="qiq-page" data-testid="page-reports">
      <p className="qiq-card-sub" data-testid="reports-intro">
        Generate exports for sales meetings and leadership reporting. CSV exports and print-ready views are
        produced from the live data.
      </p>

      {loading && <SkeletonTable />}
      {!loading && error && <ErrorBanner message={error} onRetry={load} />}
      {!loading && !error && reports && reports.length === 0 && (
        <EmptyState message="You do not have access to any reports." />
      )}

      {!loading && !error && reports && reports.length > 0 && (
        <div
          className="qiq-grid"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}
        >
          {reports.map((report) => (
            <div key={report.key} className="qiq-card" data-testid="report-card">
              <div className="qiq-card-head">
                <div style={{ display: 'flex', gap: 'var(--qiq-space-3)', alignItems: 'flex-start' }}>
                  <span className="qiq-chip qiq-chip--accent" aria-hidden="true" style={{ padding: 'var(--qiq-space-2)' }}>
                    <Icon name={toIconName(report.icon)} />
                  </span>
                  <div>
                    <div className="qiq-card-title" data-testid="report-card-name">
                      {report.name}
                    </div>
                    <div className="qiq-card-sub">{report.description}</div>
                  </div>
                </div>
              </div>
              <div className="qiq-page-actions" style={{ justifyContent: 'flex-start' }}>
                <button
                  type="button"
                  className="qiq-btn qiq-btn--primary qiq-btn--sm"
                  data-testid={`report-open-${report.key}`}
                  onClick={() => navigate(`/reports/${report.key}`)}
                >
                  <Icon name="reports" size={16} />
                  Open report
                </button>
                <button
                  type="button"
                  className="qiq-btn qiq-btn--ghost qiq-btn--sm"
                  data-testid={`report-csv-${report.key}`}
                  disabled={downloadingKey === report.key}
                  onClick={() => handleCsv(report.key)}
                >
                  <Icon name="export" size={16} />
                  CSV
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ReportsPage;
