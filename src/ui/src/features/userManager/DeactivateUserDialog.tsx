import ConfirmDialog from '../../components/common/ConfirmDialog';

interface DeactivateUserDialogProps {
  open: boolean;
  userEmail: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Danger-styled confirm dialog for deactivating a user (spec FR-13, AC-012, NFR-09; UI Standards
 * §14.3 / §9): names the user, restates that deactivation blocks their login going forward
 * (generic error, per AC-002) while preserving their history/audit trail — this is a disable, not a
 * hard delete.
 */
function DeactivateUserDialog({ open, userEmail, busy, onConfirm, onCancel }: DeactivateUserDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <ConfirmDialog
      testId="deactivate-user-dialog"
      open={open}
      title={`Deactivate user — ${userEmail}`}
      description="This blocks the user from signing in (they will see the same generic login error as any other failed attempt) while preserving their history and audit trail. This can only be reversed by re-inviting the user."
      confirmLabel="Deactivate user"
      danger
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export default DeactivateUserDialog;
