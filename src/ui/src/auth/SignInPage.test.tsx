import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { signInWithPassword, GENERIC_SIGN_IN_FAILURE } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  GENERIC_SIGN_IN_FAILURE: 'Sign-in failed. Check your details and try again.',
}));

vi.mock('./supabase', () => ({
  signInWithPassword,
  GENERIC_SIGN_IN_FAILURE,
  FORGOT_PASSWORD_ROUTE: '/forgot-password',
}));

import SignInPage from './SignInPage';

function renderSignIn() {
  return render(
    <MemoryRouter initialEntries={['/sign-in']}>
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/" element={<div data-testid="landed-root">root</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillCredentials(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
}

describe('SignInPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInWithPassword.mockResolvedValue({ ok: true });
  });

  it('render_WhenMounted_ShouldExposeAccessibleEmailPasswordAndSubmitControls', () => {
    // Arrange & Act
    renderSignIn();

    // Assert
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText(/password/i)).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
    expect(screen.getByRole('link', { name: /forgot your password/i })).toHaveAttribute('href', '/forgot-password');
  });

  it('submit_WhenCredentialsEntered_ShouldCallSignInWithPasswordWithThoseCredentials', async () => {
    // Arrange
    renderSignIn();

    // Act
    fillCredentials('seeded@example.test', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith('seeded@example.test', 'correct-horse'));
  });

  it('submit_WhileRequestInFlight_ShouldDisableTheSubmitButtonAndShowProgress', async () => {
    // Arrange
    let resolveSignIn: (value: { ok: boolean }) => void = () => undefined;
    signInWithPassword.mockReturnValue(
      new Promise<{ ok: boolean }>((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    renderSignIn();

    // Act
    fillCredentials('seeded@example.test', 'pw');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    await waitFor(() => expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled());
    resolveSignIn({ ok: true });
  });

  it('submit_WhenSignInFails_ShouldRenderTheGenericFailureMessageInAnAlert', async () => {
    // Arrange — AC-032: identical message for wrong password and unknown account.
    signInWithPassword.mockResolvedValue({ ok: false, message: GENERIC_SIGN_IN_FAILURE });
    renderSignIn();

    // Act
    fillCredentials('ghost@example.test', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(GENERIC_SIGN_IN_FAILURE);
    expect(alert.textContent).not.toMatch(/no such user|not found|incorrect password/i);
  });

  it('submit_WhenSignInFailsThenSucceeds_ShouldClearThePreviousFailureMessage', async () => {
    // Arrange
    signInWithPassword.mockResolvedValueOnce({ ok: false, message: GENERIC_SIGN_IN_FAILURE });
    renderSignIn();
    fillCredentials('seeded@example.test', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByRole('alert');

    // Act
    signInWithPassword.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('submit_WhenSignInSucceeds_ShouldNavigateToTheApplicationRoot', async () => {
    // Arrange
    renderSignIn();

    // Act
    fillCredentials('seeded@example.test', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert — the index route resolves the caller's last active tenant landing (DefaultLanding).
    expect(await screen.findByTestId('landed-root')).toBeInTheDocument();
  });

  it('submit_WhenRedirectedFromAProtectedRoute_ShouldReturnToThatRouteAfterSignIn', async () => {
    // Arrange
    render(
      <MemoryRouter initialEntries={[{ pathname: '/sign-in', state: { from: '/leads' } }]}>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/leads" element={<div data-testid="landed-leads">leads</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Act
    fillCredentials('seeded@example.test', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    expect(await screen.findByTestId('landed-leads')).toBeInTheDocument();
  });

  it('submit_WhenEmailOrPasswordEmpty_ShouldNotCallSupabase', async () => {
    // Arrange
    renderSignIn();

    // Act
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    await waitFor(() => expect(signInWithPassword).not.toHaveBeenCalled());
  });
});
