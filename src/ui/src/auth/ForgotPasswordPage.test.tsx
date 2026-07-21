import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { requestPasswordReset, UNIFORM_RESET_CONFIRMATION } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  UNIFORM_RESET_CONFIRMATION: 'If an account exists for that email address, a password reset link is on its way.',
}));

vi.mock('./supabase', () => ({
  requestPasswordReset,
  UNIFORM_RESET_CONFIRMATION,
  SIGN_IN_ROUTE: '/sign-in',
}));

import ForgotPasswordPage from './ForgotPasswordPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestPasswordReset.mockResolvedValue(undefined);
  });

  it('render_WhenMounted_ShouldExposeAnEmailFieldAndSubmitControl', () => {
    // Arrange & Act
    renderPage();

    // Assert
    expect(screen.getByRole('heading', { name: /reset your password/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('type', 'email');
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeEnabled();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/sign-in');
  });

  it('submit_WhenEmailEntered_ShouldRequestAPasswordResetForThatAddress', async () => {
    // Arrange
    renderPage();

    // Act
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'seeded@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    // Assert
    await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledWith('seeded@example.test'));
  });

  it.each(['seeded@example.test', 'ghost@example.test'])(
    'submit_WhateverTheAccountExistence_ShouldShowTheSameUniformConfirmation (%s)',
    async (email) => {
      // Arrange — AC-032: uniform reset confirmation, no enumeration.
      renderPage();

      // Act
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

      // Assert
      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent(UNIFORM_RESET_CONFIRMATION);
    },
  );

  it('submit_WhenTheResetRequestRejects_ShouldStillShowTheSameUniformConfirmation', async () => {
    // Arrange — a provider-side failure must not become an existence oracle.
    requestPasswordReset.mockRejectedValue(new Error('rate limited'));
    renderPage();

    // Act
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ghost@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    // Assert
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(UNIFORM_RESET_CONFIRMATION);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('submit_WhenEmailEmpty_ShouldNotCallSupabase', async () => {
    // Arrange
    renderPage();

    // Act
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    // Assert
    await waitFor(() => expect(requestPasswordReset).not.toHaveBeenCalled());
  });
});
