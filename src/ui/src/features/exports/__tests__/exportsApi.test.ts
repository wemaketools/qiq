import { describe, expect, it } from 'vitest';
import {
  buildDashboardExportPath,
  buildLeadsExportPath,
  buildPartiesExportPath,
  dashboardFiltersToExportFilter,
} from '../exportsApi';

describe('exportsApi path builders', () => {
  it('buildLeadsExportPath_ShouldReflectActiveFiltersAndFormat', () => {
    const path = buildLeadsExportPath(
      { statusIds: [3, 4], productLineId: 7, myLeads: true, search: 'acme', sort: '-lead_ref' },
      'csv',
    );

    expect(path).toContain('/exports/leads?');
    expect(path).toContain('status=3%2C4');
    expect(path).toContain('productLineId=7');
    expect(path).toContain('myLeads=true');
    expect(path).toContain('search=acme');
    expect(path).toContain('sort=-lead_ref');
    expect(path).toContain('format=csv');
  });

  it('buildLeadsExportPath_WhenNoFilters_ShouldStillCarryFormat', () => {
    const path = buildLeadsExportPath({}, 'xlsx');

    expect(path).toBe('/exports/leads?format=xlsx');
  });

  it('buildPartiesExportPath_ShouldReflectFiltersAndStrategicFlag', () => {
    const path = buildPartiesExportPath(
      { partyTypeId: 2, segmentId: null, industryId: null, regionId: 5, strategicOnly: true, search: 'mining' },
      'xlsx',
    );

    expect(path).toContain('partyTypeId=2');
    expect(path).toContain('regionId=5');
    expect(path).toContain('strategic=true');
    expect(path).toContain('search=mining');
    expect(path).toContain('format=xlsx');
    expect(path).not.toContain('segmentId');
  });

  it('buildDashboardExportPath_ShouldCarryWidgetFilterAndFormat', () => {
    const path = buildDashboardExportPath(
      'exec.high_value',
      { from: '2026-01-01', to: '2026-06-30', productLineId: 9 },
      'csv',
    );

    expect(path).toContain('widget=exec.high_value');
    expect(path).toContain('from=2026-01-01');
    expect(path).toContain('to=2026-06-30');
    expect(path).toContain('productLineId=9');
    expect(path).toContain('format=csv');
  });

  it('dashboardFiltersToExportFilter_ShouldMapAllFields', () => {
    const filter = dashboardFiltersToExportFilter({
      dateFrom: '2026-01-01',
      dateTo: '2026-02-01',
      productLineId: 1,
      brokerId: 2,
      rmUserId: 3,
      regionId: 4,
      teamOrRmId: 5,
      brokerTypeId: 6,
    });

    expect(filter).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
      productLineId: 1,
      brokerId: 2,
      rmUserId: 3,
      regionId: 4,
      teamOrRmId: 5,
      brokerTypeId: 6,
    });
  });
});
