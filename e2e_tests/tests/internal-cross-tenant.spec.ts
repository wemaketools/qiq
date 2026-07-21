import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginAsPersona, DEMO_TENANT_NAME, SECOND_TENANT_NAME } from '../helpers/personas';

/**
 * Internal cross-tenant oversight shell flow (spec AC-084, verification.json V-084, T-045), adapted
 * to the migrated Supabase-Auth demo seed (T-043). The Internal persona is
 * `internal.admin@quoteiq.local`: it holds the global grants (`global.view_any_tenant`, `tenants.*`)
 * that legitimately confer cross-tenant access, so it reaches Tenant Manager (never Forbidden), sees
 * every active tenant in the switcher, switches context across tenants, and keeps that context
 * across a full page reload (AuthProvider rehydration).
 *
 * The corrected AC-083 permission boundary is the counterpart, proven elsewhere against the same
 * seed: a pure tenant member (`rm.tebogo@quoteiq.local`, no tenant-management permissions) sees no
 * Tenant Manager nav and is Forbidden on the deep link (tenant-manager.spec.ts, AC-016), and every
 * pure tenant role crawls the app with zero >=400 responses (role-403-sweep.spec.ts). Only the
 * Internal persona holds cross-tenant access.
 *
 * SEED LIMITATION vs the .NET/Keycloak-era spec: the original probed a ZERO-membership Internal user
 * switching into a NON-member tenant ("The Brittany"). The migrated demo seed provisions no
 * memberless Internal persona and exactly two tenants, both of which `internal.admin` is a member of
 * (scripts/db/demo-data/catalog.ts), so the memberless / non-member nuance is not reproducible here;
 * the cross-tenant capability itself is fully exercised below. Restoring the memberless leg needs a
 * demo-seed extension (a zero-membership Internal user + a third tenant) — a T-041 follow-up.
 */
test.describe.configure({ mode: 'serial' });

/**
 * Records every app API (`/api/v1`) response with status >= 400. A clean run here is the load-bearing
 * AC-083 check: the Internal user's nav visibility and the backend authorization must agree, so no
 * screen it can reach may 403.
 */
function collectApiFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/v1') && response.status() >= 400) {
      failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}

test.describe('internal cross-tenant shell', () => {
  test('internal admin reaches Tenant Manager, sees every active tenant, switches context, and it survives a full reload (V-084)', async ({ page }) => {
    const apiFailures = collectApiFailures(page);

    await loginAsPersona(page, 'internal');

    // Global grants let the Internal user reach Tenant Manager via the nav, never the Forbidden page.
    await expect(page.getByTestId('sidebar-nav')).toBeVisible();
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);
    await page.getByTestId('nav-tenant-manager').click();
    await page.waitForURL((url) => url.pathname.startsWith('/admin/tenants'));
    await expect(page.getByTestId('tenant-list')).toBeVisible();

    // The all-tenants switcher (global.view_any_tenant) offers every active demo tenant. Removed
    // tenants are excluded by the switcher's `status === 'active'` filter (unit-covered).
    const switcher = page.getByTestId('tenant-switcher');
    await expect(switcher).toBeVisible();
    await expect(switcher.locator('select').locator(`option:has-text("${DEMO_TENANT_NAME}")`)).toHaveCount(1);
    await expect(switcher.locator('select').locator(`option:has-text("${SECOND_TENANT_NAME}")`)).toHaveCount(1);

    // Switch into the other tenant; the choice persists via PUT /me/preferences.
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      switcher.locator('select').selectOption({ label: SECOND_TENANT_NAME }),
    ]);
    await expect(page.getByTestId('active-tenant-name')).toContainText(SECOND_TENANT_NAME);
    await expect(page.getByTestId('nav-tenant-manager')).toBeVisible();
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);

    // Full page reload: AuthProvider must rehydrate the persisted cross-tenant selection rather than
    // dropping back to a Forbidden/empty state.
    await page.reload();
    await expect(page.getByTestId('sidebar-nav')).toBeVisible();
    await expect(page.getByTestId('active-tenant-name')).toContainText(SECOND_TENANT_NAME);
    await expect(page.getByTestId('nav-tenant-manager')).toBeVisible();
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);

    // Restore to the first tenant so later specs (and reruns) start from a known state.
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/me/preferences') && response.request().method() === 'PUT'),
      page.getByTestId('tenant-switcher').locator('select').selectOption({ label: DEMO_TENANT_NAME }),
    ]);

    expect(apiFailures, `Unexpected >=400 API responses during the internal cross-tenant flow:\n${apiFailures.join('\n')}`).toEqual([]);
  });
});
