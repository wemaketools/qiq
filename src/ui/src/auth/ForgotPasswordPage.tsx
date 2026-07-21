import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset, UNIFORM_RESET_CONFIRMATION, SIGN_IN_ROUTE } from './supabase';

/**
 * `/forgot-password` — anonymous reset request via Supabase Auth `resetPasswordForEmail` (P-01).
 * The confirmation is uniform whether or not the address belongs to an account, and is also shown
 * when the underlying call fails, so nothing about the outcome is observable (AC-032).
 */
function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (email.trim() === '' || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
    } catch {
      // Never surfaced: a provider failure must not become an account-existence oracle.
    }
    setSubmitting(false);
    setSubmitted(true);
  }

  return (
    <main className="qiq-auth-page" data-testid="forgot-password-page">
      <div className="qiq-card qiq-auth-card">
        <h1 className="qiq-card-title">Reset your password</h1>

        {submitted ? (
          <p role="status" aria-live="polite" className="qiq-banner" data-testid="reset-confirmation">
            {UNIFORM_RESET_CONFIRMATION}
          </p>
        ) : (
          <form onSubmit={(event) => void handleSubmit(event)} noValidate>
            <div className="qiq-field">
              <label htmlFor="forgot-password-email">Email address</label>
              <input
                id="forgot-password-email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <button
              type="submit"
              className="qiq-btn qiq-btn--primary"
              disabled={submitting}
              data-testid="reset-request-submit"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="qiq-card-sub">
          <Link to={SIGN_IN_ROUTE} className="qiq-card-link">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

export default ForgotPasswordPage;
