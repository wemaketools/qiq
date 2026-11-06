/** DemoAccounts: the sign-in quick-pick listing the seeded demo personas. */
import { DEMO_IDENTITIES } from './demoAccountList';
import { CARD_PASSWORD } from './cardPassword';

export interface DemoAccountsProps {
  readonly onPick: (email: string) => void;
  readonly disabled?: boolean;
}

export default function DemoAccounts({ onPick, disabled = false }: DemoAccountsProps) {
  return (
    <section className="qiq-card qiq-demo-accounts" data-testid="demo-accounts">
      <h2 className="qiq-card-title">Demo accounts</h2>
      <p className="qiq-card-sub">
        Click a role to sign in. Demo password: <code>{CARD_PASSWORD}</code>
      </p>
      <ul className="qiq-demo-list">
        {DEMO_IDENTITIES.map((account) => (
          <li key={account.key}>
            <button
              type="button"
              className="qiq-demo-account"
              disabled={disabled}
              onClick={() => onPick(account.email)}
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
