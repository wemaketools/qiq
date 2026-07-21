import { test, expect } from '@playwright/test';

/**
 * Basic dev-server smoke check. The app is gated behind authentication (spec FR-01, AC-001), so an
 * unauthenticated visit redirects to the SPA-rendered `/sign-in` form (Supabase Auth, P-01) —
 * full auth-flow coverage lives in tests/login.spec.ts.
 */
test.describe('smoke', () => {
  test('dev server serves the SPA and redirects unauthenticated visitors to sign-in', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByTestId('sign-in-page')).toBeVisible();
    await expect(page).toHaveTitle(/QuoteIQ/);
  });
});
