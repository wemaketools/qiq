import { describe, expect, it, vi } from 'vitest';
import { fetchDrill } from '../dashboardsApi';

vi.mock('../../../api/client', () => ({
  apiGet: vi.fn().mockResolvedValue({ widgetKey: 'leads.filtered', items: [], totalCount: 0, page: 1, pageSize: 25 }),
}));

describe('dashboardsApi', () => {
  it('fetchDrill_WithFilters_ShouldBuildQueryStringOmittingNulls', async () => {
    // Arrange
    const { apiGet } = await import('../../../api/client');

    // Act
    await fetchDrill('leads.filtered', {
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      productLineId: 1,
      brokerId: null,
      rmUserId: null,
      regionId: null,
      teamOrRmId: null,
      brokerTypeId: null,
    });

    // Assert
    expect(apiGet).toHaveBeenCalledWith(
      '/dashboards/drill?widget=leads.filtered&from=2026-07-01&to=2026-07-31&productLineId=1',
    );
  });

  it('fetchDrill_WithNoFilters_ShouldBuildQueryStringWithOnlyWidget', async () => {
    // Arrange
    const { apiGet } = await import('../../../api/client');
    vi.mocked(apiGet).mockClear();

    // Act
    await fetchDrill('leads.filtered', {
      dateFrom: null,
      dateTo: null,
      productLineId: null,
      brokerId: null,
      rmUserId: null,
      regionId: null,
      teamOrRmId: null,
      brokerTypeId: null,
    });

    // Assert
    expect(apiGet).toHaveBeenCalledWith('/dashboards/drill?widget=leads.filtered');
  });
});
