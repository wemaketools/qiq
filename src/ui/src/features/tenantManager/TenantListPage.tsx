import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { listTenants, removeTenant, restoreTenant, type TenantDto } from './tenantsApi';
import StatusChip from '../../components/common/StatusChip';
import SortableTh from '../../components/common/SortableTh';
import { useClientSort, type SortAccessors } from '../../components/common/useClientSort';
import SkeletonTable from '../../components/common/SkeletonTable';
import EmptyState from '../../components/common/EmptyState';
import ErrorBanner from '../../components/common/ErrorBanner';
import { useToast } from '../../components/common/Toast';
import RemoveTenantDialog from './RemoveTenantDialog';
import RestoreTenantDialog from './RestoreTenantDialog';

type TenantSortField = 'name' | 'contact' | 'email' | 'status';

const TENANT_SORT_ACCESSORS: SortAccessors<TenantDto, TenantSortField> = {
  name: (tenant) => tenant.name,
  contact: (tenant) => tenant.contactName,
  email: (tenant) => tenant.contactEmail,
  status: (tenant) => tenant.status,
};

/**
 * Tenant Manager list screen (spec FR-06/FR-07, PRD 5.5, AC-006, verification.json V-006):
 * name/contact/status table with a permission-gated "include removed" filter and soft-remove /
 * restore row actions. Route `/admin/tenants`, already gated at the router level by
 * `tenants.view` (see app/router.tsx); the finer-grained action permissions checked here
 * (create/deactivate/restore/view_removed) are UX affordances only — the server enforces every
 * one independently on its endpoint.
 */
function TenantListPage() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const canViewRemoved = useAppSelector(selectHasPermission(PermissionCodes.TenantsViewRemoved));
  const canCreate = useAppSelector(selectHasPermission(PermissionCodes.TenantsCreate));
  const canRemove = useAppSelector(selectHasPermission(PermissionCodes.TenantsDeactivate));
  const canRestore = useAppSelector(selectHasPermission(PermissionCodes.TenantsRestore));

  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const { sorted: sortedTenants, sort, toggle: toggleSort } = useClientSort(tenants, TENANT_SORT_ACCESSORS, {
    field: 'name',
    direction: 'asc',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<TenantDto | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<TenantDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listTenants(canViewRemoved && includeRemoved)
      .then((result) => setTenants(result))
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load tenants.'))
      .finally(() => setLoading(false));
  }, [includeRemoved, canViewRemoved]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRemoveConfirm(): Promise<void> {
    if (!removeTarget) {
      return;
    }
    setBusy(true);
    try {
      await removeTenant(removeTarget.id);
      showSuccess(`Tenant ${removeTarget.name} removed`);
      setRemoveTarget(null);
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to remove tenant.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreConfirm(): Promise<void> {
    if (!restoreTarget) {
      return;
    }
    setBusy(true);
    try {
      await restoreTenant(restoreTarget.id);
      showSuccess(`Tenant ${restoreTarget.name} restored`);
      setRestoreTarget(null);
      load();
    } catch (err) {
      showError((err as NormalizedError).title ?? 'Unable to restore tenant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="page-admin-tenants">
      <div className="qiq-page-head">
        {/* Page title lives in the shell top bar (pageTitles.ts) — this row only carries the actions. */}
        <span />
        <div style={{ display: 'flex', gap: 'var(--qiq-space-4)', alignItems: 'center' }}>
          {canViewRemoved && (
            <label data-testid="include-removed-toggle">
              <input
                type="checkbox"
                checked={includeRemoved}
                onChange={(event) => setIncludeRemoved(event.target.checked)}
              />
              {' '}Include removed
            </label>
          )}
          {canCreate && (
            <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/tenants/new')}>
              + New Tenant
            </button>
          )}
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && loading && <SkeletonTable rows={5} columns={6} />}

      {!error && !loading && tenants.length === 0 && (
        <EmptyState
          message="No tenants match the current filters."
          actions={
            canCreate ? (
              <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => navigate('/admin/tenants/new')}>
                + New Tenant
              </button>
            ) : undefined
          }
        />
      )}

      {!error && !loading && tenants.length > 0 && (
        <div className="qiq-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table data-testid="tenant-list">
          <thead>
            <tr>
              <SortableTh field="name" label="Name" sort={sort} onSort={toggleSort} />
              <SortableTh field="contact" label="Contact" sort={sort} onSort={toggleSort} />
              <SortableTh field="email" label="Email" sort={sort} onSort={toggleSort} />
              <th>Phone</th>
              <SortableTh field="status" label="Status" sort={sort} onSort={toggleSort} />
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedTenants.map((tenant) => (
              <tr key={tenant.id} className="qiq-row-clickable" onClick={() => navigate(`/admin/tenants/${tenant.id}`)}>
                <td>{tenant.name}</td>
                <td>{tenant.contactName ?? '—'}</td>
                <td>{tenant.contactEmail ?? '—'}</td>
                <td>{tenant.contactPhone ?? '—'}</td>
                <td>
                  <StatusChip
                    label={tenant.status === 'active' ? 'Active' : 'Removed'}
                    category={tenant.status === 'active' ? 'won' : 'expired'}
                  />
                </td>
                <td onClick={(event) => event.stopPropagation()}>
                  <div className="qiq-row-actions">
                    <button type="button" className="qiq-btn qiq-btn--sm" onClick={() => navigate(`/admin/tenants/${tenant.id}`)}>
                      Edit
                    </button>
                    {canRemove && tenant.status === 'active' && (
                      <button type="button" className="qiq-btn qiq-btn--sm qiq-btn--danger-soft" onClick={() => setRemoveTarget(tenant)}>
                        Remove
                      </button>
                    )}
                    {canRestore && tenant.status === 'removed' && (
                      <button type="button" className="qiq-btn qiq-btn--sm" onClick={() => setRestoreTarget(tenant)}>
                        Restore
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <RemoveTenantDialog
        open={removeTarget !== null}
        tenantName={removeTarget?.name ?? ''}
        busy={busy}
        onConfirm={() => void handleRemoveConfirm()}
        onCancel={() => setRemoveTarget(null)}
      />
      <RestoreTenantDialog
        open={restoreTarget !== null}
        tenantName={restoreTarget?.name ?? ''}
        busy={busy}
        onConfirm={() => void handleRestoreConfirm()}
        onCancel={() => setRestoreTarget(null)}
      />
    </div>
  );
}

export default TenantListPage;
