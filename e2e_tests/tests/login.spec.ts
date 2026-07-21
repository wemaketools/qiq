import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';
import { PERSONAS } from '../helpers/personas';

/**
 * Login (spec FR-01/FR-02/FR-04, AC-001/AC-002/AC-032, verification.json V-001/V-002/V-004).
 *
 * Drives the REAL SPA `/sign-in` email/password form against local Supabase Auth (GoTrue) and the
 * running API's `GET /me` — not stubbed (P-01, Q-21). Requires the T-041 demo seed personas
 * (`npm run db:seed:demo`), signed in with the shared demo password.
 */
test.describe('login', () => {
  test('unauthenticated visit redirects to the sign-in form and no sign-up exists (V-001)', async ({ page }) => {
    await page.goto('/overview');

    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByTestId('sign-in-page')).toBeVisible();
    // Supabase Auth has self-service signup disabled; the SPA offers no registration link.
    await expect(page.getByRole('link', { name: /register|sign up|create account/i })).toHaveCount(0);
  });

  test('valid credentials land on the authenticated shell (V-004)', async ({ page }) => {
    await loginAs(page, PERSONAS.relationshipManager);

    await expect(page).not.toHaveURL(/\/sign-in/);
    await expect(page.getByTestId('app-shell')).toBeVisible();
  });

  test('wrong password and unknown email show the same generic error (V-002, AC-032)', async ({ page }) => {
    // Wrong password for a real account.
    await page.goto('/sign-in');
    await page.locator('#sign-in-email').fill(PERSONAS.relationshipManager);
    await page.locator('#sign-in-password').fill('definitely-wrong-password');
    await page.getByTestId('sign-in-submit').click();
    await expect(page.getByTestId('sign-in-error')).toBeVisible();
    const wrongPasswordError = (await page.getByTestId('sign-in-error').textContent())?.trim();

    // Unknown account.
    await page.goto('/sign-in');
    await page.locator('#sign-in-email').fill('nobody-e2e@quoteiq.local');
    await page.locator('#sign-in-password').fill('whatever123');
    await page.getByTestId('sign-in-submit').click();
    await expect(page.getByTestId('sign-in-error')).toBeVisible();
    const unknownEmailError = (await page.getByTestId('sign-in-error').textContent())?.trim();

    expect(wrongPasswordError).toBeTruthy();
    expect(wrongPasswordError).toBe(unknownEmailError);
  });
});
