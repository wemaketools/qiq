import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { completePasswordReset, GENERIC_RESET_FAILURE, SIGN_IN_ROUTE } from './supabase';

const PASSWORDS_DO_NOT_MATCH = 'The two passwords do not match.';

/**
 * `/reset-password` — the completion route GoTrue's recovery link returns to (it is the
 * `redirectTo` sent with `resetPasswordForEmail`, and matches the Auth redirect-URL allow list
 * configured in T-002). The Supabase client consumes the recovery token from the URL on load
 * (`detectSessionInUrl`), which is what authorises the `updateUser({ password })` call below.
 *
 * A successful reset leaves the user with an authenticated session, so the page continues into the
 * app rather than bouncing back through sign-in.
 */
function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (password === '' || submitting) {
      return;
    }
    if (password !== confirmation) {
      setError(PASSWORDS_DO_NOT_MATCH);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await completePasswordReset(password);
    if (result.ok) {
      navigate('/', { replace: true });
      return;
    }
    setSubmitting(false);
    setError(result.message || GENERIC_RESET_FAILURE);
  }

  return (
    <main className="qiq-auth-page" data-testid="reset-password-page">
      <div className="qiq-card qiq-auth-card">
        <h1 className="qiq-card-title">Choose a new password</h1>

        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          {error !== null && (
            <div role="alert" className="qiq-banner qiq-banner--error" data-testid="reset-password-error">
              {error}
            </div>
          )}

          <div className="qiq-field">
            <label htmlFor="reset-password-new">New password</label>
            <input
              id="reset-password-new"
              name="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <div className="qiq-field">
            <label htmlFor="reset-password-confirm">Confirm new password</label>
            <input
              id="reset-password-confirm"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>

          <button
            type="submit"
            className="qiq-btn qiq-btn--primary"
            disabled={submitting}
            data-testid="reset-password-submit"
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </form>

        <p className="qiq-card-sub">
          <Link to={SIGN_IN_ROUTE} className="qiq-card-link">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

export default ResetPasswordPage;
