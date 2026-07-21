import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginAs } from '../helpers/auth';

/**
 * Design-system visual fidelity smoke (AC-082/V-082, T-043, docs/ui-remediation/plan.md).
 *
 * Computed-style assertions — deliberately not pixel diffs (machine-stable) — chosen to catch the
 * regression class found on 2026-07-13: component classes referenced but never defined, native
 * unstyled controls, and text placeholders where the prototype shows icons. Each assertion maps to
 * a `--qiq-*` token value from `src/ui/src/theme/tokens.css` (light theme, the seeded default).
 */

// Light-theme token values these assertions resolve against (tokens.css §3.1–3.2). Playwright
// computed styles come back as rgb(...), so the expected values are stated in that form.
const ACCENT = 'rgb(21, 154, 166)'; // --qiq-accent #159AA6
const ACCENT_CONTRAST = 'rgb(255, 255, 255)'; // --qiq-accent-contrast #FFFFFF
const SURFACE_CARD = 'rgb(255, 255, 255)'; // --qiq-surface-card #FFFFFF

async function style(page: Page, selector: string, property: string): Promise<string> {
  return page.locator(selector).first().evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

test.describe('design-system visual smoke (V-082)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    await expect(page.getByTestId('app-shell')).toBeVisible();
  });

  test('active sidebar nav item renders as an accent pill, not a default hyperlink', async ({ page }) => {
    // e2e-rm lands on /overview (nav-overview active). The original defect: .qiq-nav-item was
    // referenced in Sidebar.tsx but defined nowhere, so links rendered blue and underlined.
    const active = '[data-testid="sidebar-nav"] .qiq-nav-item--active';
    await expect(page.locator(active)).toBeVisible();
    // The active pill animates in via a 140ms `transition: background` (theme/components.css). A
    // single getComputedStyle read can land mid-flight and return an interpolated fractional-alpha
    // rgba (F-043-5 saw 0.62 and 0.882 on different runs of the unchanged code) — a test-timing
    // race, not a translucent design token. Poll until the background settles to the solid accent at
    // rest; if it never does, that is a genuine defect and this still fails.
    await expect.poll(() => style(page, active, 'background-color')).toBe(ACCENT);
    expect(await style(page, active, 'text-decoration-line')).toBe('none');
    // Inactive items must not be browser-default link blue either.
    const inactive = '[data-testid="sidebar-nav"] .qiq-nav-item:not(.qiq-nav-item--active)';
    expect(await style(page, inactive, 'text-decoration-line')).toBe('none');
    expect(await style(page, inactive, 'color')).not.toBe('rgb(0, 0, 238)');
  });

  test('primary + New Lead button uses the accent fill with contrast text', async ({ page }) => {
    const btn = '[data-testid="new-lead-button"]';
    await expect(page.locator(btn)).toBeVisible();
    expect(await style(page, btn, 'background-color')).toBe(ACCENT);
    expect(await style(page, btn, 'color')).toBe(ACCENT_CONTRAST);
    expect(await style(page, btn, 'border-radius')).not.toBe('0px');
  });

  test('cards use the card surface, subtle border, and 10px radius', async ({ page }) => {
    // The Leads list (a screen e2e-rm can always view) renders its content inside .qiq-card.
    await page.getByTestId('nav-leads').click();
    const card = '.qiq-card';
    await expect(page.locator(card).first()).toBeVisible();
    // expect.poll: the list re-renders as data arrives (skeleton -> table), which can detach the
    // element between locator resolution and evaluation — a detached node computes to ''.
    await expect.poll(() => style(page, card, 'background-color')).toBe(SURFACE_CARD);
    await expect.poll(() => style(page, card, 'border-top-width')).toBe('1px');
    await expect.poll(() => style(page, card, 'border-radius')).toBe('10px');
  });

  test('top bar bell and help are icon buttons, not text placeholders', async ({ page }) => {
    await expect(page.locator('[data-testid="notification-bell"] svg')).toBeVisible();
    await expect(page.locator('[data-testid="help-button"] svg')).toBeVisible();
    await expect(page.getByTestId('notification-bell')).not.toContainText('Bell');
    await expect(page.getByTestId('help-button')).not.toContainText('Help');
  });

  test('body typography comes from the token font stack', async ({ page }) => {
    const fontFamily = await style(page, 'body', 'font-family');
    expect(fontFamily).toContain('Inter');
    expect(fontFamily).toContain('Segoe UI');
  });
});
