import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import ReportViewPage from '../ReportViewPage';
import { fetchReportView, type ReportView } from '../reportsApi';

vi.mock('../reportsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reportsApi')>();
  return {
    ...actual,
    fetchReportView: vi.fn(),
    downloadReportCsv: vi.fn().mockResolvedValue(undefined),
  };
});

const report: ReportView = {
  key: 'sla-turnaround',
  name: 'SLA / Turnaround',
  header: {
    tenantName: 'Brittany Insurance',
    reportDate: '2026-07-14T08:30:00Z',
    dataPeriod: 'All time',
    currency: 'BWP',
    lastRefreshed: '2026-07-14 08:30:00Z',
    filtersEcho: ['None'],
  },
  sections: [
    {
      key: 'sla-metrics',
      title: 'SLA / Turnaround Metrics',
      kpis: [{ key: 'received_to_assignment', label: 'Received → Assignment', leadOrQuote: null, kind: 'days', value: 2, displayValue: '2.0 days' }],
      table: null,
    },
    {
      key: 'underwriting-delay-queue',
      title: 'Underwriting Delay Queue',
      kpis: [],
      table: {
        title: 'Underwriting Delay Queue',
        columns: [
          { header: 'Lead ref', type: 'text' },
          { header: 'Days in underwriting', type: 'number' },
        ],
        rows: [['L-2026-0001', 5]],
      },
    },
  ],
};

function renderView() {
  const router = createMemoryRouter(
    [
      { path: '/reports/:reportKey', element: <ReportViewPage /> },
      { path: '/reports', element: <div data-testid="landed-reports" /> },
    ],
    { initialEntries: ['/reports/sla-turnaround'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('ReportViewPage', () => {
  beforeEach(() => {
    vi.mocked(fetchReportView).mockReset();
  });

  it('render_WhenReportLoads_ShouldShowHeaderMetadata', async () => {
    vi.mocked(fetchReportView).mockResolvedValue(report);
    renderView();

    await waitFor(() => expect(screen.getByTestId('report-header-meta')).toBeInTheDocument());
    expect(screen.getByTestId('report-meta-tenant')).toHaveTextContent('Brittany Insurance');
    expect(screen.getByTestId('report-meta-period')).toHaveTextContent('All time');
    expect(screen.getByTestId('report-meta-currency')).toHaveTextContent('BWP');
    expect(screen.getByTestId('report-meta-refreshed')).toBeInTheDocument();
  });

  it('render_ShouldRenderKpiAndTableSections', async () => {
    vi.mocked(fetchReportView).mockResolvedValue(report);
    renderView();

    await waitFor(() => expect(screen.getByTestId('report-section-sla-metrics')).toBeInTheDocument());
    expect(screen.getByText('2.0 days')).toBeInTheDocument();
    expect(screen.getByTestId('report-section-underwriting-delay-queue')).toBeInTheDocument();
    expect(screen.getByText('L-2026-0001')).toBeInTheDocument();
  });

  it('click_PrintButton_ShouldCallWindowPrint', async () => {
    vi.mocked(fetchReportView).mockResolvedValue(report);
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    renderView();

    await waitFor(() => expect(screen.getByTestId('report-print-button')).toBeEnabled());
    fireEvent.click(screen.getByTestId('report-print-button'));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
