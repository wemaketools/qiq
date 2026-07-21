import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/supabase', () => ({
  getAccessToken: vi.fn().mockResolvedValue('test-access-token'),
  handleUnauthorized: vi.fn().mockResolvedValue(undefined),
}));

import { apiGet, apiPost } from './client';
import { store } from '../app/store';
import { setActiveTenant, clearSession } from '../app/slices/sessionSlice';
import { getAccessToken, handleUnauthorized } from '../auth/supabase';

function mockFetchOnce(response: Partial<Response> & { jsonBody?: unknown }): void {
  const { jsonBody, ...rest } = response;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: rest.ok ?? true,
      status: rest.status ?? 200,
      statusText: rest.statusText ?? 'OK',
      text: vi.fn().mockResolvedValue(jsonBody !== undefined ? JSON.stringify(jsonBody) : ''),
      json: vi.fn().mockResolvedValue(jsonBody),
    } as unknown as Response),
  );
}

describe('apiClient', () => {
  beforeEach(() => {
    store.dispatch(clearSession());
    vi.mocked(getAccessToken).mockReset();
    vi.mocked(getAccessToken).mockResolvedValue('test-access-token');
    vi.mocked(handleUnauthorized).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('apiGet_WhenActiveTenantSetAndPathNotExempt_ShouldAttachXTenantIdHeader', async () => {
    // Arrange
    store.dispatch(setActiveTenant(7));
    mockFetchOnce({ jsonBody: { ok: true } });

    // Act
    await apiGet('/leads');

    // Assert
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Tenant-Id']).toBe('7');
  });

  it.each(['/me', '/me/preferences', '/tenants', '/tenants/1', '/global/default-reference-items'])(
    'apiGet_WhenPathIsTenantExempt_ShouldNotAttachXTenantIdHeader (%s)',
    async (path) => {
      // Arrange
      store.dispatch(setActiveTenant(7));
      mockFetchOnce({ jsonBody: { ok: true } });

      // Act
      await apiGet(path);

      // Assert
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-Tenant-Id']).toBeUndefined();
    },
  );

  it('apiGet_WhenSupabaseSessionHasAccessToken_ShouldAttachItAsTheBearerToken', async () => {
    // Arrange — AC-033: the Supabase access token is the bearer token on every /api/v1 call.
    vi.mocked(getAccessToken).mockResolvedValue('supabase-jwt-value');
    mockFetchOnce({ jsonBody: { ok: true } });

    // Act
    await apiGet('/leads');

    // Assert
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer supabase-jwt-value');
  });

  it('apiGet_WhenTokenRotatesBetweenCalls_ShouldSendTheCurrentTokenNotACachedOne', async () => {
    // Arrange — refresh-safety: the token is read per request, never captured at module init.
    vi.mocked(getAccessToken).mockResolvedValueOnce('token-before-refresh');
    mockFetchOnce({ jsonBody: { ok: true } });
    await apiGet('/leads');
    const firstAuth = ((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1];

    vi.mocked(getAccessToken).mockResolvedValueOnce('token-after-refresh');
    mockFetchOnce({ jsonBody: { ok: true } });

    // Act
    await apiGet('/leads');

    // Assert
    const secondAuth = ((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1];
    expect((firstAuth.headers as Record<string, string>)['Authorization']).toBe('Bearer token-before-refresh');
    expect((secondAuth.headers as Record<string, string>)['Authorization']).toBe('Bearer token-after-refresh');
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('apiGet_WhenNoSupabaseSession_ShouldOmitTheAuthorizationHeaderEntirely', async () => {
    // Arrange
    vi.mocked(getAccessToken).mockResolvedValue(null);
    mockFetchOnce({ jsonBody: { ok: true } });

    // Act
    await apiGet('/leads');

    // Assert
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('apiPost_WhenServerReturnsProblemJsonWithErrorsArray_ShouldNormalizeIntoFieldErrors', async () => {
    // Arrange — F-043-1. The real backend contract (src/server/lib/errors/problem.ts,
    // `errors?: readonly FieldError[]` where FieldError is {field, code, message}) is an ARRAY.
    // The SPA previously parsed `errors` as a Record<string, string[]> dictionary, so
    // `Object.entries(...).flatMap(([field, messages]) => messages.map(...))` threw
    // "messages.map is not a function" *before* `detail` was ever read — the whole error
    // normalization blew up rather than degrading. This is the shape a 422 actually has.
    mockFetchOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      jsonBody: {
        type: 'https://tools.ietf.org/html/rfc4918#section-11.2',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'VALIDATION_FAILED: Name is required; Email is invalid',
        code: 'VALIDATION_FAILED',
        errors: [
          { field: 'name', code: 'REQUIRED', message: 'Name is required' },
          { field: 'email', code: 'INVALID_FORMAT', message: 'Email is invalid' },
        ],
        correlationId: '018f-corr-id',
      },
    });

    // Act & Assert
    await expect(apiPost('/parties', {})).rejects.toMatchObject({
      status: 422,
      title: 'VALIDATION_FAILED: Name is required; Email is invalid',
      fieldErrors: [
        { field: 'name', message: 'Name is required' },
        { field: 'email', message: 'Email is invalid' },
      ],
    });
  });

  it('apiPost_WhenProblemJsonErrorsArrayPresent_ShouldRejectWithNormalizedErrorNotATypeError', async () => {
    // Arrange — the specific failure mode of the old dictionary parser: a TypeError escaping
    // `toNormalizedError` instead of the NormalizedError every call site catches.
    mockFetchOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      jsonBody: {
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'VALIDATION_FAILED: Name is required',
        errors: [{ field: 'name', code: 'REQUIRED', message: 'Name is required' }],
        correlationId: 'c-1',
      },
    });

    // Act
    const rejection: unknown = await apiPost('/parties', {}).catch((error: unknown) => error);

    // Assert
    expect(rejection).not.toBeInstanceOf(TypeError);
    expect(rejection).toMatchObject({ status: 422, fieldErrors: [{ field: 'name', message: 'Name is required' }] });
  });

  it('apiPost_WhenProblemJsonErrorsIsMalformed_ShouldStillRejectWithAUsableTitleAndNoFieldErrors', async () => {
    // Arrange — error normalization must never itself throw, whatever the payload looks like.
    mockFetchOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      jsonBody: { status: 422, title: 'Unprocessable Entity', detail: 'Something failed', errors: { name: ['nope'] } },
    });

    // Act & Assert
    await expect(apiPost('/parties', {})).rejects.toMatchObject({
      status: 422,
      title: 'Something failed',
      fieldErrors: [],
    });
  });

  it('apiPost_WhenResponseBodyIsNotJson_ShouldStillRejectWithANormalizedError', async () => {
    // Arrange
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: vi.fn().mockResolvedValue('<html>gateway</html>'),
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
      } as unknown as Response),
    );

    // Act & Assert
    await expect(apiPost('/parties', {})).rejects.toMatchObject({
      status: 502,
      title: 'Bad Gateway',
      fieldErrors: [],
    });
  });

  it('apiPost_WhenServerReturnsProblemDetailsWithoutFieldErrors_ShouldNormalizeWithEmptyFieldErrorsArray', async () => {
    // Arrange
    mockFetchOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      jsonBody: { status: 404, title: 'Not Found', detail: 'Tenant does not exist.' },
    });

    // Act & Assert
    await expect(apiGet('/tenants/999')).rejects.toMatchObject({
      status: 404,
      title: 'Tenant does not exist.',
      fieldErrors: [],
    });
  });

  it('apiPost_WhenServerReturnsExtraOkStatusWithJsonBody_ShouldResolveWithBodyInsteadOfThrowing', async () => {
    // Arrange
    mockFetchOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      jsonBody: { lead: null, warnings: [{ code: 'DUPLICATE_LEAD', details: { duplicates: [] } }], requiresConfirmation: true },
    });

    // Act
    const result = await apiPost('/leads', {}, [409]);

    // Assert
    expect(result).toMatchObject({ requiresConfirmation: true });
  });

  it('apiPost_WhenServerReturnsNonListedStatus_ShouldStillThrowNormalizedError', async () => {
    // Arrange
    mockFetchOnce({ ok: false, status: 500, statusText: 'Internal Server Error', jsonBody: { status: 500, title: 'Server error' } });

    // Act & Assert
    await expect(apiPost('/leads', {}, [409])).rejects.toMatchObject({ status: 500 });
  });

  it('apiGet_WhenServerReturns401_ShouldTriggerTheSupabaseReAuthFlow', async () => {
    // Arrange
    mockFetchOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      jsonBody: { status: 401, title: 'Unauthorized', detail: 'No active user.', correlationId: 'c-2' },
    });

    // Act
    await expect(apiGet('/leads')).rejects.toMatchObject({ status: 401 });

    // Assert
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
  });
});
