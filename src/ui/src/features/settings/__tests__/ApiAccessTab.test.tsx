import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { sessionReducer, setSession } from '../../../app/slices/sessionSlice';
import ApiAccessTab from '../ApiAccessTab';
import {
  disableApiCredential,
  listApiCredentials,
  provisionTenantApiCredential,
  regenerateApiCredentialSecret,
  revealApiCredentialSecret,
  type ApiCredentialDto,
} from '../settingsApi';
import { ToastProvider } from '../../../components/common/Toast';

vi.mock('../settingsApi', async () => {
  const actual = await vi.importActual<typeof import('../settingsApi')>('../settingsApi');
  return {
    ...actual,
    listApiCredentials: vi.fn(),
    provisionTenantApiCredential: vi.fn(),
    revealApiCredentialSecret: vi.fn(),
    regenerateApiCredentialSecret: vi.fn(),
    disableApiCredential: vi.fn(),
  };
});

const activeCredential: ApiCredentialDto = {
  id: 5,
  brokerId: null,
  clientId: 'qiq-t1',
  status: 'active',
  createdAt: '2026-07-14T00:00:00Z',
  lastRotatedAt: null,
  disabledAt: null,
};

function renderTab(permissions: string[]) {
  const store = configureStore({ reducer: { session: sessionReducer } });
  store.dispatch(
    setSession({
      user: { userId: 1, email: 'admin@brittany.test', firstName: 'Admin', lastName: 'User' },
      memberships: [{ tenantId: 1, tenantName: 'Brittany Insurance', currencyCode: 'BWP', currencySymbol: 'BWP', permissions }],
      activeTenantId: 1,
      themePreference: 'light',
    }),
  );

  return render(
    <Provider store={store}>
      <ToastProvider>
        <ApiAccessTab />
      </ToastProvider>
    </Provider>,
  );
}

/**
 * API access tab (spec FR-25, AC-024, V-024, T-030): enable/reveal-once/regenerate/disable, all
 * permission-gated, with the secret shown only in the transient reveal dialog.
 */
describe('ApiAccessTab', () => {
  beforeEach(() => {
    vi.mocked(listApiCredentials).mockReset();
    vi.mocked(provisionTenantApiCredential).mockReset();
    vi.mocked(revealApiCredentialSecret).mockReset();
    vi.mocked(regenerateApiCredentialSecret).mockReset();
    vi.mocked(disableApiCredential).mockReset();
  });

  it('render_WhenNoCredentialAndCanEnable_ShouldProvisionAndRevealSecretOnce', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue({ credentials: [] });
    vi.mocked(provisionTenantApiCredential).mockResolvedValue({
      credential: activeCredential,
      clientId: 'qiq-t1',
      secret: 'super-secret-value',
    });

    renderTab(['api_access.view', 'api_access.enable']);

    const enable = await screen.findByTestId('enable-api-access-button');
    fireEvent.click(enable);

    expect(provisionTenantApiCredential).toHaveBeenCalled();
    expect(await screen.findByTestId('secret-reveal-dialog')).toBeInTheDocument();
    expect((screen.getByTestId('secret-value') as HTMLInputElement).value).toBe('super-secret-value');
  });

  it('render_WhenCredentialActive_ShouldShowClientIdAndRevealButton', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue({ credentials: [activeCredential] });
    vi.mocked(revealApiCredentialSecret).mockResolvedValue({
      credential: activeCredential,
      clientId: 'qiq-t1',
      secret: 'revealed-secret',
    });

    renderTab(['api_access.view', 'api_access.regenerate_secret']);

    expect(await screen.findByTestId('api-client-id')).toHaveTextContent('qiq-t1');
    fireEvent.click(screen.getByTestId('reveal-secret-button'));

    expect(revealApiCredentialSecret).toHaveBeenCalledWith(5);
    expect((await screen.findByTestId('secret-value') as HTMLInputElement).value).toBe('revealed-secret');
  });

  it('render_WhenLacksEnablePermission_ShouldHideEnableButton', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue({ credentials: [] });

    renderTab(['api_access.view']);

    await waitFor(() => expect(listApiCredentials).toHaveBeenCalled());
    expect(screen.queryByTestId('enable-api-access-button')).not.toBeInTheDocument();
  });

  it('regenerate_WhenConfirmed_ShouldRotateAndRevealNewSecret', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue({ credentials: [activeCredential] });
    vi.mocked(regenerateApiCredentialSecret).mockResolvedValue({
      credential: activeCredential,
      clientId: 'qiq-t1',
      secret: 'rotated-secret',
    });

    renderTab(['api_access.view', 'api_access.regenerate_secret']);

    fireEvent.click(await screen.findByTestId('regenerate-button'));
    // Danger confirm dialog appears; confirm it.
    const confirm = await screen.findByTestId('regenerate-confirm-dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Regenerate secret' }));

    expect(regenerateApiCredentialSecret).toHaveBeenCalledWith(5);
    expect((await screen.findByTestId('secret-value') as HTMLInputElement).value).toBe('rotated-secret');
  });
});
