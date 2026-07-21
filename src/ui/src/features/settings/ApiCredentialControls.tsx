import { useCallback, useEffect, useState } from 'react';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import type { NormalizedError } from '../../api/client';
import {
  disableApiCredential,
  listApiCredentials,
  provisionBrokerApiCredential,
  provisionTenantApiCredential,
  regenerateApiCredentialSecret,
  revealApiCredentialSecret,
  type ApiCredentialDto,
} from './settingsApi';
import SecretRevealDialog from './SecretRevealDialog';
import StatusChip from '../../components/common/StatusChip';
import ErrorBanner from '../../components/common/ErrorBanner';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { useToast } from '../../components/common/Toast';

interface ApiCredentialControlsProps {
  /** null/undefined = the tenant-scoped credential; a value = the broker-scoped credential for that broker. */
  brokerId?: number | null;
  testId: string;
}

interface RevealedSecret {
  clientId: string;
  secret: string;
}

/**
 * Shared API-credential management controls (spec FR-25, AC-024, V-024, T-030) used by both the
 * Settings API-access tab (tenant scope) and the broker view page section (broker scope). Renders the
 * enable/disable control, the client-id display, the reveal-once dialog with copy, and the danger-
 * confirmed regenerate. Every mutation is permission-gated in the UI (the server re-checks) and the
 * secret is only ever held in transient state — never persisted or re-fetched from storage.
 */
function ApiCredentialControls({ brokerId, testId }: ApiCredentialControlsProps) {
  const { showSuccess } = useToast();
  const isBrokerScope = brokerId != null;
  const canEnable = useAppSelector(selectHasPermission(PermissionCodes.ApiAccessEnable));
  const canDisable = useAppSelector(selectHasPermission(PermissionCodes.ApiAccessDisable));
  const canRegenerate = useAppSelector(selectHasPermission(PermissionCodes.ApiAccessRegenerateSecret));
  const canView = useAppSelector(selectHasPermission(PermissionCodes.ApiAccessView));

  const [credential, setCredential] = useState<ApiCredentialDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listApiCredentials(brokerId ?? undefined)
      .then((list) => {
        const match = isBrokerScope
          ? list.credentials.find((c) => c.brokerId === brokerId)
          : list.credentials.find((c) => c.brokerId === null);
        setCredential(match ?? null);
      })
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load API access.'))
      .finally(() => setLoading(false));
  }, [brokerId, isBrokerScope]);

  useEffect(() => {
    load();
  }, [load]);

  function handleError(err: unknown) {
    setError((err as NormalizedError).title ?? 'The request failed.');
  }

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const result = isBrokerScope ? await provisionBrokerApiCredential(brokerId) : await provisionTenantApiCredential();
      setRevealed({ clientId: result.clientId, secret: result.secret });
      showSuccess('API access enabled.');
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    if (!credential) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await revealApiCredentialSecret(credential.id);
      setRevealed({ clientId: result.clientId, secret: result.secret });
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!credential) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await regenerateApiCredentialSecret(credential.id);
      setRevealed({ clientId: result.clientId, secret: result.secret });
      showSuccess('Secret regenerated. The previous secret no longer works.');
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setConfirmingRegenerate(false);
      setBusy(false);
    }
  }

  async function disable() {
    if (!credential) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await disableApiCredential(credential.id);
      showSuccess('API access disabled.');
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setConfirmingDisable(false);
      setBusy(false);
    }
  }

  const isActive = credential?.status === 'active';

  return (
    <div data-testid={testId}>
      {error && <ErrorBanner message={error} onRetry={load} />}

      {loading && <p>Loading…</p>}

      {!loading && !credential && (
        <div className="qiq-card" style={{ padding: 'var(--qiq-space-4)' }}>
          <p>API access is not enabled{isBrokerScope ? ' for this broker' : ''}.</p>
          {canEnable && (
            <button type="button" className="qiq-btn qiq-btn--primary" onClick={enable} disabled={busy} data-testid="enable-api-access-button">
              Enable API access
            </button>
          )}
        </div>
      )}

      {!loading && credential && (
        <div className="qiq-card" style={{ padding: 'var(--qiq-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
            <span>Client ID:</span>
            <code data-testid="api-client-id">{credential.clientId}</code>
            <StatusChip
              label={isActive ? 'Active' : 'Disabled'}
              category={isActive ? 'won' : 'expired'}
            />
          </div>

          {isActive && (
            <div style={{ display: 'flex', gap: 'var(--qiq-space-3)' }}>
              {canView && (
                <button type="button" className="qiq-btn" onClick={reveal} disabled={busy} data-testid="reveal-secret-button">
                  Reveal secret
                </button>
              )}
              {canRegenerate && (
                <button type="button" className="qiq-btn" onClick={() => setConfirmingRegenerate(true)} disabled={busy} data-testid="regenerate-button">
                  Regenerate secret
                </button>
              )}
              {canDisable && (
                <button type="button" className="qiq-btn qiq-btn--danger" onClick={() => setConfirmingDisable(true)} disabled={busy} data-testid="disable-api-access-button">
                  Disable
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {revealed && (
        <SecretRevealDialog clientId={revealed.clientId} secret={revealed.secret} onClose={() => setRevealed(null)} />
      )}

      <ConfirmDialog
        open={confirmingRegenerate}
        testId="regenerate-confirm-dialog"
        danger
        title="Regenerate secret"
        description="This immediately invalidates the current secret. Any integration using the old secret will stop working until updated with the new one."
        confirmLabel="Regenerate secret"
        busy={busy}
        onConfirm={regenerate}
        onCancel={() => setConfirmingRegenerate(false)}
      />

      <ConfirmDialog
        open={confirmingDisable}
        testId="disable-confirm-dialog"
        danger
        title="Disable API access"
        description="This blocks all API intake for this credential. It can be re-enabled later, which issues a new client and secret."
        confirmLabel="Disable API access"
        busy={busy}
        onConfirm={disable}
        onCancel={() => setConfirmingDisable(false)}
      />
    </div>
  );
}

export default ApiCredentialControls;
