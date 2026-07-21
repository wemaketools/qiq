import ConfirmDialog from '../../components/common/ConfirmDialog';

interface RemoveTenantDialogProps {
  open: boolean;
  tenantName: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Danger-styled confirm dialog for soft-removing a tenant (spec FR-06/FR-07, AC-006, NFR-09; UI
 * Standards §14.3 / §9): names the tenant, restates that the removal is a soft delete — hidden
 * from the default tenant list, its history preserved, and restorable — rather than a destructive
 * delete.
 */
function RemoveTenantDialog({ open, tenantName, busy, onConfirm, onCancel }: RemoveTenantDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <ConfirmDialog
      testId="remove-tenant-dialog"
      open={open}
      title={`Remove tenant — ${tenantName}`}
      description="This soft-removes the tenant: it will be hidden from the default tenant list and its users will lose access, but the tenant and its history are preserved and it can be restored at any time."
      confirmLabel="Remove tenant"
      danger
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export default RemoveTenantDialog;
