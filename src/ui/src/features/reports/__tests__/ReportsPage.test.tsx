import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import ReportsPage from '../ReportsPage';
import { fetchReportCatalog, downloadReportCsv, type ReportCatalog } from '../reportsApi';

vi.mock('../reportsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reportsApi')>();
  return {
    ...actual,
    fetchReportCatalog: vi.fn(),
    downloadReportCsv: vi.fn().mockResolvedValue(undefined),
  };
});

const catalog: ReportCatalog = {
  reports: [
    { key: 'executive-weekly', name: 'Executive Weekly Report', description: 'KPIs and wins.', icon: 'overview', audience: 'ExCo' },
    { key: 'pipeline-conversion', name: 'Pipeline & Conversion', description: 'Stage conversion.', icon: 'pipeline', audience: 'Sales ops' },
  ],
};

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/reports', element: <ReportsPage /> },
      { path: '/reports/:reportKey', element: <div data-testid="landed-report-view" /> },
    ],
    { initialEntries: ['/reports'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.mocked(fetchReportCatalog).mockReset();
    vi.mocked(downloadReportCsv).mockClear();
  });

  it('render_WhenCatalogLoads_ShouldShowPermittedReportCards', async () => {
    vi.mocked(fetchReportCatalog).mockResolvedValue(catalog);
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('report-card')).toHaveLength(2));
    expect(screen.getByText('Executive Weekly Report')).toBeInTheDocument();
    expect(screen.getByText('Pipeline & Conversion')).toBeInTheDocument();
  });

  it('render_ShouldNotShowAnySchedulingUi', async () => {
    vi.mocked(fetchReportCatalog).mockResolvedValue(catalog);
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('report-card')).toHaveLength(2));
    expect(screen.queryByText(/schedul/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cadence/i)).not.toBeInTheDocument();
  });

  it('click_WhenOpenReport_ShouldNavigateToReportView', async () => {
    vi.mocked(fetchReportCatalog).mockResolvedValue(catalog);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('report-open-executive-weekly')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('report-open-executive-weekly'));

    expect(screen.getByTestId('landed-report-view')).toBeInTheDocument();
  });

  it('click_WhenCsv_ShouldDownloadThatReportsCsv', async () => {
    vi.mocked(fetchReportCatalog).mockResolvedValue(catalog);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('report-csv-pipeline-conversion')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('report-csv-pipeline-conversion'));

    await waitFor(() => expect(downloadReportCsv).toHaveBeenCalledWith('pipeline-conversion'));
  });

  it('render_WhenNoReportsPermitted_ShouldShowEmptyState', async () => {
    vi.mocked(fetchReportCatalog).mockResolvedValue({ reports: [] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('You do not have access to any reports.')).toBeInTheDocument(),
    );
  });
});
