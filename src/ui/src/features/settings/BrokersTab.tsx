import { useCallback, useEffect, useState } from 'react';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { listBrokers, listReferenceItems, type BrokerSummaryDto, type ReferenceItemDto } from './settingsApi';
import BrokerFormPanel from './BrokerFormDrawer';
import StatusChip from '../../components/common/StatusChip';
import SortableTh from '../../components/common/SortableTh';
import { useClientSort, type SortAccessors } from '../../components/common/useClientSort';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { useToast } from '../../components/common/Toast';

/**
 * Brokers tab (spec FR-24, PRD 12.10, AC-023, T-012/T-016): list + `BrokerFormPanel` for add/edit
 * (rendered inline in place of the list, like every other form in the product), including the
 * contacts editor and disable confirmation. `GET /brokers` is called with no `status`
 * filter so disabled brokers stay visible here (with a status chip) even though they are excluded
 * from active-broker pickers elsewhere (T-012's disabled-brokers-hidden-from-pickers invariant).
 */
function BrokersTab() {
  const { showSuccess } = useToast();
  const canManage = useAppSelector(selectHasPermission(PermissionCodes.BrokersManage));

  const [brokers, setBrokers] = useState<BrokerSummaryDto[]>([]);
  const [brokerTypes, setBrokerTypes] = useState<ReferenceItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerState, setDrawerState] = useState<{ open: boolean; brokerId: number | null }>({ open: false, brokerId: null });

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // `broker_type` reference items require `reference_data.manage` (a *different* Settings
    // permission than `brokers.view`/`brokers.manage`) — a broker-only caller can legitimately lack
    // it. Loading broker types is therefore best-effort (falls back to blank Type cells/an empty
    // tier dropdown rather than failing the whole tab) so this tab's core data (the broker list
    // itself) never fails to load just because the caller cannot also read reference data.
    Promise.all([listBrokers(), listReferenceItems('broker_type').catch(() => [] as ReferenceItemDto[])])
      .then(([brokerList, types]) => {
        setBrokers(brokerList.items);
        setBrokerTypes(types);
      })
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load brokers.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function brokerTypeName(brokerTypeId: number | null): string {
    if (brokerTypeId === null) {
      return '—';
    }
    return brokerTypes.find((t) => t.id === brokerTypeId)?.name ?? '—';
  }

  // In-component (not module-level) because the Type column sorts on the resolved reference name;
  // brokers and brokerTypes land in the same load, so the items change re-triggers the sort memo.
  const sortAccessors: SortAccessors<BrokerSummaryDto, 'name' | 'type' | 'branch' | 'status'> = {
    name: (broker) => broker.name,
    type: (broker) => (broker.brokerTypeId === null ? null : brokerTypeName(broker.brokerTypeId)),
    branch: (broker) => broker.branch,
    status: (broker) => broker.status,
  };
  const { sorted: sortedBrokers, sort, toggle: toggleSort } = useClientSort(brokers, sortAccessors, {
    field: 'name',
    direction: 'asc',
  });

  if (drawerState.open) {
    return (
      <div data-testid="brokers-tab">
        <BrokerFormPanel
          brokerId={drawerState.brokerId}
          brokerTypes={brokerTypes}
          canManage={canManage}
          onClose={() => setDrawerState({ open: false, brokerId: null })}
          onSaved={(message) => {
            showSuccess(message);
            setDrawerState({ open: false, brokerId: null });
            load();
          }}
          onDisabled={(message) => {
            showSuccess(message);
            setDrawerState({ open: false, brokerId: null });
            load();
          }}
        />
      </div>
    );
  }

  return (
    <div data-testid="brokers-tab">
      <div className="qiq-page-head">
        <h2>Brokers</h2>
        {canManage && (
          <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => setDrawerState({ open: true, brokerId: null })}>
            + Add broker
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && loading && <SkeletonTable rows={5} columns={4} />}

      {!error && !loading && brokers.length === 0 && (
        <EmptyState
          message="No brokers configured yet."
          actions={
            canManage ? (
              <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => setDrawerState({ open: true, brokerId: null })}>
                + Add broker
              </button>
            ) : undefined
          }
        />
      )}

      {!error && !loading && brokers.length > 0 && (
        <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table data-testid="brokers-table">
          <thead>
            <tr>
              <SortableTh field="name" label="Name" sort={sort} onSort={toggleSort} />
              <SortableTh field="type" label="Type" sort={sort} onSort={toggleSort} />
              <SortableTh field="branch" label="Branch" sort={sort} onSort={toggleSort} />
              <SortableTh field="status" label="Status" sort={sort} onSort={toggleSort} />
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedBrokers.map((broker) => (
              <tr
                key={broker.id}
                className="qiq-row-clickable"
                onClick={() => setDrawerState({ open: true, brokerId: broker.id })}
              >
                <td>{broker.name}</td>
                <td>{brokerTypeName(broker.brokerTypeId)}</td>
                <td>{broker.branch ?? '—'}</td>
                <td>
                  <StatusChip label={broker.status === 'active' ? 'Active' : 'Disabled'} category={broker.status === 'active' ? 'won' : 'expired'} />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="qiq-row-actions">
                    <button
                      type="button"
                      className="qiq-btn qiq-btn--sm"
                      onClick={() => setDrawerState({ open: true, brokerId: broker.id })}
                    >
                      {canManage ? 'Edit' : 'View'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

    </div>
  );
}

export default BrokersTab;
