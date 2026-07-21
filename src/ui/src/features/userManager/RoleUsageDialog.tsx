import ConfirmDialog from '../../components/common/ConfirmDialog';
import type { RoleUsageDto } from './rolesApi';

interface RoleUsageDialogProps {
  open: boolean;
  roleName: string;
  usage: RoleUsageDto | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shown before disabling a role (spec FR-13, AC-012, PRD 20.1.1, T-007 `GET /roles/{id}/usage`):
 * lists every user and group that currently references the role so the administrator understands
 * the blast radius before proceeding. Disabling with existing usage still requires the backend's
 * explicit `force=true` (T-007 `ROLE_IN_USE` 409 otherwise) — this dialog's confirm always passes
 * that intent through to the caller, which is responsible for retrying with `force`.
 */
function RoleUsageDialog({ open, roleName, usage, busy, onConfirm, onCancel }: RoleUsageDialogProps) {
  if (!open) {
    return null;
  }

  const userCount = usage?.users.length ?? 0;
  const groupCount = usage?.groups.length ?? 0;
  const inUse = userCount > 0 || groupCount > 0;

  return (
    <ConfirmDialog
      testId="role-usage-dialog"
      open={open}
      title={`Disable role — ${roleName}`}
      description={
        inUse
          ? `This role is currently in use by ${userCount} user(s) and ${groupCount} group(s). Disabling it will remove it from every list below going forward.`
          : 'This role is not currently assigned to any user or group.'
      }
      confirmLabel="Disable role"
      danger
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {inUse && (
        <div data-testid="role-usage-list">
          {userCount > 0 && (
            <div>
              <h3>Users</h3>
              <ul>
                {usage!.users.map((user) => (
                  <li key={user.userId}>{user.email}</li>
                ))}
              </ul>
            </div>
          )}
          {groupCount > 0 && (
            <div>
              <h3>Groups</h3>
              <ul>
                {usage!.groups.map((group) => (
                  <li key={group.groupId}>{group.name}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

export default RoleUsageDialog;
