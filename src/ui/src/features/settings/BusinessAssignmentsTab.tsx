import { useEffect, useState } from 'react';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission, selectSession } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import { fetchBusinessAssignments, updateBusinessAssignments, type BusinessAssignmentsDto } from './settingsApi';
import { listRoles, type RoleDto } from '../userManager/rolesApi';
import ErrorBanner from '../../components/common/ErrorBanner';
import SkeletonTable from '../../components/common/SkeletonTable';
import { useToast } from '../../components/common/Toast';

/**
 * Business assignments tab (spec FR-23 as amended 2026-07-15, PRD 8, AC-022): the tenant picks one
 * role for each of the two fixed assignment slots — the RM role (a lead's accountable owner) and
 * the Underwriting role (what Send to underwriting assigns and quote assignment offers). Replaces
 * the earlier free-form lead/quote assignable-role lists. Saves via
 * `PUT /settings/business-assignments`; the server enforces that the two slots are different roles
 * and that a slot with live lead/quote assignees cannot be cleared (409).
 */
function BusinessAssignmentsTab() {
  const { showSuccess, showError } = useToast();
  const canManage = useAppSelector(selectHasPermission(PermissionCodes.BusinessAssignmentsManage));
  const activeTenantId = useAppSelector(selectSession).activeTenantId;

  const [allRoles, setAllRoles] = useState<RoleDto[]>([]);
  const [rmRoleId, setRmRoleId] = useState<number | null>(null);
  const [underwritingRoleId, setUnderwritingRoleId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function applyLoaded(assignments: BusinessAssignmentsDto): void {
    setRmRoleId(assignments.rmRole?.roleId ?? null);
    setUnderwritingRoleId(assignments.underwritingRole?.roleId ?? null);
  }

  function load(): void {
    setLoading(true);
    setLoadError(null);
    Promise.all([fetchBusinessAssignments(), listRoles()])
      .then(([assignments, roles]) => {
        // Cross-tenant callers get EVERY tenant's roles from /roles; the two slots configure THIS
        // tenant, and the server refuses a foreign tenant's role — offer only what can be saved.
        setAllRoles(roles.filter((role) => role.tenantId === null || role.tenantId === activeTenantId));
        applyLoaded(assignments);
      })
      .catch((err: unknown) => setLoadError((err as NormalizedError).title ?? 'Unable to load business assignments.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only.
  }, []);

  async function handleSave(): Promise<void> {
    setFormError(null);

    if (rmRoleId !== null && rmRoleId === underwritingRoleId) {
      setFormError('The RM role and the Underwriting role must be different roles.');
      return;
    }

    setSaving(true);
    try {
      const saved = await updateBusinessAssignments({ rmRoleId, underwritingRoleId });
      applyLoaded(saved);
      showSuccess('Business assignments saved');
    } catch (err) {
      const message = (err as NormalizedError).title ?? 'Unable to save business assignments.';
      setFormError(message);
      showError(message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <SkeletonTable rows={4} columns={2} />;
  }

  if (loadError) {
    return <ErrorBanner message={loadError} onRetry={load} />;
  }

  function renderSlotSelect(
    id: string,
    testId: string,
    value: number | null,
    onChange: (roleId: number | null) => void,
  ) {
    return (
      <select
        id={id}
        data-testid={testId}
        value={value ?? ''}
        disabled={!canManage}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
      >
        <option value="">Not configured</option>
        {allRoles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div data-testid="business-assignments-tab">
      <div className="qiq-page-head">
        <h2>Business assignments</h2>
      </div>
      {formError && <ErrorBanner message={formError} />}

      <div className="qiq-card" style={{ padding: 0 }}>
        <div data-testid="business-assignments-form" className="qiq-form-grid" style={{ maxWidth: '640px', padding: 'var(--qiq-space-5)' }}>
          <div className="qiq-field">
            <label htmlFor="rm-role">RM role</label>
            {renderSlotSelect('rm-role', 'rm-role-select', rmRoleId, setRmRoleId)}
            <p className="qiq-field-hint">Users holding this role can be a lead's accountable owner (RM).</p>
          </div>

          <div className="qiq-field">
            <label htmlFor="underwriting-role">Underwriting role</label>
            {renderSlotSelect('underwriting-role', 'underwriting-role-select', underwritingRoleId, setUnderwritingRoleId)}
            <p className="qiq-field-hint">Users holding this role receive Send-to-underwriting and quote assignments.</p>
          </div>
        </div>

        {canManage && (
          <div data-testid="form-sticky-footer" className="qiq-sticky-footer">
            <button type="button" className="qiq-btn qiq-btn--primary" onClick={() => void handleSave()} disabled={saving}>
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default BusinessAssignmentsTab;
