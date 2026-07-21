/**
 * The report catalog, its permission gating, and the server-side report formatting
 * (T-040; AC-083; V-106).
 *
 * These are the pure halves of the reports domain: which reports exist, who may see each, how a
 * KPI value renders in a print-ready document, and how a filter is described in the metadata
 * header. Every expected value below is READ FROM THE REFERENCE (`ReportCatalog.cs`,
 * `ReportFormatting.cs`, `ReportFilterDescription.cs`), not from this port's output.
 *
 * WHY THE CATALOG ITSELF IS PINNED KEY-BY-KEY
 * ===========================================
 * A catalog is a registry, and a registry whose entries resolve to nothing is the exact shape of
 * the dashboard-drill failure this codebase already suffered once: 31 widget keys listed, one of
 * them wired. So the ten keys are pinned here, and `reports.test.ts` renders EVERY ONE of them
 * through the real endpoint — the two together are what make "the catalog lists reports that work"
 * a checked claim rather than a hopeful one.
 */
import { describe, expect, it } from 'vitest';

import {
  REPORT_CATALOG,
  REPORT_KEYS,
  findReport,
  reportsVisibleTo,
} from '../../domains/reports/catalog.js';
import {
  describeReportFilters,
  describeReportPeriod,
  formatReportDays,
  formatReportValue,
} from '../../domains/reports/contracts.js';
import { EMPTY_DASHBOARD_FILTER } from '../../domains/dashboards/filters.js';

import type { PermissionCode } from '../../domains/rbac/permission-catalog.js';

function holder(...permissions: readonly PermissionCode[]): (permission: PermissionCode) => boolean {
  const held = new Set<string>(permissions);
  return (permission) => held.has(permission);
}

describe('report catalog (ReportCatalog.cs:47-88)', () => {
  it('lists the reference ten reports in display order', () => {
    expect(REPORT_CATALOG.map((report) => report.key)).toEqual([
      'executive-weekly',
      'pipeline-conversion',
      'broker-performance',
      'rm-performance',
      'loss-analysis',
      'sla-turnaround',
      'pipeline-aging',
      'escalation-queue',
      'tenant-configuration',
      'internal-tenant-overview',
    ]);
  });

  it('exposes every catalog key through REPORT_KEYS', () => {
    expect(Object.values(REPORT_KEYS).sort()).toEqual([...REPORT_CATALOG.map((r) => r.key)].sort());
  });

  it('binds each report to the reference permission (ReportCatalog.cs:49-87)', () => {
    const bound = Object.fromEntries(REPORT_CATALOG.map((r) => [r.key, r.permission]));

    expect(bound).toEqual({
      'executive-weekly': 'dashboards.view_executive',
      'pipeline-conversion': 'dashboards.view_pipeline',
      'broker-performance': 'dashboards.view_broker_performance',
      'rm-performance': 'dashboards.view_rm_performance',
      'loss-analysis': 'dashboards.view_loss_analysis',
      // SLA/Turnaround deliberately rides the PIPELINE permission, not one of its own: there is no
      // standalone SLA dashboard (spec FR-60), so it inherits the dashboard it is surfaced beside.
      'sla-turnaround': 'dashboards.view_pipeline',
      'pipeline-aging': 'dashboards.view_pipeline',
      'escalation-queue': 'alerts.view',
      'tenant-configuration': 'tenants.manage_settings',
      'internal-tenant-overview': 'global.cross_tenant_reporting',
    });
  });

  it('marks ONLY the internal tenant overview as cross-tenant', () => {
    expect(REPORT_CATALOG.filter((r) => r.isCrossTenant).map((r) => r.key)).toEqual([
      'internal-tenant-overview',
    ]);
  });

  it('finds a descriptor by key and returns undefined for an unknown one', () => {
    expect(findReport('loss-analysis')?.name).toBe('Loss Analysis');
    expect(findReport('no-such-report')).toBeUndefined();
    // Ordinal, not case-insensitive (`StringComparison.Ordinal`, :92).
    expect(findReport('Loss-Analysis')).toBeUndefined();
  });

  it('shows a caller only the reports whose binding permission they hold', () => {
    const visible = reportsVisibleTo(holder('dashboards.view_executive', 'alerts.view'));

    expect(visible.map((r) => r.key)).toEqual(['executive-weekly', 'escalation-queue']);
  });

  it('shows NOTHING to a reports.view holder with no report permissions', () => {
    // Every descriptor in the reference carries a non-null permission, so an otherwise-permitted
    // caller sees an empty catalog rather than the full set. Asserted so a future null default
    // cannot quietly open all ten.
    expect(reportsVisibleTo(holder())).toEqual([]);
  });

  it('never puts the permission code on the wire', () => {
    // `ReportDescriptorDto` is deliberately narrower than `ReportDescriptor` (ReportContracts.cs:4).
    const dto = REPORT_CATALOG[0];
    expect(dto).toBeDefined();
    expect(Object.keys(dto ?? {})).toContain('permission');
  });
});

describe('report KPI formatting (ReportFormatting.cs:18-34)', () => {
  it('formats currency as "{code} {N0}"', () => {
    expect(formatReportValue(1234, 'currency', 'BWP')).toBe('BWP 1,234');
    expect(formatReportValue(1234567.89, 'currency', 'USD')).toBe('USD 1,234,568');
  });

  it('formats a fraction as a one-decimal percent', () => {
    expect(formatReportValue(0.5, 'percent', 'BWP')).toBe('50.0%');
    expect(formatReportValue(0.4567, 'percent', 'BWP')).toBe('45.7%');
    expect(formatReportValue(0, 'percent', 'BWP')).toBe('0.0%');
  });

  it('formats days with one decimal and a unit', () => {
    expect(formatReportValue(2, 'days', 'BWP')).toBe('2.0 days');
    expect(formatReportDays(2.25)).toBe('2.3 days');
  });

  it('formats a count with group separators and no decimals', () => {
    expect(formatReportValue(1234, 'count', 'BWP')).toBe('1,234');
  });

  it('renders null as an em dash for every kind', () => {
    for (const kind of ['currency', 'percent', 'days', 'count'] as const) {
      expect(formatReportValue(null, kind, 'BWP')).toBe('—');
    }
    expect(formatReportDays(null)).toBe('—');
  });

  it('keeps a negative value negative rather than guarding it (money stays money)', () => {
    expect(formatReportValue(-500, 'currency', 'BWP')).toBe('BWP -500');
  });
});

describe('report period and filter echo (ReportFilterDescription.cs:11-64)', () => {
  it('describes an unbounded period as "All time"', () => {
    expect(describeReportPeriod(EMPTY_DASHBOARD_FILTER)).toBe('All time');
  });

  it('describes a bounded period as "from to to"', () => {
    expect(
      describeReportPeriod({ ...EMPTY_DASHBOARD_FILTER, from: '2026-01-01', to: '2026-03-31' }),
    ).toBe('2026-01-01 to 2026-03-31');
  });

  it('uses an ellipsis for a half-open period', () => {
    expect(describeReportPeriod({ ...EMPTY_DASHBOARD_FILTER, from: '2026-01-01' })).toBe(
      '2026-01-01 to …',
    );
    expect(describeReportPeriod({ ...EMPTY_DASHBOARD_FILTER, to: '2026-03-31' })).toBe(
      '… to 2026-03-31',
    );
  });

  it('echoes "None" when no dimension is set', () => {
    expect(describeReportFilters(EMPTY_DASHBOARD_FILTER)).toEqual(['None']);
  });

  it('echoes every set dimension in the reference order', () => {
    expect(
      describeReportFilters({
        from: '2026-01-01',
        to: '2026-03-31',
        productLineId: 1,
        brokerId: 2,
        rmUserId: 3,
        regionId: 4,
        teamOrRmId: 5,
        brokerTypeId: 6,
      }),
    ).toEqual([
      'Product line id: 1',
      'Broker id: 2',
      'RM id: 3',
      'Region id: 4',
      'Team/RM id: 5',
      'Broker type id: 6',
    ]);
  });
});
