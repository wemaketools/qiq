import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildReportCsvPath, downloadReportCsv, fetchReportCatalog, fetchReportView, toIconName } from '../reportsApi';
import { apiGet } from '../../../api/client';
import { downloadExport } from '../../exports/exportsApi';

vi.mock('../../../api/client', () => ({ apiGet: vi.fn() }));
vi.mock('../../exports/exportsApi', () => ({ downloadExport: vi.fn().mockResolvedValue(undefined) }));

describe('reportsApi', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    vi.mocked(downloadExport).mockClear();
  });

  it('fetchReportCatalog_ShouldGetReportsPath', async () => {
    vi.mocked(apiGet).mockResolvedValue({ reports: [] });
    await fetchReportCatalog();
    expect(apiGet).toHaveBeenCalledWith('/reports');
  });

  it('fetchReportView_ShouldGetEncodedKeyPath', async () => {
    vi.mocked(apiGet).mockResolvedValue({});
    await fetchReportView('sla-turnaround');
    expect(apiGet).toHaveBeenCalledWith('/reports/sla-turnaround');
  });

  it('buildReportCsvPath_ShouldRequestCsvFormat', () => {
    expect(buildReportCsvPath('pipeline-aging')).toBe('/reports/pipeline-aging/csv?format=csv');
  });

  it('downloadReportCsv_ShouldDownloadThroughSharedBlobPath', async () => {
    await downloadReportCsv('executive-weekly');
    expect(downloadExport).toHaveBeenCalledWith('/reports/executive-weekly/csv?format=csv', 'executive-weekly.csv');
  });

  it('toIconName_ShouldFallBackToReportsForUnknownIcon', () => {
    expect(toIconName('overview')).toBe('overview');
    expect(toIconName('made-up')).toBe('reports');
  });
});
