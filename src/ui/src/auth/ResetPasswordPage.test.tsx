import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { completePasswordReset, GENERIC_RESET_FAILURE } = vi.hoisted(() => ({
  completePasswordReset: vi.fn(),
  GENERIC_RESET_FAILURE: 'That reset link is no longer valid. Request a new one and try again.',
}));

vi.mock('./supabase', () => ({
  completePasswordReset,
  GENERIC_RESET_FAILURE,
  SIGN_IN_ROUTE: '/sign-in',
}));

import ResetPasswordPage from './ResetPasswordPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reset-password']}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/" element={<div data-testid="landed-root">root</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillPasswords(password: string, confirmation: string): void {
  fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: confirmation } });
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completePasswordReset.mockResolvedValue({ ok: true });
  });

  it('render_WhenMounted_ShouldExposeTwoPasswordFieldsAndSubmitControl', () => {
    // Arrange & Act
    renderPage();

    // Assert
    expect(screen.getByRole('heading', { name: /choose a new password/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^new password/i)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/confirm new password/i)).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: /update password/i })).toBeEnabled();
  });

  it('submit_WhenPasswordsMatch_ShouldCompleteTheResetWithTheNewPassword', async () => {
    // Arrange
    renderPage();

    // Act
    fillPasswords('brand-new-password', 'brand-new-password');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    // Assert
    await waitFor(() => expect(completePasswordReset).toHaveBeenCalledWith('brand-new-password'));
  });

  it('submit_WhenPasswordsDoNotMatch_ShouldShowAValidationAlertAndNotCallSupabase', async () => {
    // Arrange
    renderPage();

    // Act
    fillPasswords('brand-new-password', 'different-password');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(completePasswordReset).not.toHaveBeenCalled();
  });

  it('submit_WhenResetSucceeds_ShouldNavigateIntoTheApplication', async () => {
    // Arrange — completing a recovery leaves the user with an authenticated Supabase session.
    renderPage();

    // Act
    fillPasswords('brand-new-password', 'brand-new-password');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    // Assert
    expect(await screen.findByTestId('landed-root')).toBeInTheDocument();
  });

  it('submit_WhenResetFails_ShouldRenderTheGenericFailureMessage', async () => {
    // Arrange
    completePasswordReset.mockResolvedValue({ ok: false, message: GENERIC_RESET_FAILURE });
    renderPage();

    // Act
    fillPasswords('brand-new-password', 'brand-new-password');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_RESET_FAILURE);
  });
});
