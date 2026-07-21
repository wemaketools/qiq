import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = {
  getSession: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
};

const createClientMock = vi.fn(() => ({ auth: authMock }));

vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));

async function loadModule() {
  vi.resetModules();
  return import('./supabase');
}

describe('supabase browser auth module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-anon-key');
    authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    authMock.signOut.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('getSupabaseClient_WhenCalled_ShouldCreateClientFromViteUrlAndAnonKeyOnly', async () => {
    // Arrange
    const { getSupabaseClient } = await loadModule();

    // Act
    getSupabaseClient();

    // Assert
    expect(createClientMock).toHaveBeenCalledTimes(1);
    const [url, key] = createClientMock.mock.calls[0] as unknown as [string, string];
    expect(url).toBe('http://127.0.0.1:54321');
    expect(key).toBe('local-anon-key');
  });

  it('getSupabaseClient_WhenCalled_ShouldEnableSessionPersistenceAndAutomaticTokenRefresh', async () => {
    // Arrange — AC-033: reload keeps the session, refresh is client-managed (V-043).
    const { getSupabaseClient } = await loadModule();

    // Act
    getSupabaseClient();

    // Assert
    const options = (createClientMock.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];
    const auth = options['auth'] as Record<string, unknown>;
    expect(auth['persistSession']).toBe(true);
    expect(auth['autoRefreshToken']).toBe(true);
  });

  it('getSupabaseClient_WhenCalledTwice_ShouldReuseTheSingleBrowserClient', async () => {
    // Arrange
    const { getSupabaseClient } = await loadModule();

    // Act
    const first = getSupabaseClient();
    const second = getSupabaseClient();

    // Assert
    expect(second).toBe(first);
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('getSupabaseClient_WhenEnvVarsMissing_ShouldThrowNamingTheMissingVariable', async () => {
    // Arrange
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const { getSupabaseClient } = await loadModule();

    // Act & Assert
    expect(() => getSupabaseClient()).toThrow(/VITE_SUPABASE_ANON_KEY/);
  });

  it('getAccessToken_WhenSessionExists_ShouldReturnTheSupabaseAccessToken', async () => {
    // Arrange
    authMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-abc' } }, error: null });
    const { getAccessToken } = await loadModule();

    // Act
    const token = await getAccessToken();

    // Assert
    expect(token).toBe('jwt-abc');
  });

  it('getAccessToken_WhenCalledRepeatedly_ShouldReReadTheSessionEachTimeSoRefreshedTokensAreUsed', async () => {
    // Arrange — the interceptor must never cache a token at module init (refresh-safety).
    authMock.getSession
      .mockResolvedValueOnce({ data: { session: { access_token: 'old' } }, error: null })
      .mockResolvedValueOnce({ data: { session: { access_token: 'rotated' } }, error: null });
    const { getAccessToken } = await loadModule();

    // Act
    const first = await getAccessToken();
    const second = await getAccessToken();

    // Assert
    expect(first).toBe('old');
    expect(second).toBe('rotated');
    expect(authMock.getSession).toHaveBeenCalledTimes(2);
  });

  it('getAccessToken_WhenNoSession_ShouldReturnNull', async () => {
    // Arrange
    const { getAccessToken } = await loadModule();

    // Act & Assert
    await expect(getAccessToken()).resolves.toBeNull();
  });

  it('signInWithPassword_WhenCredentialsValid_ShouldReportSuccess', async () => {
    // Arrange
    authMock.signInWithPassword.mockResolvedValue({ data: { session: { access_token: 'jwt' } }, error: null });
    const { signInWithPassword } = await loadModule();

    // Act
    const result = await signInWithPassword('user@example.test', 'correct-horse');

    // Assert
    expect(result.ok).toBe(true);
    expect(authMock.signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.test',
      password: 'correct-horse',
    });
  });

  it('signInWithPassword_WhenWrongPasswordOrUnknownAccount_ShouldReturnTheSameGenericMessage', async () => {
    // Arrange — AC-032/V-042: no account enumeration.
    const { signInWithPassword, GENERIC_SIGN_IN_FAILURE } = await loadModule();

    authMock.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: 'Invalid login credentials' } });
    const wrongPassword = await signInWithPassword('seeded@example.test', 'nope');

    authMock.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: 'Email not confirmed' } });
    const unknownAccount = await signInWithPassword('ghost@example.test', 'nope');

    // Assert
    expect(wrongPassword).toEqual({ ok: false, message: GENERIC_SIGN_IN_FAILURE });
    expect(unknownAccount).toEqual({ ok: false, message: GENERIC_SIGN_IN_FAILURE });
    expect(GENERIC_SIGN_IN_FAILURE).not.toMatch(/password|account|email/i);
  });

  it('signInWithPassword_WhenTheCallThrows_ShouldStillReturnTheGenericMessage', async () => {
    // Arrange
    authMock.signInWithPassword.mockRejectedValue(new Error('network down'));
    const { signInWithPassword, GENERIC_SIGN_IN_FAILURE } = await loadModule();

    // Act
    const result = await signInWithPassword('user@example.test', 'pw');

    // Assert
    expect(result).toEqual({ ok: false, message: GENERIC_SIGN_IN_FAILURE });
  });

  it('requestPasswordReset_WhenCalled_ShouldPassTheResetCompletionRedirectUrl', async () => {
    // Arrange
    authMock.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const { requestPasswordReset, RESET_PASSWORD_ROUTE } = await loadModule();

    // Act
    await requestPasswordReset('user@example.test');

    // Assert
    expect(authMock.resetPasswordForEmail).toHaveBeenCalledWith('user@example.test', {
      redirectTo: `${window.location.origin}${RESET_PASSWORD_ROUTE}`,
    });
  });

  it('requestPasswordReset_WhenSupabaseReportsAnError_ShouldNotSurfaceItSoConfirmationStaysUniform', async () => {
    // Arrange — AC-032: identical confirmation whether or not the account exists.
    authMock.resetPasswordForEmail.mockResolvedValue({ data: null, error: { message: 'User not found' } });
    const { requestPasswordReset } = await loadModule();

    // Act & Assert
    await expect(requestPasswordReset('ghost@example.test')).resolves.toBeUndefined();
  });

  it('requestPasswordReset_WhenTheCallThrows_ShouldStillResolveSoConfirmationStaysUniform', async () => {
    // Arrange
    authMock.resetPasswordForEmail.mockRejectedValue(new Error('rate limited'));
    const { requestPasswordReset } = await loadModule();

    // Act & Assert
    await expect(requestPasswordReset('ghost@example.test')).resolves.toBeUndefined();
  });

  it('completePasswordReset_WhenUpdateSucceeds_ShouldReportSuccess', async () => {
    // Arrange
    authMock.updateUser.mockResolvedValue({ data: { user: {} }, error: null });
    const { completePasswordReset } = await loadModule();

    // Act
    const result = await completePasswordReset('new-password-123');

    // Assert
    expect(result.ok).toBe(true);
    expect(authMock.updateUser).toHaveBeenCalledWith({ password: 'new-password-123' });
  });

  it('completePasswordReset_WhenUpdateFails_ShouldReportFailureWithoutLeakingProviderDetail', async () => {
    // Arrange
    authMock.updateUser.mockResolvedValue({ data: { user: null }, error: { message: 'AuthApiError: token expired' } });
    const { completePasswordReset, GENERIC_RESET_FAILURE } = await loadModule();

    // Act
    const result = await completePasswordReset('new-password-123');

    // Assert
    expect(result).toEqual({ ok: false, message: GENERIC_RESET_FAILURE });
  });

  it('signOut_WhenCalled_ShouldEndTheSupabaseSessionAndSendTheBrowserToSignIn', async () => {
    // Arrange
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:5173', assign });
    const { signOut, SIGN_IN_ROUTE } = await loadModule();

    // Act
    await signOut();

    // Assert
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(SIGN_IN_ROUTE);
  });

  it('handleUnauthorized_WhenCalledConcurrently_ShouldOnlyRedirectOnce', async () => {
    // Arrange
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:5173', assign });
    const { handleUnauthorized } = await loadModule();

    // Act
    await Promise.all([handleUnauthorized(), handleUnauthorized(), handleUnauthorized()]);

    // Assert
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('onAuthStateChange_WhenSubscribed_ShouldReturnAnUnsubscribeFunction', async () => {
    // Arrange
    const unsubscribe = vi.fn();
    authMock.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
    const { onAuthStateChange } = await loadModule();

    // Act
    const dispose = onAuthStateChange(() => undefined);
    dispose();

    // Assert
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
