import ApiCredentialControls from './ApiCredentialControls';

/**
 * Settings API-access tab (spec FR-25, AC-024, V-024, §12.6, T-030): manages the tenant-scoped API
 * intake credential — enable/disable, client-id display, reveal-once secret dialog with copy, and
 * danger-confirmed regenerate. Broker-scoped credentials are managed on the broker view page via
 * `BrokerApiSection`.
 */
function ApiAccessTab() {
  return (
    <div data-testid="api-access-tab">
      <div style={{ marginBottom: 'var(--qiq-space-4)' }}>
        <div className="qiq-page-head" style={{ marginBottom: 'var(--qiq-space-2)' }}>
          <h2>API access</h2>
        </div>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--qiq-text-secondary)' }}>
          Issue OAuth client-credentials so external systems can submit leads to this tenant over the REST intake API.
        </p>
      </div>

      <ApiCredentialControls testId="tenant-api-credential" />
    </div>
  );
}

export default ApiAccessTab;
