import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { signInWithPassword, GENERIC_SIGN_IN_FAILURE, FORGOT_PASSWORD_ROUTE } from './supabase';

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (email.trim() === '' || password === '' || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await signInWithPassword(email.trim(), password);
    if (result.ok) {
      navigate(returnPath, { replace: true });
      return;
    }
    setSubmitting(false);
    setError(result.message || GENERIC_SIGN_IN_FAILURE);
  }

  return (
    <main className="qiq-auth-page" data-testid="sign-in-page">
      <div className="qiq-card qiq-auth-card">
        <h1 className="qiq-card-title">Sign in to QuoteIQ</h1>

        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          {error !== null && (
            <div role="alert" className="qiq-banner qiq-banner--error" data-testid="sign-in-error">
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
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <button type="submit" className="qiq-btn qiq-btn--primary" disabled={submitting} data-testid="sign-in-submit">
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="qiq-card-sub">
          <Link to={FORGOT_PASSWORD_ROUTE} className="qiq-card-link">
            Forgot your password?
          </Link>
        </p>
      </div>
    </main>
  );
}

export default SignInPage;
