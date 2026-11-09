import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import DemoAccounts from './DemoAccounts';
import {
  signInAsDemoPersona,
  signInWithPassword,
  GENERIC_SIGN_IN_FAILURE,
  FORGOT_PASSWORD_ROUTE,
} from './supabase';

const DEMO_SIGN_IN_UNAVAILABLE =
  'One-click demo sign-in is not available here. The email is filled in; enter the demo password.';

interface SignInLocationState {
  from?: string;
}

/**
 * `/sign-in` — the one accepted login-surface change of this migration (P-01): an SPA-rendered
 * email/password form against Supabase Auth, replacing the Keycloak-hosted themed pages. Styling
 * stays inside the existing design-system layer (`theme/components.css`); no visual redesign.
 *
 * Every failure renders the same message (AC-032) — the page never learns, and therefore never
 * leaks, whether the address belongs to an account.
 *
 * On success it navigates to the app root, whose index route (`DefaultLanding`) resolves the
 * caller's remembered last active tenant and first permitted landing page (FR-04) — or back to the
 * protected route the user was originally trying to reach.
 */
function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const returnPath = (location.state as SignInLocationState | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await signIn(email, password);
  }

  async function signIn(address: string, secret: string): Promise<void> {
    if (address.trim() === '' || secret === '' || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await signInWithPassword(address.trim(), secret);
    if (result.ok) {
      navigate(returnPath, { replace: true });
      return;
    }
    setSubmitting(false);
    setError(result.message || GENERIC_SIGN_IN_FAILURE);
  }

  /**
   * The server signs the persona in, so the browser never holds the demo password. If it will not
   * (not configured here, or the persona is not available), the email is filled in and the password
   * field focused, with a notice, so the click never fails silently.
   */
  async function signInAsDemo(demoEmail: string): Promise<void> {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setEmail(demoEmail);
    setPassword('');
    const result = await signInAsDemoPersona(demoEmail);
    if (result.ok) {
      navigate(returnPath, { replace: true });
      return;
    }
    setSubmitting(false);
    setError(DEMO_SIGN_IN_UNAVAILABLE);
    passwordRef.current?.focus();
  }

  return (
    <main className="qiq-auth-page" data-testid="sign-in-page">
      <div className="qiq-auth-stack">
        <div className="qiq-card qiq-auth-card">
          <h1 className="qiq-card-title">Sign in to QuoteIQ</h1>

          <form onSubmit={(event) => void handleSubmit(event)} noValidate>
            {error !== null && (
              <div
                role="alert"
                className="qiq-banner qiq-banner--error"
                data-testid="sign-in-error"
              >
                {error}
              </div>
            )}

            <div className="qiq-field">
              <label htmlFor="sign-in-email">Email address</label>
              <input
                id="sign-in-email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="qiq-field">
              <label htmlFor="sign-in-password">Password</label>
              <input
                id="sign-in-password"
                ref={passwordRef}
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <button
              type="submit"
              className="qiq-btn qiq-btn--primary"
              disabled={submitting}
              data-testid="sign-in-submit"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="qiq-card-sub">
            <Link to={FORGOT_PASSWORD_ROUTE} className="qiq-card-link">
              Forgot your password?
            </Link>
          </p>
        </div>
        <DemoAccounts
          disabled={submitting}
          onPick={(pickedEmail) => void signInAsDemo(pickedEmail)}
        />
      </div>
    </main>
  );
}

export default SignInPage;
