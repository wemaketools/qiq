import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../../components/common/Icon';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import SkeletonTable from '../../components/common/SkeletonTable';
import type { NormalizedError } from '../../api/client';
import { downloadReportCsv, fetchReportView, type ReportSection, type ReportView } from './reportsApi';
import './print.css';

/**
 * Print-ready report view (spec FR-64/FR-65, AC-063, A-5, PRD 19, T-040): a header block carrying the
 * FR-65 metadata (tenant, report date, data period, currency, last refreshed) plus the report's KPI and
 * table sections, and a "Print / Save as PDF" action that calls `window.print()` — the browser is the
 * only PDF path (no server-side rendering). Built on the T-043 design-system layer + the report print
 * stylesheet (`print.css`).
 */
function ReportViewPage() {
  const { reportKey = '' } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState<ReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchReportView(reportKey)
      .then(setReport)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load this report.'))
      .finally(() => setLoading(false));
  }, [reportKey]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCsv = useCallback(() => {
    setDownloading(true);
    downloadReportCsv(reportKey).finally(() => setDownloading(false));
  }, [reportKey]);

  return (
    <div className="qiq-page" data-testid="page-report-detail">
      <div className="qiq-page-actions qiq-report-print-hidden" style={{ justifyContent: 'space-between' }}>
        <button
          type="button"
          className="qiq-btn qiq-btn--ghost qiq-btn--sm"
          data-testid="report-back"
          onClick={() => navigate('/reports')}
        >
          <Icon name="chevron-left" size={16} />
          All reports
        </button>
        <div className="qiq-page-actions">
          <button
            type="button"
            className="qiq-btn qiq-btn--ghost qiq-btn--sm"
            data-testid="report-csv"
            disabled={downloading || !report}
            onClick={handleCsv}
          >
            <Icon name="export" size={16} />
            CSV
          </button>
          <button
            type="button"
            className="qiq-btn qiq-btn--primary qiq-btn--sm"
            data-testid="report-print-button"
            disabled={!report}
            onClick={() => window.print()}
          >
            <Icon name="reports" size={16} />
            Print / Save as PDF
          </button>
        </div>
      </div>

      {loading && <SkeletonTable />}
      {!loading && error && <ErrorBanner message={error} onRetry={load} />}
      {!loading && !error && !report && <EmptyState message="This report has no content." />}

      {!loading && !error && report && (
        <div className="qiq-report-view" data-testid="report-view">
          <header className="qiq-report-header">
            <h1 className="qiq-card-title" style={{ fontSize: '20px', margin: 0 }} data-testid="report-title">
              {report.name}
            </h1>
            <div className="qiq-report-header-meta" data-testid="report-header-meta">
              <Meta label="Tenant" value={report.header.tenantName} testId="report-meta-tenant" />
              <Meta label="Report date" value={formatDate(report.header.reportDate)} testId="report-meta-date" />
              <Meta label="Data period" value={report.header.dataPeriod} testId="report-meta-period" />
              <Meta label="Currency" value={report.header.currency} testId="report-meta-currency" />
              <Meta label="Last refreshed" value={report.header.lastRefreshed} testId="report-meta-refreshed" />
            </div>
          </header>

          {report.sections.map((section) => (
            <ReportSectionBlock key={section.key} section={section} />
          ))}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <div className="qiq-report-meta-label">{label}</div>
      <div className="qiq-report-meta-value">{value}</div>
    </div>
  );
}

function ReportSectionBlock({ section }: { section: ReportSection }) {
  return (
    <section className="qiq-card qiq-report-section" data-testid={`report-section-${section.key}`}>
      <div className="qiq-card-head">
        <div className="qiq-card-title">{section.title}</div>
      </div>

      {section.kpis.length > 0 && (
        <div className="qiq-report-kpi-grid">
          {section.kpis.map((kpi) => (
            <div key={kpi.key} className="qiq-card" style={{ boxShadow: 'none' }}>
              <div className="qiq-kpi-label">{kpi.label}</div>
              <div className="qiq-kpi-value">{kpi.displayValue}</div>
            </div>
          ))}
        </div>
      )}

      {section.table && section.table.rows.length > 0 && (
        <div className="qiq-table-wrap" style={{ marginTop: section.kpis.length > 0 ? 'var(--qiq-space-4)' : 0 }}>
          <table>
            <thead>
              <tr>
                {section.table.columns.map((column) => (
                  <th key={column.header} style={{ textAlign: column.type === 'number' ? 'right' : 'left' }}>
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      style={{ textAlign: section.table!.columns[cellIndex]?.type === 'number' ? 'right' : 'left' }}
                    >
                      {formatCell(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section.table && section.table.rows.length === 0 && section.kpis.length === 0 && (
        <EmptyState message="No rows for the selected period." />
      )}
    </section>
  );
}

function formatCell(cell: string | number | null): string {
  if (cell === null || cell === undefined) {
    return '—';
  }
  return typeof cell === 'number' ? cell.toLocaleString() : String(cell);
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

export default ReportViewPage;
