import type { TenantMembership } from '../../app/slices/sessionSlice';

/**
 * Human label for an RBAC row's tenant scope. Cross-tenant callers (`global.view_any_tenant`) see
 * roles/groups from EVERY tenant in User Manager, and the default per-tenant role sets share names
 * across tenants — an unlabeled "Admin" appearing twice in a picker is indistinguishable. `Global`
 * for tenant-less rows; the tenant's name when the session knows it; a plain id fallback for a
 * tenant outside the caller's membership list.
 */
export function scopeLabel(
  tenantId: number | null,
  memberships: readonly TenantMembership[],
): string {
  if (tenantId === null) {
    return 'Global';
  }
  const membership = memberships.find((candidate) => candidate.tenantId === tenantId);
  return membership !== undefined ? membership.tenantName : `Tenant ${tenantId}`;
}

export interface ScopeGroup<T> {
  label: string;
  items: T[];
}

/** Buckets scoped rows for an `<optgroup>` select: Global first, then tenants alphabetically. */
export function groupByScope<T extends { tenantId: number | null }>(
  items: readonly T[],
  memberships: readonly TenantMembership[],
): ScopeGroup<T>[] {
  const byLabel = new Map<string, T[]>();
  for (const item of items) {
    const label = scopeLabel(item.tenantId, memberships);
    const bucket = byLabel.get(label);
    if (bucket === undefined) {
      byLabel.set(label, [item]);
    } else {
      bucket.push(item);
    }
  }
  return [...byLabel.entries()]
    .map(([label, groupItems]) => ({ label, items: groupItems }))
    .sort((a, b) => {
      if (a.label === 'Global') {
        return b.label === 'Global' ? 0 : -1;
      }
      if (b.label === 'Global') {
        return 1;
      }
      return a.label.localeCompare(b.label);
    });
}
