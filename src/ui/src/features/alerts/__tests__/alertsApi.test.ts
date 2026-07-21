import { describe, expect, it, vi, beforeEach } from 'vitest';
import { apiGet, apiPost } from '../../../api/client';
import {
  actionForAlertType,
  ALERT_ACTION_LABELS,
  getAlertBadge,
  listAlerts,
  resetAlertBadge,
  tabForCategory,
  labelForAlertType,
  isAlertTab,
} from '../alertsApi';

vi.mock('../../../api/client', () => ({
  apiGet: vi.fn(() => Promise.resolve({})),
  apiPost: vi.fn(() => Promise.resolve(undefined)),
}));

describe('alertsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listAlerts_WhenTabIsAll_ShouldOmitTabParam', () => {
    // Arrange & Act
    void listAlerts({ tab: 'all', page: 1 });

    // Assert
    const path = vi.mocked(apiGet).mock.calls[0]![0];
    expect(path).not.toContain('tab=');
    expect(path).toContain('page=1');
  });

  it('listAlerts_WhenFiltersProvided_ShouldEncodeEachParam', () => {
    // Arrange & Act
    void listAlerts({ tab: 'sla', ownerUserId: 7, productLineId: 3, coverTypeId: 4, regionId: 5, priority: 'high', page: 2 });

    // Assert
    const path = vi.mocked(apiGet).mock.calls[0]![0];
    expect(path).toContain('tab=sla');
    expect(path).toContain('ownerUserId=7');
    expect(path).toContain('productLineId=3');
    expect(path).toContain('coverTypeId=4');
    expect(path).toContain('regionId=5');
    expect(path).toContain('priority=high');
    expect(path).toContain('page=2');
  });

  it('getAlertBadge_ShouldCallBadgeEndpoint', () => {
    // Act
    void getAlertBadge();

    // Assert
    expect(apiGet).toHaveBeenCalledWith('/alerts/badge');
  });

  it('resetAlertBadge_ShouldPostToResetEndpoint', () => {
    // Act
    void resetAlertBadge();

    // Assert
    expect(apiPost).toHaveBeenCalledWith('/alerts/badge/reset');
  });

  it('tabForCategory_ShouldMapKeysToTabsAndNullForStalled', () => {
    expect(tabForCategory('escalated')).toBe('escalated');
    expect(tabForCategory('overdue')).toBe('overdue');
    expect(tabForCategory('expiring')).toBe('expiring');
    expect(tabForCategory('sla')).toBe('sla');
    expect(tabForCategory('stalled')).toBeNull();
    expect(tabForCategory('unknown')).toBeNull();
    expect(tabForCategory(null)).toBeNull();
  });

  it('actionForAlertType_ShouldResolveTheContextualAction', () => {
    expect(actionForAlertType('unassigned_lead')).toBe('assign');
    expect(actionForAlertType('overdue_follow_up')).toBe('follow-up');
    expect(actionForAlertType('executive_escalation')).toBe('executive-review');
    expect(actionForAlertType('high_value_stalled')).toBe('executive-review');
    expect(actionForAlertType('sla_breach')).toBeNull();
    expect(ALERT_ACTION_LABELS.assign).toBe('Assign & acknowledge');
  });

  it('labelForAlertType_ShouldFallBackToCodeForUnknownType', () => {
    expect(labelForAlertType('overdue_follow_up')).toBe('Follow-Up Due');
    expect(labelForAlertType('brand_new_type')).toBe('brand_new_type');
  });

  it('isAlertTab_ShouldNarrowToKnownTabs', () => {
    expect(isAlertTab('escalated')).toBe(true);
    expect(isAlertTab('nope')).toBe(false);
    expect(isAlertTab(null)).toBe(false);
  });
});
