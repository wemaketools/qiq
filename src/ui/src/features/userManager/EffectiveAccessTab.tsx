import type { EffectiveAccessDto } from './usersApi';
import { permissionDescription } from './permissionCatalog';

interface EffectiveAccessTabProps {
  access: EffectiveAccessDto;
}

const SECTION_STYLE = { marginBottom: 'var(--qiq-space-5)' } as const;
const SECTION_TITLE_STYLE = { marginBottom: 'var(--qiq-space-3)' } as const;
const LIST_STYLE = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  fontSize: '13px',
} as const;
const EMPTY_STYLE = { margin: 0, fontSize: '13px', color: 'var(--qiq-text-secondary)' } as const;

/** A permission rendered as its friendly catalog name with the raw code alongside in muted mono. */
function PermissionLabel({ code }: { code: string }) {
  return (
    <>
      {permissionDescription(code)}{' '}
      <span className="qiq-mono" style={{ color: 'var(--qiq-text-secondary)', fontSize: '11.5px' }}>
        {code}
      </span>
    </>
  );
}

/**
 * Effective access view (spec FR-14, AC-013, verification.json V-013): renders direct roles,
 * direct permissions, group memberships, tenant assignments, and the resolved permission set per
 * tenant (plus the global/null-tenant scope), sourced verbatim from
 * `GET /users/{id}/effective-access` (T-007 `GetEffectiveAccessQueryHandler`) — no client-side
 * union/resolution logic is duplicated here. Permissions display their friendly catalog name with
 * the raw code alongside.
 */
function EffectiveAccessTab({ access }: EffectiveAccessTabProps) {
  return (
    <div data-testid="effective-access-tab">
      <section style={SECTION_STYLE}>
        <h3 className="qiq-form-section-title" style={SECTION_TITLE_STYLE}>Direct roles</h3>
        {access.directRoles.length === 0 ? (
          <p style={EMPTY_STYLE}>No direct roles.</p>
        ) : (
          <ul data-testid="direct-roles-list" style={LIST_STYLE}>
            {access.directRoles.map((role) => (
              <li key={`${role.roleId}-${role.tenantId ?? 'global'}`}>
                {role.roleName} {role.tenantId === null ? '(global)' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={SECTION_STYLE}>
        <h3 className="qiq-form-section-title" style={SECTION_TITLE_STYLE}>Direct permissions</h3>
        {access.directPermissions.length === 0 ? (
          <p style={EMPTY_STYLE}>No direct permissions.</p>
        ) : (
          <ul data-testid="direct-permissions-list" style={LIST_STYLE}>
            {access.directPermissions.map((permission) => (
              <li key={`${permission.permissionCode}-${permission.tenantId ?? 'global'}`}>
                <PermissionLabel code={permission.permissionCode} />
                {permission.tenantId === null ? ' (global)' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={SECTION_STYLE}>
        <h3 className="qiq-form-section-title" style={SECTION_TITLE_STYLE}>Groups</h3>
        {access.groups.length === 0 ? (
          <p style={EMPTY_STYLE}>No group memberships.</p>
        ) : (
          <ul data-testid="groups-list" style={LIST_STYLE}>
            {access.groups.map((group) => (
              <li key={`${group.groupId}-${group.tenantId ?? 'global'}`}>{group.groupName}</li>
            ))}
          </ul>
        )}
      </section>

      <section style={SECTION_STYLE}>
        <h3 className="qiq-form-section-title" style={SECTION_TITLE_STYLE}>Tenant assignments</h3>
        {access.tenantAssignments.length === 0 ? (
          <p style={EMPTY_STYLE}>No tenant assignments.</p>
        ) : (
          <ul data-testid="tenant-assignments-list" style={LIST_STYLE}>
            {access.tenantAssignments.map((tenant) => (
              <li key={tenant.tenantId}>{tenant.tenantName}</li>
            ))}
          </ul>
        )}
      </section>

      <section style={SECTION_STYLE}>
        <h3 className="qiq-form-section-title" style={SECTION_TITLE_STYLE}>Resolved permissions per tenant</h3>
        <div data-testid="resolved-permissions" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}>
          {Object.entries(access.effectivePermissionsByTenant).map(([scopeKey, codes]) => {
            const tenantName =
              scopeKey === 'global'
                ? 'Global'
                : access.tenantAssignments.find((t) => String(t.tenantId) === scopeKey)?.tenantName ?? scopeKey;
            return (
              <div key={scopeKey} data-testid={`resolved-permissions-scope-${scopeKey}`}>
                <h4 style={{ fontSize: '13px', marginBottom: 'var(--qiq-space-2)' }}>{tenantName}</h4>
                <ul style={LIST_STYLE}>
                  {codes.map((code) => (
                    <li key={code}>
                      <PermissionLabel code={code} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default EffectiveAccessTab;
