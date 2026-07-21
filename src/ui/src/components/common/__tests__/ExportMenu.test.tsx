import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExportMenu from '../ExportMenu';
import { downloadExport } from '../../../features/exports/exportsApi';

vi.mock('../../../features/exports/exportsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../features/exports/exportsApi')>();
  return { ...actual, downloadExport: vi.fn().mockResolvedValue(undefined) };
});

describe('ExportMenu', () => {
  beforeEach(() => {
    vi.mocked(downloadExport).mockClear();
  });

  it('render_ShouldShowExportTrigger', () => {
    render(<ExportMenu buildPath={(f) => `/exports/leads?format=${f}`} fileNameBase="leads" />);

    expect(screen.getByTestId('export-menu-trigger')).toHaveTextContent('Export');
  });

  it('click_WhenTriggerClicked_ShouldRevealCsvAndExcelOptions', () => {
    render(<ExportMenu buildPath={(f) => `/exports/leads?format=${f}`} fileNameBase="leads" />);

    fireEvent.click(screen.getByTestId('export-menu-trigger'));

    expect(screen.getByTestId('export-menu-csv')).toBeInTheDocument();
    expect(screen.getByTestId('export-menu-xlsx')).toBeInTheDocument();
  });

  it('click_WhenCsvSelected_ShouldDownloadCsvPath', async () => {
    render(<ExportMenu buildPath={(f) => `/exports/leads?status=1&format=${f}`} fileNameBase="leads" />);
    fireEvent.click(screen.getByTestId('export-menu-trigger'));

    fireEvent.click(screen.getByTestId('export-menu-csv'));

    await waitFor(() => expect(downloadExport).toHaveBeenCalledTimes(1));
    expect(downloadExport).toHaveBeenCalledWith('/exports/leads?status=1&format=csv', 'leads.csv');
  });

  it('click_WhenExcelSelected_ShouldDownloadXlsxPath', async () => {
    render(<ExportMenu buildPath={(f) => `/exports/leads?format=${f}`} fileNameBase="leads" />);
    fireEvent.click(screen.getByTestId('export-menu-trigger'));

    fireEvent.click(screen.getByTestId('export-menu-xlsx'));

    await waitFor(() => expect(downloadExport).toHaveBeenCalledTimes(1));
    expect(downloadExport).toHaveBeenCalledWith('/exports/leads?format=xlsx', 'leads.xlsx');
  });

  it('render_WhenDisabled_ShouldDisableTrigger', () => {
    render(<ExportMenu buildPath={(f) => `/exports/leads?format=${f}`} fileNameBase="leads" disabled />);

    expect(screen.getByTestId('export-menu-trigger')).toBeDisabled();
  });
});
