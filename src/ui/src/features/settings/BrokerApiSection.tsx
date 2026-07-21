import ApiCredentialControls from './ApiCredentialControls';

interface BrokerApiSectionProps {
  brokerId: number;
}

/**
 * Broker-scoped API credential section (spec FR-25, AC-024, §12.6, T-030), embedded in the broker
 * view page. Provisions/reveals/regenerates/disables a credential whose broker the intake endpoint
 * FORCES onto every lead it creates (the unspoofable-broker rule), so this broker's partners can
 * submit leads that are always attributed to it. Shares every control with the tenant API-access tab
 * via `ApiCredentialControls`.
 */
function BrokerApiSection({ brokerId }: BrokerApiSectionProps) {
  return (
    <section data-testid="broker-api-section">
      <h3>API access</h3>
      <p>Issue a credential scoped to this broker. Leads submitted with it are always attributed to this broker.</p>
      <ApiCredentialControls brokerId={brokerId} testId="broker-api-credential" />
    </section>
  );
}

export default BrokerApiSection;
