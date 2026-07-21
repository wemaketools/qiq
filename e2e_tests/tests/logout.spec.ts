import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';
import { PERSONAS } from '../helpers/personas';

/**
 * Sign-out and unauthenticated deep links (spec FR-01, AC-001, verification.json V-001). Real flow
 * against local Supabase Auth; requires the demo-seed personas (`npm run db:seed:demo`).
 */
test.describe('logout', () => {
  test('sign-out returns to the sign-in form', async ({ page }) => {
    await loginAs(page, PERSONAS.relationshipManager);
    await expect(page.getByTestId('app-shell')).toBeVisible();

    await page.getByTestId('user-card').getByRole('button').first().click();
    await page.getByTestId('sign-out-button').click();

    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByTestId('sign-in-page')).toBeVisible();
  });

  test('deep link while unauthenticated redirects to sign-in', async ({ page }) => {
    await page.goto('/leads');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByTestId('sign-in-page')).toBeVisible();
  });
});
