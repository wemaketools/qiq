import { useState } from 'react';
import ConfirmDialog from '../../components/common/ConfirmDialog';

interface SecretRevealDialogProps {
  clientId: string;
  secret: string;
  onClose: () => void;
}

/**
 * Shows an API credential's client id and secret exactly once (spec FR-25, AC-024, V-024, T-030).
 * The secret lives only in this component's props (an in-memory response) and is never persisted or
 * re-fetched from storage; closing the dialog drops it, and it can only be seen again via an explicit,
 * permission-bound reveal that reads it live from Keycloak. The copy button places the secret on the
 * clipboard so operators do not have to retype it before it is gone.
 */
function SecretRevealDialog({ clientId, secret, onClose }: SecretRevealDialogProps) {
  const [copied, setCopied] = useState(false);

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <ConfirmDialog
      open
      testId="secret-reveal-dialog"
      title="API credential secret"
      description="Copy this secret now. For your security it is shown only once and cannot be retrieved again."
      confirmLabel="Done"
      onConfirm={onClose}
      onCancel={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
        <label className="qiq-field">
          <span>Client ID</span>
          <input type="text" readOnly value={clientId} data-testid="secret-client-id" />
        </label>
        <label className="qiq-field">
          <span>Client secret</span>
          <input type="text" readOnly value={secret} data-testid="secret-value" />
        </label>
        <div>
          <button type="button" className="qiq-btn" onClick={copySecret} data-testid="copy-secret-button">
            {copied ? 'Copied' : 'Copy secret'}
          </button>
        </div>
      </div>
    </ConfirmDialog>
  );
}

export default SecretRevealDialog;
