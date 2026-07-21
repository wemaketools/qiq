import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * API access credential lifecycle (spec FR-25, AC-024, V-024, T-030) driven through the real Settings
 * API-access tab against the migrated first-party API-key backend (src/server/domains/api-access;
 * Keycloak is gone). Ensures the tenant credential is enabled, that the client id shows in the
 * migrated `qiq_<hex>` format, and that regenerate — behind a danger confirmation — reveals a new
 * secret that differs from the previous one.
 *
 * MIGRATED-CONTRACT NOTE: the secret is hashed at rest (HMAC, src/server/domains/api-access/keys.ts)
 * and RevealSecret is a deliberate 410 (reveal-once issuance) — a stored secret is NEVER retrievable
 * again; a fresh plaintext is only produced by provision (Enable) and regenerate. The test therefore
 * obtains its "before" secret from a rotation, not a reveal, so it is deterministic and re-runnable
 * whether or not a prior run already provisioned the credential (the UI never re-shows Enable, and
 * disabling does not delete the row: src/ui/src/features/settings/ApiCredentialControls.tsx).
 */
test.describe('settings > API access (V-024)', () => {
  test('enable tenant API access, then regenerate behind a danger confirm reveals a new secret once', async ({ page }) => {
    await loginAs(page, 'pilot.admin@quoteiq.local');

    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-api-access').click();
    await expect(page.getByTestId('api-access-tab')).toBeVisible();

    // Ensure a credential exists. On a fresh DB, Enable provisions it and reveals the secret once
    // (the V-024 enable path); on a re-run the credential already exists and Enable is not shown.
    const enableButton = page.getByTestId('enable-api-access-button');
    await expect(enableButton.or(page.getByTestId('api-client-id'))).toBeVisible();
    if (await enableButton.isVisible()) {
      await enableButton.click();
      const provisionDialog = page.getByTestId('secret-reveal-dialog');
      await expect(provisionDialog).toBeVisible();
      const provisioned = await provisionDialog.getByTestId('secret-value').inputValue();
      expect(provisioned.length).toBeGreaterThan(0);
      await provisionDialog.getByTestId('copy-secret-button').click();
      await provisionDialog.getByRole('button', { name: 'Done' }).click();
      await expect(page.getByTestId('secret-reveal-dialog')).toHaveCount(0);
    }

    // The client id is displayed in the migrated qiq_<hex> format (T-022).
    await expect(page.getByTestId('api-client-id')).toContainText('qiq_');

    // Two danger-confirmed rotations: each reveals a fresh secret exactly once, and the second must
    // differ from the first — proving regenerate actually rotates the stored secret.
    const firstSecret = await regenerateAndReadSecret(page);
    const rotatedSecret = await regenerateAndReadSecret(page);
    expect(rotatedSecret).not.toBe(firstSecret);
  });

  test.fixme('a broker view page provisions a broker-scoped credential', async ({ page }) => {
    // STILL BLOCKED (not a seed gap): awaits the dedicated broker view page that embeds
    // BrokerApiSection (data-testid broker-api-section) with the same enable/reveal/regenerate
    // controls scoped to one broker — that page is not yet built.
    await loginAs(page, 'pilot.admin@quoteiq.local');
    await expect(page.getByTestId('broker-api-section')).toBeVisible();
  });
});

/**
 * Rotates the tenant secret behind the danger confirmation and returns the freshly revealed value,
 * closing the reveal-once dialog afterwards.
 */
async function regenerateAndReadSecret(page: Page): Promise<string> {
  await page.getByTestId('regenerate-button').click();
  const confirm = page.getByTestId('regenerate-confirm-dialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Regenerate secret' }).click();

  const dialog = page.getByTestId('secret-reveal-dialog');
  await expect(dialog).toBeVisible();
  const secret = await dialog.getByTestId('secret-value').inputValue();
  expect(secret.length).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('secret-reveal-dialog')).toHaveCount(0);
  return secret;
}
