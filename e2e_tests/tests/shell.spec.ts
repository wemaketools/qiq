import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';
import { loginAsPersona, PERSONAS, DEMO_TENANT_NAME, SECOND_TENANT_NAME } from '../helpers/personas';

/**
 * Application shell (spec FR-10/FR-52, NFR-04, A-3, AC-009/AC-051/AC-070/AC-074, verification.json
 * V-009/V-051/V-070/V-074). Real flows against local Supabase Auth + the running API, over the
 * T-041 demo personas (`npm run db:seed:demo`).
 *
 * Persona mapping notes (migrated demo seed):
 *   - full standard nav + no admin nav: the Sales Manager (`salesHead`) — its bundle holds all five
 *     dashboards + leads/quotes/parties/brokers/reports/alerts but no Settings/User/Tenant admin.
 *   - single-tenant (no switcher): a Relationship Manager (single membership).
 *   - multi-tenant switcher: the Internal admin (member of both demo tenants + global grants).
 *
 * SEED LIMITATION: both demo tenants use currency BWP (scripts/db/demo-data/catalog.ts), so the
 * .NET-era ZAR display-currency assertions (AC-074, F-046) have no non-BWP tenant to land on. Those
 * are skipped with an explicit reason rather than faked; adding a non-BWP demo tenant would restore
 * them (same seed-gap convention tenant-isolation.spec.ts documents).
 */
// Serial: several specs mutate shared per-user preference state (last_tenant_id, theme_preference)
// via PUT /me/preferences, so they must not run concurrently against the same seeded accounts.
test.describe.configure({ mode: 'serial' });

test.describe('shell', () => {
  test('sidebar, top bar, user card, and footer render per PRD 12.2, and admin nav is hidden without permission (V-051)', async ({ page }) => {
    await loginAsPersona(page, 'salesHead');

    await expect(page.getByTestId('sidebar-nav')).toBeVisible();
    for (const testId of ['nav-overview', 'nav-leads', 'nav-parties', 'nav-pipeline', 'nav-brokers', 'nav-rm-performance', 'nav-loss-analysis', 'nav-alerts', 'nav-reports']) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    // Admin sections are permission-bound (AC-016): entries the role cannot use are absent, not
    // disabled. The Sales Manager holds no users.view / tenants.view, so User Manager and Tenant
    // Manager must be absent. Settings IS visible because the sales_manager bundle holds brokers.view
    // (a SETTINGS_PERMISSION_CODES member), which legitimately opens the Settings > Brokers
    // subsection — exactly the per-subsection permission-binding V-051 describes.
    await expect(page.getByTestId('nav-settings')).toBeVisible();
    await expect(page.getByTestId('nav-user-manager')).toHaveCount(0);
    await expect(page.getByTestId('nav-tenant-manager')).toHaveCount(0);

    await expect(page.getByTestId('topbar')).toBeVisible();
    await expect(page.getByTestId('global-search-input')).toBeVisible();
    await expect(page.getByTestId('notification-bell')).toBeVisible();
    await expect(page.getByTestId('help-button')).toBeVisible();
    await expect(page.getByTestId('new-lead-button')).toBeVisible();

    await expect(page.getByTestId('footer-currency')).toContainText('BWP');
    await expect(page.getByTestId('footer-data-timestamp')).toBeVisible();
    await expect(page.getByTestId('footer-refresh')).toBeVisible();

    await page.getByTestId('user-card').getByRole('button').first().click();
    await expect(page.getByTestId('user-card-menu')).toBeVisible();
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await expect(page.getByTestId('sign-out-button')).toBeVisible();
  });

  test.skip('non-admin member of a non-BWP tenant sees the tenant\'s real display currency (AC-074, F-046)', async () => {
    // SEED GAP: both demo tenants are BWP, so there is no non-BWP, non-admin persona to prove the
    // footer reads the true (non-default) display currency from GET /me. Restore once the demo seed
    // adds a non-BWP tenant with a member lacking business_rules.view.
  });

  test('single-tenant user sees no tenant switcher (V-009)', async ({ page }) => {
    await loginAsPersona(page, 'relationshipManager');
    await expect(page.getByTestId('tenant-switcher')).toHaveCount(0);
  });

  test('tenant switcher swaps context and keeps the active tenant visible (V-009)', async ({ page }) => {
    await loginAsPersona(page, 'internal');

    await expect(page.getByTestId('tenant-switcher')).toBeVisible();
    await expect(page.getByTestId('active-tenant-name')).toContainText(DEMO_TENANT_NAME);
    // Both demo tenants are BWP, so the footer currency stays BWP across the switch (the
    // currency-CHANGES-on-switch assertion needs a non-BWP tenant — see the skipped test above).
    await expect(page.getByTestId('footer-currency')).toContainText('BWP');

    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      page.getByTestId('tenant-switcher').locator('select').selectOption({ label: SECOND_TENANT_NAME }),
    ]);
    await expect(page.getByTestId('active-tenant-name')).toContainText(SECOND_TENANT_NAME);

    // Restore to the first tenant so later tests (and reruns) start from a known state.
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      page.getByTestId('tenant-switcher').locator('select').selectOption({ label: DEMO_TENANT_NAME }),
    ]);
  });

  test('login lands on the last active tenant and the preference persists across re-login (V-004)', async ({ page }) => {
    await loginAs(page, PERSONAS.internal);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      page.getByTestId('tenant-switcher').locator('select').selectOption({ label: SECOND_TENANT_NAME }),
    ]);
    await expect(page.getByTestId('active-tenant-name')).toContainText(SECOND_TENANT_NAME);

    await page.getByTestId('user-card').getByRole('button').first().click();
    await page.getByTestId('sign-out-button').click();
    await expect(page).toHaveURL(/\/sign-in$/);

    await loginAs(page, PERSONAS.internal);
    await expect(page.getByTestId('active-tenant-name')).toContainText(SECOND_TENANT_NAME);

    // Restore to the first tenant so other tests (and reruns) start from a known state.
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      page.getByTestId('tenant-switcher').locator('select').selectOption({ label: DEMO_TENANT_NAME }),
    ]);
  });

  test('theme toggle switches tokens and persists across reload (V-070)', async ({ page }) => {
    await loginAsPersona(page, 'relationshipManager');

    // The seeded preference may be 'system'; the intent of V-070 is that TOGGLING sets an explicit
    // theme, changes the applied tokens, and survives a reload — not a specific starting value.
    const initial = await page.locator('html').getAttribute('data-theme');

    await page.getByTestId('user-card').getByRole('button').first().click();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      page.getByTestId('theme-toggle').click(),
    ]);
    const toggled = await page.locator('html').getAttribute('data-theme');
    expect(toggled).not.toBe(initial);
    expect(['light', 'dark']).toContain(toggled);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', toggled ?? '');

    // Toggle again so reruns start from a comparable state.
    await page.getByTestId('user-card').getByRole('button').first().click();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      page.getByTestId('theme-toggle').click(),
    ]);
  });
});
