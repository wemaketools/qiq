/**
 * DemoAccounts: the sign-in quick-pick of LOCAL DEVELOPMENT builds. Picking a persona signs in with the local
 * demo password. Loaded only behind `import.meta.env.DEV` (see SignInPage), so production builds do not contain
 * it; `scan-bundle` checks the marker.
 */
import { DEMO_ACCOUNTS_MARKER, DEMO_IDENTITIES, DEMO_PASSWORD } from './demoAccountList';

export interface DemoAccountsProps {
  readonly onPick: (email: string, password: string) => void;
  readonly disabled?: boolean;
}

export default function DemoAccounts({ onPick, disabled = false }: DemoAccountsProps) {
  return (
    <section
      className="qiq-card qiq-demo-accounts"
      data-marker={DEMO_ACCOUNTS_MARKER}
      data-testid="demo-accounts"
    >
      <h2 className="qiq-card-title">Demo accounts (local development only)</h2>
      <p className="qiq-card-sub">
        Click a role to sign in. Local password: <code>{DEMO_PASSWORD}</code>
      </p>
      <ul className="qiq-demo-list">
        {DEMO_IDENTITIES.map((account) => (
          <li key={account.key}>
            <button
              type="button"
              className="qiq-demo-account"
              disabled={disabled}
              onClick={() => onPick(account.email, DEMO_PASSWORD)}
            >
              {account.firstName} {account.lastName}
              <span className="qiq-demo-account-role">{account.roleLabel}</span>
              <span className="qiq-demo-account-role">{account.email}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
