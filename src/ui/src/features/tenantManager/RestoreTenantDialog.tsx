import ConfirmDialog from '../../components/common/ConfirmDialog';

interface RestoreTenantDialogProps {
  open: boolean;
  tenantName: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm dialog for restoring a soft-removed tenant back to Active (spec FR-06/FR-07, AC-006):
 * the counterpart action to {@link RemoveTenantDialog}. Non-destructive, so it uses the standard
 * (non-danger) primary button per UI Standards §9/§14.3.
 */
function RestoreTenantDialog({ open, tenantName, busy, onConfirm, onCancel }: RestoreTenantDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <ConfirmDialog
      testId="restore-tenant-dialog"
      open={open}
      title={`Restore tenant — ${tenantName}`}
      description="This reactivates the tenant: it reappears in the default tenant list and its users regain access."
      confirmLabel="Restore tenant"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export default RestoreTenantDialog;
