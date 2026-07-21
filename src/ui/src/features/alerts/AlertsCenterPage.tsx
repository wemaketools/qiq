import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppDispatch } from '../../app/hooks';
import { openAlertsCenterBadgeReset, refreshAlertsBadge } from '../../app/slices/alertsBadgeSlice';
import { useTenantCurrency } from '../../components/shell/useTenantCurrency';
import { formatCompactCurrency } from '../../components/dashboards/formatters';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { useToast } from '../../components/common/Toast';
import type { NormalizedError } from '../../api/client';
import { DEFAULT_AGING_AMBER_DAYS, DEFAULT_AGING_RED_DAYS } from '../leads/agingThresholds';
import {
  fetchBusinessAssignments,
  fetchFullBusinessRules,
  listReferenceItems,
  type BusinessAssignmentsDto,
  type ReferenceItemDto,
} from '../settings/settingsApi';
import {
  assignLead,
  getEligibleLeadOwners,
  getLead,
  logFollowUp,
  type EligibleLeadOwnerDto,
  type LeadAssignmentPayload,
  type LeadDetailDto,
} from '../leads/leadsApi';
import { PRIORITY_HIGH, PRIORITY_NORMAL } from '../leads/form/leadFormConstants';
import { deriveLeadReportingCategory } from '../leads/leadStatusCategory';
import AssignDialog from '../leads/dialogs/AssignDialog';
import LogFollowUpDialog from '../leads/dialogs/LogFollowUpDialog';
import CategoryCards from './CategoryCards';
import AlertsQueueTable from './AlertsQueueTable';
import ExecutiveReviewDialog from './ExecutiveReviewDialog';
import {
  ALERTS_PAGE_SIZE,
  ALERT_TABS,
  ALERT_TAB_LABELS,
  actionForAlertType,
  getAlertSummary,
  isAlertTab,
  listAlerts,
  tabForCategory,
  type AlertActionKind,
  type AlertListDto,
  type AlertListItemDto,
  type AlertSummaryDto,
  type AlertTab,
} from './alertsApi';

interface AlertsFilters {
  ownerUserId: number | null;
  productLineId: number | null;
  coverTypeId: number | null;
  regionId: number | null;
  priority: string | null;
}

const EMPTY_FILTERS: AlertsFilters = {
  ownerUserId: null,
  productLineId: null,
  coverTypeId: null,
  regionId: null,
  priority: null,
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveInitialTab(searchParams: URLSearchParams): AlertTab {
  const tabParam = searchParams.get('tab');
  if (isAlertTab(tabParam)) {
    return tabParam;
  }
  const categoryTab = tabForCategory(searchParams.get('category'));
  return categoryTab ?? 'all';
}

/**
 * Alerts & Escalation center (spec FR-62/FR-63, PRD 18.2, T-037). Route `/alerts` with `?category=`
 * deep-link support (dashboards/reports pre-filter into it by category, which selects the matching
 * queue tab on load). Composes the category summary cards, the tabbed Escalation Queue with its
 * premium-at-risk rollup, the contextual per-row workflow actions (Assign & acknowledge / Follow up /
 * Executive review), and — via `openAlertsCenterBadgeReset` on mount — the per-user new-alert badge
 * reset. Built entirely on the T-024 alerts backend, the T-028 workflow dialogs, and the T-043
 * design-system layer.
 */
function AlertsCenterPage() {
  const dispatch = useAppDispatch();
  const currencyCode = useTenantCurrency();
  const { showSuccess } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState<AlertTab>(() => resolveInitialTab(searchParams));
  const [filters, setFilters] = useState<AlertsFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const [summary, setSummary] = useState<AlertSummaryDto | null>(null);
  const [list, setList] = useState<AlertListDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ownerOptions, setOwnerOptions] = useState<EligibleLeadOwnerDto[] | null>(null);
  const [productLineOptions, setProductLineOptions] = useState<ReferenceItemDto[] | null>(null);
  const [coverTypeOptions, setCoverTypeOptions] = useState<ReferenceItemDto[] | null>(null);
  const [regionOptions, setRegionOptions] = useState<ReferenceItemDto[] | null>(null);
  const [agingThresholds, setAgingThresholds] = useState({ amber: DEFAULT_AGING_AMBER_DAYS, red: DEFAULT_AGING_RED_DAYS });

  // Contextual per-row action state (spec FR-62): the alert being acted on, its resolved workflow
  // action, and (for Assign/Follow up) the fetched lead + configured lead-assignable roles the
  // shared T-028 dialogs need.
  const [actionAlert, setActionAlert] = useState<AlertListItemDto | null>(null);
  const [actionKind, setActionKind] = useState<AlertActionKind | null>(null);
  const [actionLead, setActionLead] = useState<LeadDetailDto | null>(null);
  const [actionRoles, setActionRoles] = useState<BusinessAssignmentsDto | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Reset the per-user new-alert badge on entering the center (spec FR-63/AC-062): server-persisted
  // per user, so it stays zero for this user across reloads while others keep their own count.
  useEffect(() => {
    void dispatch(openAlertsCenterBadgeReset());
  }, [dispatch]);

  useEffect(() => {
    getEligibleLeadOwners().then(setOwnerOptions).catch(() => setOwnerOptions(null));
    listReferenceItems('product_line').then(setProductLineOptions).catch(() => setProductLineOptions(null));
    listReferenceItems('cover_type').then(setCoverTypeOptions).catch(() => setCoverTypeOptions(null));
    listReferenceItems('region').then(setRegionOptions).catch(() => setRegionOptions(null));
    fetchFullBusinessRules()
      .then((rules) => setAgingThresholds({ amber: rules.agingAmberDays, red: rules.agingRedDays }))
      .catch(() => undefined);
  }, []);

  const loadSummary = useCallback(() => {
    getAlertSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const loadList = useCallback(() => {
    setLoading(true);
    setError(null);
    listAlerts({
      tab: activeTab,
      ownerUserId: filters.ownerUserId,
      productLineId: filters.productLineId,
      coverTypeId: filters.coverTypeId,
      regionId: filters.regionId,
      priority: filters.priority,
      page,
      pageSize: ALERTS_PAGE_SIZE,
    })
      .then(setList)
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load alerts.'))
      .finally(() => setLoading(false));
  }, [activeTab, filters, page]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  function selectTab(tab: string): void {
    if (!isAlertTab(tab)) {
      return;
    }
    setActiveTab(tab);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    next.delete('category');
    if (tab === 'all') {
      next.delete('tab');
    } else {
      next.set('tab', tab);
    }
    setSearchParams(next, { replace: true });
  }

  function updateFilter<K extends keyof AlertsFilters>(key: K, value: AlertsFilters[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  function clearFilters(): void {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  function refetchAfterAction(): void {
    loadSummary();
    loadList();
    void dispatch(refreshAlertsBadge());
  }

  async function beginAction(alert: AlertListItemDto): Promise<void> {
    const kind = actionForAlertType(alert.type);
    if (!kind) {
      return;
    }
    setActionAlert(alert);
    setActionKind(kind);
    setDialogError(null);
    setActionLead(null);
    setActionRoles(null);

    // Fetch the lead for every workflow kind — assign/follow-up need it directly, and executive
    // review needs the lead's reporting category to decide whether the backend will require a
    // future next-follow-up date (open past Quote Sent), so the dialog collects one and the action
    // does not dead-end on a 4xx (F-037-06).
    try {
      const lead = await getLead(alert.leadId);
      setActionLead(lead);
      if (kind === 'assign') {
        const assignments = await fetchBusinessAssignments();
        setActionRoles(assignments);
      }
    } catch (err) {
      setDialogError((err as NormalizedError).title ?? 'Unable to open this action.');
    }
  }

  function closeAction(): void {
    setActionAlert(null);
    setActionKind(null);
    setActionLead(null);
    setActionRoles(null);
    setDialogBusy(false);
    setDialogError(null);
  }

  async function handleAssignConfirm(assignments: LeadAssignmentPayload[], comment: string | null): Promise<void> {
    if (!actionLead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await assignLead(actionLead.id, assignments, comment);
      showSuccess(`Lead ${updated.leadRef} assigned`);
      closeAction();
      refetchAfterAction();
    } catch (err) {
      setDialogBusy(false);
      setDialogError((err as NormalizedError).title ?? 'Unable to assign this lead.');
    }
  }

  async function handleFollowUpConfirm(followUpDate: string | null, outcomeNote: string, nextFollowUpDate: string | null): Promise<void> {
    if (!actionLead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await logFollowUp(actionLead.id, followUpDate, outcomeNote, nextFollowUpDate);
      showSuccess(`Follow-up logged for ${updated.leadRef}`);
      closeAction();
      refetchAfterAction();
    } catch (err) {
      setDialogBusy(false);
      setDialogError((err as NormalizedError).title ?? 'Unable to log this follow-up.');
    }
  }

  async function handleExecutiveReviewConfirm(comment: string, nextFollowUpDate: string | null): Promise<void> {
    if (!actionLead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await logFollowUp(actionLead.id, todayIso(), comment, nextFollowUpDate);
      showSuccess(`Executive review recorded for ${updated.leadRef}`);
      closeAction();
      refetchAfterAction();
    } catch (err) {
      setDialogBusy(false);
      setDialogError((err as NormalizedError).title ?? 'Unable to record this review.');
    }
  }

  const rollup = summary?.rollup;
  const tabCounts = list?.tabCounts ?? {};
  const totalPages = list ? Math.max(1, Math.ceil(list.totalCount / ALERTS_PAGE_SIZE)) : 1;
  const filtersApplied = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div data-testid="page-alerts">
      {/* Page title lives in the shell top bar (pageTitles.ts). */}
      <div className="qiq-filterbar qiq-card" data-testid="alerts-filter-bar" style={{ marginBottom: 'var(--qiq-space-4)' }}>
        <div className="qiq-field">
          <label htmlFor="alerts-filter-owner">Owner</label>
          <select
            id="alerts-filter-owner"
            data-testid="alerts-filter-owner"
            disabled={ownerOptions == null}
            value={filters.ownerUserId ?? ''}
            onChange={(event) => updateFilter('ownerUserId', event.target.value === '' ? null : Number(event.target.value))}
          >
            <option value="">All</option>
            {(ownerOptions ?? []).map((owner) => (
              <option key={owner.userId} value={owner.userId}>
                {owner.firstName} {owner.lastName}
              </option>
            ))}
          </select>
        </div>

        <div className="qiq-field">
          <label htmlFor="alerts-filter-product">Product line</label>
          <select
            id="alerts-filter-product"
            data-testid="alerts-filter-product"
            disabled={productLineOptions == null}
            value={filters.productLineId ?? ''}
            onChange={(event) => updateFilter('productLineId', event.target.value === '' ? null : Number(event.target.value))}
          >
            <option value="">All</option>
            {(productLineOptions ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div className="qiq-field">
          <label htmlFor="alerts-filter-cover">Cover type</label>
          <select
            id="alerts-filter-cover"
            data-testid="alerts-filter-cover"
            disabled={coverTypeOptions == null}
            value={filters.coverTypeId ?? ''}
            onChange={(event) => updateFilter('coverTypeId', event.target.value === '' ? null : Number(event.target.value))}
          >
            <option value="">All</option>
            {(coverTypeOptions ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div className="qiq-field">
          <label htmlFor="alerts-filter-region">Region</label>
          <select
            id="alerts-filter-region"
            data-testid="alerts-filter-region"
            disabled={regionOptions == null}
            value={filters.regionId ?? ''}
            onChange={(event) => updateFilter('regionId', event.target.value === '' ? null : Number(event.target.value))}
          >
            <option value="">All</option>
            {(regionOptions ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div className="qiq-field">
          <label htmlFor="alerts-filter-priority">Priority</label>
          <select
            id="alerts-filter-priority"
            data-testid="alerts-filter-priority"
            value={filters.priority ?? ''}
            onChange={(event) => updateFilter('priority', event.target.value === '' ? null : event.target.value)}
          >
            <option value="">All</option>
            <option value={PRIORITY_HIGH}>High</option>
            <option value={PRIORITY_NORMAL}>Normal</option>
          </select>
        </div>

        <button
          type="button"
          className="qiq-btn qiq-btn--ghost"
          data-testid="alerts-clear-filters"
          disabled={!filtersApplied}
          onClick={clearFilters}
        >
          Clear filters
        </button>
      </div>

      {summary && (
        <CategoryCards categories={summary.categories} activeTab={activeTab} onSelectTab={selectTab} />
      )}

      <div className="qiq-card">
        <div
          className="qiq-card-head"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--qiq-space-4)' }}
        >
          <div>
            <div className="qiq-card-title">Escalation Queue</div>
            <div className="qiq-card-sub" data-testid="premium-at-risk-rollup">
              {rollup
                ? `Premium at risk: ${formatCompactCurrency(rollup.premiumAtRisk, currencyCode)} · ${rollup.quoteCount} quotes`
                : 'Premium at risk: —'}
            </div>
          </div>

          <nav className="qiq-tabs" data-testid="alerts-tabs" aria-label="Alert queue tabs">
            {ALERT_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                data-testid={`alerts-tab-${tab}`}
                data-active={tab === activeTab ? 'true' : 'false'}
                className={tab === activeTab ? 'qiq-tab qiq-tab--active' : 'qiq-tab'}
                onClick={() => selectTab(tab)}
              >
                {ALERT_TAB_LABELS[tab]}{' '}
                <span data-testid={`alerts-tab-count-${tab}`}>{tabCounts[tab] ?? 0}</span>
              </button>
            ))}
          </nav>
        </div>

        {error && <ErrorBanner message={error} onRetry={loadList} />}

        {!error && loading && <SkeletonTable rows={8} columns={9} />}

        {!error && !loading && list && list.items.length === 0 && (
          <EmptyState message="No alerts match the current filters." />
        )}

        {!error && !loading && list && list.items.length > 0 && (
          <>
            <AlertsQueueTable
              alerts={list.items}
              currencyCode={currencyCode}
              agingAmberDays={agingThresholds.amber}
              agingRedDays={agingThresholds.red}
              onAction={(alert) => void beginAction(alert)}
            />

            <div
              data-testid="alerts-pagination"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: 'var(--qiq-space-3)',
                fontSize: '12px',
                color: 'var(--qiq-text-secondary)',
              }}
            >
              <span data-testid="alerts-page-summary">
                {(page - 1) * ALERTS_PAGE_SIZE + 1}-{Math.min(page * ALERTS_PAGE_SIZE, list.totalCount)} of {list.totalCount}
              </span>
              <div style={{ display: 'flex', gap: 'var(--qiq-space-2)' }}>
                <button type="button" className="qiq-btn qiq-btn--sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <button type="button" className="qiq-btn qiq-btn--sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {actionKind === 'assign' && actionAlert && actionLead && (
        <AssignDialog
          open
          lead={actionLead}
          roles={actionRoles}
          busy={dialogBusy}
          error={dialogError}
          onConfirm={(assignments, comment) => void handleAssignConfirm(assignments, comment)}
          onCancel={closeAction}
        />
      )}

      {actionKind === 'follow-up' && actionAlert && actionLead && (
        <LogFollowUpDialog
          open
          lead={actionLead}
          busy={dialogBusy}
          error={dialogError}
          onConfirm={(followUpDate, outcomeNote, nextFollowUpDate) =>
            void handleFollowUpConfirm(followUpDate, outcomeNote, nextFollowUpDate)
          }
          onCancel={closeAction}
        />
      )}

      {actionKind === 'executive-review' && actionAlert && actionLead && (
        <ExecutiveReviewDialog
          open
          entityRef={actionAlert.quoteRef ?? actionAlert.leadRef}
          partyName={actionAlert.clientName}
          requiresNextFollowUpDate={deriveLeadReportingCategory(actionLead.statusName) === 'quoted'}
          busy={dialogBusy}
          error={dialogError}
          onConfirm={(comment, nextFollowUpDate) => void handleExecutiveReviewConfirm(comment, nextFollowUpDate)}
          onCancel={closeAction}
        />
      )}
    </div>
  );
}

export default AlertsCenterPage;
