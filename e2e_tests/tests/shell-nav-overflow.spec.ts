import { test, expect } from '@playwright/test';
import { loginAsPersona } from '../helpers/personas';

/**
 * Shell nav pointer-interception regression (T-052, finding F-043-4). At a standard 1280x720
 * viewport the full-nav Internal persona's sidebar legitimately fills/overflows the column. The
 * pre-fix layout let the overflowing nav content collide with the TenantSwitcher, which — as a
 * later DOM sibling with no bounded scroll region between them — painted on top and intercepted
 * pointer events, so a real click on the lowest nav links (User Manager, Tenant Manager) landed on
 * the switcher instead of the link.
 *
 * A plain `toBeVisible` check does NOT catch this: the element exists and is visible while an
 * overlay steals its click. The load-bearing assertions here are (1) the element at each nav link's
 * visual center IS the link (not the switcher/select), via `elementFromPoint`, and (2) a genuine
 * click actually navigates. Both must hold for the full nav length, for any tenant whose nav fills
 * the sidebar — the layout must bound the nav's own scroll region rather than rely on hiding items.
 */
test.describe.configure({ mode: 'serial' });

test.describe('shell nav is not click-stolen by the tenant switcher (F-043-4)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('real clicks on User Manager and Tenant Manager navigate for the full-nav Internal persona', async ({
    page,
  }) => {
    await loginAsPersona(page, 'internal');

    // The Internal admin legitimately sees every section, so the sidebar nav fills/overflows 720px
    // — the exact condition that exposed the interception.
    await expect(page.getByTestId('nav-user-manager')).toBeVisible();
    await expect(page.getByTestId('nav-tenant-manager')).toBeVisible();

    // Pointer-interception check: the element under each nav link's centre must be the link itself
    // (or a descendant like its icon/label), never the tenant switcher/select overlaying it.
    for (const testId of ['nav-user-manager', 'nav-tenant-manager']) {
      const link = page.getByTestId(testId);
      await link.scrollIntoViewIfNeeded();
      const ownsCentre = await link.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit !== null && (el === hit || el.contains(hit));
      });
      expect(
        ownsCentre,
        `the element at the centre of ${testId} should be the nav link, not an overlay (switcher)`,
      ).toBe(true);
    }

    // Genuine clicks must land on the links and navigate.
    await page.getByTestId('nav-user-manager').click();
    await expect(page).toHaveURL(/\/admin\/users$/);

    await page.getByTestId('nav-tenant-manager').click();
    await expect(page).toHaveURL(/\/admin\/tenants$/);
  });
});
